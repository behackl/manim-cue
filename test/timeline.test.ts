import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extent, pairingReason, parseTimeline, safeRelativePath, soundLabel } from '../src/timeline';
const raw = readFileSync('test/fixtures/timeline-v1.json', 'utf8');

test('real v1 spans distinguish nominal requests, ordinary samples and frozen holds', () => {
  const t = parseTimeline(raw);
  assert.deepEqual(t.events.map(e => [e.start, e.end, e.samples, e.hold_intervals]), [
    [0, .5, 2, 0], [.5, 1, 2, 0], [1, 1.5, 2, 0], [1.5, 1.75, 0, 1], [1.75, 2.25, 2, 0],
  ]);
  assert.equal(t.events[0].nominal_duration, .3);
  assert.equal(t.events[4].nominal_duration, 1);
  assert.equal(t.events[1].source?.site_id, t.events[2].source?.site_id);
  assert.deepEqual(t.events.slice(1, 3).map(e => e.source?.occurrence), [0, 1]);
  assert.equal('output' in t, false);
});

test('placement differs from declaration time; unknown sound duration stays unknown', () => {
  const t = parseTimeline(raw);
  const sound = t.declarations.find(d => d.kind === 'sound')!;
  assert.equal(sound.kind, 'sound'); if (sound.kind !== 'sound') return;
  sound.start = -.5; sound.duration = null;
  assert.equal(soundLabel(sound), 'example.wav');
  assert.deepEqual(extent(t), [-.5, 2.25]);
  assert.equal(sound.at, 2.25);
  assert.equal(parseTimeline(JSON.stringify(t)).declarations.at(-1)?.kind, 'sound');
});

test('reject invalid observations instead of repairing or inventing a timeline', () => {
  const cases: ((t: any) => void)[] = [
    t => t.version = 2, t => t.complete = false, t => t.policy = 'render',
    t => t.events[1].start = -.1, t => t.events[0].end = 999,
    t => t.events[1].id = t.events[0].id, t => t.events[0].samples = 1.5,
    t => t.declarations[0].event_id = 'missing', t => t.declarations[0].order = 1,
    t => t.events[0].source.path = '../secret.py', t => t.events[0].source.line = 0,
    t => t.declarations[2].duration = -1, t => t.frame_rate = 0,
  ];
  for (const modify of cases) { const data = JSON.parse(raw); modify(data); assert.throws(() => parseTimeline(JSON.stringify(data)), /Invalid timeline/); }
});

test('plausible pairing is not a certificate; obvious mismatches are unlinked', () => {
  const t = parseTimeline(raw);
  assert.equal(pairingReason(t, 2.25, 4, 0), null);
  assert.match(pairingReason(t, 3, 4, 0)!, /durations/);
  assert.match(pairingReason(t, 2.25, 30, 0)!, /rates/);
  assert.match(pairingReason(t, 2.25, 4, NaN)!, /measured/);
  assert.match(pairingReason(t, 2.25, 4, .13)!, /timestamps drift/);
  const section = t.declarations[0]; if (section.kind !== 'section') return;
  section.skip_requested = true;
  assert.match(pairingReason(t, 2.25, 4, 0)!, /skip/);
  section.skip_requested = false; t.events[2].start += .1;
  assert.match(pairingReason(t, 2.25, 4, 0)!, /gaps/);
});

test('small mux timestamp rounding is tolerated, but accumulated/interior drift is not', () => {
  const t = parseTimeline(raw); t.frame_rate = 30;
  assert.equal(pairingReason(t, t.end - 0.000651041667, 30, 0.000651041667), null);
  assert.match(pairingReason(t, t.end, 30, 0.02)!, /timestamps drift/, 'matching end times cannot hide intermediate drift');
  assert.match(pairingReason(t, t.end, 30000 / 1001, 0)!, /rates/, '30 and 29.97 are not interchangeable');
});

test('navigation path hints cannot escape their root', () => {
  for (const p of ['../x', '/x', 'C:/x', 'a\\b', 'a/../b', 'a//b', 'a\0b']) assert.equal(safeRelativePath(p), false);
  assert.equal(safeRelativePath('helpers/é.py'), true);
});
