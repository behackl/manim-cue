import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { environmentFor, workingDirectoryFor } from './environment';
import { RuntimeUnavailable } from './diagnostics';
import { copyExport, validateDestination } from './export-files';
import { Scenes } from './scenes';
import { insideEnvironment } from './setup-plan';
import { createJob, inspect, renderPreview, publishPreview, fileHash, type TimelineResult, type PreviewResult, type SceneJob } from './jobs';
import { PreviewQueue } from './preview-queue';
import { frameIndex, videoFrameIndex, videoFrames } from './transport';
import { selectEvents, selectionRange, videoLoop, type SelectionMode, type TimeRange } from './selection';
import { isCall } from './timeline';
import { Views } from './views';
import { Exports, type ExportSource } from './exports';
import { model, receive } from './panel';

/**
 * The open Scene: its jobs, its results (frame, timeline, video) and the state of the
 * preview. Fields without `private` are read by the panel; only this class changes them.
 */
export class Session implements vscode.Disposable {
  generation = 0;
  target?: { uri: vscode.Uri; scene: string; column?: vscode.ViewColumn };
  job?: SceneJob;
  /** The media offered to the preview: a frame or the video. */
  preview?: PreviewResult;
  video?: PreviewResult;
  timeline?: TimelineResult;
  /** Offered media by path, until the preview acknowledges a newer one. */
  readonly retained = new Map<string, PreviewResult>();
  displayed?: string;
  comparing = false;
  reference?: PreviewResult;
  pinRequest?: { sequence: number; token?: string };
  selected?: number;
  selectedEvents: number[] = [];
  loopEnabled = false;
  status = 'Open a Python Scene to inspect its execution.';
  error?: string;
  busy = false;
  autoPreview = true;
  seekSequence = 0;
  frameSequence = -1;
  desiredTime = 0;
  playbackTime?: number;
  playIntent?: number;
  positionClamped = false;
  mediaError?: string;
  pythonInUse?: string;
  readonly extensionId: string;
  readonly views: Views;
  readonly scenes: Scenes;
  readonly exports: Exports;
  private opening = 0;
  private abort?: AbortController;
  private pending: Promise<void> = Promise.resolve();
  private references = new Map<string, PreviewResult>();
  private displayedReference?: string;
  private displaySequence = -1;
  private playbackSequence = -1;
  private lastInteraction = 0;
  private playSequence = 0;
  private preparing = false;
  private selectionAnchor?: number;
  private phaseErrors = new Map<string, string>();
  private frameStarted = 0;
  private displayTiming?: { token: string; started: number; produced: number };
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
      (m, origin) => { void receive(this, m, origin).catch(e => this.failAction(e)); }, webview => model(this, webview), () => {
        this.queue.remove('render'); this.playIntent = undefined;
        this.preview = undefined; this.displayed = undefined; this.retained.clear();
        this.exports.close(); this.clearComparison(); this.views.update(); void this.cleanup();
      });
  }
  /** The video, if it shows the current source. */
  currentVideo(): PreviewResult | undefined { return this.video && !this.video.outdated ? this.video : undefined; }
  /** The offered media is current and, for a frame, at the selected time. */
  mediaReady(): boolean {
    const p = this.preview;
    return !!p && !p.outdated && (!p.media.capture || this.frameSequence === this.seekSequence) && !this.mediaError;
  }
  /** The selected range of plays and waits; a current video can loop it only on its frame boundaries. */
  selection(): { range: TimeRange; available: boolean; loop?: TimeRange } | undefined {
    const t = this.timeline, range = t && selectionRange(t.timeline.entries, this.selectedEvents);
    if (!range) return;
    const video = this.currentVideo()?.media;
    const loop = video && videoLoop(range, video.rate, videoFrames(video.duration, video.rate));
    return { range, available: !t.outdated && (!video || !!loop), loop };
  }
  async open(uri?: vscode.Uri, scene?: string): Promise<void> {
    const opening = ++this.opening;
    if (!vscode.workspace.isTrusted) { await vscode.window.showWarningMessage('Trust this workspace to discover or execute Manim scenes.'); return; }
    const remembered = this.context.workspaceState.get<{ uri: string; scene: string; time: number }>('lastScene');
    let document = uri ? await vscode.workspace.openTextDocument(uri) : vscode.window.activeTextEditor?.document;
    if (!uri && document?.languageId !== 'python' && remembered) {
      document = await vscode.workspace.openTextDocument(vscode.Uri.parse(remembered.uri));
      scene ??= remembered.scene;
    }
    if (opening !== this.opening) return;
    if (!document || document.uri.scheme !== 'file' || document.languageId !== 'python') throw new Error('Open a saved local Python file first.');
    if (document.isDirty) {
      if (await vscode.window.showWarningMessage('Manim Cue executes saved files. Save this file and run?', 'Save and Run') !== 'Save and Run') return;
      if (!await document.save()) return;
    }
    if (!scene && remembered?.uri === document.uri.toString()) scene = remembered.scene;
    if (!scene) {
      const candidates = await this.scenes.candidates(document);
      if (opening !== this.opening) return;
      scene = candidates.length === 1 ? candidates[0].name : await vscode.window.showQuickPick([...candidates.map(c => c.name), 'Enter scene name…'], { placeHolder: 'Select a Scene (custom/imported bases may need a name)' });
      if (scene === 'Enter scene name…') scene = await vscode.window.showInputBox({ prompt: 'Top-level Scene class name' });
    }
    if (!scene || opening !== this.opening) return;
    if (!/^[\p{ID_Start}_][\p{ID_Continue}]*$/u.test(scene)) throw new Error('Enter a Python class name, not a command or expression.');
    const different = !this.target || this.target.uri.toString() !== document.uri.toString() || this.target.scene !== scene;
    this.exports.invalidate('Scene reopened — export cancelled.', true); this.exports.close();
    this.cancel(false);
    if (different) {
      this.clearComparison(); this.selectedEvents = []; this.selectionAnchor = undefined; this.selected = undefined;
      this.displayed = undefined; this.retained.clear(); this.timeline = undefined; this.preview = undefined; this.video = undefined;
      this.diskHash = undefined; this.sourceEdited = false; this.desiredTime = 0; this.playbackTime = undefined; this.positionClamped = false;
    }
    if (different && remembered?.uri === document.uri.toString() && remembered.scene === scene && Number.isFinite(remembered.time) && remembered.time >= 0) this.desiredTime = remembered.time;
    this.target = { uri: document.uri, scene, column: vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === document.uri.toString())?.viewColumn };
    this.remember();
    this.autoPreview = vscode.workspace.getConfiguration('manimCue', document.uri).get('autoPreview', true);
    await this.views.open();
    if (opening === this.opening) await this.refresh();
  }
  async refresh(frame = true, started = performance.now()): Promise<void> {
    this.clearAutoRefresh();
    if (!this.target) { await this.open(); return; }
    if (!vscode.workspace.isTrusted) throw new Error('Workspace trust is required.');
    const target = this.target, intent = this.generation;
    const document = await vscode.workspace.openTextDocument(target.uri);
    const hash = await fileHash(target.uri.fsPath);
    if (this.target !== target || intent !== this.generation || this.disposed) return;
    if (document.isDirty) { this.invalidate('Unsaved source — save to refresh'); throw new Error('Save the Python file before refreshing.'); }
    this.cancel(false);
    this.diskHash = hash; this.sourceEdited = false; this.lastInteraction = Date.now(); this.frameStarted = started;
    const generation = this.generation, abort = new AbortController(); this.abort = abort;
    this.preparing = true; this.busy = true; this.error = undefined; this.phaseErrors.clear();
    this.status = 'Resolving Python environment…'; this.views.update();
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
        if (!(fps >= 1 && fps <= 120 && width >= 64 && width <= 3840 && timeout >= 5 && timeout <= 7200)) throw new Error('Invalid Manim Cue frame rate, resolution or timeout setting.');
        this.output.appendLine(`Python: ${environment.python}\nSelection: ${environment.selection}\nSource: ${target.uri.fsPath}\nWorking directory: ${cwd}`);
        const job = await createJob({ ...environment, source: target.uri.fsPath, scene: target.scene, cwd, fps, width,
          timeout: timeout * 1000, scratch: this.scratch, helpers: vscode.Uri.joinPath(this.context.extensionUri, 'python').fsPath,
          signal: abort.signal, log: s => { if (!this.disposed) this.output.append(s); } });
        if (!current()) return;
        this.job = job;
        this.requestInspection(0, frame);
      } catch (e) { if (current()) { this.error = String(e); this.status = 'Refresh failed'; this.output.appendLine(this.error); } }
      finally { if (current()) { this.preparing = false; this.busy = this.queue.busy; this.views.update(); } }
    });
    await this.whenIdle();
  }
  private current(job: SceneJob, signal?: AbortSignal): boolean {
    return this.job === job && !this.disposed && !signal?.aborted;
  }
  private phaseError(phase: string, error?: unknown): void {
    if (error === undefined) this.phaseErrors.delete(phase);
    else this.phaseErrors.set(phase, error instanceof Error ? error.message.slice(-5000) : String(error));
    this.error = [...this.phaseErrors].map(([name, message]) => `${name}: ${message}`).join('\n') || undefined;
  }
  private jobFailed(job: SceneJob, signal: AbortSignal, phase: string, error: unknown): void {
    if (!this.current(job, signal)) return;
    this.phaseError(phase, error);
    if (phase === 'Movie' || phase === 'Timeline') this.playIntent = undefined;
    if (phase === 'Frame capture' || phase === 'Timeline') this.pinRequest = undefined;
    this.status = `${phase} failed — completed results retained`;
    if (error instanceof RuntimeUnavailable) {
      this.job = undefined; this.pinRequest = undefined; this.playIntent = undefined;
      this.queue.clear(); // Do not repeat the same failed import/capability check for queued jobs.
      this.status = 'Preview unavailable — Check Python, then Refresh';
    }
    this.output.appendLine(`\n${this.status}: ${this.error}`); this.views.update();
  }
  private offer(result: PreviewResult): void {
    this.retained.set(result.media.path, result); this.preview = result;
    this.playbackSequence = -1; this.playbackTime = undefined; this.mediaError = undefined;
    this.views.update();
  }
  /**
   * One evaluation gives the frame at the selected time and, if the job has no current
   * timeline yet, the timeline. Without a timeline, the process ends after the frame.
   */
  private requestInspection(delay = 0, frame = true): void {
    const job = this.job;
    if (!job) return;
    if (frame && this.views.previewOpen) this.status = `Updating frame at ${this.desiredTime.toFixed(3)} s…`;
    this.queue.enqueue('inspect', async signal => {
      const sequence = this.seekSequence, time = this.desiredTime, started = this.frameStarted;
      const capture = frame && this.views.previewOpen, timeline = !this.timeline || this.timeline.outdated;
      if (!this.current(job, signal) || !capture && !timeline) return;
      const phase = timeline ? 'Timeline' : 'Frame capture';
      this.status = timeline ? 'Evaluating scene timeline…' : `Capturing frame at ${time.toFixed(3)} s…`; this.views.update();
      try {
        const result = await inspect(job, { time: capture ? time : undefined, timeline }, signal, async frame => {
          if (!this.current(job, signal) || sequence !== this.seekSequence) return;
          const published = await publishPreview(frame, this.mediaRoot);
          if (!this.current(job, signal) || sequence !== this.seekSequence) return;
          this.phaseError('Frame capture');
          this.displayTiming = { token: published.media.path, started, produced: performance.now() };
          if (this.pinRequest?.sequence === sequence) this.pinRequest.token = published.media.path;
          this.frameSequence = sequence; this.offer(published);
          this.status = timeline ? 'Evaluating scene timeline…' : published.media.capture?.time === null ? 'End-state snapshot ready' : 'Current frame ready';
          this.views.update();
        });
        if (!this.current(job, signal)) return;
        if (result.timeline) {
          this.timeline = result.timeline; this.selected = undefined; this.selectedEvents = []; this.selectionAnchor = undefined; this.loopEnabled = false;
          this.phaseError('Timeline'); this.status = 'Timeline ready'; this.views.update();
        }
        if ((frame && this.autoPreview) || this.playIntent !== undefined) this.requestVideo(this.playIntent !== undefined);
      } catch (e) { this.jobFailed(job, signal, phase, e); }
    }, delay);
  }
  private showVideo(video: PreviewResult): void {
    if (this.comparing) return;
    const fps = video.media.rate, frames = videoFrames(video.media.duration, fps);
    if (this.desiredTime >= frames / fps) {
      this.desiredTime = (frames - 1) / fps;
      ++this.seekSequence; this.positionClamped = true;
    }
    this.offer(video);
  }
  async renderVideo(): Promise<void> {
    this.comparing = false; this.pinRequest = undefined;
    if (!this.views.previewOpen) await this.views.open();
    if (!this.job || !this.timeline || this.timeline.outdated) await this.refresh();
    this.requestVideo(true); await this.whenIdle();
  }
  /** Renders the video after the frame and the timeline of the job, unless the scene is static. */
  private requestVideo(immediate = false): void {
    if (this.comparing || !this.views.previewOpen || this.queue.running('render')) return;
    const job = this.job, timeline = this.timeline;
    if (!job || !timeline || timeline.outdated) return;
    if (!immediate && (!this.preview || this.preview.outdated)) return;
    const video = this.currentVideo();
    if (video) { this.showVideo(video); return; }
    if (timeline.timeline.duration === 0) {
      this.playIntent = undefined; this.status = 'Static scene snapshot'; this.views.update(); return;
    }
    this.queue.enqueue('render', async signal => {
      if (!this.current(job, signal)) return;
      this.status = 'Rendering complete movie…'; this.views.update();
      try {
        const result = await renderPreview(job, signal);
        if (!this.current(job, signal)) return;
        const published = await publishPreview(result.video, this.mediaRoot);
        if (!this.current(job, signal)) return;
        // The render's timeline describes the video; selections keep their entry indices.
        this.phaseError('Movie'); this.video = published; this.timeline = result.timeline;
        if (this.loopEnabled && !this.selection()?.available) {
          this.loopEnabled = false; this.playIntent = undefined;
          this.phaseError('Loop', 'The selected interval cannot be mapped to this movie’s frames. Choose another interval.');
        }
        this.showVideo(published); this.status = 'Preview ready';
      } catch (e) { this.jobFailed(job, signal, 'Movie', e); }
    }, immediate ? 0 : Math.max(0, this.lastInteraction + 1500 - Date.now()));
  }
  seek(time: number, immediate = false): void {
    if (!this.target || !Number.isFinite(time) || this.disposed) return;
    this.desiredTime = Math.max(0, time); this.playIntent = undefined; this.pinRequest = undefined;
    this.positionClamped = false; ++this.seekSequence; this.lastInteraction = Date.now(); this.frameStarted = performance.now();
    this.remember();
    if (!this.autoPreview) this.queue.remove('render');
    const video = this.currentVideo();
    if (!this.comparing && video) this.showVideo(video);
    else this.requestInspection(immediate ? 0 : 150);
    this.views.update();
  }
  step(direction: -1 | 1): void {
    if (!this.target || !this.job) return;
    const fps = this.job.options.fps, video = this.currentVideo()?.media;
    const count = video ? videoFrames(video.duration, fps) : Number.MAX_SAFE_INTEGER;
    const index = video && this.playbackTime !== undefined ? videoFrameIndex(this.playbackTime, fps, count) : frameIndex(this.desiredTime, fps, count);
    this.seek(Math.max(0, Math.min(count - 1, index + direction)) / fps);
  }
  play(): void {
    this.comparing = false; this.pinRequest = undefined;
    const selection = this.loopEnabled ? this.selection() : undefined;
    if (selection?.available && (this.desiredTime < selection.range.start || this.desiredTime >= selection.range.end)) this.seek(selection.range.start);
    this.playIntent = ++this.playSequence; this.requestVideo(true); this.views.update();
  }
  pause(): void {
    this.playIntent = undefined; this.remember(); if (!this.autoPreview) this.queue.remove('render'); this.views.update();
  }
  /** The preview reports the presented position of the video. */
  playback(token: string, request: number, time: number, currentTime: number | undefined, playing: boolean | undefined, sequence: number): void {
    if (token !== this.preview?.media.path || request !== this.seekSequence || !this.mediaReady() || sequence <= this.playbackSequence) return;
    this.playbackSequence = sequence;
    const { duration, rate } = this.preview.media, frames = videoFrames(duration, rate);
    if (time < 0 || time > duration + 0.01) return;
    this.playbackTime = videoFrameIndex(time, rate, frames) / rate;
    if (playing === true && currentTime !== undefined) this.desiredTime = Math.max(0, Math.min(currentTime, (frames - 1) / rate));
    if (playing === false) this.remember();
    this.views.position(this.generation, this.playbackTime);
  }
  /** The preview shows `token`: pin a requested reference and release older media. */
  async presented(token: string, request: number, sequence: number): Promise<void> {
    if (!this.retained.has(token) || sequence <= this.displaySequence) return;
    this.displaySequence = sequence; this.displayed = token;
    if (this.comparing && this.pinRequest?.sequence === this.seekSequence && this.pinRequest.token === token &&
      request === this.seekSequence && this.mediaReady()) {
      this.pin(this.retained.get(token)!); this.views.update();
    }
    if (token === this.preview?.media.path) {
      for (const key of this.retained.keys()) if (key !== token) this.retained.delete(key);
      if (request === this.seekSequence && this.preview.media.capture && this.mediaReady()) this.playbackTime = this.preview.media.capture.time ?? undefined;
      if (this.displayTiming?.token === token && request === this.seekSequence && this.mediaReady()) {
        const now = performance.now(), t = this.displayTiming;
        this.output.appendLine(`[Cue timing] Current frame visible: ${((now - t.started) / 1000).toFixed(3)} s; browser load/swap: ${((now - t.produced) / 1000).toFixed(3)} s`);
        this.displayTiming = undefined;
      }
    }
    if (!this.queue.busy) await this.cleanup();
  }
  mediaFailed(token: string, message: string): void {
    if (token !== this.preview?.media.path) return;
    this.playIntent = undefined;
    if (this.pinRequest?.token === token) this.pinRequest = undefined;
    const previous = this.displayed ? this.retained.get(this.displayed) : undefined;
    if (this.video?.media.path === token) this.video = undefined;
    if (previous && previous.media.path !== token) {
      this.preview = previous; this.error = `Replacement preview failed: ${message.slice(0, 300)}`;
      this.status = 'Keeping previous preview';
    } else this.mediaError = `Preview unavailable: ${message.slice(0, 300)}`;
    this.views.update();
  }
  async referencePresented(token: string): Promise<void> {
    if (token !== this.reference?.media.path) return;
    this.displayedReference = token;
    for (const key of this.references.keys()) if (key !== token) this.references.delete(key);
    if (!this.queue.busy) await this.cleanup();
  }
  async referenceFailed(token: string, message: string): Promise<void> {
    if (token !== this.reference?.media.path) return;
    const previous = this.displayedReference ? this.references.get(this.displayedReference) : undefined;
    this.reference = previous?.media.path !== token ? previous : undefined;
    this.references.delete(token);
    this.phaseError('Comparison reference', message.slice(0, 300)); this.views.update();
    if (!this.queue.busy) await this.cleanup();
  }
  private remember(): void {
    clearTimeout(this.rememberTimer);
    if (!this.target) return;
    const value = { uri: this.target.uri.toString(), scene: this.target.scene, time: this.desiredTime };
    this.rememberTimer = setTimeout(() => { void this.context.workspaceState.update('lastScene', value); }, 200);
  }
  configurationChanged(event: vscode.ConfigurationChangeEvent): void {
    const uri = this.target?.uri, cfg = vscode.workspace.getConfiguration('manimCue', uri);
    if (event.affectsConfiguration('manimCue.autoPreview', uri)) {
      this.autoPreview = cfg.get('autoPreview', true);
      if (this.autoPreview) this.requestVideo(); else if (this.playIntent === undefined) this.queue.remove('render');
    }
    if (event.affectsConfiguration('manimCue.autoRefreshOnSave', uri) && !cfg.get('autoRefreshOnSave', true)) this.clearAutoRefresh();
    if (event.affectsConfiguration('python', uri) || ['pythonPath', 'frameRate', 'previewWidth', 'workingDirectory', 'timeoutSeconds'].some(key => event.affectsConfiguration(`manimCue.${key}`, uri))) {
      this.scenes.invalidate(); this.invalidate('Environment/profile changed — refresh');
    }
    this.views.update();
  }
  select(index: number, mode: SelectionMode = 'replace'): void {
    const timeline = this.timeline, entries = timeline?.timeline.entries, entry = entries?.[index];
    if (!timeline || !entries || !entry) return;
    this.selected = index;
    this.phaseError('Loop');
    if (timeline.outdated) { this.views.update(); return; } // Old timelines remain inspectable, not loopable.
    this.playIntent = undefined;
    if (isCall(entry)) {
      this.selectedEvents = selectEvents(entries, this.selectedEvents, index, mode, this.selectionAnchor);
      if (mode !== 'range') this.selectionAnchor = index;
      if (!selectionRange(entries, this.selectedEvents)) this.loopEnabled = false;
      if (mode === 'replace') this.seek(entry.start);
    } else {
      this.selectedEvents = []; this.selectionAnchor = undefined; this.loopEnabled = false;
      this.seek(entry.start);
    }
    if (this.loopEnabled && !this.selection()?.available) this.loopEnabled = false;
    this.views.update();
  }
  setLoop(enabled: boolean): void {
    if (!this.selection()?.available) return;
    this.loopEnabled = enabled; this.playIntent = undefined; this.views.update();
  }
  private clearComparison(): void {
    this.comparing = false; this.reference = undefined; this.references.clear(); this.displayedReference = undefined; this.pinRequest = undefined;
  }
  private pin(result: PreviewResult): void {
    this.phaseError('Comparison reference');
    this.reference = result; this.references.set(result.media.path, result); this.pinRequest = undefined;
    for (const token of this.references.keys()) if (token !== result.media.path && token !== this.displayedReference) this.references.delete(token);
  }
  setComparison(enabled: boolean, token = this.displayed, time?: number, replace = false): void {
    if (!enabled) {
      this.comparing = false; this.pinRequest = undefined;
      if (this.autoPreview) this.requestVideo();
      this.views.update(); return;
    }
    const result = token === this.displayed && token ? this.retained.get(token) : undefined;
    if (!result) return;
    if (time !== undefined && (!Number.isFinite(time) || time < 0 || result.media.kind === 'video' && time > result.media.duration)) return;
    this.comparing = true; this.playIntent = undefined; this.pinRequest = undefined;
    this.queue.remove('render');
    const needsPin = replace || !this.reference;
    if (result.media.kind === 'image') {
      if (needsPin) this.pin(result); // Deliberately retain the displayed pixels, even if outdated.
    } else if (this.mediaReady() && result.media.path === this.preview?.media.path && this.job) {
      // A video is never replaced with an older frame. Request a new frame at its presented
      // position; the UI says that this is a new evaluation, not pixels from the video.
      const value = time ?? this.playbackTime ?? this.desiredTime, fps = result.media.rate;
      if (!Number.isFinite(value) || value < 0 || value > result.media.duration) return;
      this.seek(videoFrameIndex(value, fps, videoFrames(result.media.duration, fps)) / fps, true);
      if (needsPin) this.pinRequest = { sequence: this.seekSequence };
    }
    this.views.update();
  }
  async copyPoint(token: string, x: number, y: number): Promise<void> {
    const p = this.preview?.profile;
    if (p && token === this.preview?.media.path && token === this.displayed && this.mediaReady() &&
      Math.abs(x) <= p.frameWidth / 2 && Math.abs(y) <= p.frameHeight / 2) {
      await vscode.env.clipboard.writeText(`[${Number(x.toPrecision(6))}, ${Number(y.toPrecision(6))}, 0]`);
    }
  }
  async saveFrame(token = this.displayed): Promise<void> {
    const result = token && token === this.displayed ? this.retained.get(token) : undefined;
    if (!result || result.media.kind !== 'image') return;
    // Read before the dialog: a later decoded replacement may release the source file.
    const bytes = await fs.readFile(result.media.path);
    const stamp = result.media.capture?.time;
    const name = `${path.parse(result.source).name}-${this.target?.scene ?? 'frame'}-${stamp == null ? 'end-state' : stamp.toFixed(3) + 's'}${result.outdated ? '-old' : ''}.png`;
    const uri = await vscode.window.showSaveDialog({ title: 'Save captured frame', defaultUri: vscode.Uri.file(path.join(path.dirname(result.source), name)), filters: { 'PNG image': ['png'] } });
    if (uri) await this.saveArtifact(bytes, uri, '.png', result);
  }
  private async saveArtifact(bytes: Uint8Array, destination: vscode.Uri, extension: string, result: PreviewResult | TimelineResult): Promise<void> {
    if (destination.scheme !== 'file') throw new Error('Export requires a local destination.');
    const validate = async () => {
      if (this.disposed) throw new Error('Export cancelled: Manim Cue closed.');
      await validateDestination(destination.fsPath, extension, [result.source, this.scratch,
        ...Object.keys(result.profile.configs), ...(this.target ? [this.target.uri.fsPath] : [])]);
    };
    await validate();
    await copyExport(bytes, destination.fsPath, new AbortController().signal, validate);
  }
  async clearCaches(): Promise<void> {
    if (this.exports.busy) throw new Error('Finish or cancel the export before clearing caches.');
    this.cancel(false); const generation = this.generation;
    this.views.update();
    this.pending = this.pending.catch(() => {}).then(async () => {
      await this.queue.whenIdle();
      if (this.disposed || generation !== this.generation) return;
      await fs.rm(path.join(this.scratch, 'cache-v1'), { recursive: true, force: true });
      if (!this.disposed && generation === this.generation) { this.status = 'Cue caches cleared — refresh to rebuild'; this.views.update(); }
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
    ++this.generation; ++this.seekSequence; this.abort?.abort(); this.playIntent = undefined; this.loopEnabled = false; this.pinRequest = undefined;
    if (!preserve) {
      this.job = undefined;
      for (const result of [this.preview, this.video, this.timeline, ...this.retained.values(), ...this.exports.results]) if (result) result.outdated = true;
    } else if (this.preview?.media.capture?.requestedTime === this.desiredTime && !this.preview.outdated) this.frameSequence = this.seekSequence;
    this.preparing = false; this.queue.clear(); this.busy = this.queue.busy;
    this.status = this.timeline ? 'Cancelled — completed observation retained' : 'Cancelled';
    this.views.update();
  }
  invalidate(reason: string, savedHash?: string): void {
    this.exports.invalidate(reason + ' — export cancelled.', false, savedHash);
    if (!this.target) return;
    this.cancel(false); this.status = reason; this.views.update();
  }
  async environmentChanged(): Promise<void> {
    this.scenes.invalidate();
    if (!this.target || !this.pythonInUse || vscode.workspace.getConfiguration('manimCue', this.target.uri).get<string>('pythonPath', '').trim()) return;
    const generation = this.generation;
    const resolved = await environmentFor(this.target.uri);
    if (generation === this.generation && resolved.python !== this.pythonInUse) this.invalidate('Python environment changed — refresh');
  }
  changed(uri: vscode.Uri): void {
    if (!this.target) return;
    if (uri.toString() === this.target.uri.toString()) {
      this.sourceEdited = true;
      this.invalidate('Source changed — save to refresh');
    }
    else if (!insideEnvironment(uri.fsPath) &&
      (uri.fsPath.endsWith('.py') || uri.fsPath.endsWith('manim.cfg') || path.basename(uri.fsPath) === '.env')) {
      this.invalidate('Possible dependency changed — refresh (dependency coverage is incomplete)');
    }
  }
  async saved(uri: vscode.Uri): Promise<void> {
    const started = performance.now();
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
      this.invalidate(automatic ? 'Source saved — refresh queued…' : 'Source changed — refresh', hash);
      if (!automatic) return;
      const generation = this.generation;
      this.busy = true; this.error = undefined; this.views.update();
      this.saveTimer = setTimeout(() => {
        this.saveTimer = undefined;
        if (this.disposed || this.target !== target || generation !== this.generation) return;
        void this.refresh(true, started).catch(e => {
          // Job failures already stay in the panel; preflight failures should too.
          if (this.disposed || generation !== this.generation) return;
          this.busy = false; this.status = 'Automatic refresh failed';
          this.error = e instanceof Error ? e.message : String(e);
          this.output.appendLine(this.error); this.views.update();
        });
      }, 500);
    } catch (e) {
      if (this.disposed || this.target !== target || check !== this.saveCheck) return;
      this.invalidate('Source unavailable — save or refresh to retry');
      this.error = e instanceof Error ? e.message : String(e);
      this.output.appendLine(this.error); this.views.update();
    }
  }
  async navigate(index: number): Promise<void> {
    if (!this.timeline || !this.target) return;
    const result = this.timeline, target = this.target, generation = this.generation;
    const site = result.timeline.entries[index]?.source;
    if (!site?.path) throw new Error('No navigable path was captured for this source site.');
    if (result.outdated || (await vscode.workspace.openTextDocument(target.uri)).isDirty) throw new Error('Source changed. Refresh before navigating revision-local locations.');
    const root = path.dirname(await fs.realpath(result.source));
    const file = await fs.realpath(path.resolve(root, site.path));
    const relative = path.relative(root, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Source resolves outside the captured root.');
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    if (doc.isDirty) throw new Error('This helper has unsaved edits. Save and refresh before navigating.');
    if (site.line > doc.lineCount) throw new Error('Captured line is no longer present. Refresh.');
    if (generation !== this.generation) return;
    if (file !== await fs.realpath(result.source)) void vscode.window.showInformationMessage('Helper-file location is best effort: Manim only fingerprints the primary source.');
    await vscode.window.showTextDocument(doc, { viewColumn: target.column ?? vscode.ViewColumn.One, selection: new vscode.Range(site.line - 1, 0, site.line - 1, 0), preserveFocus: false });
  }
  private exportSource(): ExportSource | undefined {
    if (!this.target) return;
    return { uri: this.target.uri, scene: this.target.scene, frame: this.displayed ? this.retained.get(this.displayed) : undefined,
      video: this.video, timeline: this.timeline, job: this.job, time: this.playbackTime ?? this.desiredTime };
  }
  openExportDialog(token?: string, time?: number): void { this.playIntent = undefined; this.exports.open(token, time); }
  async openExport(): Promise<void> {
    if (!this.target) { void vscode.window.showInformationMessage('Open a Scene before exporting.'); return; }
    this.exports.requestOpen = true; await this.views.open(); this.views.update();
  }
  async exportTimeline(): Promise<void> {
    if (!this.timeline) throw new Error('No completed timeline to export.');
    const result = this.timeline;
    const bytes = await fs.readFile(result.file);
    const target = await vscode.window.showSaveDialog({ filters: { 'Timeline JSON': ['json'] }, saveLabel: result.outdated ? 'Export stale observation' : 'Export timeline' });
    if (target) await this.saveArtifact(bytes, target, '.json', result);
  }
  failAction(e: unknown): void { if (!this.disposed) void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e)); }
  private async cleanup(): Promise<void> {
    if (this.queue.busy || this.preparing || this.exports.busy) return;
    // Recheck ownership after filesystem awaits: a display/pin acknowledgement or
    // completed job may have changed the live set while directory listing yielded.
    const keep = () => new Set([...this.exports.directories, this.job?.directory, this.timeline?.directory, this.video?.directory, ...[...this.retained.values(), ...this.references.values()].map(r => r.directory)]);
    const media = () => new Set([...this.exports.files, this.preview?.media.path, this.video?.media.path, ...this.retained.keys(), ...this.references.keys()]);
    try {
      for (const file of await fs.readdir(this.mediaRoot).catch(() => [] as string[])) {
        if (this.queue.busy || this.preparing || this.exports.busy) return;
        const full = path.join(this.mediaRoot, file);
        if (!media().has(full)) await fs.rm(full, { force: true });
      }
      for (const entry of await fs.readdir(this.scratch, { withFileTypes: true })) {
        if (this.queue.busy || this.preparing || this.exports.busy) return;
        const dir = path.join(this.scratch, entry.name);
        if (!entry.isDirectory() || !entry.name.startsWith('run-')) continue;
        if (!keep().has(dir)) await fs.rm(dir, { recursive: true, force: true });
        else for (const file of await fs.readdir(path.join(dir, 'media'))) {
          if (this.queue.busy || this.preparing || this.exports.busy) return;
          const full = path.join(dir, 'media', file);
          if (!media().has(full)) await fs.rm(full, { force: true });
        }
      }
    } catch { /* Best effort (e.g. a media handle is still being released). */ }
  }
  async whenIdle(): Promise<void> { await this.pending; await this.queue.whenIdle(); await this.exports.whenIdle(); }
  dispose(): void {
    clearTimeout(this.rememberTimer);
    if (this.target) void this.context.workspaceState.update('lastScene', { uri: this.target.uri.toString(), scene: this.target.scene, time: this.desiredTime });
    this.clearAutoRefresh(); this.exports.dispose(); this.disposed = true; ++this.generation; this.abort?.abort();
    this.queue.clear(); this.scenes.dispose(); this.views.dispose();
  }
}
