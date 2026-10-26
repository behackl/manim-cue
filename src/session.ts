import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { environmentFor, workingDirectoryFor } from './environment';
import { RuntimeUnavailable } from './diagnostics';
import { Scenes } from './scenes';
import { insideEnvironment } from './setup-plan';
import { createJob, inspect, renderPreview, publishPreview, fileHash, type TimelineResult, type PreviewResult, type SceneJob } from './jobs';
import { PreviewQueue } from './preview-queue';
import type { TimeRange } from './selection';
import { Views } from './views';
import { Exports, type ExportSource } from './exports';
import { model, receive } from './panel';

type Topic = 'Frame' | 'Timeline' | 'Video';

/**
 * The open scene: its jobs and its results (frame, timeline, video). The webviews own
 * the playback; this class makes the results that they ask for. Fields without
 * `private` are read by the panel; only this class changes them.
 */
export class Session implements vscode.Disposable {
  target?: { uri: vscode.Uri; scene: string; column?: vscode.ViewColumn };
  job?: SceneJob;
  frame?: PreviewResult;
  video?: PreviewResult;
  timeline?: TimelineResult;
  /** The comparison reference, kept here so that its file stays. */
  reference?: PreviewResult;
  /** The plays to loop, chosen in the timeline view. */
  loop?: TimeRange;
  /** The last position: the next update starts there, and the next session too. */
  time = 0;
  status = 'Open a scene to see its frames and its timeline.';
  error?: string;
  busy = false;
  pythonInUse?: string;
  readonly extensionId: string;
  readonly views: Views;
  readonly scenes: Scenes;
  readonly exports: Exports;
  /** Increments to stop the async work of an older refresh. */
  private generation = 0;
  private opening = 0;
  private abort?: AbortController;
  private pending: Promise<void> = Promise.resolve();
  private preparing = false;
  /** "Render video" or Play came before the timeline: render when it is ready. */
  private videoWanted = false;
  private errors = new Map<string, string>();
  private saveTimer?: ReturnType<typeof setTimeout>;
  private saveCheck = 0;
  private diskHash?: string;
  /** The editor changed the source after the last refresh; a save with the old content still refreshes. */
  private sourceEdited = false;
  private disposed = false;
  private rememberTimer?: ReturnType<typeof setTimeout>;
  private readonly queue = new PreviewQueue(() => {
    if (this.disposed) return;
    this.busy = this.preparing || this.queue.busy;
    this.views?.update();
    if (!this.busy) void this.cleanup();
  }, e => { this.error = String(e); this.views.update(); });
  private readonly scratch: string;
  private readonly mediaRoot: string;
  constructor(private readonly context: vscode.ExtensionContext, private readonly output: vscode.OutputChannel) {
    this.extensionId = context.extension.id;
    this.scratch = vscode.Uri.joinPath(context.storageUri ?? context.globalStorageUri, 'runs').fsPath;
    this.mediaRoot = path.join(this.scratch, 'preview-media');
    this.exports = new Exports(context, this.scratch, () => this.exportSource(), () => { this.views?.update(); void this.cleanup(); },
      () => this.queue.suspend(), text => { if (!this.disposed) this.output.append(text); });
    this.scenes = new Scenes(vscode.Uri.joinPath(context.extensionUri, 'python', 'discover.py').fsPath);
    this.views = new Views(context.extensionUri, [vscode.Uri.file(this.mediaRoot)],
      (m, origin) => { void receive(this, m, origin).catch(e => this.failAction(e)); }, webview => model(this, webview),
      () => { this.queue.remove('frame'); this.queue.remove('render'); this.reference = undefined; this.exports.close(); });
  }
  get autoPreview(): boolean { return vscode.workspace.getConfiguration('manimCue', this.target?.uri).get('autoPreview', true); }
  async open(uri?: vscode.Uri, scene?: string): Promise<void> {
    const opening = ++this.opening;
    if (!vscode.workspace.isTrusted) { await vscode.window.showWarningMessage('Trust this workspace to run Manim scenes.'); return; }
    const remembered = this.context.workspaceState.get<{ uri: string; scene: string; time: number }>('lastScene');
    let document = uri ? await vscode.workspace.openTextDocument(uri) : vscode.window.activeTextEditor?.document;
    if (!uri && document?.languageId !== 'python' && remembered) {
      document = await vscode.workspace.openTextDocument(vscode.Uri.parse(remembered.uri));
      scene ??= remembered.scene;
    }
    if (opening !== this.opening) return;
    if (!document || document.uri.scheme !== 'file' || document.languageId !== 'python') throw new Error('Open a Python file on this computer first.');
    if (document.isDirty) {
      if (await vscode.window.showWarningMessage('Manim Cue runs the saved file. Save it now?', 'Save and Run') !== 'Save and Run') return;
      if (!await document.save()) return;
    }
    if (!scene && remembered?.uri === document.uri.toString()) scene = remembered.scene;
    scene ??= await this.scenes.pick(document);
    if (!scene || opening !== this.opening) return;
    if (!/^[\p{ID_Start}_][\p{ID_Continue}]*$/u.test(scene)) throw new Error('Enter the name of a Python class.');
    const different = !this.target || this.target.uri.toString() !== document.uri.toString() || this.target.scene !== scene;
    this.exports.invalidate(true); this.exports.close();
    this.cancel(false);
    if (different) {
      this.frame = this.video = this.timeline = this.reference = this.loop = undefined;
      this.diskHash = undefined; this.sourceEdited = false;
      const time = remembered?.uri === document.uri.toString() && remembered.scene === scene ? remembered.time : 0;
      this.time = Number.isFinite(time) && time >= 0 ? time : 0;
    }
    this.target = { uri: document.uri, scene, column: vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === document.uri.toString())?.viewColumn };
    this.remember();
    await this.views.open();
    if (opening === this.opening) await this.refresh();
  }
  async refresh(frame = true): Promise<void> {
    this.clearAutoRefresh();
    if (!this.target) { await this.open(); return; }
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace to run the scene.');
    const target = this.target, intent = this.generation;
    const document = await vscode.workspace.openTextDocument(target.uri);
    const hash = await fileHash(target.uri.fsPath);
    if (this.target !== target || intent !== this.generation || this.disposed) return;
    if (document.isDirty) { this.invalidate('Outdated. Save the scene file to update.'); throw new Error('Save the scene file to update.'); }
    const videoWanted = this.videoWanted;
    this.cancel(false);
    this.diskHash = hash; this.sourceEdited = false; this.videoWanted = videoWanted;
    const generation = this.generation, abort = new AbortController(); this.abort = abort;
    this.preparing = true; this.busy = true; this.error = undefined; this.errors.clear();
    this.status = 'Starting Python…'; this.views.update();
    const current = () => generation === this.generation && !abort.signal.aborted && !this.disposed;
    this.pending = this.pending.catch(() => {}).then(async () => {
      await this.queue.whenIdle();
      if (!current()) return;
      try {
        this.output.appendLine(`\n── ${target.scene} · ${path.basename(target.uri.fsPath)} · generation ${generation} ──`);
        const environment = await environmentFor(target.uri);
        if (!current()) return;
        this.pythonInUse = environment.python;
        const cfg = vscode.workspace.getConfiguration('manimCue', target.uri), cwd = workingDirectoryFor(target.uri);
        const fps = cfg.get<number>('frameRate', 30), width = cfg.get<number>('previewWidth', 960), timeout = cfg.get<number>('timeoutSeconds', 600);
        if (!(fps >= 1 && fps <= 120 && width >= 64 && width <= 3840 && timeout >= 5 && timeout <= 7200)) throw new Error('Check the Manim Cue settings for the frame rate, the preview width and the timeout.');
        this.output.appendLine(`Python: ${environment.python}\nSelection: ${environment.selection}\nSource: ${target.uri.fsPath}\nWorking directory: ${cwd}`);
        const job = await createJob({ ...environment, source: target.uri.fsPath, scene: target.scene, cwd, fps, width,
          timeout: timeout * 1000, scratch: this.scratch, helpers: vscode.Uri.joinPath(this.context.extensionUri, 'python').fsPath,
          signal: abort.signal, log: s => { if (!this.disposed) this.output.append(s); } });
        if (!current()) return;
        this.job = job;
        this.requestTimeline(frame);
      } catch (e) { if (current()) { this.error = e instanceof Error ? e.message : String(e); this.status = 'Update failed'; this.output.appendLine(this.error); } }
      finally { if (current()) { this.preparing = false; this.busy = this.queue.busy; this.views.update(); } }
    });
    await this.whenIdle();
  }
  private current(job: SceneJob, signal: AbortSignal): boolean {
    return this.job === job && !this.disposed && !signal.aborted;
  }
  /** Errors by topic; each one stays until the same topic succeeds. */
  private setError(topic: Topic, message?: string): void {
    if (message === undefined) this.errors.delete(topic); else this.errors.set(topic, message);
    this.error = [...this.errors.values()].join('\n') || undefined;
  }
  private jobFailed(job: SceneJob, signal: AbortSignal, topic: Topic, error: unknown): void {
    if (!this.current(job, signal)) return;
    const what = { Frame: 'The frame update', Timeline: 'The timeline update', Video: 'The video render' }[topic];
    this.status = `${what} failed`;
    this.setError(topic, `${what} failed: ${error instanceof Error ? error.message : String(error)}`);
    if (topic !== 'Frame') this.videoWanted = false;
    if (error instanceof RuntimeUnavailable) {
      this.job = undefined;
      this.queue.clear(); // Do not repeat the same failed check for queued jobs.
      this.status = 'Python environment not ready';
      this.setError(topic, error.message);
    }
    this.output.appendLine(`\n${this.error}`); this.views.update();
  }
  private async publishFrame(job: SceneJob, signal: AbortSignal, result: PreviewResult): Promise<void> {
    const published = await publishPreview(result, this.mediaRoot);
    if (!this.current(job, signal)) return;
    this.frame = published; this.setError('Frame'); this.views.update();
  }
  /** One run gives the timeline and, with `frame`, the frame at the current time on the way. */
  private requestTimeline(frame: boolean): void {
    const job = this.job!;
    this.queue.enqueue('inspect', async signal => {
      const capture = frame && this.views.previewOpen;
      if (!this.current(job, signal)) return;
      this.status = capture ? 'Updating frame and timeline…' : 'Updating timeline…'; this.views.update();
      try {
        const result = await inspect(job, { time: capture ? this.time : undefined, timeline: true }, signal, async frame => {
          if (!this.current(job, signal)) return;
          this.status = 'Updating timeline…';
          await this.publishFrame(job, signal, frame);
        });
        if (!this.current(job, signal)) return;
        this.timeline = result.timeline; this.setError('Timeline'); this.status = 'Up to date'; this.views.update();
        if (frame && this.autoPreview || this.videoWanted) this.requestVideo();
      } catch (e) { this.jobFailed(job, signal, 'Timeline', e); }
    });
  }
  /** The preview has no current result for `time`. A newer request replaces this one. */
  requestFrame(time: number): void {
    this.time = time; this.remember();
    const job = this.job;
    if (!job || !this.views.previewOpen) return;
    this.queue.enqueue('frame', async signal => {
      const frame = this.frame?.media.capture;
      if (!this.current(job, signal) || frame?.requestedTime === time && !this.frame!.outdated) return;
      this.status = 'Updating frame…'; this.views.update();
      try {
        await inspect(job, { time, timeline: false }, signal, frame => this.current(job, signal) ? this.publishFrame(job, signal, frame) : undefined);
        if (this.current(job, signal)) { this.status = 'Up to date'; this.views.update(); }
      } catch (e) { this.jobFailed(job, signal, 'Frame', e); }
    }, 100); // Scrubbing sends many requests: start when they pause.
  }
  async renderVideo(): Promise<void> {
    this.videoWanted = true;
    if (!this.views.previewOpen) await this.views.open();
    if (!this.job) await this.refresh(); else this.requestVideo();
    await this.whenIdle();
  }
  /** Renders the video after the timeline, unless the scene has no plays or waits. */
  private requestVideo(): void {
    const job = this.job, timeline = this.timeline;
    if (!job || !timeline || timeline.outdated || this.queue.running('render') || this.video && !this.video.outdated) return;
    if (timeline.timeline.duration === 0) { this.videoWanted = false; return; }
    this.queue.enqueue('render', async signal => {
      if (!this.current(job, signal)) return;
      this.status = 'Rendering video…'; this.views.update();
      try {
        const result = await renderPreview(job, signal);
        if (!this.current(job, signal)) return;
        const published = await publishPreview(result.video, this.mediaRoot);
        if (!this.current(job, signal)) return;
        // The render's timeline describes the video; selections keep their entry indices.
        this.video = published; this.timeline = result.timeline; this.videoWanted = false;
        this.setError('Video'); this.status = 'Up to date'; this.views.update();
      } catch (e) { this.jobFailed(job, signal, 'Video', e); }
    });
  }
  /** The timeline view chose a time: the preview moves there. */
  seek(time: number): void {
    this.time = time; this.remember(); this.views.seek(time);
  }
  /** The preview moved: the timeline shows it. */
  position(time: number): void {
    this.time = time; this.remember(); this.views.position(time);
  }
  /** The preview compares other frames with the frame `id`. */
  pin(id: string): void {
    if (this.frame?.media.path !== id) return;
    this.reference = this.frame; this.views.update();
  }
  setLoop(range?: TimeRange): void { this.loop = range; this.views.update(); }
  private remember(): void {
    clearTimeout(this.rememberTimer);
    if (!this.target) return;
    const value = { uri: this.target.uri.toString(), scene: this.target.scene, time: this.time };
    this.rememberTimer = setTimeout(() => { void this.context.workspaceState.update('lastScene', value); }, 200);
  }
  configurationChanged(event: vscode.ConfigurationChangeEvent): void {
    const uri = this.target?.uri;
    if (event.affectsConfiguration('manimCue.autoPreview', uri)) {
      if (this.autoPreview) this.requestVideo(); else if (!this.videoWanted) this.queue.remove('render');
    }
    if (event.affectsConfiguration('manimCue.autoRefreshOnSave', uri) && !vscode.workspace.getConfiguration('manimCue', uri).get('autoRefreshOnSave', true)) this.clearAutoRefresh();
    if (event.affectsConfiguration('python', uri) || ['pythonPath', 'frameRate', 'previewWidth', 'workingDirectory', 'timeoutSeconds'].some(key => event.affectsConfiguration(`manimCue.${key}`, uri))) {
      this.scenes.invalidate(); this.invalidate('Outdated. Refresh to use the new settings.');
    }
    this.views.update();
  }
  async copyPoint(x: number, y: number): Promise<void> {
    await vscode.env.clipboard.writeText(`[${Number(x.toPrecision(6))}, ${Number(y.toPrecision(6))}, 0]`);
  }
  async clearCaches(): Promise<void> {
    if (this.exports.busy) throw new Error('Wait for the export to finish, or cancel it, to clear the caches.');
    this.cancel(false); const generation = this.generation;
    this.pending = this.pending.catch(() => {}).then(async () => {
      await this.queue.whenIdle();
      if (this.disposed || generation !== this.generation) return;
      await fs.rm(path.join(this.scratch, 'cache-v1'), { recursive: true, force: true });
      if (!this.disposed && generation === this.generation) { this.status = 'Caches cleared. Refresh to update.'; this.views.update(); }
    });
    await this.pending;
  }
  private clearAutoRefresh(): void {
    clearTimeout(this.saveTimer); this.saveTimer = undefined; ++this.saveCheck;
  }
  /** Stops all work. Without `preserve`, the results become outdated and the job ends. */
  cancel(preserve = true): void {
    if (preserve) this.exports.cancel();
    this.clearAutoRefresh();
    ++this.generation; this.abort?.abort(); this.videoWanted = false;
    if (!preserve) {
      this.job = undefined;
      for (const result of [this.frame, this.video, this.timeline, ...this.exports.results]) if (result) result.outdated = true;
    }
    this.preparing = false; this.queue.clear(); this.busy = this.queue.busy;
    this.status = 'Cancelled';
    this.views.update();
  }
  invalidate(reason: string, savedHash?: string): void {
    this.exports.invalidate(false, savedHash);
    if (!this.target) return;
    this.cancel(false); this.status = reason; this.views.update();
  }
  async environmentChanged(): Promise<void> {
    this.scenes.invalidate();
    if (!this.target || !this.pythonInUse || vscode.workspace.getConfiguration('manimCue', this.target.uri).get<string>('pythonPath', '').trim()) return;
    const generation = this.generation;
    const resolved = await environmentFor(this.target.uri);
    if (generation === this.generation && resolved.python !== this.pythonInUse) this.invalidate('Outdated. Refresh to use the new Python environment.');
  }
  changed(uri: vscode.Uri): void {
    if (!this.target) return;
    if (uri.toString() === this.target.uri.toString()) {
      this.sourceEdited = true;
      this.invalidate('Outdated. Save the scene file to update.');
    }
    else if (!insideEnvironment(uri.fsPath) &&
      (uri.fsPath.endsWith('.py') || uri.fsPath.endsWith('manim.cfg') || path.basename(uri.fsPath) === '.env')) {
      this.invalidate('Outdated. A project file changed. Refresh to update.');
    }
  }
  async saved(uri: vscode.Uri): Promise<void> {
    if (!this.target || uri.toString() !== this.target.uri.toString()) { this.changed(uri); return; }
    const target = this.target, check = ++this.saveCheck;
    try {
      const hash = await fileHash(uri.fsPath);
      if (this.disposed || this.target !== target || check !== this.saveCheck) return;
      // A disk notification must never run an older saved version under a dirty buffer.
      if (vscode.workspace.textDocuments.some(d => d.uri.toString() === uri.toString() && d.isDirty)) return;
      // Save + file-watcher notifications often describe the same write. Do not cancel
      // a queued/active run for the duplicate, even when the watcher arrives late.
      if (hash === this.diskHash && !this.sourceEdited) return;
      this.diskHash = hash; this.sourceEdited = false;
      const automatic = vscode.workspace.isTrusted && vscode.workspace.getConfiguration('manimCue', uri).get('autoRefreshOnSave', true);
      this.invalidate(automatic ? 'Update queued…' : 'Outdated. Refresh to update.', hash);
      if (!automatic) return;
      const generation = this.generation;
      this.busy = true; this.error = undefined; this.views.update();
      this.saveTimer = setTimeout(() => {
        this.saveTimer = undefined;
        if (this.disposed || this.target !== target || generation !== this.generation) return;
        void this.refresh().catch(e => {
          // Job failures already stay in the panel; preflight failures should too.
          if (this.disposed || generation !== this.generation) return;
          this.busy = false; this.status = 'Update failed';
          this.error = e instanceof Error ? e.message : String(e);
          this.output.appendLine(this.error); this.views.update();
        });
      }, 500);
    } catch (e) {
      if (this.disposed || this.target !== target || check !== this.saveCheck) return;
      this.invalidate('Cannot read the scene file. Save it again to update.');
      this.error = e instanceof Error ? e.message : String(e);
      this.output.appendLine(this.error); this.views.update();
    }
  }
  async navigate(index: number): Promise<void> {
    if (!this.timeline || !this.target) return;
    const result = this.timeline, target = this.target, generation = this.generation;
    const site = result.timeline.entries[index]?.source;
    if (!site?.path) throw new Error('This entry has no source line in the scene folder.');
    if (result.outdated || (await vscode.workspace.openTextDocument(target.uri)).isDirty) throw new Error('The scene file changed. Refresh to update the timeline.');
    const root = path.dirname(await fs.realpath(result.source));
    const file = await fs.realpath(path.resolve(root, site.path));
    const relative = path.relative(root, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('This entry has no source line in the scene folder.');
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    if (doc.isDirty) throw new Error('This file has unsaved changes. Save it and refresh.');
    if (site.line > doc.lineCount) throw new Error('This line is no longer in the file. Refresh to update.');
    if (generation !== this.generation) return;
    await vscode.window.showTextDocument(doc, { viewColumn: target.column ?? vscode.ViewColumn.One, selection: new vscode.Range(site.line - 1, 0, site.line - 1, 0), preserveFocus: false });
  }
  private exportSource(): ExportSource | undefined {
    return this.target && { uri: this.target.uri, scene: this.target.scene, frame: this.frame, video: this.video, timeline: this.timeline, job: this.job };
  }
  async openExport(): Promise<void> {
    if (!this.target) { void vscode.window.showInformationMessage('Open a scene to export.'); return; }
    this.exports.requestOpen = true; await this.views.open(); this.views.update();
  }
  failAction(e: unknown): void { if (!this.disposed) void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e)); }
  /** Removes the run folders and media files that no result and no export uses. */
  private async cleanup(): Promise<void> {
    const idle = () => !this.queue.busy && !this.preparing && !this.exports.busy;
    if (!idle()) return;
    // Recompute after each await: a job or an export can start meanwhile.
    const results = () => [this.frame, this.video, this.timeline, this.reference];
    const keep = () => new Set([...this.exports.directories, this.job?.directory, ...results().map(r => r?.directory)]);
    const media = () => new Set([...this.exports.files, this.frame?.media.path, this.video?.media.path, this.reference?.media.path]);
    try {
      for (const file of await fs.readdir(this.mediaRoot).catch(() => [] as string[])) {
        if (!idle()) return;
        const full = path.join(this.mediaRoot, file);
        if (!media().has(full)) await fs.rm(full, { force: true });
      }
      for (const entry of await fs.readdir(this.scratch, { withFileTypes: true })) {
        if (!idle()) return;
        const dir = path.join(this.scratch, entry.name);
        if (!entry.isDirectory() || !entry.name.startsWith('run-')) continue;
        if (!keep().has(dir)) await fs.rm(dir, { recursive: true, force: true });
        else for (const file of await fs.readdir(path.join(dir, 'media'))) {
          if (!idle()) return;
          const full = path.join(dir, 'media', file);
          if (!media().has(full)) await fs.rm(full, { force: true });
        }
      }
    } catch { /* Best effort (e.g. a media handle is still being released). */ }
  }
  async whenIdle(): Promise<void> { await this.pending; await this.queue.whenIdle(); await this.exports.whenIdle(); }
  dispose(): void {
    clearTimeout(this.rememberTimer);
    if (this.target) void this.context.workspaceState.update('lastScene', { uri: this.target.uri.toString(), scene: this.target.scene, time: this.time });
    this.clearAutoRefresh(); this.exports.dispose(); this.disposed = true; ++this.generation; this.abort?.abort();
    this.queue.clear(); this.scenes.dispose(); this.views.dispose();
  }
}
