class RequestError extends Error { constructor(message, info) { super(message); Object.assign(this, info); } }
const cancelled = () => new DOMException('Request cancelled', 'AbortError');
function checkAbort(signal) { if (signal?.aborted) throw cancelled(); }
function sleep(ms, signal) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); reject(cancelled()); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

// One deadline for the entire operation, including offline waits, response bodies and retries.
// Racing the signal also handles a stalled body reader or a fetch implementation ignoring abort.
async function withDeadline(opts, defaultMs, run) {
  checkAbort(opts.signal);
  const ms = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : defaultMs;
  const ctrl = new AbortController();
  let expired = false;
  const abort = () => ctrl.abort();
  opts.signal?.addEventListener('abort', abort, { once: true });
  let rejectAbort;
  const stopped = new Promise((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(expired
    ? new RequestError('Нейросеть слишком долго не отвечает. Попробуйте снова.', { code: 'REQUEST_TIMEOUT', retryable: true })
    : cancelled());
  ctrl.signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => { expired = true; ctrl.abort(); }, ms);
  const scoped = { ...opts, signal: ctrl.signal,
    onStatus: (...args) => { if (!ctrl.signal.aborted) opts.onStatus?.(...args); },
    onText: (...args) => { if (!ctrl.signal.aborted) opts.onText?.(...args); },
  };
  try { return await Promise.race([Promise.resolve().then(() => run(scoped)), stopped]); }
  finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', abort);
    ctrl.signal.removeEventListener('abort', onAbort);
    ctrl.abort();
  }
}

function waitOnline(signal) {
  checkAbort(signal);
  if (navigator.onLine !== false) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => { window.removeEventListener('online', online); signal?.removeEventListener('abort', abort); };
    const online = () => { cleanup(); resolve(); };
    const abort = () => { cleanup(); reject(cancelled()); };
    window.addEventListener('online', online, { once: true });
    signal?.addEventListener('abort', abort, { once: true });
  });
}


export { withDeadline, sleep, waitOnline, checkAbort };
