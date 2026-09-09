import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PreviewQueue } from '../src/preview-queue';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('latest frame preempts movie, joins it, then resumes background work', async () => {
  const trace: string[] = [], errors: unknown[] = [];
  const queue = new PreviewQueue(() => {}, e => errors.push(e));
  const started = deferred(); let attempts = 0, running = 0;
  queue.enqueue('movie', async signal => {
    assert.equal(++running, 1);
    trace.push(`movie${++attempts}`); started.resolve();
    if (attempts === 1) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    --running;
  });
  await started.promise;
  queue.enqueue('frame', async () => { trace.push('obsolete'); }, 50);
  queue.enqueue('frame', async () => { assert.equal(running, 0); trace.push('latest'); });
  await queue.whenIdle();
  assert.deepEqual(trace, ['movie1', 'latest', 'movie2']);
  assert.deepEqual(errors, []);
});

test('completed frame survives a later task error; cancellation clears deferred work', async () => {
  const completed: string[] = [], errors: unknown[] = [];
  const queue = new PreviewQueue(() => {}, error => errors.push(error));
  queue.enqueue('frame', async () => { completed.push('frame'); });
  queue.enqueue('timeline', async () => { throw new Error('timeline failed'); });
  await queue.whenIdle();
  assert.deepEqual(completed, ['frame']); assert.equal(errors.length, 1);
  queue.enqueue('movie', async () => { completed.push('movie'); }, 100);
  queue.clear(); await queue.whenIdle();
  assert.deepEqual(completed, ['frame']); assert.equal(queue.busy, false);
});
