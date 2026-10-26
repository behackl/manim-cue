import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { environmentFor, workingDirectoryFor } from './environment';
import { createJob, fileHash, inspect, renderExport, type PreviewResult, type Result, type TimelineResult, type SceneJob } from './jobs';
import { exportChoice, exportSize, type ExportChoice, type ExportModel } from './export-settings';
import { copyExport, validateDestination } from './export-files';
import { isCall } from './timeline';

/** For a dialog, `frame` is the shown media: a frame or the video. `time` is the preview position. */
export interface ExportSource {
  uri: vscode.Uri; scene: string; frame?: PreviewResult; video?: PreviewResult; timeline?: TimelineResult; job?: SceneJob; time: number;
}
/** The state of the export dialog. `quick`: a save without the dialog, which keeps the stored dialog choice. */
interface Dialog { id: string; source: ExportSource; choice: ExportChoice; time: number; error?: string; quick?: boolean }
interface Active { source: ExportSource; abort: AbortController; native: boolean; started?: boolean; sourceHash?: string; job?: SceneJob }

/** Owns dialog/file lifetimes, not the preview selection or render profile. */
export class Exports {
  private dialog?: Dialog;
  private active?: Active;
  private task?: Promise<void>;
  private status?: string;
  requestOpen = false;
  constructor(private context: vscode.ExtensionContext, private scratch: string,
    private source: () => ExportSource | undefined, private update: () => void,
    private suspend: () => Promise<() => void>, private log: (text: string) => void) {}
  get busy(): boolean { return !!this.active; }
  get nativeBusy(): boolean { return this.active?.native === true && this.active.started === true; }
  get directories(): string[] {
    return [this.dialog?.source, this.active?.source].flatMap(s => [s?.frame?.directory, s?.video?.directory, s?.timeline?.directory, s?.job?.directory])
      .concat(this.active?.job?.directory).filter((p): p is string => !!p);
  }
  /** Results that an open dialog or a running export still uses. */
  get results(): (PreviewResult | TimelineResult)[] {
    return [this.dialog?.source, this.active?.source].flatMap(s => [s?.frame, s?.video, s?.timeline]).filter(r => r !== undefined);
  }
  get files(): string[] {
    return [this.dialog?.source, this.active?.source].flatMap(s => [s?.frame?.media.path, s?.video?.media.path]).filter((p): p is string => !!p);
  }
  /** A scene without plays and waits has no video; its frame is the export. */
  private hasVideo(source: ExportSource): boolean { return !source.timeline || source.timeline.timeline.entries.some(isCall); }
  private dirty(source: ExportSource): boolean { return vscode.workspace.textDocuments.some(d => d.uri.toString() === source.uri.toString() && d.isDirty); }
  private description(result: PreviewResult | TimelineResult): string {
    const p = result.profile;
    const media = 'media' in result ? result.media : undefined;
    const time = media?.kind === 'image' ? (media.capture?.time == null ? 'Last frame' : `${media.capture.time.toFixed(2)} s`) : `${(media?.duration ?? (result as TimelineResult).timeline.duration).toFixed(2)} s`;
    return `${result.outdated ? 'Outdated · ' : ''}${time} · ${p.width} × ${p.height} · ${p.fps} fps${media?.kind === 'video' ? ` · ${media.hasAudio ? 'with sound' : 'no sound'}` : ''}`;
  }
  snapshot(webview?: vscode.Webview): ExportModel {
    const s = this.dialog, current = this.source();
    const p = s?.source.frame?.profile ?? s?.source.timeline?.profile;
    return { busy: this.busy, nativeBusy: this.nativeBusy, status: this.status, requestOpen: this.requestOpen,
      dialog: s ? { id: s.id, scene: s.source.scene, choice: s.choice,
        aspect: p ? p.width / p.height : 16 / 9, previewSize: { width: p?.width ?? 960, height: p?.height ?? 540 },
        frame: s.source.frame ? { kind: s.source.frame.media.kind, description: this.description(s.source.frame),
          uri: webview && s.source.frame.media.kind === 'image' ? webview.asWebviewUri(vscode.Uri.file(s.source.frame.media.path)).toString() : undefined } : undefined,
        video: s.source.video?.media.kind === 'video' ? this.description(s.source.video) : undefined,
        timeline: s.source.timeline ? this.description(s.source.timeline) : undefined,
        canExportVideo: this.hasVideo(s.source),
        canCapture: !!s.source.frame && s.source.frame.media.kind === 'video' && !s.source.frame.outdated,
        dirty: this.dirty(s.source), newer: s.source.frame !== current?.frame && s.source.frame !== current?.video || current?.video?.media.path !== s.source.video?.media.path || current?.timeline?.directory !== s.source.timeline?.directory,
        error: s.error } : undefined };
  }
  /** Opens the dialog for the frame or the video that the preview shows at `time`. */
  open(time: number, video: boolean): void {
    this.requestOpen = false;
    if (this.busy) { this.update(); return; }
    const current = this.source();
    if (!current) { this.update(); return; }
    const source = { ...current, frame: video ? current.video : current.frame };
    const p = source.frame?.profile ?? source.timeline?.profile;
    let choice: ExportChoice = { kind: source.frame?.media.kind === 'video' ? 'video' : 'frame', method: source.video && !source.video.outdated ? 'copy' : 'render',
      settings: { ...exportSize(1080, p ? p.width / p.height : 16 / 9), fps: p?.fps ?? 30, crf: 18, preset: 'medium', options: '' } };
    try { choice = exportChoice(this.context.workspaceState.get('exportChoice')); } catch { /* First visit or incompatible stored preference. */ }
    if (choice.kind === 'video' && !this.hasVideo(source)) choice = { ...choice, kind: 'frame' };
    this.dialog = { id: randomUUID(), source, choice, time }; this.update();
  }
  /** Saves the frame at the preview position as PNG: the shown frame, or else a new frame for the position. */
  async saveFrame(): Promise<void> {
    const source = this.source();
    if (!source || this.busy) return;
    const shown = source.frame?.media.capture?.requestedTime === source.time ? source.frame : undefined;
    if (!shown && !source.job) throw new Error('Refresh to update the frame first.');
    if (!shown && !vscode.workspace.isTrusted) throw new Error('Trust this workspace to run the scene.');
    const p = (source.frame ?? source.video)?.profile;
    const settings = { ...exportSize(1080, p ? p.width / p.height : 16 / 9), fps: p?.fps ?? 30, crf: 18, preset: 'medium' as const, options: '' };
    const s: Dialog = { id: randomUUID(), source: { ...source, frame: shown ?? source.video ?? source.frame }, choice: { kind: 'frame', method: 'copy', settings }, time: source.time, quick: true };
    const active: Active = { source: s.source, abort: new AbortController(), native: !shown };
    this.active = active; this.task = this.run(s, active);
    await this.task;
  }
  /** Saves the timeline as JSON, without the export dialog. */
  async saveTimeline(): Promise<void> {
    const source = this.source(), result = source?.timeline;
    if (!source || !result) throw new Error('There is no timeline to save yet.');
    const name = `${source.scene}-timeline${result.outdated ? '-outdated' : ''}.json`;
    const destination = await vscode.window.showSaveDialog({ title: 'Save timeline',
      defaultUri: vscode.Uri.file(path.join(path.dirname(source.uri.fsPath), name)), filters: { JSON: ['json'] } });
    if (!destination) return;
    if (destination.scheme !== 'file') throw new Error('Choose a file on this computer.');
    const validate = () => validateDestination(destination.fsPath, '.json', [source.uri.fsPath, this.scratch, ...Object.keys(result.profile.configs)]);
    await validate();
    await copyExport(result.file, destination.fsPath, new AbortController().signal, validate);
  }
  close(id?: string): void { if (!id || this.dialog?.id === id) { this.dialog = undefined; this.update(); } }
  /** The scene or its settings changed: stop a render for export. */
  invalidate(force = false, savedHash?: string): void {
    if (savedHash && savedHash === this.active?.sourceHash) return; // A delayed notification for the accepted save.
    if (this.active?.native && (force || this.active.started)) this.active.abort.abort(new Error('Export cancelled. The scene changed.'));
  }
  cancel(): void { this.active?.abort.abort(new Error('Export cancelled.')); }
  dispose(): void { this.cancel(); this.dialog = undefined; }
  async whenIdle(): Promise<void> { await this.task; }
  async submit(id: string, value: unknown): Promise<void> {
    const s = this.dialog;
    if (!s || s.id !== id || this.busy) return;
    try {
      // Copies do not depend on render controls, including oversized aspect-derived defaults.
      s.choice = exportChoice(value, s.choice.settings);
      const { kind, method } = s.choice;
      const native = kind === 'video' && method === 'render' || kind === 'frame' && s.source.frame?.media.kind === 'video';
      if (kind === 'frame' && !s.source.frame || kind === 'video' && method === 'copy' && s.source.video?.media.kind !== 'video' || kind === 'timeline' && !s.source.timeline) throw new Error('There is nothing of this kind to save yet.');
      if (kind === 'video' && !this.hasVideo(s.source)) throw new Error('This scene has no plays or waits. Save its frame as PNG.');
      if (kind === 'frame' && native && !this.snapshot().dialog?.canCapture) throw new Error('Refresh to update the frame first.');
      if (native && !vscode.workspace.isTrusted) throw new Error('Trust this workspace to run the scene.');
      if (kind === 'video' && method === 'render' && (s.source.timeline ?? s.source.frame)?.profile.videoEncoder === false) throw new Error('This Manim version cannot export video. Run “Manim Cue: Set Up Python Environment”.');
      const active: Active = { source: s.source, abort: new AbortController(), native };
      this.active = active; this.status = 'Choose where to save…'; s.error = undefined; this.update();
      this.task = this.run(s, active);
      await this.task;
    } catch (e) {
      if (this.dialog === s) s.error = e instanceof Error ? e.message : String(e);
      this.update();
    }
  }
  private async run(s: Dialog, active: Active): Promise<void> {
    const { kind, settings } = s.choice, signal = active.abort.signal;
    const native = active.native, source = s.source;
    const extension = kind === 'frame' ? '.png' : kind === 'timeline' ? '.json' : '.mp4';
    const result = kind === 'frame' ? source.frame : kind === 'timeline' ? source.timeline : source.video;
    const outdated = !native && result?.outdated;
    const stamp = kind === 'frame' ? `-${source.frame?.media.capture?.time == null && !native ? 'last' : (native ? s.time : source.frame!.media.capture!.time!).toFixed(3) + 's'}` : kind === 'timeline' ? '-timeline' : '';
    let release: (() => void) | undefined, sourceHash: string | undefined;
    try {
      const destination = await vscode.window.showSaveDialog({ title: { frame: 'Save frame', video: 'Save video', timeline: 'Save timeline' }[kind],
        defaultUri: vscode.Uri.file(path.join(path.dirname(source.uri.fsPath), `${source.scene}${stamp}${outdated ? '-outdated' : ''}${extension}`)),
        filters: { [extension.slice(1).toUpperCase()]: [extension.slice(1)] } });
      signal.throwIfAborted();
      if (!destination) { this.status = undefined; return; }
      if (destination.scheme !== 'file') throw new Error('Choose a file on this computer.');
      const forbidden = [source.uri.fsPath, this.scratch, ...Object.keys(result?.profile.configs ?? {})];
      await validateDestination(destination.fsPath, extension, forbidden);
      if (native) {
        if (this.source()?.uri.toString() !== source.uri.toString() || this.source()?.scene !== source.scene) throw new Error('The scene changed. Open Export again.');
        const document = await vscode.workspace.openTextDocument(source.uri);
        if (document.isDirty) {
          // Explicit consent even if the document became dirty while Save As was open.
          if (kind === 'frame') throw new Error('The scene file has unsaved changes. Save it, then save the frame.');
          if (await vscode.window.showWarningMessage('Save the scene file and render the video?', { modal: true }, 'Save and Render') !== 'Save and Render') { this.status = undefined; return; }
          if (!await document.save()) throw new Error('The scene file could not be saved.');
        }
        active.sourceHash = sourceHash = await fileHash(source.uri.fsPath);
        if (document.isDirty) throw new Error('The scene file changed. Save it and try again.');
        active.started = true; signal.throwIfAborted();
        release = await this.suspend(); signal.throwIfAborted();
      }
      this.dialog = undefined;
      let preference: ExportChoice | undefined;
      try { preference = exportChoice(s.choice); } catch { /* A copy may carry an invalid render draft. Keep the last valid preference. */ }
      if (preference && !s.quick) await this.context.workspaceState.update('exportChoice', preference);
      this.status = native ? (kind === 'frame' ? 'Updating frame for export…' : 'Rendering video for export…') : 'Saving…'; this.update();
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Manim Cue: ${this.status}`, cancellable: true }, async (_progress, cancellation) => {
        const subscription = cancellation.onCancellationRequested(() => this.cancel());
        try {
          let file: string, rendered: Result | undefined;
          if (!native) file = kind === 'timeline' ? source.timeline!.file : (result as PreviewResult).media.path;
          else if (kind === 'frame') {
            const { frame } = await inspect(source.job!, { time: s.time, timeline: false }, signal);
            if (!frame?.media.capture || frame.media.capture.time === null) throw new Error('The scene ends before this time. Choose an earlier time.');
            file = frame.media.path; rendered = frame;
          } else {
            const env = await environmentFor(source.uri); signal.throwIfAborted();
            const cfg = vscode.workspace.getConfiguration('manimCue', source.uri), timeout = cfg.get<number>('timeoutSeconds', 600);
            if (!Number.isFinite(timeout) || timeout < 5 || timeout > 7200) throw new Error('Set “Manim Cue: Timeout Seconds” to a value from 5 to 7200.');
            const job = await createJob({ ...env, source: source.uri.fsPath, scene: source.scene, cwd: workingDirectoryFor(source.uri), fps: settings.fps, width: settings.width,
              timeout: timeout * 1000, exportSettings: settings, scratch: this.scratch,
              helpers: vscode.Uri.joinPath(this.context.extensionUri, 'python').fsPath, signal, log: this.log });
            active.job = job; signal.throwIfAborted();
            if (job.sourceHash !== sourceHash || this.dirty(source)) throw new Error('The scene file changed. Save it and try again.');
            this.log(`\n── Export ${source.scene} · ${settings.width}×${settings.height} · ${settings.fps} fps · CRF ${settings.crf} / ${settings.preset} ──\nPython: ${env.python}\nSource: ${source.uri.fsPath}\n`);
            const exported = await renderExport(job, signal); rendered = exported; file = exported.file;
          }
          const beforePublish = async () => {
            signal.throwIfAborted();
            await validateDestination(destination.fsPath, extension, [...forbidden, ...Object.keys(rendered?.profile.configs ?? {})]);
            if (rendered && this.dirty(source)) throw new Error('The scene file changed. Save it and try again.');
          };
          await copyExport(file, destination.fsPath, signal, beforePublish);
        } finally { subscription.dispose(); }
      });
      this.status = `Saved ${path.basename(destination.fsPath)}`;
      void vscode.window.showInformationMessage(this.status, 'Reveal file', 'Open file').then(action => {
        if (action === 'Reveal file') void vscode.commands.executeCommand('revealFileInOS', destination);
        if (action === 'Open file') void vscode.env.openExternal(destination);
      });
    } catch (e) {
      const error = signal.aborted ? signal.reason : e;
      const detail = error instanceof Error ? error.message : String(error);
      this.log(`\nExport: ${detail}\n`);
      this.status = detail.split('\n')[0].slice(0, 300);
      if (this.dialog === s) s.error = this.status;
      else if (this.status !== 'Export cancelled.') void vscode.window.showErrorMessage(`Export failed: ${this.status}`, 'Show Log').then(action => { if (action) void vscode.commands.executeCommand('manimCue.logs'); });
    } finally {
      // No export output is published into the preview's resource root.
      if (active.job) await fs.rm(active.job.directory, { recursive: true, force: true }).catch(() => {});
      this.active = undefined; release?.(); this.update();
    }
  }
}
