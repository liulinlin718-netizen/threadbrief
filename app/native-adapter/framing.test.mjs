import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { relayJsonLines } from './framing.mjs';

async function relay(chunks, transform) {
  const output = [];
  const destination = new Writable({ write(chunk, encoding, callback) { output.push(Buffer.from(chunk)); callback(); } });
  await relayJsonLines(Readable.from(chunks), destination, transform);
  return Buffer.concat(output);
}
test('no-op preserves original bytes across UTF-8, chunk boundaries and final partial frames', async () => {
  const input = Buffer.from(' {"id":1, "text":"中文"} \r\n\nnot-json\n{"tail":');
  const chunks = Array.from(input, byte => Buffer.from([byte]));
  assert.deepEqual(await relay(chunks, async message => message), input);
});
test('only transformed frames are reserialized in sequence', async () => {
  const input = Buffer.from(' {"id":1} \r\n {"id":2} \n');
  const output = await relay([input], async message => message.id === 1 ? { ...message, addition: 'x' } : null);
  assert.equal(output.toString(), '{"id":1,"addition":"x"}\r\n {"id":2} \n');
});
test('transform rejection is surfaced instead of silently dropping the overlay', async () => {
  await assert.rejects(relay([Buffer.from('{"id":1}\n')], async () => { throw new Error('store unavailable'); }), /store unavailable/);
});
test('a complete final JSON frame without newline still gets transformed', async () => {
  assert.equal((await relay([Buffer.from('{"id":1}')], async value => ({ ...value, checked: true }))).toString(), '{"id":1,"checked":true}');
});
