import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { PythonExtension } from '@vscode/python-extension';
import { environmentFor, workingDirectoryFor } from './environment';
import { checkPython, formatDiagnostic, type PythonDiagnostic } from './diagnostics';
import { selectPythonFor } from './python-picker';
import { Scenes } from './scenes';
import { executeJob, fileHash, type RunResult } from './jobs';
import { Cancelled } from './process';
import { pairingReason, safeRelativePath, type Site } from './timeline';
import type { Model } from './protocol';
import { Views } from './views';

class Cue implements vscode.Disposable {
  private generation = 0;
  private opening = 0;
  private abort?: AbortController;
  private pending: Promise<void> = Promise.resolve();
  private target?: { uri: vscode.Uri; scene: string; column?: vscode.ViewColumn };
  private result?: RunResult;
  private preview?: RunResult;
  private selected?: string;
  private status = 'Open a Python Scene to inspect its execution.';
  private error?: string;
  private busy = false;
  private stale = false;
  private autoPreview = true;
  private seekSequence = 0;
  private playbackSequence = -1;
  private playbackTime?: number;
  private desiredTime = 0;
  private positionClamped = false;
  private mediaError?: string;
  private pythonInUse?: string;
  private doctorAbort?: AbortController;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private saveCheck = 0;
  private diskHash?: string;
  private sourceEdited = false;
  private disposed = false;
  private readonly output = vscode.window.createOutputChannel('Manim Cue');
  readonly views: Views;
  readonly scenes: Scenes;
  private readonly scratch: string;
  constructor(private readonly context: vscode.ExtensionContext) {
    this.scratch = vscode.Uri.joinPath(context.storageUri ?? context.globalStorageUri, 'runs').fsPath;
    this.scenes = new Scenes(vscode.Uri.joinPath(context.extensionUri, 'python', 'discover.py').fsPath);
    this.views = new Views(context.extensionUri, () => this.preview ? [vscode.Uri.file(path.join(this.preview.directory, 'media'))] : [],
      (m, origin) => { void this.message(m, origin).catch(e => this.failAction(e)); }, webview => this.snapshot(webview));
  }
  snapshot(webview?: vscode.Webview): Model {
    let reason = 'No preview. The timeline is independent of media.';
    const media = this.preview?.media;
    const matched = this.result && this.preview?.directory === this.result.directory;
    const linked = !!(matched && !this.stale && media?.kind === 'video' && !this.mediaError &&
      !pairingReason(this.result!.timeline, media.duration, media.rate, media.maxFrameTimeError));
    if (media) {
      if (this.stale || !matched) reason = 'Old preview — unlinked from the displayed timeline';
      else if (this.mediaError) reason = this.mediaError;
      else if (media.kind === 'image') reason = 'Separate-run still image — no video time axis';
      else reason = pairingReason(this.result!.timeline, media.duration, media.rate, media.maxFrameTimeError) ?? '';
    }
    return {
      generation: this.generation, scene: this.target?.scene ?? '', status: this.status + (this.positionClamped ? ' — position clamped to scene end' : ''),
      busy: this.busy, stale: this.stale, error: this.error, autoPreview: this.autoPreview, python: this.pythonInUse,
      timeline: this.result?.timeline, selected: this.selected, linked, pairing: reason, playbackTime: this.playbackTime,
      position: { time: this.desiredTime, request: this.seekSequence },
      profile: this.result ? `Cairo · ${this.result.profile.fps} fps · ${this.result.profile.width}×${this.result.profile.height} · seed ${this.result.profile.seed}` : undefined,
      media: media ? { uri: webview ? webview.asWebviewUri(vscode.Uri.file(media.path)).toString() : '',
        kind: media.kind, token: this.preview!.directory, old: this.stale || !matched, duration: media.duration, rate: media.rate,
        frame: { width: this.preview!.profile.frameWidth, height: this.preview!.profile.frameHeight } } : undefined,
    };
  }
  async open(uri?: vscode.Uri, scene?: string): Promise<void> {
    const opening = ++this.opening;
    if (!vscode.workspace.isTrusted) { await vscode.window.showWarningMessage('Trust this workspace to discover or execute Manim scenes.'); return; }
    const document = uri ? await vscode.workspace.openTextDocument(uri) : vscode.window.activeTextEditor?.document;
    if (opening !== this.opening) return;
    if (!document || document.uri.scheme !== 'file' || document.languageId !== 'python') throw new Error('Open a saved local Python file first.');
    if (document.isDirty) {
      if (await vscode.window.showWarningMessage('Manim Cue executes saved files. Save this file and run?', 'Save and Run') !== 'Save and Run') return;
      if (!await document.save()) return;
    }
    if (!scene) {
      const candidates = await this.scenes.candidates(document);
      if (opening !== this.opening) return;
      scene = candidates.length === 1 ? candidates[0].name : await vscode.window.showQuickPick([...candidates.map(c => c.name), 'Enter scene name…'], { placeHolder: 'Select a Scene (custom/imported bases may need a name)' });
      if (scene === 'Enter scene name…') scene = await vscode.window.showInputBox({ prompt: 'Top-level Scene class name' });
    }
    if (!scene || opening !== this.opening) return;
    if (!/^[\p{ID_Start}_][\p{ID_Continue}]*$/u.test(scene)) throw new Error('Enter a Python class name, not a command or expression.');
    const different = !this.target || this.target.uri.toString() !== document.uri.toString() || this.target.scene !== scene;
    this.cancel();
    if (different) { this.result = undefined; this.preview = undefined; this.selected = undefined; this.diskHash = undefined; this.sourceEdited = false; this.desiredTime = 0; this.playbackTime = undefined; this.positionClamped = false; }
    this.target = { uri: document.uri, scene, column: vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === document.uri.toString())?.viewColumn };
    this.autoPreview = vscode.workspace.getConfiguration('manimCue', document.uri).get('autoPreview', true);
    await this.views.open();
    if (opening === this.opening) await this.refresh();
  }
  async refresh(preview = this.autoPreview): Promise<void> {
    this.clearAutoRefresh();
    if (!this.target) { await this.open(); return; }
    if (!vscode.workspace.isTrusted) throw new Error('Workspace trust is required.');
    const target = this.target, intent = this.generation;
    const document = await vscode.workspace.openTextDocument(target.uri);
    const hash = await fileHash(target.uri.fsPath);
    if (this.target !== target || intent !== this.generation || this.disposed) return;
    if (document.isDirty) { this.invalidate('Unsaved source — save to refresh'); throw new Error('Save the Python file before refreshing.'); }
    this.diskHash = hash; this.sourceEdited = false;
    const generation = ++this.generation;
    ++this.seekSequence; // Freeze the selected position; ignore in-flight old playback.
    this.abort?.abort();
    const abort = new AbortController(); this.abort = abort;
    this.pythonInUse = undefined;
    this.busy = true; this.stale = !!this.result; this.error = undefined; this.status = 'Waiting for prior job to stop…'; this.views.update();
    const current = () => generation === this.generation && !abort.signal.aborted && !this.disposed;
    this.pending = this.pending.catch(() => {}).then(async () => {
      if (!current()) return;
      try {
        this.output.appendLine(`\n── ${target.scene} · ${path.basename(target.uri.fsPath)} · generation ${generation} ──`);
        this.status = 'Resolving Python environment…'; this.views.update();
        const environmentStart = performance.now();
        const environment = await environmentFor(target.uri);
        if (!current()) return;
        this.output.appendLine(`[Cue timing] Interpreter resolution: ${((performance.now() - environmentStart) / 1000).toFixed(3)} s`);
        this.pythonInUse = environment.python;
        const cfg = vscode.workspace.getConfiguration('manimCue', target.uri);
        const cwd = workingDirectoryFor(target.uri);
        this.output.appendLine(`Python: ${environment.python}\nSelection: ${environment.selection}\nSource: ${target.uri.fsPath}\nWorking directory: ${cwd}`);
        this.views.update();
        const fps = cfg.get<number>('frameRate', 30), width = cfg.get<number>('previewWidth', 960), timeout = cfg.get<number>('timeoutSeconds', 600);
        if (!(fps >= 1 && fps <= 120 && width >= 64 && width <= 3840 && timeout >= 5 && timeout <= 7200)) throw new Error('Invalid Manim Cue frame rate, resolution or timeout setting.');
        const result = await executeJob({ ...environment, source: target.uri.fsPath, scene: target.scene, cwd,
          fps, width, timeout: timeout * 1000, preview, scratch: this.scratch,
          helpers: vscode.Uri.joinPath(this.context.extensionUri, 'python').fsPath, signal: abort.signal,
          log: s => { if (!this.disposed) this.output.append(s); },
          phase: s => { if (current()) { this.status = s; this.views.update(); } },
          timelineReady: r => { if (current()) {
            this.result = r; this.stale = false; this.selected = undefined;
            if (this.desiredTime > r.timeline.end) { this.desiredTime = r.timeline.end; ++this.seekSequence; this.positionClamped = true; }
            this.views.update();
          } },
        });
        if (!current()) return;
        this.result = result;
        if (result.media) { this.preview = result; this.playbackSequence = -1; this.playbackTime = undefined; this.mediaError = undefined; }
        this.status = 'Completed observation'; this.stale = false;
      } catch (e) {
        if (!current()) return;
        this.status = e instanceof Cancelled ? 'Cancelled' : 'Run failed — completed observations retained';
        this.error = e instanceof Error ? e.message.slice(-5000) : String(e);
        this.output.appendLine(`\n${this.error}`);
      } finally {
        if (generation === this.generation && !this.disposed) { this.busy = false; this.views.update(); }
        await this.cleanup();
      }
    });
    await this.pending;
  }
  seek(time: number): void {
    if (!this.result || !Number.isFinite(time) || this.disposed) return;
    this.desiredTime = Math.max(0, Math.min(time, this.result.timeline.end));
    this.positionClamped = false; ++this.seekSequence; this.views.update();
  }
  async clearCaches(): Promise<void> {
    this.cancel(); const generation = this.generation;
    this.stale = !!this.result; this.views.update();
    this.pending = this.pending.catch(() => {}).then(async () => {
      if (this.disposed || generation !== this.generation) return;
      await fs.rm(path.join(this.scratch, 'cache-v1'), { recursive: true, force: true });
      if (!this.disposed && generation === this.generation) { this.status = 'Cue caches cleared — refresh to rebuild'; this.views.update(); }
    });
    await this.pending;
  }
  private clearAutoRefresh(): void {
    clearTimeout(this.saveTimer); this.saveTimer = undefined; ++this.saveCheck;
  }
  cancel(): void {
    this.clearAutoRefresh();
    ++this.generation; ++this.seekSequence; this.abort?.abort(); this.busy = false;
    this.status = this.result ? 'Cancelled — completed observation retained' : 'Cancelled';
    this.views.update();
  }
  invalidate(reason: string): void {
    if (!this.target) return;
    this.cancel(); this.stale = !!this.result; this.status = reason; this.views.update();
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
    else if (uri.fsPath.endsWith('.py') || uri.fsPath.endsWith('manim.cfg') || path.basename(uri.fsPath) === '.env') this.invalidate('Possible dependency changed — refresh (dependency coverage is incomplete)');
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
      this.invalidate(automatic ? 'Source saved — refresh queued…' : 'Source changed — refresh');
      if (!automatic) return;
      const generation = this.generation;
      this.busy = true; this.error = undefined; this.views.update();
      this.saveTimer = setTimeout(() => {
        this.saveTimer = undefined;
        if (this.disposed || this.target !== target || generation !== this.generation) return;
        void this.refresh().catch(e => {
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
  private site(key: string): Site | null | undefined {
    if (key.startsWith('event:')) return this.result?.timeline.events.find(e => e.id === key.slice(6))?.source;
    if (key.startsWith('declaration:')) return this.result?.timeline.declarations.find(d => String(d.order) === key.slice(12))?.source;
  }
  private async navigate(key: string): Promise<void> {
    if (!this.result || !this.target) return;
    const result = this.result, target = this.target, generation = this.generation;
    const site = this.site(key);
    if (!site?.path || site.outside_root || !safeRelativePath(site.path)) throw new Error('No verified navigable path was captured for this source site.');
    if (this.stale || await fileHash(result.source) !== result.sourceHash || (await vscode.workspace.openTextDocument(target.uri)).isDirty) throw new Error('Source changed. Refresh before navigating revision-local locations.');
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
  async export(): Promise<void> {
    if (!this.result) throw new Error('No completed timeline to export.');
    const bytes = await fs.readFile(path.join(this.result.directory, 'timeline.json'));
    const target = await vscode.window.showSaveDialog({ filters: { 'Timeline JSON': ['json'] }, saveLabel: this.stale ? 'Export stale observation' : 'Export timeline' });
    if (target) await vscode.workspace.fs.writeFile(target, bytes);
  }
  private pythonResource(uri?: vscode.Uri): vscode.Uri {
    const resource = uri ?? this.target?.uri ?? vscode.window.activeTextEditor?.document.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!resource || resource.scheme !== 'file') throw new Error('Open a local Python file or workspace first.');
    if (!vscode.workspace.isTrusted) throw new Error('Workspace trust is required to check or configure Python.');
    return resource;
  }
  async selectPython(uri?: vscode.Uri): Promise<void> {
    const resource = this.pythonResource(uri);
    if (await selectPythonFor(resource)) {
      this.error = undefined; this.views.update();
      await this.doctor(resource);
    }
  }
  async doctor(uri?: vscode.Uri): Promise<PythonDiagnostic | undefined> {
    const resource = this.pythonResource(uri);
    this.doctorAbort?.abort();
    const abort = new AbortController(); this.doctorAbort = abort;
    try {
      const report = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Checking Manim Cue Python', cancellable: true }, async (_progress, token) => {
        const subscription = token.onCancellationRequested(() => abort.abort());
        try {
          if (token.isCancellationRequested) abort.abort();
          this.output.appendLine(`\n── Python environment check ──\nResource: ${resource.fsPath}\nWorkspace folder: ${vscode.workspace.getWorkspaceFolder(resource)?.uri.fsPath ?? '(outside workspace folders)'}`);
          const environment = await environmentFor(resource);
          abort.signal.throwIfAborted();
          const cwd = workingDirectoryFor(resource);
          this.output.appendLine(`Requested executable: ${environment.python}\nSelection: ${environment.selection}\nWorking directory: ${cwd}`);
          return await checkPython({ ...environment, cwd, helpers: vscode.Uri.joinPath(this.context.extensionUri, 'python').fsPath,
            signal: abort.signal, log: s => { if (!this.disposed) this.output.append(s); } });
        } finally { subscription.dispose(); }
      });
      if (abort.signal.aborted || this.disposed) return;
      this.output.appendLine(formatDiagnostic(report)); this.output.show(true);
      const message = report.status === 'ready'
        ? `Timeline API available in ${report.python}. See Manim Cue output for details; refresh the timeline to retry your Scene.`
        : `${report.status}: ${report.python}. ${report.error ?? ''} See Manim Cue output for details.`;
      const notification = report.status === 'ready' ? vscode.window.showInformationMessage : vscode.window.showWarningMessage;
      void notification(message, 'Select Python…').then(action => {
        if (action && !this.disposed) void this.selectPython(resource).catch(e => this.failAction(e));
      });
      return report;
    } catch (e) {
      if (abort.signal.aborted || this.disposed) return;
      const message = e instanceof Error ? e.message : String(e);
      this.output.appendLine(message); this.output.show(true);
      void vscode.window.showWarningMessage(`Python check failed: ${message}`, 'Select Python…').then(action => {
        if (action && !this.disposed) void this.selectPython(resource).catch(error => this.failAction(error));
      });
    } finally { if (this.doctorAbort === abort) this.doctorAbort = undefined; }
  }
  logs(): void { this.output.show(true); }
  failAction(e: unknown): void { if (!this.disposed) void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e)); }
  private async message(data: unknown, origin: 'timeline' | 'preview'): Promise<void> {
    if (!data || typeof data !== 'object' || this.disposed) return;
    const m = data as Record<string, unknown>;
    if (m.kind === 'ready') { this.views.update(); return; }
    if (m.kind === 'refresh') { await this.refresh(); return; }
    if (m.kind === 'cancel') { this.cancel(); return; }
    if (m.kind === 'preview') { await this.refresh(true); return; }
    if (m.kind === 'logs') { this.logs(); return; }
    if (m.kind === 'doctor') { await this.doctor(); return; }
    if (m.kind === 'export') { await this.export(); return; }
    if (m.kind === 'autoPreview' && typeof m.value === 'boolean') { this.autoPreview = m.value; this.views.update(); return; }
    if (origin === 'preview' && m.kind === 'copyPoint') {
      const p = this.preview?.profile;
      if (p && m.token === this.preview?.directory && !this.busy && !this.stale && !this.snapshot().media?.old &&
        typeof m.x === 'number' && Number.isFinite(m.x) && Math.abs(m.x) <= p.frameWidth / 2 &&
        typeof m.y === 'number' && Number.isFinite(m.y) && Math.abs(m.y) <= p.frameHeight / 2) {
        await vscode.env.clipboard.writeText(`[${Number(m.x.toPrecision(6))}, ${Number(m.y.toPrecision(6))}, 0]`);
      }
      return;
    }
    if (origin === 'preview' && m.kind === 'mediaError' && m.token === this.preview?.directory && typeof m.message === 'string') {
      this.mediaError = `Preview unavailable: ${m.message.slice(0, 300)}`; this.views.update(); return;
    }
    if (origin === 'preview' && m.kind === 'playback' && m.token === this.preview?.directory && m.seekSequence === this.seekSequence && !this.busy && this.snapshot().linked && typeof m.time === 'number' && Number.isFinite(m.time) && typeof m.sequence === 'number' && m.sequence > this.playbackSequence) {
      this.playbackSequence = m.sequence;
      if (m.time >= 0 && m.time <= (this.preview?.media?.duration ?? 0) + 0.01) {
        this.playbackTime = m.time;
        this.desiredTime = typeof m.currentTime === 'number' && Number.isFinite(m.currentTime)
          ? Math.max(0, Math.min(m.currentTime, this.result!.timeline.end)) : m.time;
        this.views.position(this.generation, m.time);
      }
      return;
    }
    if (origin !== 'timeline' || m.generation !== this.generation) return;
    if (m.kind === 'select' && typeof m.key === 'string' && this.site(m.key) !== undefined) { this.selected = m.key; this.views.update(); }
    if (m.kind === 'navigate' && typeof m.key === 'string') await this.navigate(m.key);
    if (m.kind === 'seek' && typeof m.time === 'number') this.seek(m.time);
  }
  private async cleanup(): Promise<void> {
    const keep = new Set([this.result?.directory, this.preview?.directory]);
    try {
      for (const entry of await fs.readdir(this.scratch, { withFileTypes: true })) {
        const dir = path.join(this.scratch, entry.name);
        if (entry.isDirectory() && entry.name.startsWith('run-') && !keep.has(dir)) await fs.rm(dir, { recursive: true, force: true });
      }
    } catch { /* Best effort (e.g. a media handle is still being released). */ }
  }
  whenIdle(): Promise<void> { return this.pending; }
  dispose(): void { this.clearAutoRefresh(); this.doctorAbort?.abort(); this.disposed = true; ++this.generation; this.abort?.abort(); this.scenes.dispose(); this.views.dispose(); this.output.dispose(); }
}

