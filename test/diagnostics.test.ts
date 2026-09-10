import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { formatDiagnostic, readDiagnostic, RuntimeUnavailable, type PythonDiagnostic } from '../src/diagnostics';

const report: PythonDiagnostic = { status: 'limited', python: '/env/python', python_version: '3.13', prefix: '/env',
  base_prefix: '/base', cwd: '/scene', manim_module: '/env/manim/__init__.py', manim_version: '0.21.0',
  capture_frame: true, timeline: false, video_encoder: false, error: 'Timeline requires capture_timeline.' };

test('partial diagnostics never claim that timeline or encoding is ready', () => {
  const text = formatDiagnostic(report);
  assert.match(text, /Check: limited/);
  assert.match(text, /Timeline \/ full preview: unavailable/);
  assert.match(text, /capture \/ comparison: available/);
  assert.match(text, /export encoder profile: unavailable/);
  assert.doesNotMatch(text, /Timeline evaluation API available/);
  assert.match(new RuntimeUnavailable({ ...report, status: 'unsupported-manim' }).message, /Check Python Environment.*Refresh/);
});

test('diagnostics accept limited runtimes and reject malformed or oversized reports', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cue-diagnostic-'));
  try {
    const file = path.join(root, 'diagnostic.json');
    await fs.writeFile(file, JSON.stringify(report));
    assert.deepEqual(await readDiagnostic(file), report);
    for (const data of ['{', '{}', JSON.stringify({ ...report, status: 'probably-ready' }), ' '.repeat(65537)]) {
      await fs.writeFile(file, data);
      await assert.rejects(readDiagnostic(file));
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
