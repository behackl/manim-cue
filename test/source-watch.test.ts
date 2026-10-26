import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { SourceWatch, type FileUri } from '../src/source-watch';

const uri = (fsPath: string): FileUri => ({ fsPath, toString: () => `file://${fsPath}` });
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** A scene file and a fake session that records what the watch asks for. */
async function setup(refresh: () => Promise<void> = async () => {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cue-watch-'));
  const file = uri(path.join(dir, 'scene.py'));
  await fs.writeFile(file.fsPath, 'saved');
  const calls: string[] = [], state = { dirty: false, automatic: true };
  const watch = new SourceWatch({
    file: () => file, dirty: () => state.dirty, automatic: () => state.automatic,
    invalidate: reason => { calls.push(`invalidate ${reason}`); watch.stop(); }, // The session cancels its work.
    queued: () => calls.push('queued'),
    refresh: async () => { calls.push('refresh'); await refresh(); },
    failed: (status, error) => calls.push(`failed ${status}: ${(error as Error).message}`),
  }, 10);
  return { dir, file, calls, state, watch };
}

test('a save queues one update; duplicate notifications of the same write do not', async () => {
  const { dir, file, calls, watch } = await setup();
  try {
    await watch.saved(file); await watch.saved(file);
    await pause(30);
    assert.deepEqual(calls, ['invalidate Update queued…', 'queued', 'refresh']);
    watch.updating('other'); calls.length = 0;
    await watch.saved(file); watch.stop(); await pause(30);
    assert.deepEqual(calls, ['invalidate Update queued…', 'queued'], 'stop cancels the queued update');
  } finally { await fs.rm(dir, { recursive: true }); }
});

test('an error of the automatic update shows, unless a newer change came first', async () => {
  const { dir, file, calls, watch } = await setup(async () => { throw new Error('the file is gone'); });
  try {
    await watch.saved(file); await pause(30);
    assert.deepEqual(calls.at(-1), 'failed Update failed: the file is gone');
    calls.length = 0;
    const later = await setup(async () => { later.watch.stop(); throw new Error('superseded'); });
    await later.watch.saved(later.file); await pause(30);
    assert.equal(later.calls.some(c => c.startsWith('failed')), false, 'a newer change replaces the error');
    await fs.rm(later.dir, { recursive: true });
  } finally { await fs.rm(dir, { recursive: true }); }
});

test('unsaved edits and other files', async () => {
  const { dir, file, calls, state, watch } = await setup();
  try {
    state.dirty = true;
    await watch.saved(file); await pause(30);
    assert.deepEqual(calls, [], 'a disk notification does not run the saved file under unsaved edits');
    state.dirty = false;
    await watch.saved(file, 'not the saved text'); await pause(30);
    assert.deepEqual(calls, [], 'an edit counts as a save only when the text equals the file');
    await watch.saved(file, 'saved'); await pause(30);
    assert.deepEqual(calls, ['invalidate Update queued…', 'queued', 'refresh']);
    calls.length = 0; state.automatic = false;
    await fs.writeFile(file.fsPath, 'changed'); await watch.saved(file); await pause(30);
    assert.deepEqual(calls, ['invalidate Outdated. Refresh to update.']);
    calls.length = 0;
    watch.changed(uri(path.join(dir, 'helper.py'))); watch.changed(uri(path.join(dir, '.venv', 'lib', 'site.py'))); watch.changed(uri(path.join(dir, 'notes.txt')));
    assert.deepEqual(calls, ['invalidate Outdated. A project file changed. Refresh to update.']);
    calls.length = 0;
    await fs.rm(file.fsPath); await watch.saved(file);
    assert.match(calls.at(-1) ?? '', /^failed Cannot read the scene file/);
  } finally { await fs.rm(dir, { recursive: true }); }
});
