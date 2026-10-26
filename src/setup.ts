import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { PythonExtension } from '@vscode/python-extension';
import { checkPython, diagnosticSummary, formatDiagnostic, type PythonDiagnostic } from './diagnostics';
import { workingDirectoryFor } from './environment';
import { Cancelled, runProcess } from './process';
import { MANIM_BRANCH, SETUP_PYTHON, setupCommands } from './setup-plan';

const SETUP_TIMEOUT = 15 * 60 * 1000;

type Tool = { kind: 'uv'; executable: string; version: string } | { kind: 'python'; executable: string; version: string };
export interface SetupResult { python: string; diagnostic: PythonDiagnostic; refresh: boolean }

async function present(file: string): Promise<boolean> {
  return fs.lstat(file).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
}

function setupRoot(resource: vscode.Uri): string {
  return vscode.workspace.getWorkspaceFolder(resource)?.uri.fsPath ??
    (path.extname(resource.fsPath) ? path.dirname(resource.fsPath) : resource.fsPath);
}

function displayCommand(executable: string, args: string[]): string {
  return [executable, ...args].map(value => /[\s"']/u.test(value) ? JSON.stringify(value) : value).join(' ');
}

async function probe(executable: string, args: string[], cwd: string): Promise<string | undefined> {
  const abort = new AbortController();
  try {
    return (await runProcess(executable, args, { cwd, env: process.env, signal: abort.signal, timeout: 5000 })).trim();
  } catch { return undefined; }
}

async function selectedPython(resource: vscode.Uri, cwd: string): Promise<{ executable: string; version: string; supported: boolean } | undefined> {
  const api = await PythonExtension.api();
  await api.ready;
  const selected = api.environments.getActiveEnvironmentPath(resource);
  const environment = selected ? await api.environments.resolveEnvironment(selected) : undefined;
  const executable = environment?.executable.uri?.fsPath;
  if (!executable || !path.isAbsolute(executable)) return;
  const raw = await probe(executable, ['-c', 'import sys; print(".".join(map(str, sys.version_info[:3])))'], cwd);
  if (!raw || !/^\d+\.\d+\.\d+$/u.test(raw)) return;
  const [major, minor] = raw.split('.').map(Number);
  return { executable, version: raw, supported: major === 3 && minor >= 11 };
}

async function chooseTool(resource: vscode.Uri, cwd: string): Promise<Tool | undefined> {
  const python = await selectedPython(resource, cwd);
  const pathUv = await probe('uv', ['--version'], cwd);
  while (true) {
    type Choice = vscode.QuickPickItem & { action: 'uv' | 'python' | 'locate' };
    const choices: Choice[] = pathUv ? [
      { label: 'Create with uv', description: 'Recommended', detail: pathUv, action: 'uv' },
      { label: 'Create with the selected Python', detail: python ? `${python.executable} (${python.version}${python.supported ? '' : ' · too old'})` : 'No Python interpreter is selected', action: 'python' },
    ] : [
      { label: 'Create with the selected Python', detail: python ? `${python.executable} (${python.version}${python.supported ? '' : ' · too old'})` : 'No Python interpreter is selected', action: 'python' },
      { label: 'Locate uv…', detail: 'Choose the uv executable', action: 'locate' },
    ];
    const choice = await vscode.window.showQuickPick(choices, {
      title: 'Set Up Python Environment',
      placeHolder: pathUv ? 'Choose how to create .venv' : 'Choose how to create .venv. uv is not on VS Code’s PATH.',
    });
    if (!choice) return;
    if (choice.action === 'uv') return { kind: 'uv', executable: 'uv', version: pathUv! };
    if (choice.action === 'python') {
      if (python?.supported) return { kind: 'python', executable: python.executable, version: python.version };
      const message = python
        ? `Manim Cue needs Python 3.11 or newer. The selected interpreter is Python ${python.version}.`
        : 'Select Python 3.11 or newer, then run the setup again.';
      const action = await vscode.window.showWarningMessage(message, 'Select Python…');
      if (action) await vscode.commands.executeCommand('manimCue.selectPython', resource);
      return;
    }
    const picked = await vscode.window.showOpenDialog({
      title: 'Locate uv', defaultUri: vscode.Uri.file(cwd), openLabel: 'Use uv',
      canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
    });
    if (!picked?.[0]) continue;
    if (picked[0].scheme !== 'file') {
      await vscode.window.showWarningMessage('Choose a uv executable on this computer.');
      continue;
    }
    const version = await probe(picked[0].fsPath, ['--version'], cwd);
    if (version) return { kind: 'uv', executable: picked[0].fsPath, version };
    await vscode.window.showWarningMessage(`This file is not a working uv executable: ${picked[0].fsPath}`);
  }
}

async function confirmSetup(root: string, directory: string, tool: Tool): Promise<boolean> {
  const creator = tool.kind === 'uv' ? `${tool.version}\nPython: ${SETUP_PYTHON}` : `Python ${tool.version}\n${tool.executable}`;
  const downloads = tool.kind === 'uv'
    ? `The setup downloads and installs Python packages. uv downloads Python ${SETUP_PYTHON} if it is missing.`
    : 'The setup downloads and installs Python packages.';
  const answer = await vscode.window.showInformationMessage(
    `Create a new Python environment for Manim?\n\nProject: ${root}\nEnvironment: ${directory}\nCreated with: ${creator}\nManim branch: ${MANIM_BRANCH}\n\n${downloads} Package installation can run the build code of the packages.`,
    { modal: true }, 'Create Environment',
  );
  return answer === 'Create Environment';
}

/** Removes a stale manimCue.pythonPath override without writing settings the user never set. */
async function clearPythonOverride(resource: vscode.Uri): Promise<void> {
  const configuration = vscode.workspace.getConfiguration('manimCue', resource);
  const override = configuration.inspect<string>('pythonPath');
  const scopes = [
    [override?.workspaceFolderValue, vscode.ConfigurationTarget.WorkspaceFolder],
    [override?.workspaceValue, vscode.ConfigurationTarget.Workspace],
    [override?.globalValue, vscode.ConfigurationTarget.Global],
  ] as const;
  for (const [value, target] of scopes) if (value?.trim()) await configuration.update('pythonPath', undefined, target);
}

async function deleteOwnedEnvironment(directory: string): Promise<void> {
  const answer = await vscode.window.showWarningMessage(`Delete the incomplete environment at ${directory}?`, { modal: true }, 'Delete .venv');
  if (answer === 'Delete .venv') await fs.rm(directory, { recursive: true, force: true });
}

/** Creates only a new project-local environment; existing environments are never modified. */
export async function setupPythonEnvironment(options: {
  resource: vscode.Uri; extensionUri: vscode.Uri; output: vscode.OutputChannel; canRefresh: boolean; signal?: AbortSignal;
}): Promise<SetupResult | undefined> {
  if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace to set up Python.');
  options.signal?.throwIfAborted();
  const root = setupRoot(options.resource), directory = path.join(root, '.venv');
  if (await present(directory)) {
    const action = await vscode.window.showWarningMessage(
      `An environment already exists at ${directory}. Select it, or delete it to create a new one.`,
      { modal: true }, 'Select Python…',
    );
    if (action) await vscode.commands.executeCommand('manimCue.selectPython', options.resource);
    return;
  }
  const tool = await chooseTool(options.resource, root);
  if (!tool || !await confirmSetup(root, directory, tool)) return;
  options.signal?.throwIfAborted();
  // Tool selection may have taken a while; do not merge into an environment created meanwhile.
  if (await present(directory)) {
    await vscode.window.showWarningMessage(`The setup stopped: ${directory} now exists. Select it, or delete it to create a new one.`, { modal: true });
    return;
  }

  let owned = false;
  while (true) {
    let phase = 'creating .venv';
    try {
      const diagnostic = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification, title: 'Manim Cue: Setting up Python…', cancellable: true,
      }, async (progress, token) => {
        const abort = new AbortController();
        const subscription = token.onCancellationRequested(() => abort.abort());
        const stop = () => abort.abort(); options.signal?.addEventListener('abort', stop, { once: true });
        if (options.signal?.aborted) abort.abort();
        const log = (text: string) => options.output.append(text);
        const execute = async (executable: string, args: string[]) => {
          options.output.appendLine(`\n$ ${displayCommand(executable, args)}`);
          await runProcess(executable, args, { cwd: root, env: process.env, signal: abort.signal, timeout: SETUP_TIMEOUT, log });
        };
        try {
          options.output.appendLine(`\n── Python environment setup ──\nProject: ${root}\nEnvironment: ${directory}\nManim branch: ${MANIM_BRANCH}\nCreator: ${tool.executable} (${tool.version})`);
          progress.report({ message: 'Creating .venv…' });
          owned = true; // The destination was absent immediately before this user-approved operation.
          const commands = setupCommands(tool, directory);
          await execute(commands.create.executable, commands.create.args);
          const python = commands.python;
          if (!await present(python)) throw new Error(`The new environment has no Python executable at ${python}.`);

          phase = 'installing Manim'; progress.report({ message: 'Installing Manim…' });
          await execute(commands.install.executable, commands.install.args);

          phase = 'checking the environment'; progress.report({ message: 'Checking the environment…' });
          const api = await PythonExtension.api(); await api.ready;
          const env: NodeJS.ProcessEnv = { ...process.env, ...api.environments.getEnvironmentVariables(options.resource) };
          const key = Object.keys(env).find(name => name.toLowerCase() === 'path') ?? 'PATH';
          env[key] = `${path.dirname(python)}${path.delimiter}${env[key] ?? ''}`;
          const result = await checkPython({ python, env, cwd: workingDirectoryFor(options.resource),
            helpers: vscode.Uri.joinPath(options.extensionUri, 'python').fsPath, signal: abort.signal, log });
          options.output.appendLine(`\n${formatDiagnostic(result)}`);
          if (result.status !== 'ready') throw new Error(diagnosticSummary(result));
          return { python, result };
        } finally { subscription.dispose(); options.signal?.removeEventListener('abort', stop); }
      });
      if (options.signal?.aborted) return;

      phase = 'selecting the environment';
      try {
        const api = await PythonExtension.api(); await api.ready;
        await api.environments.updateActiveEnvironmentPath(diagnostic.python, options.resource);
        await clearPythonOverride(options.resource);
      } catch (error) {
        options.output.appendLine(`\nEnvironment is ready, but selection failed: ${error instanceof Error ? error.message : String(error)}`);
        const action = await vscode.window.showWarningMessage(
          `The environment at ${diagnostic.python} is ready. Select it with “Select Python…”.`, 'Select Python…', 'Show Log',
        );
        if (action === 'Select Python…') await vscode.commands.executeCommand('manimCue.selectPython', options.resource);
        else if (action === 'Show Log') options.output.show(true);
        return;
      }
      const actions = options.canRefresh ? ['Refresh', 'Show Log'] as const : ['Show Log'] as const;
      const action = await vscode.window.showInformationMessage('The Python environment is ready.', ...actions);
      if (action === 'Show Log') options.output.show(true);
      return { python: diagnostic.python, diagnostic: diagnostic.result, refresh: action === 'Refresh' };
    } catch (error) {
      if (options.signal?.aborted) return;
      const cancelled = error instanceof Cancelled;
      const detail = error instanceof Error ? error.message : String(error);
      options.output.appendLine(`\nSetup ${cancelled ? 'cancelled' : 'failed'} while ${phase}: ${detail}`);
      const hasDirectory = owned && await present(directory);
      const retry = hasDirectory ? 'Retry from scratch' : 'Retry';
      const cleanup = hasDirectory ? ['Delete Incomplete .venv'] as const : [] as const;
      const message = `The setup ${cancelled ? 'was cancelled' : 'failed'} while ${phase}.${hasDirectory ? ' The new .venv can be incomplete.' : ''}`;
      let action = await vscode.window.showWarningMessage(message, { modal: true }, retry, 'Show Log', ...cleanup);
      if (action === 'Show Log') {
        // A modal dialog would cover the log, so repeat the choices without one.
        options.output.show(true);
        action = await vscode.window.showWarningMessage(message, retry, ...cleanup);
      }
      if (action === 'Delete Incomplete .venv') { await deleteOwnedEnvironment(directory); return; }
      if (action === retry) {
        if (hasDirectory) { await fs.rm(directory, { recursive: true, force: true }); owned = false; }
        continue;
      }
      return;
    }
  }
}
