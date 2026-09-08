import * as vscode from 'vscode';
import * as path from 'node:path';
import { PythonExtension } from '@vscode/python-extension';

export interface PythonEnvironment {
  python: string; env: NodeJS.ProcessEnv; selection: string;
}
export function workingDirectoryFor(uri: vscode.Uri): string {
  const root = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath ?? path.dirname(uri.fsPath);
  return path.resolve(root, vscode.workspace.getConfiguration('manimCue', uri).get('workingDirectory', '') || '.');
}

export async function environmentFor(uri: vscode.Uri): Promise<PythonEnvironment> {
  if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before running Python with Manim Cue.');
  const override = vscode.workspace.getConfiguration('manimCue', uri).get<string>('pythonPath', '').trim();
  const api = await PythonExtension.api();
  await api.ready;
  const selected = override ? undefined : api.environments.getActiveEnvironmentPath(uri);
  const environment = selected ? await api.environments.resolveEnvironment(selected) : undefined;
  const python = override || environment?.executable.uri?.fsPath;
  if (!python || !path.isAbsolute(python)) throw new Error('Select a Python interpreter, or set manimCue.pythonPath to an absolute executable path.');
  const env: NodeJS.ProcessEnv = { ...process.env, ...api.environments.getEnvironmentVariables(uri) };
  const key = Object.keys(env).find(k => k.toLowerCase() === 'path') ?? 'PATH';
  env[key] = `${path.dirname(python)}${path.delimiter}${env[key] ?? ''}`;
  return { python, env, selection: override ? 'manimCue.pythonPath override' : `Python extension selection for this file: ${selected!.path}` };
}
