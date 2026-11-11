import { GeminiError } from '../js/gemini.js';

export default async ({ open, ok }) => {
  const origin = new SyntaxError('broken JSON near token 7');
  const wrapped = new GeminiError('Неправильный JSON', { code: 'BAD_JSON', cause: origin });
  ok(wrapped.cause === origin && wrapped.code === 'BAD_JSON',
    'GeminiError preserves the underlying parsing cause for diagnostics');
  const { page } = await open({ freeProxy: 'https://storage-proxy.test' });
  const states = await page.evaluate(async () => {
    const config = await import('./js/config.js');
    const storage = await import('./js/storage.js');
    const originalSet = Storage.prototype.setItem;
    let events = [];
    window.addEventListener('kd-storage-state', e => events.push(e.detail.failed));
    Storage.prototype.setItem = function(k,v) {
      if (k === 'kd.freeProxyOk') throw Error('quota');
      return originalSet.call(this,k,v);
    };
    try {
      config.useFreeProxy('https://storage-proxy.test');
    } finally { Storage.prototype.setItem = originalSet; }
    const failedProxy = storage.storageFailures.has('kd.freeProxyOk');
    config.useFreeProxy('https://storage-proxy.test');
    const recoveredProxy = !storage.storageFailures.has('kd.freeProxyOk');
    const origRemove = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function(k) {
      if (k === 'kd.progress:theory') throw Error('quota');
      return origRemove.call(this,k);
    };
    let failedProgress;
    try { failedProgress = storage.clearProgress('theory'); }
    finally { Storage.prototype.removeItem = origRemove; }
    const trackedProgress = storage.storageFailures.has('kd.progress:theory');
    const recoveredProgress = storage.clearProgress('theory') &&
      !storage.storageFailures.has('kd.progress:theory');
    return { failedProxy, recoveredProxy, failedProgress, trackedProgress, recoveredProgress, events };
  });
  ok(states.failedProxy && states.recoveredProxy && states.events.includes(true) &&
    states.events.includes(false), 'config persistence failures appear and clear in shared warning state');
  ok(states.failedProgress === false && states.trackedProgress && states.recoveredProgress,
    'clearProgress reports failure and success consistently with saveProgress');
};
