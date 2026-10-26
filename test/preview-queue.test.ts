import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PreviewQueue } from '../src/preview-queue';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('latest inspection preempts the render, joins it, then resumes background work', async () => {
  const trace: string[] = [], errors: unknown[] = [];
  const queue = new PreviewQueue(() => {}, e => errors.push(e));
  const started = deferred(); let attempts = 0, running = 0;
  queue.enqueue('render', async signal => {
    assert.equal(++running, 1);
    trace.push(`movie${++attempts}`); started.resolve();
    if (attempts === 1) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    --running;
  });
  await started.promise;
  queue.enqueue('inspect', async () => { trace.push('obsolete'); }, 50);
  queue.enqueue('inspect', async () => { assert.equal(running, 0); trace.push('latest'); });
  await queue.whenIdle();
  assert.deepEqual(trace, ['movie1', 'latest', 'movie2']);
  assert.deepEqual(errors, []);
});

test('explicit export joins background work and defers coalesced seeks until release', async () => {
  const trace: string[] = [], joined = deferred();
  const queue = new PreviewQueue(() => {}, error => { throw error; });
  let attempts = 0;
  queue.enqueue('render', async signal => {
    trace.push(`movie${++attempts}`);
    if (attempts === 1) {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      await joined.promise; trace.push('purged');
    }
  });
  const held = queue.suspend();
  queue.enqueue('inspect', async () => { trace.push('obsolete'); });
  queue.enqueue('inspect', async () => { trace.push('latest'); });
  assert.deepEqual(trace, ['movie1']);
  joined.resolve(); const release = await held;
  trace.push('export');
  assert.deepEqual(trace, ['movie1', 'purged', 'export']);
  release(); await queue.whenIdle();
  assert.deepEqual(trace, ['movie1', 'purged', 'export', 'latest', 'movie2']);
});

test('completed inspection survives a later task error; cancellation clears deferred work', async () => {
  const completed: string[] = [], errors: unknown[] = [];
  const queue = new PreviewQueue(() => {}, error => errors.push(error));
  queue.enqueue('inspect', async () => { completed.push('frame'); });
  queue.enqueue('render', async () => { throw new Error('render failed'); });
  await queue.whenIdle();
  assert.deepEqual(completed, ['frame']); assert.equal(errors.length, 1);
  queue.enqueue('render', async () => { completed.push('movie'); }, 100);
  queue.clear(); await queue.whenIdle();
  assert.deepEqual(completed, ['frame']); assert.equal(queue.busy, false);
});

test('a frame waits for a running timeline inspection but replaces a running frame', async () => {
  const trace: string[] = [];
  const queue = new PreviewQueue(() => {}, error => { throw error; });
  const started = deferred(), release = deferred();
  queue.enqueue('inspect', async signal => { trace.push('inspect'); started.resolve(); await release.promise; if (signal.aborted) trace.push('inspect stopped'); });
  await started.promise;
  queue.enqueue('frame', async () => { trace.push('frame 1'); });
  queue.enqueue('frame', async () => { trace.push('frame 2'); });
  release.resolve(); await queue.whenIdle();
  assert.deepEqual(trace, ['inspect', 'frame 2']);
  const running = deferred();
  queue.enqueue('frame', async signal => {
    trace.push('frame 3'); running.resolve();
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    trace.push('frame 3 stopped');
  });
  await running.promise;
  queue.enqueue('frame', async () => { trace.push('frame 4'); });
  await queue.whenIdle();
  assert.deepEqual(trace.slice(2), ['frame 3', 'frame 3 stopped', 'frame 4']);
});

test('a render that runs longer than the patience finishes before a frame', async () => {
  const trace: string[] = [];
  const queue = new PreviewQueue(() => {}, error => { throw error; }, 20);
  const running = deferred(), release = deferred();
  queue.enqueue('render', async signal => { trace.push('render'); running.resolve(); await release.promise; trace.push(signal.aborted ? 'render stopped' : 'render done'); });
  await running.promise; await new Promise(resolve => setTimeout(resolve, 40));
  queue.enqueue('frame', async () => { trace.push('frame'); });
  release.resolve(); await queue.whenIdle();
  assert.deepEqual(trace, ['render', 'render done', 'frame']);
});
