import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectEvents, selectionRange, movieLoop } from '../src/selection';
import type { Event } from '../src/timeline';

const events = [0, 1, 2, 3].map(i => ({ id: String(i), start: i / 4, end: (i + 1) / 4 }) as Event);
test('replace, toggle and anchored range selection describe one continuous interval', () => {
  const one = selectEvents(events, [], '1', 'replace');
  assert.deepEqual(one, ['1']);
  const multiple = selectEvents(events, one, '3', 'toggle');
  assert.deepEqual(multiple, ['1', '3']);
  assert.deepEqual(selectionRange(events, multiple), { start: .25, end: 1 });
  assert.deepEqual(selectEvents(events, multiple, '3', 'toggle'), ['1']);
  assert.deepEqual(selectEvents(events, multiple, '0', 'range', '3'), ['0', '1', '2', '3']);
  assert.deepEqual(selectEvents(events, [], '2', 'range'), ['2']);
  assert.equal(selectionRange(events, []), undefined);
});
test('loop mapping uses checked PTS, permits clock roundoff, rejects non-frame boundaries', () => {
  const pts = [0, .2501, .4998, .7502];
  assert.deepEqual(movieLoop({ start: .25, end: .75 }, 4, pts, 1), { start: .2501, end: .7502 });
  assert.deepEqual(movieLoop({ start: .5 - 1e-10, end: 1 }, 4, pts, 1), { start: .4998, end: 1 });
  assert.equal(movieLoop({ start: .3, end: .75 }, 4, pts, 1), undefined);
  assert.equal(movieLoop({ start: 0, end: 2 }, 4, pts, 1), undefined);
  assert.equal(movieLoop({ start: 0, end: 0 }, 4, pts, 1), undefined);
});
