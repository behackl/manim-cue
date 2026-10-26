import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectEvents, selectionRange, movieLoop } from '../src/selection';
import type { Entry } from '../src/timeline';

const call = (i: number) => ({ kind: 'play', start: i / 4, end: (i + 1) / 4 }) as Entry;
const entries = [call(0), { kind: 'section', start: .25 } as Entry, call(1), call(2), call(3)];
test('replace, toggle and anchored range selection describe one continuous interval', () => {
  const one = selectEvents(entries, [], 2, 'replace');
  assert.deepEqual(one, [2]);
  const multiple = selectEvents(entries, one, 4, 'toggle');
  assert.deepEqual(multiple, [2, 4]);
  assert.deepEqual(selectionRange(entries, multiple), { start: .25, end: 1 });
  assert.deepEqual(selectEvents(entries, multiple, 4, 'toggle'), [2]);
  assert.deepEqual(selectEvents(entries, multiple, 0, 'range', 4), [0, 2, 3, 4]);
  assert.deepEqual(selectEvents(entries, [], 3, 'range'), [3]);
  assert.deepEqual(selectEvents(entries, [2], 1, 'replace'), [2], 'only plays and waits are selectable');
  assert.equal(selectionRange(entries, []), undefined);
});
test('loop mapping permits clock roundoff and rejects non-frame boundaries', () => {
  assert.deepEqual(movieLoop({ start: .25, end: .75 }, 4, 4), { start: .25, end: .75 });
  assert.deepEqual(movieLoop({ start: .5 - 1e-10, end: 1 }, 4, 4), { start: .5, end: 1 });
  assert.equal(movieLoop({ start: .3, end: .75 }, 4, 4), undefined);
  assert.equal(movieLoop({ start: 0, end: 2 }, 4, 4), undefined);
  assert.equal(movieLoop({ start: 0, end: 0 }, 4, 4), undefined);
});
