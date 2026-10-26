import * as vscode from 'vscode';
import * as path from 'node:path';
import { PythonExtension } from '@vscode/python-extension';
import { createJob, type SceneJob } from './jobs';
import type { RenderSettings } from './export-settings';

export interface PythonEnvironment {
  python: string; env: NodeJS.ProcessEnv; selection: string;
}
export function workingDirectoryFor(uri: vscode.Uri): string {
  const root = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath ?? path.dirname(uri.fsPath);
  return path.resolve(root, vscode.workspace.getConfiguration('manimCue', uri).get('workingDirectory', '') || '.');
}

/** No Python executable for the scene: "Check Python" helps. */
export class PythonNotFound extends Error {}
export async function environmentFor(uri: vscode.Uri): Promise<PythonEnvironment> {
  if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace to run Python.');
  const override = vscode.workspace.getConfiguration('manimCue', uri).get<string>('pythonPath', '').trim();
  const api = await PythonExtension.api();
  await api.ready;
  const selected = override ? undefined : api.environments.getActiveEnvironmentPath(uri);
  const environment = selected ? await api.environments.resolveEnvironment(selected) : undefined;
  const python = override || environment?.executable.uri?.fsPath;
  if (override && !path.isAbsolute(override)) throw new PythonNotFound('Set “Manim Cue: Python Path” to an absolute path.');
  if (!python) throw new PythonNotFound('Select a Python interpreter with “Python: Select Interpreter”.');
  const env: NodeJS.ProcessEnv = { ...process.env, ...api.environments.getEnvironmentVariables(uri) };
  const key = Object.keys(env).find(k => k.toLowerCase() === 'path') ?? 'PATH';
  env[key] = `${path.dirname(python)}${path.delimiter}${env[key] ?? ''}`;
  return { python, env, selection: override ? 'manimCue.pythonPath override' : `Python extension selection for this file: ${selected!.path}` };
}

/**
 * A job for the saved scene file with the Python and the settings of its workspace. An
 * export sets its own size and frame rate.
 */
export async function sceneJob(uri: vscode.Uri, scene: string, o: { scratch: string; helpers: string; signal: AbortSignal;
  log: (text: string) => void; sourceHash?: string; exportSettings?: RenderSettings }): Promise<{ job: SceneJob; environment: PythonEnvironment; cwd: string }> {
  const environment = await environmentFor(uri);
  const cfg = vscode.workspace.getConfiguration('manimCue', uri), cwd = workingDirectoryFor(uri);
  const fps = o.exportSettings?.fps ?? cfg.get<number>('frameRate', 30), width = o.exportSettings?.width ?? cfg.get<number>('previewWidth', 960);
  const timeout = cfg.get<number>('timeoutSeconds', 600);
  if (!(fps >= 1 && fps <= 120 && (o.exportSettings || width >= 64 && width <= 3840) && timeout >= 5 && timeout <= 7200)) {
    throw new Error('Check the Manim Cue settings for the frame rate, the preview width and the timeout.');
  }
  const job = await createJob({ ...environment, source: uri.fsPath, scene, cwd, fps, width, timeout: timeout * 1000,
    scratch: o.scratch, helpers: o.helpers, signal: o.signal, log: o.log, exportSettings: o.exportSettings }, o.sourceHash);
  return { job, environment, cwd };
}
