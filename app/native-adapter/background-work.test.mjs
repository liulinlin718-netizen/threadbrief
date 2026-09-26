import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundWork } from './background-work.mjs';

test('failed diagnostics are isolated and bounded same-key writes finish with newest state', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const writes = [], failures = [];
  const work = createBackgroundWork({ concurrency: 1, maxQueued: 2, onError: key => failures.push(key) });
  work.enqueue('active', () => gate);
  work.enqueue('status', () => writes.push('old'));
  work.enqueue('status', () => writes.push('new'));
  work.enqueue('bad-log', () => { throw new Error('Disk unavailable'); });
  assert.equal(work.enqueue('overflow', () => writes.push('overflow')), false);
  release(); await work.drain();
  assert.deepEqual(writes, ['new']); assert.deepEqual(failures, ['bad-log']);
  work.enqueue('status', () => writes.push('recovered')); await work.drain();
  assert.deepEqual(writes, ['new', 'recovered']);
});

test('shutdown deadline and cancelled queued work do not hang on a stalled job', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const work = createBackgroundWork({ concurrency: 1 });
  work.enqueue('stalled', () => gate);
  work.enqueue('closed-task', () => assert.fail('Closed task must not refresh'));
  work.cancel('closed-task'); await work.drain(10); work.close();
  assert.equal(work.enqueue('late', () => {}), false);
  release(); await work.drain();
});
