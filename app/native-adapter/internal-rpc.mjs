import { randomUUID } from 'node:crypto';
import { CONSUME_FRAME } from './framing.mjs';

// Separate adapter RPCs from the desktop's request namespace. Neither desktop
// requests nor server requests/notifications are consumed or reserialized.
export function createInternalRpc({ write, methods, timeoutMs = 15000 }) {
  const prefix = `threadbrief:${randomUUID()}:`;
  const allowed = new Set(methods);
  const pending = new Map();
  const sent = new Set();
  let sequence = 0;
  let closed = false;
  const call = (method, params) => {
    if (closed) return Promise.reject(new Error('Internal RPC transport closed'));
    if (!allowed.has(method)) return Promise.reject(new Error('Internal RPC method not allowed'));
    const id = `${prefix}${++sequence}`;
    sent.add(id);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Object.assign(new Error('Internal RPC timed out'), { code: 'INTERNAL_RPC_TIMEOUT' }));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        // Writable.write enqueues this complete frame atomically, even when the
        // transparent relay is waiting for stream backpressure to clear.
        write(Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'));
      } catch (error) {
        pending.delete(id); clearTimeout(timer); reject(error);
      }
    });
  };
  const consume = message => {
    if (message.method !== undefined || !sent.has(message.id)) return null;
    const request = pending.get(message.id);
    if (request) {
      pending.delete(message.id); clearTimeout(request.timer);
      request.resolve(message);
    }
    // A late or duplicate adapter response must not leak to the desktop.
    return CONSUME_FRAME;
  };
  const observeClient = message => {
    if (message.method && sent.has(message.id)) throw new Error('Internal RPC request ID collision');
  };
  const close = () => {
    closed = true;
    for (const request of pending.values()) {
      clearTimeout(request.timer); request.reject(new Error('Internal RPC transport closed'));
    }
    pending.clear();
  };
  return { call, consume, observeClient, close };
}
