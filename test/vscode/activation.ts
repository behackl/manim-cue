import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Model } from '../../src/protocol';

/** Editor/API compatibility only; deliberately no claim of native Manim rendering. */
export async function run(): Promise<void> {
  const manifest = JSON.parse(await fs.readFile(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const extension = vscode.extensions.getExtension(`${manifest.publisher}.${manifest.name}`);
  assert.ok(extension, 'development extension registered under its manifest identity');
  assert.ok(vscode.extensions.getExtension('ms-python.python'), 'real Python extension provisioned');
  const api = await extension.activate() as { getSnapshot(): Model; whenIdle(): Promise<void> };
  await api.whenIdle();
  const commands = await vscode.commands.getCommands();
  for (const { command } of manifest.contributes.commands) assert.ok(commands.includes(command), `${command} registered`);
  assert.equal(api.getSnapshot().scene, '', 'activation must not open/execute a Scene');
  assert.equal(api.getSnapshot().busy, false);
  assert.equal(api.getSnapshot().media, undefined);
  assert.equal(api.getSnapshot().timeline, undefined);
  await vscode.commands.executeCommand('manimCue.cancel');
  await vscode.commands.executeCommand('manimCue.clearCaches');
  assert.equal(api.getSnapshot().error, undefined);
  const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
  await fs.writeFile(path.join(root, 'smoke-success.json'), JSON.stringify({
    kind: 'activation-only', vscode: vscode.version, platform: process.platform,
    extension: extension.id, pythonExtension: vscode.extensions.getExtension('ms-python.python')!.packageJSON.version,
  }));
}
