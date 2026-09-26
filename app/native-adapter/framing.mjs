import { once } from 'node:events';

// Only adapter-owned RPC responses may be consumed by an internal broker.
export const CONSUME_FRAME = Symbol('consume-adapter-owned-response');

async function write(destination, bytes) {
  if (!destination.write(bytes)) await once(destination, 'drain');
}

// Unchanged frames are forwarded byte-for-byte, including whitespace and CRLF.
export async function relayJsonLines(source, destination, transform = async () => null, { scheduler, onCancelled, onTransformError, observe } = {}) {
  let pending = Buffer.alloc(0);
  const running = new Set();
  let failed;
  async function relayFrame(frame, parsed, context = {}) {
    let replacement;
    try { replacement = parsed && typeof parsed === 'object' ? await transform(parsed, context) : null; }
    catch (error) {
      if (context.signal?.aborted) { await onCancelled?.(parsed); return; }
      if (onTransformError && await onTransformError(parsed, error)) return;
      throw error;
    }
    if (context.signal?.aborted) {
      await onCancelled?.(parsed);
      return;
    }
    if (replacement === CONSUME_FRAME) return;
    const ending = frame.at(-1) === 10 ? (frame.at(-2) === 13 ? '\r\n' : '\n') : '';
    const output = replacement === null || replacement === undefined || replacement === parsed
      ? frame : Buffer.from(JSON.stringify(replacement) + ending);
    await write(destination, output);
  }
  function dispatch(frame) {
    let parsed;
    try { parsed = JSON.parse(frame.toString('utf8')); } catch { }
    observe?.(parsed);
    if (!scheduler) return relayFrame(frame, parsed);
    const work = scheduler.run(parsed, context => relayFrame(frame, parsed, context), frame.length);
    const tracked = work.catch(error => { failed ??= error; source.destroy(error); }).finally(() => running.delete(tracked));
    running.add(tracked);
  }
  try {
    for await (const chunk of source) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk);
      if (pending.length > 64 * 1024 * 1024) throw new Error('App-server frame exceeds bridge limit');
      let newline;
      while ((newline = pending.indexOf(10)) !== -1) {
        const frame = pending.subarray(0, newline + 1);
        pending = pending.subarray(newline + 1);
        await dispatch(frame);
      }
    }
    // A complete final JSON value still gets the overlay; partial bytes pass as-is.
    if (pending.length) await dispatch(pending);
  } finally { await Promise.all(running); }
  if (failed) throw failed;
}
