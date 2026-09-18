import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { createInternalRpc } from './internal-rpc.mjs';
import { relayJsonLines, CONSUME_FRAME } from './framing.mjs';

test('internal responses disappear while desktop bytes and server notifications are exact', async () => {
  const writes = [], received = [];
  const broker = createInternalRpc({ write: bytes => writes.push(JSON.parse(bytes)), methods: ['mcpServerStatus/list'] });
  const result = broker.call('mcpServerStatus/list', { limit: 100 });
  const id = writes[0].id;
  const before = ' {"id":9, "result": {"ok":true}} \r\n';
  const after = ` {"id":"${id}","method":"server/request","params":{}} \n{"method":"thread/started"}\n`;
  await relayJsonLines(Readable.from([before + JSON.stringify({ id, result: { data: [] } }) + '\n' + after]),
    new Writable({ write(bytes, _, done) { received.push(Buffer.from(bytes)); done(); } }), broker.consume);
  assert.deepEqual((await result).result, { data: [] });
  assert.equal(Buffer.concat(received).toString(), before + after);
  assert.equal(broker.consume({ id: 'threadbrief:unknown:1', result: {} }), null);
  assert.equal(broker.consume({ id, result: {} }), CONSUME_FRAME);
  broker.close();
});

test('timeouts consume late replies; close rejects pending calls and blocks new requests', async () => {
  const writes = [];
  const broker = createInternalRpc({ write: bytes => writes.push(JSON.parse(bytes)), methods: ['read'], timeoutMs: 5 });
  await assert.rejects(broker.call('read', {}), { code: 'INTERNAL_RPC_TIMEOUT' });
  assert.equal(broker.consume({ id: writes[0].id, result: {} }), CONSUME_FRAME);
  const pending = broker.call('read', {});
  broker.close();
  await assert.rejects(pending, /transport closed/);
  await assert.rejects(broker.call('read', {}), /transport closed/);
});

test('method whitelist and namespace collision fail without sending an unapproved frame', async () => {
  const writes = [];
  const broker = createInternalRpc({ write: bytes => writes.push(JSON.parse(bytes)), methods: ['read'] });
  await assert.rejects(broker.call('turn/start', {}), /not allowed/);
  assert.equal(writes.length, 0);
  const pending = broker.call('read', {});
  assert.throws(() => broker.observeClient({ id: writes[0].id, method: 'read' }), /collision/);
  broker.close(); await assert.rejects(pending, /closed/);
});
