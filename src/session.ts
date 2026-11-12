import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { environmentFor, PythonNotFound, sceneJob } from './environment';
import { RuntimeUnavailable } from './diagnostics';
import { Scenes } from './scenes';
import { inspect, renderPreview, publishPreview, fileHash, NotebookError, type TimelineResult, type PreviewResult, type SceneJob } from './jobs';
import { codeHash, isDirty, isNotebook, locate, markCell, notebookOfCell, save, showCell, editorCells, type CellMode, type Problem, type ProblemAction } from './notebook';
import { PreviewQueue } from './preview-queue';
import type { TimeRange } from './selection';
import { Views } from './views';
import { copied } from './measurement';
import { Exports, type ExportSource } from './exports';
import { SourceWatch } from './source-watch';
import { model, receive } from './panel';

type Topic = 'Frame' | 'Timeline' | 'Video';
const failures: Record<Topic, string> = { Frame: 'The frame update', Timeline: 'The timeline update', Video: 'The video render' };

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
  /** The error comes from the Python environment: "Check Python" helps. */
  pythonProblem = false;
  readonly extensionId: string;
  readonly views: Views;
  readonly scenes: Scenes;
  readonly exports: Exports;
  readonly watch = new SourceWatch({
    file: () => this.target?.uri,
    dirty: uri => isDirty(uri as vscode.Uri),
    hash: uri => this.target && isNotebook(uri) ? this.savedHash(this.target) : undefined,
    automatic: uri => vscode.workspace.isTrusted && vscode.workspace.getConfiguration('manimCue', uri as vscode.Uri).get('autoRefreshOnSave', true),
    invalidate: (reason, savedHash) => this.invalidate(reason, savedHash),
    // A running update of the saved file goes on; its results are outdated too.
    edited: () => {
      this.exports.invalidate(false); this.videoWanted = false;
      for (const result of [this.frame, this.video, this.timeline, ...this.exports.results]) if (result) result.outdated = true;
      this.status = 'Outdated. Save the scene file to update.'; this.views.update();
    },
    queued: () => { this.busy = true; this.error = undefined; this.views.update(); },
    refresh: () => this.refresh(),
    failed: (status, e) => {
      if (this.disposed) return;
      this.busy = false; this.status = status; this.error = e instanceof Error ? e.message : String(e);
      this.output.appendLine(this.error); this.views.update();
    },
  });
  /** Increments to stop the async work of an older refresh. */
  private generation = 0;
  private opening = 0;
  private abort?: AbortController;
  private pending: Promise<void> = Promise.resolve();
  private preparing = false;
  /** "Render video" or Play asked for a video; the render can wait for the timeline. */
  videoWanted = false;
  private errors = new Map<string, string>();
  /** The notebook problem of the last failed run, with the cell mode of that run. */
  problem?: { problem: Problem; mode: CellMode };
  private notebookTimer?: ReturnType<typeof setTimeout>;
  private notebookCheck = 0;
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
      () => this.queue.suspend(), text => { if (!this.disposed) this.output.append(text); }, source => this.savedHash(source));
    this.scenes = new Scenes(vscode.Uri.joinPath(context.extensionUri, 'python').fsPath);
    this.views = new Views(context.extensionUri, [vscode.Uri.file(this.mediaRoot)],
      (m, origin) => { void receive(this, m, origin).catch(e => this.failAction(e)); }, (webview, view, sent) => model(this, webview, view, sent),
      () => {
        // Without the preview, frames and videos have no use.
        const rendering = this.queue.running('render');
        this.queue.remove('frame'); this.queue.remove('render'); this.videoWanted = false;
        this.reference = undefined; this.exports.close();
        if (rendering) { this.done(); this.views.update(); }
      });
  }
  get autoRender(): boolean {
    return vscode.workspace.getConfiguration('manimCue', this.target?.uri).get('renderVideoAutomatically', true);
  }
  async open(uri?: vscode.Uri, scene?: string): Promise<void> {
    const opening = ++this.opening;
    if (!vscode.workspace.isTrusted) { await vscode.window.showWarningMessage('Trust this workspace to run Manim scenes.'); return; }
    const remembered = this.context.workspaceState.get<{ uri: string; scene: string; time: number }>('lastScene');
    let source = uri;
    if (!source) {
      const active = vscode.window.activeTextEditor?.document;
      const notebook = vscode.window.activeNotebookEditor?.notebook ?? (active && notebookOfCell(active));
      source = notebook?.uri ?? (active?.languageId === 'python' ? active.uri : undefined);
      if (!source && remembered) { source = vscode.Uri.parse(remembered.uri); scene ??= remembered.scene; }
    }
    const python = source && !isNotebook(source) && (await vscode.workspace.openTextDocument(source)).languageId === 'python';
    if (opening !== this.opening) return;
    if (!source || source.scheme !== 'file' || !python && !isNotebook(source)) throw new Error('Open a Python file or a notebook on this computer first.');
    const document = { uri: source };
    if (isDirty(source)) {
      if (await vscode.window.showWarningMessage('Manim Cue runs the saved file. Save it now?', 'Save and Run') !== 'Save and Run') return;
      if (!await save(source)) return;
    }
    if (!scene && remembered?.uri === document.uri.toString()) scene = remembered.scene;
    scene ??= await this.scenes.pick(source);
    if (!scene || opening !== this.opening) return;
    if (!/^[\p{ID_Start}_][\p{ID_Continue}]*$/u.test(scene)) throw new Error('Enter the name of a Python class.');
    const different = !this.target || this.target.uri.toString() !== document.uri.toString() || this.target.scene !== scene;
    this.exports.invalidate(true); this.exports.close();
    this.cancel(false);
    if (different) {
      this.frame = this.video = this.timeline = this.reference = this.loop = undefined;
      this.watch.reset();
      const time = remembered?.uri === document.uri.toString() && remembered.scene === scene ? remembered.time : 0;
      this.time = Number.isFinite(time) && time >= 0 ? time : 0;
    }
    const editors = [...vscode.window.visibleTextEditors.map(e => ({ uri: e.document.uri, column: e.viewColumn })),
      ...vscode.window.visibleNotebookEditors.map(e => ({ uri: e.notebook.uri, column: e.viewColumn }))];
    this.target = { uri: document.uri, scene, column: editors.find(e => e.uri.toString() === document.uri.toString())?.column };
    this.remember();
    await this.views.open();
    if (opening === this.opening) await this.refresh();
  }
  async refresh(frame = true): Promise<void> {
    // A save notification that is still on the way must not cancel this update.
    this.watch.stop();
    if (!this.target) { await this.open(); return; }
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace to run the scene.');
    const target = this.target, intent = this.generation;
    let hash: string;
    try { hash = await this.savedHash(target); } catch (e) {
      // The hash of a notebook needs Python: show its errors like those of the update.
      if (!isNotebook(target.uri) || this.target !== target || intent !== this.generation || this.disposed) throw e;
      this.cancel(false); this.updateFailed(e); return;
    }
    if (this.target !== target || intent !== this.generation || this.disposed) return;
    if (isDirty(target.uri)) { this.invalidate('Outdated. Save the scene file to update.'); throw new Error('Save the scene file to update.'); }
    const videoWanted = this.videoWanted;
    this.cancel(false);
    this.watch.updating(hash); this.videoWanted = videoWanted;
    const generation = this.generation, abort = new AbortController(); this.abort = abort;
    this.preparing = true; this.busy = true; this.error = undefined; this.errors.clear(); this.pythonProblem = false; this.problem = undefined;
    this.status = 'Starting Python…'; this.views.update();
    const current = () => generation === this.generation && !abort.signal.aborted && !this.disposed;
    this.pending = this.pending.catch(() => {}).then(async () => {
      await this.queue.whenIdle();
      if (!current()) return;
      try {
        this.output.appendLine(`\n── ${target.scene} · ${path.basename(target.uri.fsPath)} · generation ${generation} ──`);
        const { job, environment, cwd } = await sceneJob(target.uri, target.scene, { scratch: this.scratch, sourceHash: hash, cells: this.cells(target.uri),
          helpers: vscode.Uri.joinPath(this.context.extensionUri, 'python').fsPath, signal: abort.signal, log: s => { if (!this.disposed) this.output.append(s); } });
        if (!current()) return;
        this.pythonInUse = environment.python;
        this.output.appendLine(`Python: ${environment.python}\nSelection: ${environment.selection}\nSource: ${target.uri.fsPath}\nWorking directory: ${cwd}`);
        this.job = job;
        this.requestTimeline(frame);
      } catch (e) {
        if (!current()) return;
        this.updateFailed(e);
      }
      finally { if (current()) { this.preparing = false; this.busy = this.queue.busy; this.views.update(); } }
    });
    await this.whenIdle();
  }
  private updateFailed(e: unknown): void {
    this.error = e instanceof Error ? e.message : String(e); this.status = 'Update failed'; this.pythonProblem = e instanceof PythonNotFound;
    this.output.appendLine(this.error); this.views.update();
  }
  /** Which cells of a notebook run; remembered for each notebook in this workspace. */
  cells(uri: vscode.Uri): CellMode {
    return this.context.workspaceState.get<Record<string, CellMode>>('cellModes', {})[uri.toString()] === 'allAbove' ? 'allAbove' : 'needed';
  }
  async setCells(mode: CellMode): Promise<void> {
    if (!this.target || !isNotebook(this.target.uri) || mode === this.cells(this.target.uri)) return;
    const modes = { ...this.context.workspaceState.get<Record<string, CellMode>>('cellModes', {}) };
    if (mode === 'needed') delete modes[this.target.uri.toString()]; else modes[this.target.uri.toString()] = mode;
    await this.context.workspaceState.update('cellModes', modes);
    // The user asked for it, and nothing must be saved: update at once.
    if (isDirty(this.target.uri)) { this.invalidate('Outdated. Save the scene file to update.'); return; }
    await this.refresh();
  }
  private helpers(): string { return vscode.Uri.joinPath(this.context.extensionUri, 'python').fsPath; }
  /** The hash of the saved source of a run: of the file, or of the code that a notebook run executes. */
  private async savedHash(target: { uri: vscode.Uri; scene: string }): Promise<string> {
    if (!isNotebook(target.uri)) return fileHash(target.uri.fsPath);
    return codeHash(await environmentFor(target.uri), this.helpers(), target.scene, this.cells(target.uri), { path: target.uri.fsPath });
  }
  /**
   * A notebook changed in the editor. Only a change of the code that the run executes
   * makes the results outdated: not outputs, execution counts or the cells that it skips.
   */
  notebookChanged(event: vscode.NotebookDocumentChangeEvent): void {
    const target = this.target;
    if (!target || event.notebook.uri.toString() !== target.uri.toString()) return;
    if (!event.contentChanges.length && !event.cellChanges.some(change => change.document)) return;
    clearTimeout(this.notebookTimer);
    const check = ++this.notebookCheck;
    this.notebookTimer = setTimeout(() => {
      void (async () => {
        const hash = await codeHash(await environmentFor(target.uri), this.helpers(), target.scene, this.cells(target.uri), { cells: editorCells(event.notebook) });
        if (check !== this.notebookCheck || this.target !== target) return;
        if (hash !== this.watch.updated) await this.watch.edit(target.uri);
        // An undo back to the saved code: as for a file, update that code.
        else if (this.watch.edited && !event.notebook.isDirty) await this.watch.saved(target.uri);
      })().catch(e => this.output.appendLine(`Could not check the notebook: ${e instanceof Error ? e.message : e}`));
    }, 250);
  }
  /** An action for the notebook problem of the last failed run. */
  async problemAction(action: ProblemAction): Promise<void> {
    const target = this.target, found = this.problem?.problem;
    if (!target || !found) return;
    if (action === 'runAllAbove') { await this.setCells('allAbove'); return; }
    const cell = found.cell ?? found.location;
    if (!cell) return;
    if (action === 'runCell') await markCell(target.uri, cell, target.column);
    else await showCell(target.uri, cell, found.cell ? 1 : found.location!.line, target.column);
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
    const what = failures[topic];
    this.status = `${what} failed`;
    this.setError(topic, `${what} failed: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof NotebookError) this.problem = { problem: error.problem, mode: job.options.cells ?? 'needed' };
    if (topic !== 'Frame') this.videoWanted = false;
    // A Python executable that does not start, for example a deleted environment.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') this.pythonProblem = true;
    if (error instanceof RuntimeUnavailable) {
      this.pythonProblem = true;
      this.job = undefined;
      this.queue.clear(); // Do not repeat the same failed check for queued jobs.
      this.status = 'Python environment not ready';
      this.setError(topic, error.message);
    }
    this.output.appendLine(`\n${this.error}`); this.views.update();
  }
  /** The status after a job: an earlier failure or unsaved edits stay visible. */
  private done(): void {
    const failed = (['Timeline', 'Video', 'Frame'] as const).find(topic => this.errors.has(topic));
    this.status = this.watch.edited ? 'Outdated. Save the scene file to update.' : failed ? `${failures[failed]} failed` : 'Up to date';
  }
  private async publishFrame(job: SceneJob, signal: AbortSignal, result: PreviewResult): Promise<void> {
    const published = await publishPreview(result, this.mediaRoot);
    if (!this.current(job, signal)) return;
    published.outdated = this.watch.edited;
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
        // The loop belongs to the selection of the old timeline, also when the timeline view is hidden.
        if (result.timeline!.directory !== this.timeline?.directory) this.loop = undefined;
        this.timeline = result.timeline!; this.timeline.outdated = this.watch.edited;
        this.setError('Timeline'); this.done(); this.views.update();
        if (frame && this.autoRender || this.videoWanted) this.requestVideo();
      } catch (e) { this.jobFailed(job, signal, 'Timeline', e); }
    });
  }
  /** The preview has no current result for `time`. A newer request replaces this one. */
  requestFrame(time: number): void {
    this.time = time; this.remember();
    const job = this.job;
    if (!job || !this.views.previewOpen || this.watch.edited) return;
    this.queue.enqueue('frame', async signal => {
      // A frame of this job is the result, also when an unsaved edit made it outdated.
      if (!this.current(job, signal) || this.frame?.directory === job.directory && this.frame.media.capture?.requestedTime === time) return;
      this.status = 'Updating frame…'; this.views.update();
      try {
        await inspect(job, { time, timeline: false }, signal, frame => this.current(job, signal) ? this.publishFrame(job, signal, frame) : undefined);
        if (this.current(job, signal)) { this.done(); this.views.update(); }
      } catch (e) { this.jobFailed(job, signal, 'Frame', e); }
    }, 100); // Scrubbing sends many requests: start when they pause.
  }
  async renderVideo(): Promise<void> {
    this.videoWanted = true;
    if (!this.views.previewOpen) await this.views.open();
    if (!this.job) await this.refresh(); else this.requestVideo();
    await this.whenIdle();
  }
  /** The preview webview starts, also after it was closed: render the video if it is missing. */
  previewReady(): void { if (this.autoRender) this.requestVideo(); }
  /** Renders the video for the preview after the timeline, unless the scene has no plays or waits. */
  private requestVideo(): void {
    const job = this.job, timeline = this.timeline;
    if (!job || !timeline || timeline.outdated || !this.views.previewOpen || this.queue.running('render')) return;
    if (this.video && !this.video.outdated) { this.videoWanted = false; return; }
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
        this.video.outdated = this.timeline.outdated = this.watch.edited;
        this.setError('Video'); this.done(); this.views.update();
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
    if (event.affectsConfiguration('manimCue.renderVideoAutomatically', uri)) {
      if (this.autoRender) this.requestVideo(); else if (!this.videoWanted) this.queue.remove('render');
    }
    if (event.affectsConfiguration('manimCue.autoRefreshOnSave', uri) && !vscode.workspace.getConfiguration('manimCue', uri).get('autoRefreshOnSave', true)) this.watch.stop();
    if (event.affectsConfiguration('python', uri) || ['pythonPath', 'frameRate', 'previewWidth', 'workingDirectory', 'timeoutSeconds'].some(key => event.affectsConfiguration(`manimCue.${key}`, uri))) {
      this.scenes.invalidate(); this.invalidate('Outdated. Refresh to use the new settings.');
    }
    this.views.update();
  }
  async copyPoint(x: number, y: number): Promise<void> {
    await vscode.env.clipboard.writeText(`[${copied(x)}, ${copied(y)}, 0]`);
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
  /** Stops all work. Without `preserve`, the results become outdated and the job ends. */
  cancel(preserve = true): void {
    if (preserve) this.exports.cancel();
    this.watch.stop();
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
  async navigate(index: number): Promise<void> {
    if (!this.timeline || !this.target) return;
    const result = this.timeline, target = this.target, generation = this.generation;
    const site = result.timeline.entries[index]?.source;
    if (!site?.path) throw new Error('This entry has no source line in the scene folder.');
    if (isNotebook(target.uri)) {
      if (result.outdated) throw new Error('The notebook changed. Refresh to update the timeline.');
      const cell = await locate(result.directory, site.path, site.line);
      if (!cell) throw new Error('This entry has no source line in the notebook.');
      if (generation === this.generation) await showCell(target.uri, cell, cell.line, target.column);
      return;
    }
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
    return this.target && { uri: this.target.uri, scene: this.target.scene, frame: this.frame, video: this.video, timeline: this.timeline, job: this.job, time: this.time,
      cells: isNotebook(this.target.uri) ? this.cells(this.target.uri) : undefined };
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
    clearTimeout(this.rememberTimer); clearTimeout(this.notebookTimer);
    if (this.target) void this.context.workspaceState.update('lastScene', { uri: this.target.uri.toString(), scene: this.target.scene, time: this.time });
    this.watch.dispose(); this.exports.dispose(); this.disposed = true; ++this.generation; this.abort?.abort();
    this.queue.clear(); this.scenes.dispose(); this.views.dispose();
  }
}
