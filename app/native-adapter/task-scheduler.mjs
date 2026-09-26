// Preserve ordering inside a task while unrelated tasks and cancellation keep
// moving. Initialization and unknown control messages remain global barriers.
export function createTaskScheduler({ onReject, maxPending = 512, maxPendingBytes = 64 * 1024 * 1024 } = {}) {
  const lanes = new Map(), entries = new Set();
  let barrier = Promise.resolve();
  let initialization = barrier;
  let pendingBytes = 0;
  const reject = (message, code) => {
    if (typeof onReject !== 'function') throw new Error(code);
    return onReject(message, code);
  };
  function run(message, job, bytes = 0) {
    const threadId = typeof message?.params?.threadId === 'string' ? message.params.threadId : null;
    const interrupt = message?.method === 'turn/interrupt' && threadId;
    const reply = message && message.method === undefined && message.id !== undefined;
    const scoped = threadId && /^(?:turn\/|thread\/(?:resume|fork|read|unsubscribe)|mcpServer\/tool\/call)/u.test(message?.method || '');
    if (interrupt) {
      // An interrupt also cancels starts already queued/preparing for this task.
      // They have no backend turn id yet and must never start after the stop.
      for (const entry of entries) if (entry.threadId === threadId && entry.message?.method === 'turn/start') entry.controller.abort();
    }
    if ((entries.size >= maxPending || pendingBytes + bytes > maxPendingBytes) && !interrupt && !reply && message?.id !== undefined && message?.method) {
      return Promise.resolve(reject(message, 'ADAPTER_BUSY'));
    }
    const controller = new AbortController();
    const entry = { threadId, message, controller };
    const before = interrupt || reply ? initialization : scoped ? lanes.get(threadId) || barrier
      : Promise.all([barrier, ...lanes.values()]);
    entries.add(entry);
    pendingBytes += bytes;
    const task = before.then(async () => {
      if (controller.signal.aborted) return reject(message, 'REQUEST_CANCELLED');
      await job({ signal: controller.signal });
    });
    // Cleanup promises never mask an original rejection or create an unhandled
    // secondary rejection. The relay owns reporting actual transport errors.
    const settled = task.catch(() => {}).finally(() => {
      entries.delete(entry);
      pendingBytes -= bytes;
      if (lanes.get(threadId) === settled) lanes.delete(threadId);
    });
    if (scoped && !interrupt) lanes.set(threadId, settled);
    else if (!reply && !interrupt) { barrier = settled; lanes.clear(); }
    if (['initialize', 'initialized'].includes(message?.method)) initialization = settled;
    return task;
  }
  return { run };
}
