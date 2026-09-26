// Diagnostic jobs cannot throw into the protocol relay. Same-key work is
// coalesced, concurrency is bounded, and failures never contain user data.
export function createBackgroundWork({ concurrency = 2, maxQueued = 128, onError = () => {} } = {}) {
  const queued = new Map(), active = new Set(), drains = new Set();
  let closed = false;
  function pump() {
    for (const [key, job] of queued) {
      if (active.size >= concurrency) break;
      if (active.has(key)) continue;
      queued.delete(key); active.add(key);
      Promise.resolve().then(job).catch(error => { try { onError(key, error); } catch {} }).finally(() => {
        active.delete(key); pump();
        if (!active.size && !queued.size) { for (const resolve of drains) resolve(); drains.clear(); }
      });
    }
  }
  function enqueue(key, job) {
    if (closed || typeof job !== 'function' || (!queued.has(key) && queued.size >= maxQueued)) return false;
    queued.set(key, job); pump(); return true;
  }
  function drain(timeoutMs = 1000) {
    if (!active.size && !queued.size) return Promise.resolve();
    return new Promise(resolve => {
      const finish = () => { clearTimeout(timer); drains.delete(finish); resolve(); };
      const timer = setTimeout(finish, timeoutMs);
      drains.add(finish);
    });
  }
  function close() { closed = true; queued.clear(); }
  return { enqueue, drain, close, cancel: key => queued.delete(key) };
}
