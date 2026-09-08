import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contain, coordinate, rulerTicks, scenePoint } from '../src/measurement';

test('contained media excludes pillarboxing and letterboxing', () => {
  assert.deepEqual(contain({ x: 10, y: 20, width: 800, height: 200 }, { width: 400, height: 400 }), { x: 310, y: 20, width: 200, height: 200 });
  assert.deepEqual(contain({ x: 0, y: 0, width: 400, height: 800 }, { width: 800, height: 400 }), { x: 0, y: 300, width: 400, height: 200 });
  assert.equal(contain({ x: 0, y: 0, width: 0, height: 1 }, { width: 1, height: 1 }), undefined);
});
test('scene coordinates invert y, exclude margins and clamp captured drags', () => {
  const rect = { x: 30, y: 10, width: 800, height: 400 }, frame = { width: 16, height: 8 };
  assert.deepEqual(scenePoint({ x: 430, y: 210 }, rect, frame), { x: 0, y: 0 });
  assert.deepEqual(scenePoint({ x: 30, y: 10 }, rect, frame), { x: -8, y: 4 });
  assert.equal(scenePoint({ x: 0, y: 210 }, rect, frame), undefined);
  assert.deepEqual(scenePoint({ x: 1000, y: 900 }, rect, frame, true), { x: 8, y: -4 });
  assert.equal(scenePoint({ x: NaN, y: 0 }, rect, frame), undefined);
  assert.equal(scenePoint({ x: 0, y: 0 }, rect, { width: -1, height: 8 }), undefined);
});
test('rulers are bounded and coordinates preserve small units without negative zero', () => {
  assert.deepEqual(rulerTicks(8, 400), [-4, -2, 0, 2, 4]);
  assert.ok(rulerTicks(1e10, 100000).length <= 100);
  assert.deepEqual(rulerTicks(Infinity, 100), []);
  assert.equal(coordinate(-0), '0'); assert.equal(coordinate(0.000000125), '1.25e-7');
});
