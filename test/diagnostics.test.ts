import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDiagnostic, RuntimeUnavailable, type PythonDiagnostic } from '../src/diagnostics';

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
