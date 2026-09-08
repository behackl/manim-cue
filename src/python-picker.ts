import * as vscode from 'vscode';
import * as path from 'node:path';
import { PythonExtension } from '@vscode/python-extension';

/** Explicit Cue-only override. Never install packages or alter the Python extension's selection. */
export async function selectPythonFor(uri: vscode.Uri): Promise<boolean> {
  if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before configuring Python for Manim Cue.');
  const api = await PythonExtension.api();
  await api.ready;
  const current = vscode.workspace.getConfiguration('manimCue', uri).get<string>('pythonPath', '');
  const selected = api.environments.getActiveEnvironmentPath(uri).path;
  type Choice = vscode.QuickPickItem & { executable?: string; action?: 'follow' | 'enter' };
  const choices: Choice[] = [
    { label: 'Default: follow Python: Select Interpreter', description: current ? undefined : 'Active', detail: `Selected for this file: ${selected}`, action: 'follow' },
    { label: 'Enter a Python executable path…', detail: 'For example, /path/to/.venv/bin/python (not the environment folder)', action: 'enter' },
  ];
  const paths = new Set<string>();
  for (const environment of api.environments.known) {
    const executable = environment.executable.uri?.fsPath;
    if (!executable || paths.has(executable)) continue;
    paths.add(executable);
    choices.push({ label: environment.environment?.name || path.basename(path.dirname(executable)),
      description: executable === current ? 'Cue override' : undefined, detail: executable, executable });
  }
  const choice = await vscode.window.showQuickPick(choices, {
    title: `Python for Manim Cue — ${path.basename(uri.fsPath)}`,
    placeHolder: 'Choose a known interpreter or enter a path; no packages will be installed', matchOnDetail: true,
  });
  if (!choice) return false;
  let executable = choice.action === 'follow' ? '' : choice.executable;
  if (choice.action === 'enter') executable = await vscode.window.showInputBox({
    title: 'Python executable for Manim Cue', value: current || selected,
    prompt: 'Absolute executable path; preserve the .venv/bin/python path rather than resolving its symlink.',
    validateInput: value => path.isAbsolute(value.trim()) ? undefined : 'Enter an absolute executable path.',
  });
  if (executable === undefined) return false;
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  // Loose files have no folder settings. Explain any broader scope before applying it.
  const hasWorkspace = !!(vscode.workspace.workspaceFile || vscode.workspace.workspaceFolders?.length);
  const scope = folder ? `workspace folder “${folder.name}”` : hasWorkspace
    ? 'this workspace (the scene is outside its opened folders)'
    : 'User settings (all workspaces without their own override)';
  const answer = await vscode.window.showInformationMessage(
    `${executable ? `Use ${executable.trim()}` : 'Follow the Python extension selection'} for Manim Cue in ${scope}?`,
    { modal: true }, 'Apply',
  );
  if (answer !== 'Apply') return false;
  await vscode.workspace.getConfiguration('manimCue', uri).update('pythonPath', executable.trim(),
    folder ? vscode.ConfigurationTarget.WorkspaceFolder : hasWorkspace ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
  return true;
}
