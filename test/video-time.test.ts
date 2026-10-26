import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSkipped, sceneTime, skippedParts, videoTime } from '../src/video-time';
import type { Entry } from '../src/timeline';

const call = (start: number, end: number, skipped = false) => ({ kind: 'play', start, end, skipped }) as Entry;
const parts = skippedParts([call(0, 1), call(1, 1.5, true), call(1.5, 2, true), { kind: 'section', start: 2 } as Entry,
  call(2, 3), call(3, 3.5, true), call(3.5, 4.5)]);

test('skipped plays and waits merge into parts of scene time', () => {
  assert.deepEqual(parts, [{ start: 1, end: 2 }, { start: 3, end: 3.5 }]);
  assert.deepEqual(skippedParts([call(0, 1)]), []);
});
test('scene time maps to video time; a skipped part takes no video time', () => {
  assert.deepEqual([0, .5, 1, 1.5, 2, 2.5, 3, 3.25, 3.5, 4.5].map(t => videoTime(parts, t)), [0, .5, 1, 1, 1, 1.5, 2, 2, 2, 3]);
  assert.deepEqual([0, .5, 1, 1.5, 2, 2.5, 3].map(t => sceneTime(parts, t)), [0, .5, 2, 2.5, 3.5, 4, 4.5]);
  assert.equal(videoTime([], 1.25), 1.25); assert.equal(sceneTime([], 1.25), 1.25);
});
test('times in a skipped part have no video frame', () => {
  assert.deepEqual([.99, 1, 1.75, 2, 3, 3.49, 3.5].map(t => isSkipped(parts, t)), [false, true, true, false, true, true, false]);
  assert.equal(isSkipped(parts, 1 - 1e-9), true, 'rounding at a part boundary');
});
test('scene and video time round-trip outside the skipped parts', () => {
  for (const t of [0, .25, .75, 2, 2.75, 3.5, 4]) assert.ok(Math.abs(sceneTime(parts, videoTime(parts, t)) - t) < 1e-9, String(t));
});
