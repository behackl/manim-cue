import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extent, isCall, parseTimeline } from '../src/timeline';
const raw = readFileSync('test/fixtures/timeline-v1.json', 'utf8');

test('Manim fixture keeps the spans of plays, waits and frozen waits', () => {
  const t = parseTimeline(raw);
  assert.equal(t.scene, 'TimelineExample'); assert.equal(t.duration, 2.25);
  assert.deepEqual(t.entries.filter(isCall).map(e => [e.kind, e.start, e.end, e.frozen]), [
    ['play', 0, .5, false], ['wait', .5, 1, false], ['wait', 1, 1.5, false], ['wait', 1.5, 1.75, true], ['wait', 1.75, 2.25, false],
  ]);
  assert.deepEqual(t.entries.map(e => e.kind), ['section', 'play', 'caption', 'wait', 'wait', 'wait', 'wait', 'sound']);
  assert.deepEqual(t.entries[1].source, { path: 'timeline_scene.py', line: 16 });
});

test('captions and sounds extend the drawn span', () => {
  const t = parseTimeline(raw);
  assert.deepEqual(extent(t), [0, 2.35]);
  const sound = t.entries.at(-1)!; if (sound.kind !== 'sound') return;
  sound.start = -.5; sound.duration = null;
  assert.deepEqual(extent(t), [-.5, 2.25]);
});

test('reject other schemas, versions and malformed entries', () => {
  const cases: ((t: any) => void)[] = [
    t => t.schema = 'manim.execution-timeline', t => t.version = 2, t => t.frame_rate = 0,
    t => t.entries = null, t => t.entries[0].kind = 'marker', t => t.entries[1].end = '1',
    t => t.entries[1].animations = [{ type: 'Wait' }], t => t.entries[1].source = { path: 'a.py' },
    t => t.entries[7].duration = 'long', t => t.source = { path: 'a.py' },
  ];
  for (const modify of cases) { const data = JSON.parse(raw); modify(data); assert.throws(() => parseTimeline(JSON.stringify(data)), /Invalid timeline/); }
});
