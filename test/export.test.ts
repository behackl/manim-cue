import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { encoderOptions, exportSize, renderSettings } from '../src/export-settings';
import { copyExport, validateDestination } from '../src/export-files';

const settings = { width: 1920, height: 1080, fps: 29.97, crf: 18, preset: 'medium', options: '' };
test('export settings keep dimensions, FPS and codec options explicit and bounded', () => {
  assert.equal(renderSettings(settings).fps, 29.97);
  assert.deepEqual(exportSize(1080, 16 / 9), { width: 1920, height: 1080 });
  assert.deepEqual(exportSize(1080, 9 / 16), { width: 1080, height: 1920 });
  assert.equal(encoderOptions('threads=4\nx264-params=keyint=30:scenecut=0')['x264-params'], 'keyint=30:scenecut=0');
  for (const text of ['crf=20', 'preset=slow', 'a=b\na=c', '=value', 'key=', '--flag=bad', 'key=bad\u0000value', 'x'.repeat(8193)]) assert.throws(() => encoderOptions(text));
  for (const change of [{ width: 1919 }, { height: 0 }, { width: 8192, height: 8192 }, { fps: NaN }, { fps: 121 }, { crf: 52 }, { preset: 'unknown' }]) assert.throws(() => renderSettings({ ...settings, ...change }));
});
test('atomic export copies exact bytes and preserves an existing destination on cancellation or validation failure', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cue-export-'));
  try {
    const source = path.join(dir, 'source.mp4'), destination = path.join(dir, 'output.mp4');
    await fs.writeFile(source, 'new artifact'); await fs.writeFile(destination, 'previous export');
    const abort = new AbortController();
    await assert.rejects(copyExport(source, destination, abort.signal, async () => { abort.abort(); }));
    assert.equal(await fs.readFile(destination, 'utf8'), 'previous export');
    await assert.rejects(copyExport(source, destination, new AbortController().signal, async () => { throw new Error('Source changed'); }));
    assert.equal(await fs.readFile(destination, 'utf8'), 'previous export');
    await copyExport(source, destination, new AbortController().signal);
    assert.equal(await fs.readFile(destination, 'utf8'), 'new artifact');
    const held = await fs.readFile(source);
    await fs.writeFile(source, 'replacement after Save As opened');
    await copyExport(held, destination, new AbortController().signal);
    assert.equal(await fs.readFile(destination, 'utf8'), 'new artifact', 'held bytes survive source replacement');
    await assert.rejects(copyExport(Buffer.from('unpublished'), destination, new AbortController().signal,
      async () => { throw new Error('Destination became forbidden'); }));
    assert.equal(await fs.readFile(destination, 'utf8'), 'new artifact', 'failed held-byte publication preserves destination');
    assert.deepEqual((await fs.readdir(dir)).sort(), ['output.mp4', 'source.mp4']);
    await assert.rejects(copyExport(source, source, new AbortController().signal));
    await validateDestination(destination, '.mp4', [path.join(dir, 'private')]);
    await assert.rejects(validateDestination(destination, '.png', []));
    await fs.symlink(source, path.join(dir, 'alias.mp4'));
    await assert.rejects(validateDestination(path.join(dir, 'alias.mp4'), '.mp4', [source]));
    await assert.rejects(validateDestination(destination, '.mp4', [dir]));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
