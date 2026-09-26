import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { setImmediate as tick } from 'node:timers/promises';
import { relayJsonLines } from './framing.mjs';
import { createTaskScheduler } from './task-scheduler.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const frame = (id, method, threadId) => ({ id, method, params: { threadId } });
function fixture(transform, options = {}) {
  const source = new PassThrough(), seen = [], rejected = [];
  const destination = new Writable({ write(bytes, encoding, done) { seen.push(bytes.toString()); done(); } });
  const onReject = (message, code) => rejected.push({ id: message.id, code });
  const complete = relayJsonLines(source, destination, transform, {
    scheduler: createTaskScheduler({ ...options, onReject }), onCancelled: message => onReject(message, 'REQUEST_CANCELLED'),
    onTransformError: options.onTransformError,
  });
  return { source, seen, rejected, complete,
    send: (...frames) => source.write(frames.map(value => ` ${JSON.stringify(value)} \r\n`).join('')),
    ids: () => seen.map(raw => JSON.parse(raw).id) };
}

test('another task and interrupt pass a stalled task, even in later stream chunks', async () => {
  const gate = deferred(), entered = deferred();
  const f = fixture(async message => { if (message.id === 1) { entered.resolve(); await gate.promise; } return null; });
  try {
    f.send(frame(1, 'turn/start', 'A')); await entered.promise;
    f.send(frame(2, 'turn/start', 'B'), frame(3, 'turn/interrupt', 'B'));
    await tick(); await tick();
    assert.ok(f.ids().includes(3), 'B cancellation must not wait for A');
    assert.ok(!f.ids().includes(1));
  } finally { gate.resolve(); f.source.end(); await f.complete; }
  assert.ok(f.ids().includes(1));
});

test('same-task stop prevents both preparing and queued starts from launching later', async () => {
  const gate = deferred(), entered = deferred();
  const f = fixture(async message => { if (message.id === 1) { entered.resolve(); await gate.promise; } return null; });
  try {
    f.send(frame(1, 'turn/start', 'A')); await entered.promise;
    f.send(frame(2, 'turn/start', 'A'), frame(3, 'turn/interrupt', 'A'));
    await tick(); assert.deepEqual(f.ids(), [3]);
  } finally { gate.resolve(); f.source.end(); await f.complete; }
  assert.deepEqual(f.ids(), [3]);
  assert.deepEqual(f.rejected.map(x => x.id).sort(), [1, 2]);
  assert.ok(f.rejected.every(x => x.code === 'REQUEST_CANCELLED'));
});

test('initialization and same-task ordering remain intact and unchanged frames retain bytes', async () => {
  const gate = deferred(), entered = deferred();
  const f = fixture(async message => { if (message.id === 0) { entered.resolve(); await gate.promise; } return null; });
  const frames = [frame(0, 'initialize'), frame(1, 'turn/start', 'A'), frame(2, 'turn/steer', 'A')];
  f.send(...frames); await entered.promise; await tick(); assert.deepEqual(f.ids(), []);
  gate.resolve(); f.source.end(); await f.complete;
  assert.deepEqual(f.ids(), [0, 1, 2]);
  assert.equal(f.seen.join(''), frames.map(value => ` ${JSON.stringify(value)} \r\n`).join(''));
});

test('bounded task queue rejects overload while cancellation and backend approval replies pass', async () => {
  const gate = deferred(), entered = deferred();
  const f = fixture(async message => { if (message.id === 1) { entered.resolve(); await gate.promise; } return null; }, { maxPending: 1 });
  f.send(frame(1, 'turn/start', 'A')); await entered.promise;
  f.send(frame(2, 'turn/start', 'B'), { id: 9, result: { approved: true } }, frame(3, 'turn/interrupt', 'A'));
  await tick(); await tick();
  assert.ok(f.ids().includes(9)); assert.ok(f.ids().includes(3));
  assert.ok(f.rejected.some(x => x.id === 2 && x.code === 'ADAPTER_BUSY'));
  gate.resolve(); f.source.end(); await f.complete;
});

test('a task preparation failure is contained and its next request and other tasks continue', async () => {
  const errors = [];
  const f = fixture(async message => { if (message.id === 1) throw new Error('fixture disk failure'); return null; }, {
    onTransformError: message => { errors.push(message.id); return true; },
  });
  f.send(frame(1, 'turn/start', 'A'), frame(2, 'turn/start', 'A'), frame(3, 'turn/start', 'B'));
  f.source.end(); await f.complete;
  assert.deepEqual(errors, [1]); assert.deepEqual(f.ids().sort(), [2, 3]);
});
