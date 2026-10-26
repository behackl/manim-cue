import * as vscode from 'vscode';
import { PythonExtension } from '@vscode/python-extension';
import { environmentFor, workingDirectoryFor } from './environment';
import { checkPython, diagnosticSummary, formatDiagnostic, type PythonDiagnostic } from './diagnostics';
import { selectPythonFor } from './python-picker';
import { setupPythonEnvironment } from './setup';
import type { TimeRange } from './selection';
import { Session } from './session';
import { model } from './panel';

/** The commands that check, select or create the Python environment of a scene. */
class PythonCommands implements vscode.Disposable {
  private doctorAbort?: AbortController;
  private setupAbort?: AbortController;
  private disposed = false;
  constructor(private readonly context: vscode.ExtensionContext, private readonly output: vscode.OutputChannel, private readonly session: Session) {}
  private resource(uri?: vscode.Uri): vscode.Uri {
    const resource = uri ?? this.session.target?.uri ?? vscode.window.activeTextEditor?.document.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!resource || resource.scheme !== 'file') throw new Error('Open a Python file on this computer first.');
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace to check or set up Python.');
    return resource;
  }
  private offer(resource: vscode.Uri, action: string | undefined): void {
    if (this.disposed) return;
    if (action === 'Set Up Python Environment…') void this.setup(resource).catch(e => this.session.failAction(e));
    else if (action === 'Select Python…') void this.select(resource).catch(e => this.session.failAction(e));
  }
  async select(uri?: vscode.Uri): Promise<void> {
    const resource = this.resource(uri);
    if (await selectPythonFor(resource)) {
      this.session.error = undefined; this.session.views.update();
      await this.doctor(resource);
    }
  }
  async setup(uri?: vscode.Uri): Promise<void> {
    if (this.setupAbort) { void vscode.window.showInformationMessage('The Python environment setup is already running.'); return; }
    const resource = this.resource(uri), abort = new AbortController(); this.setupAbort = abort;
    const session = this.session, current = () => session.target?.uri.toString() === resource.toString();
    try {
      const result = await setupPythonEnvironment({ resource, extensionUri: this.context.extensionUri, output: this.output,
        canRefresh: current(), signal: abort.signal });
      if (!result || this.disposed) return;
      session.error = undefined; session.scenes.invalidate();
      if (current()) session.invalidate('Python environment ready. Refresh to update.'); else session.views.update();
      if (result.refresh && current()) await session.refresh();
    } finally { if (this.setupAbort === abort) this.setupAbort = undefined; }
  }
  async doctor(uri?: vscode.Uri): Promise<PythonDiagnostic | undefined> {
    const resource = this.resource(uri);
    this.doctorAbort?.abort();
    const abort = new AbortController(); this.doctorAbort = abort;
    try {
      const report = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Manim Cue: Checking the Python environment…', cancellable: true }, async (_progress, token) => {
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
      const message = `Manim Cue: ${diagnosticSummary(report)}`;
      const notification = report.status === 'ready' ? vscode.window.showInformationMessage : vscode.window.showWarningMessage;
      const actions = report.status === 'ready' ? ['Select Python…'] : ['Set Up Python Environment…', 'Select Python…'];
      void notification(message, ...actions).then(action => this.offer(resource, action));
      return report;
    } catch (e) {
      if (abort.signal.aborted || this.disposed) return;
      const message = e instanceof Error ? e.message : String(e);
      this.output.appendLine(message); this.output.show(true);
      void vscode.window.showWarningMessage(`The Python check failed: ${message}`, 'Set Up Python Environment…', 'Select Python…').then(action => this.offer(resource, action));
    } finally { if (this.doctorAbort === abort) this.doctorAbort = undefined; }
  }
  dispose(): void { this.disposed = true; this.doctorAbort?.abort(); this.setupAbort?.abort(); }
}

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('Manim Cue');
  const session = new Session(context, output), python = new PythonCommands(context, output, session);
  const command = (id: string, fn: (...args: never[]) => unknown) => vscode.commands.registerCommand(id, (...args) => Promise.resolve(fn(...args as never[])).catch(e => session.failAction(e)));
  context.subscriptions.push(output, session, python,
    vscode.languages.registerCodeLensProvider({ language: 'python', scheme: 'file' }, session.scenes),
    command('manimCue.open', (uri?: vscode.Uri, scene?: string) => session.open(uri, scene)),
    command('manimCue.refresh', () => session.refresh()), command('manimCue.refreshTimeline', () => session.refresh(false)),
    command('manimCue.preview', () => session.renderVideo()),
    command('manimCue.cancel', () => session.cancel()), command('manimCue.logs', () => output.show(true)),
    command('manimCue.export', () => session.exports.save('timeline')),
    command('manimCue.doctor', (uri?: vscode.Uri) => python.doctor(uri)),
    command('manimCue.selectPython', (uri?: vscode.Uri) => python.select(uri)),
    command('manimCue.setupPython', (uri?: vscode.Uri) => python.setup(uri)),
    command('manimCue.clearCaches', () => session.clearCaches()),
    command('manimCue.saveFrame', () => session.exports.save('frame')), command('manimCue.openExport', () => session.openExport()),
    command('manimCue.previousFrame', () => session.views.step(-1)), command('manimCue.nextFrame', () => session.views.step(1)),
    vscode.workspace.onDidChangeTextDocument(e => {
      if (!e.contentChanges.length) return;
      // VS Code can deliver content changes before updating isDirty. Invalidate
      // immediately; the async disk check rechecks dirtiness before queuing a run.
      session.changed(e.document.uri);
      if (!e.document.isDirty) void session.saved(e.document.uri);
    }),
    vscode.workspace.onDidSaveTextDocument(document => { void session.saved(document.uri); }),
    vscode.workspace.onDidChangeConfiguration(e => session.configurationChanged(e)),
  );
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.{py,cfg,env}');
  context.subscriptions.push(watcher, watcher.onDidChange(uri => { void session.saved(uri); }), watcher.onDidCreate(uri => { void session.saved(uri); }), watcher.onDidDelete(uri => session.changed(uri)));
  void PythonExtension.api().then(api => {
    context.subscriptions.push(api.environments.onDidChangeActiveEnvironmentPath(() => { void session.environmentChanged().catch(e => session.failAction(e)); }));
  }).catch(() => {});
  // Small diagnostic API for integration tests/consumers; no mutable scene or renderer objects.
  return { getSnapshot: () => model(session), whenIdle: () => session.whenIdle(), seek: (time: number) => session.seek(time),
    setLoop: (range?: TimeRange) => session.setLoop(range), pin: (id: string) => session.pin(id),
    submitExport: (id: string, choice: unknown) => session.exports.submit(id, choice) };
}
