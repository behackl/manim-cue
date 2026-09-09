import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frameIndex, indexAt } from '../src/transport';

test('frame selection uses half-open nominal intervals and actual movie PTS', () => {
  assert.equal(frameIndex(.3, 4), 1);
  assert.equal(frameIndex(15 / 22, 22), 15);
  assert.equal(frameIndex(10, 4, 12), 11);
  assert.equal(frameIndex(0, 30), 0);
  assert.equal(frameIndex(Number.MAX_VALUE, 30), Number.MAX_SAFE_INTEGER - 1);
  const pts = [0, .2501, .4998, .7502];
  assert.equal(indexAt(.4998, pts.length, i => pts[i]), 2);
  assert.equal(indexAt(.4997, pts.length, i => pts[i]), 1);
});
