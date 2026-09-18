import { once } from 'node:events';

// Only adapter-owned RPC responses may be consumed by an internal broker.
export const CONSUME_FRAME = Symbol('consume-adapter-owned-response');

async function write(destination, bytes) {
  if (!destination.write(bytes)) await once(destination, 'drain');
}

// Unchanged frames are forwarded byte-for-byte, including whitespace and CRLF.
export async function relayJsonLines(source, destination, transform = async () => null) {
  let pending = Buffer.alloc(0);
  async function relayFrame(frame) {
    let parsed;
    try { parsed = JSON.parse(frame.toString('utf8')); } catch { }
    const replacement = parsed && typeof parsed === 'object' ? await transform(parsed) : null;
    if (replacement === CONSUME_FRAME) return;
    const ending = frame.at(-1) === 10 ? (frame.at(-2) === 13 ? '\r\n' : '\n') : '';
    const output = replacement === null || replacement === undefined || replacement === parsed
      ? frame : Buffer.from(JSON.stringify(replacement) + ending);
    await write(destination, output);
  }
  for await (const chunk of source) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk);
    if (pending.length > 64 * 1024 * 1024) throw new Error('App-server frame exceeds bridge limit');
    let newline;
    while ((newline = pending.indexOf(10)) !== -1) {
      const frame = pending.subarray(0, newline + 1);
      pending = pending.subarray(newline + 1);
      await relayFrame(frame);
    }
  }
  // A complete final JSON value still gets the overlay; partial bytes pass as-is.
  if (pending.length) await relayFrame(pending);
}
