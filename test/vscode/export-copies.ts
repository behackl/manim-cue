import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Exports, type ExportSource } from '../../src/exports';
import type { ExportChoice } from '../../src/export-settings';
import type { Profile, RunResult } from '../../src/jobs';

/** Real controller and filesystem publication; no Manim needed for existing artifact copies. */
export async function testExportCopies(root: string): Promise<void> {
  const dir = await fs.mkdtemp(path.join(root, 'copy-test-'));
  const save = vscode.window.showSaveDialog, info = vscode.window.showInformationMessage;
  try {
    const scratch = path.join(dir, 'runs'), run = path.join(scratch, 'run-1');
    await fs.mkdir(run, { recursive: true });
    const files = { frame: path.join(run, 'frame.png'), video: path.join(run, 'movie.mp4'), timeline: path.join(run, 'timeline.json') };
    for (const [kind, file] of Object.entries(files)) await fs.writeFile(file, `original ${kind} bytes\n`);
    const sourceFile = path.join(dir, 'scene.py'); await fs.writeFile(sourceFile, '# never executed\n');
    Object.assign(vscode.window, { showInformationMessage: async () => undefined });
    for (const [width, height] of [[960, 120], [120, 960]]) {
      const memory = new Map<string, unknown>();
      const context = { workspaceState: { get: (key: string) => memory.get(key), update: async (key: string, value: unknown) => { memory.set(key, value); } } } as unknown as vscode.ExtensionContext;
      const profile: Profile = { version: 'test', module: 'test', fps: 30, width, height, frameWidth: 16, frameHeight: 16 * height / width, seed: 0, configs: {} };
      const observation = { directory: run, source: sourceFile, sourceHash: 'a'.repeat(64), profile };
      const media = { duration: 1, rate: 30, hasAudio: false, averageRate: 30, frames: 30, maxFrameTimeError: 0 };
      const source: ExportSource = { uri: vscode.Uri.file(sourceFile), scene: 'Demo', edited: false, time: 0,
        frame: { ...observation, media: { ...media, kind: 'image', path: files.frame, capture: { requestedTime: 0, time: 0, frameIndex: 0 } } },
        movie: { ...observation, media: { ...media, kind: 'video', path: files.video } },
        timeline: { ...observation, timeline: { end: 1, revision: 'b'.repeat(64) } as RunResult['timeline'] } };
      let pickers = 0;
      const exports = new Exports(context, scratch, () => source, () => {}, async () => { throw new Error('Copies must not start native work'); }, () => {});
      try {
        for (const kind of ['frame', 'video', 'timeline'] as const) {
          const destination = path.join(dir, `copy-${width}-${kind}${path.extname(files[kind])}`);
          await fs.writeFile(destination, 'previous export');
          Object.assign(vscode.window, { showSaveDialog: async () => { ++pickers; return vscode.Uri.file(destination); } });
          exports.open(source.frame!.media.path, 0);
          const dialog = exports.snapshot().dialog!;
          assert.equal(Math.max(dialog.choice.settings.width, dialog.choice.settings.height), 8640);
          await exports.submit(dialog.id, { ...dialog.choice, kind, method: 'copy', settings: null });
          assert.deepEqual(await fs.readFile(destination), await fs.readFile(files[kind]));
          assert.match(exports.snapshot().status ?? '', /Export saved/);
          assert.equal(memory.has('exportChoice'), false, 'invalid render drafts are not persisted');
        }
        assert.equal(pickers, 3);
        exports.open(source.frame!.media.path, 0);
        const dialog = exports.snapshot().dialog!;
        await exports.submit(dialog.id, { ...dialog.choice, kind: 'video', method: 'render' } satisfies ExportChoice);
        assert.match(exports.snapshot().dialog?.error ?? '', /dimensions/);
        assert.equal(pickers, 3, 'invalid new renders are still rejected before the picker');
      } finally { exports.dispose(); }
    }
  } finally {
    Object.assign(vscode.window, { showSaveDialog: save, showInformationMessage: info });
    await fs.rm(dir, { recursive: true, force: true });
  }
}