export function activate(context: vscode.ExtensionContext) {
  const cue = new Cue(context);
  const command = (id: string, fn: (...args: never[]) => unknown) => vscode.commands.registerCommand(id, (...args) => Promise.resolve(fn(...args as never[])).catch(e => cue.failAction(e)));
  context.subscriptions.push(cue,
    vscode.languages.registerCodeLensProvider({ language: 'python', scheme: 'file' }, cue.scenes),
    command('manimCue.open', (uri?: vscode.Uri, scene?: string) => cue.open(uri, scene)),
    command('manimCue.refresh', () => cue.refresh()), command('manimCue.preview', () => cue.refresh(true)),
    command('manimCue.cancel', () => cue.cancel()), command('manimCue.logs', () => cue.logs()), command('manimCue.export', () => cue.export()),
    command('manimCue.doctor', (uri?: vscode.Uri) => cue.doctor(uri)),
    command('manimCue.selectPython', (uri?: vscode.Uri) => cue.selectPython(uri)),
    command('manimCue.clearCaches', () => cue.clearCaches()),
    vscode.workspace.onDidChangeTextDocument(e => {
      if (!e.contentChanges.length) return;
      // VS Code can deliver content changes before updating isDirty. Invalidate
      // immediately; the async disk check rechecks dirtiness before queuing a run.
      cue.changed(e.document.uri);
      if (!e.document.isDirty) void cue.saved(e.document.uri);
    }),
    vscode.workspace.onDidSaveTextDocument(document => { void cue.saved(document.uri); }),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('manimCue') || e.affectsConfiguration('python')) { cue.scenes.invalidate(); cue.invalidate('Environment/profile changed — refresh'); } }),
  );
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.{py,cfg,env}');
  context.subscriptions.push(watcher, watcher.onDidChange(uri => { void cue.saved(uri); }), watcher.onDidCreate(uri => { void cue.saved(uri); }), watcher.onDidDelete(uri => cue.changed(uri)));
  void PythonExtension.api().then(api => {
    context.subscriptions.push(api.environments.onDidChangeActiveEnvironmentPath(() => { void cue.environmentChanged().catch(e => cue.failAction(e)); }));
  }).catch(() => {});
  // Small diagnostic API for integration tests/consumers; no mutable scene or renderer objects.
  return { getSnapshot: () => cue.snapshot(), whenIdle: () => cue.whenIdle(), seek: (time: number) => cue.seek(time) };
}
