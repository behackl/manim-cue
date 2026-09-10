import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { environmentFor, workingDirectoryFor } from './environment';
import { captureFrame, checkInputs, createJob, fileHash, renderExport, type PreviewResult, type RunResult, type SceneJob } from './jobs';
import { exportChoice, exportSize, type ExportChoice, type ExportModel } from './export-settings';
import { copyExport, validateDestination } from './export-files';
import { indexAt } from './transport';

export interface ExportSource {
  uri: vscode.Uri; scene: string; frame?: PreviewResult; movie?: PreviewResult; timeline?: RunResult;
  job?: SceneJob; time: number; edited: boolean;
}
interface Session { id: string; source: ExportSource; choice: ExportChoice; time: number; error?: string }
interface Active { source: ExportSource; abort: AbortController; native: boolean; started?: boolean; sourceHash?: string; job?: SceneJob }

/** Owns dialog/file lifetimes, not the preview selection or render profile. */
export class Exports {
  private session?: Session;
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
    return [this.session?.source, this.active?.source].flatMap(s => [s?.frame?.directory, s?.movie?.directory, s?.timeline?.directory, s?.job?.directory])
      .concat(this.active?.job?.directory).filter((p): p is string => !!p);
  }
  get files(): string[] {
    return [this.session?.source, this.active?.source].flatMap(s => [s?.frame?.media.path, s?.movie?.media.path]).filter((p): p is string => !!p);
  }
  private dirty(source: ExportSource): boolean { return vscode.workspace.textDocuments.some(d => d.uri.toString() === source.uri.toString() && d.isDirty); }
  private old(result: PreviewResult | RunResult, current = this.source()): boolean {
    return !current || current.edited || this.dirty(current) || result.directory !== current.job?.directory;
  }
  private description(result: PreviewResult | RunResult): string {
    const p = result.profile;
    const media = 'media' in result ? result.media : undefined;
    const time = media?.kind === 'image' ? (media.capture?.time == null ? 'End state' : `${media.capture.time.toFixed(3)} s`) : `${media?.duration ?? (result as RunResult).timeline.end} s`;
    return `${this.old(result) ? 'OLD · ' : ''}${time} · ${p.width} × ${p.height} · ${p.fps} fps · source ${result.sourceHash.slice(0, 8)}${media?.kind === 'video' ? ` · H.264 · ${media.hasAudio ? 'includes audio' : 'no audio'}` : ''}`;
  }
  snapshot(webview?: vscode.Webview): ExportModel {
    const s = this.session, current = this.source();
    const p = s?.source.frame?.profile ?? s?.source.timeline?.profile;
    return { busy: this.busy, nativeBusy: this.nativeBusy, status: this.status, requestOpen: this.requestOpen,
      dialog: s ? { id: s.id, scene: s.source.scene, choice: s.choice,
        aspect: p ? p.width / p.height : 16 / 9, previewSize: { width: p?.width ?? 960, height: p?.height ?? 540 },
        frame: s.source.frame ? { kind: s.source.frame.media.kind, description: this.description(s.source.frame),
          uri: webview && s.source.frame.media.kind === 'image' ? webview.asWebviewUri(vscode.Uri.file(s.source.frame.media.path)).toString() : undefined } : undefined,
        video: s.source.movie?.media.kind === 'video' ? this.description(s.source.movie) : undefined,
        timeline: s.source.timeline ? `${this.description(s.source.timeline)} · revision ${s.source.timeline.timeline.revision.slice(0, 8)}` : undefined,
        canCapture: !!s.source.frame && s.source.frame.media.kind === 'video' && !this.old(s.source.frame) && s.source.job?.profile?.captureFrame === true,
        dirty: this.dirty(s.source), newer: current?.frame?.media.path !== s.source.frame?.media.path || current?.movie?.media.path !== s.source.movie?.media.path || current?.timeline?.directory !== s.source.timeline?.directory,
        error: s.error } : undefined };
  }
  open(token?: string, time?: number): void {
    this.requestOpen = false;
    if (this.busy) { this.update(); return; }
    const source = this.source();
    if (!source) { this.update(); return; }
    if (token !== undefined && token !== source.frame?.media.path) return;
    const p = source.frame?.profile ?? source.timeline?.profile;
    let choice: ExportChoice = { kind: source.frame?.media.kind === 'video' ? 'video' : 'frame', method: source.movie && !this.old(source.movie) ? 'copy' : 'render',
      settings: { ...exportSize(1080, p ? p.width / p.height : 16 / 9), fps: p?.fps ?? 30, crf: 18, preset: 'medium', options: '' } };
    try { choice = exportChoice(this.context.workspaceState.get('exportChoice')); } catch { /* First visit or incompatible stored preference. */ }
    const media = source.frame?.media, value = time ?? source.time;
    if (!Number.isFinite(value) || value < 0 || media?.kind === 'video' && value > media.duration) return;
    const pts = media?.frameTimes;
    const selected = media?.kind === 'video' && pts ? indexAt(value + 1e-7, pts.length, i => pts[i]) / source.frame!.profile.fps : value;
    this.session = { id: randomUUID(), source, choice, time: selected }; this.update();
  }
  close(id?: string): void { if (!id || this.session?.id === id) { this.session = undefined; this.update(); } }
  invalidate(reason: string, force = false, savedHash?: string): void {
    if (savedHash && savedHash === this.active?.sourceHash) return; // A delayed notification for the accepted save.
    if (this.active?.native && (force || this.active.started)) this.active.abort.abort(new Error(reason));
  }
  cancel(): void { this.active?.abort.abort(new Error('Export cancelled.')); }
  dispose(): void { this.cancel(); this.session = undefined; }
  async whenIdle(): Promise<void> { await this.task; }
  async submit(id: string, value: unknown): Promise<void> {
    const s = this.session;
    if (!s || s.id !== id || this.busy) return;
    try {
      const incoming = value as ExportChoice;
      // Hidden render controls cannot block an exact artifact copy.
      s.choice = exportChoice({ ...incoming, settings: incoming?.kind === 'video' && incoming.method === 'render' ? incoming.settings : s.choice.settings });
      const { kind, method } = s.choice;
      const native = kind === 'video' && method === 'render' || kind === 'frame' && s.source.frame?.media.kind === 'video';
      if (kind === 'frame' && !s.source.frame || kind === 'video' && method === 'copy' && s.source.movie?.media.kind !== 'video' || kind === 'timeline' && !s.source.timeline) throw new Error('No completed artifact of this kind.');
      if (kind === 'frame' && native && !this.snapshot().dialog?.canCapture) throw new Error('Refresh to a current movie with frame capture support first.');
      if (native && !vscode.workspace.isTrusted) throw new Error('Trust this workspace before executing Python.');
      if (kind === 'video' && method === 'render' && this.source()?.job?.profile?.videoEncoder === false) throw new Error('New MP4 exports require Manim’s public video encoder profile support. Run Manim Cue: Check Python Environment; existing artifact copies remain available.');
      const active: Active = { source: s.source, abort: new AbortController(), native };
      this.active = active; this.status = 'Choosing export destination…'; s.error = undefined; this.update();
      this.task = this.run(s, active);
      await this.task;
    } catch (e) {
      if (this.session === s) s.error = e instanceof Error ? e.message : String(e);
      this.update();
    }
  }
  private async run(s: Session, active: Active): Promise<void> {
    const { kind, settings } = s.choice, signal = active.abort.signal;
    const native = active.native, source = s.source;
    const extension = kind === 'frame' ? '.png' : kind === 'timeline' ? '.json' : '.mp4';
    const artifact = kind === 'frame' ? source.frame : kind === 'timeline' ? source.timeline : source.movie;
    const old = !native && artifact && this.old(artifact);
    const stamp = kind === 'frame' ? `-${source.frame?.media.capture?.time == null && !native ? 'end-state' : (native ? s.time : source.frame!.media.capture!.time!).toFixed(3) + 's'}` : kind === 'timeline' ? '-timeline' : '';
    let release: (() => void) | undefined, sourceHash: string | undefined;
    try {
      const destination = await vscode.window.showSaveDialog({ title: native ? 'Render and save' : 'Save export',
        defaultUri: vscode.Uri.file(path.join(path.dirname(source.uri.fsPath), `${source.scene}${stamp}${old ? '-old' : ''}${extension}`)),
        filters: { [extension.slice(1).toUpperCase()]: [extension.slice(1)] } });
      signal.throwIfAborted();
      if (!destination) { this.status = undefined; return; }
      if (destination.scheme !== 'file') throw new Error('Export requires a local destination.');
      const forbidden = [source.uri.fsPath, this.scratch, ...Object.keys(artifact?.profile.configs ?? {})];
      await validateDestination(destination.fsPath, extension, forbidden);
      if (native) {
        if (this.source()?.uri.toString() !== source.uri.toString() || this.source()?.scene !== source.scene) throw new Error('Scene changed. Open Export again.');
        const document = await vscode.workspace.openTextDocument(source.uri);
        if (document.isDirty) {
          // Explicit consent even if the document became dirty while Save As was open.
          if (kind === 'frame') throw new Error('Source has unsaved changes. Save and refresh before capturing this frame.');
          if (await vscode.window.showWarningMessage('Save the source and render the whole Scene?', { modal: true }, 'Save and Render') !== 'Save and Render') { this.status = undefined; return; }
          if (!await document.save()) throw new Error('Source could not be saved.');
        }
        active.sourceHash = sourceHash = await fileHash(source.uri.fsPath);
        if (document.isDirty) throw new Error('Source changed before export. Try again after saving.');
        active.started = true; signal.throwIfAborted();
        release = await this.suspend(); signal.throwIfAborted();
      }
      this.session = undefined;
      await this.context.workspaceState.update('exportChoice', s.choice);
      this.status = native ? 'Export rendering — automatic previews paused' : 'Saving export…'; this.update();
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Manim Cue: ${this.status}`, cancellable: true }, async (_progress, cancellation) => {
        const subscription = cancellation.onCancellationRequested(() => this.cancel());
        try {
          let file: string, observed: PreviewResult | undefined;
          if (!native) file = kind === 'timeline' ? path.join(source.timeline!.directory, 'timeline.json') : artifact!.media!.path;
          else if (kind === 'frame') {
            await checkInputs(source.frame!);
            const frame = await captureFrame(source.job!, s.time, signal);
            if (!frame?.media.capture || frame.media.capture.time === null) throw new Error('The requested frame is unavailable; no PNG was exported. Refresh or save an end-state snapshot.');
            file = frame.media.path; observed = frame;
          } else {
            const env = await environmentFor(source.uri); signal.throwIfAborted();
            const cfg = vscode.workspace.getConfiguration('manimCue', source.uri), timeout = cfg.get<number>('timeoutSeconds', 600);
            if (!Number.isFinite(timeout) || timeout < 5 || timeout > 7200) throw new Error('Export timeout must be between 5 and 7200 seconds.');
            const job = await createJob({ ...env, source: source.uri.fsPath, scene: source.scene, cwd: workingDirectoryFor(source.uri), fps: settings.fps, width: settings.width,
              timeout: timeout * 1000, preview: false, exportSettings: settings, scratch: this.scratch,
              helpers: vscode.Uri.joinPath(this.context.extensionUri, 'python').fsPath, signal, log: this.log, phase: () => {}, timelineReady: () => {} });
            active.job = job; signal.throwIfAborted();
            if (job.sourceHash !== sourceHash || this.dirty(source)) throw new Error('Source changed while preparing export.');
            this.log(`\n── Export ${source.scene} · ${settings.width}×${settings.height} · ${settings.fps} fps · CRF ${settings.crf} / ${settings.preset} ──\nPython: ${env.python}\nSource: ${source.uri.fsPath}\n`);
            observed = await renderExport(job, signal); file = observed.media.path;
          }
          const beforePublish = async () => {
            signal.throwIfAborted();
            await validateDestination(destination.fsPath, extension, [...forbidden, ...Object.keys(observed?.profile.configs ?? {})]);
            if (observed) { if (this.dirty(source)) throw new Error('Source changed during export.'); await checkInputs(observed); }
          };
          await copyExport(file, destination.fsPath, signal, beforePublish);
        } finally { subscription.dispose(); }
      });
      this.status = `Export saved: ${path.basename(destination.fsPath)}`;
      void vscode.window.showInformationMessage(this.status, 'Reveal file', 'Open file').then(action => {
        if (action === 'Reveal file') void vscode.commands.executeCommand('revealFileInOS', destination);
        if (action === 'Open file') void vscode.env.openExternal(destination);
      });
    } catch (e) {
      const error = signal.aborted ? signal.reason : e;
      const detail = error instanceof Error ? error.message : String(error);
      this.log(`\nExport: ${detail}\n`);
      this.status = detail.split('\n')[0].slice(0, 300);
      if (this.session === s) s.error = this.status;
      else if (this.status !== 'Export cancelled.') void vscode.window.showErrorMessage(`Export failed: ${this.status}`, 'Show logs').then(action => { if (action) void vscode.commands.executeCommand('manimCue.logs'); });
    } finally {
      // No export output is published into the preview's resource root.
      if (active.job) await fs.rm(active.job.directory, { recursive: true, force: true }).catch(() => {});
      this.active = undefined; release?.(); this.update();
    }
  }
}
