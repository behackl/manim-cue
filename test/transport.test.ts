import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frameIndex, videoFrameIndex } from '../src/transport';

test('frame selection uses half-open nominal intervals', () => {
  assert.equal(frameIndex(.3, 4), 1);
  assert.equal(frameIndex(15 / 22, 22), 15);
  assert.equal(frameIndex(10, 4, 12), 11);
  assert.equal(frameIndex(0, 30), 0);
  assert.equal(frameIndex(Number.MAX_VALUE, 30), Number.MAX_SAFE_INTEGER - 1);
});
test('video times tolerate timestamp rounding and mid-frame seek targets', () => {
  assert.equal(videoFrameIndex(.4998, 4), 2);
  assert.equal(videoFrameIndex(.5002, 4), 2);
  assert.equal(videoFrameIndex(.625, 4), 2);
  assert.equal(videoFrameIndex(-.01, 4), 0);
});
