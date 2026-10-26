import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnosticSummary, formatDiagnostic, RuntimeUnavailable, type PythonDiagnostic } from '../src/diagnostics';

const report: PythonDiagnostic = { status: 'limited', python: '/env/python', python_version: '3.13', prefix: '/env',
  base_prefix: '/base', cwd: '/scene', manim_module: '/env/manim/__init__.py', manim_version: '0.21.0',
  capture_frame: true, timeline: false, video_encoder: false, error: 'Missing features: timelines (capture_timeline).' };

test('the log lists each feature; the summary is one plain sentence', () => {
  const text = formatDiagnostic(report);
  assert.match(text, /Frames: available/);
  assert.match(text, /Timeline: missing/);
  assert.match(text, /Video export: missing/);
  assert.match(text, /Manim: \/env\/manim\/__init__.py \(version 0.21.0\)/);
  assert.match(text, /Missing features/);
  assert.equal(diagnosticSummary({ ...report, status: 'ready' }), 'Ready.');
  assert.match(diagnosticSummary({ ...report, status: 'missing-manim' }), /not installed/);
  assert.doesNotMatch(new RuntimeUnavailable(report).message, /capture_timeline|\/env/);
  assert.match(new RuntimeUnavailable(report).message, /Set Up Python Environment/);
});
