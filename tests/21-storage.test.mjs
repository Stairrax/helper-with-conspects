// Fault injection: IDB quotas, aborted transactions, localStorage quotas and retries.
export default async ({ open, ok }) => {
  const { page } = await open();
  const result = await page.evaluate(async () => {
    const s = await import('./js/storage.js');
    const put = IDBObjectStore.prototype.put;
    const set = Storage.prototype.setItem;
    const key = 'audit-storage';
    await s.idbSet(key, { revision: 1 });
    IDBObjectStore.prototype.put = function(value, k) {
      if (k === key) throw new DOMException('quota', 'QuotaExceededError');
      return put.call(this, value, k);
    };
    const fallbackSaved = await s.idbSet(key, { revision: 2 });
    const fallbackRead = (await s.idbGet(key)).revision;
    const backupRead = (await s.makeBackup()).idb[key].revision;
    IDBObjectStore.prototype.put = put;
    await s.idbSet(key, { revision: 3 });
    const recoveredRead = (await s.idbGet(key)).revision;
    const fallbackRemoved = localStorage.getItem('kd.idb.' + key) === null;

    // Even rapid writes must snapshot the data at the time they were requested.
    const value = { revision: 4 };
    const first = s.idbSet(key, value);
    value.revision = 5;
    const second = s.idbSet(key, value);
    value.revision = 999;
    await Promise.all([first, second]);
    const ordered = (await s.idbGet(key)).revision;

    IDBObjectStore.prototype.put = function(value, k) {
      if (k === key) { this.transaction.abort(); return undefined; }
      return put.call(this, value, k);
    };
    Storage.prototype.setItem = function(k, value) {
      if (k === 'kd.idb.' + key || k === 'kd.settings') throw new DOMException('quota', 'QuotaExceededError');
      return set.call(this, k, value);
    };
    const failed = await s.idbSet(key, { revision: 6 });
    const settingsFailed = s.saveSettings({});
    const warned = !document.getElementById('storageWarning').classList.contains('hidden');
    const stillOld = (await s.idbGet(key)).revision;
    IDBObjectStore.prototype.put = put;
    Storage.prototype.setItem = set;
    await s.idbSet(key, { revision: 7 });
    const otherFailureRemains = !document.getElementById('storageWarning').classList.contains('hidden');
    s.saveSettings(s.loadSettings());
    const warningCleared = document.getElementById('storageWarning').classList.contains('hidden');

    // An unsuccessful open must not poison the cached connection forever.
    const openDB = indexedDB.open.bind(indexedDB);
    let attempts = 0;
    indexedDB.open = (...args) => {
      attempts++;
      if (attempts === 1) {
        const req = { error: new DOMException('blocked', 'UnknownError') };
        setTimeout(() => req.onerror(), 0);
        return req;
      }
      return openDB(...args);
    };
    const fresh = await import('./js/storage.js?connection-retry');
    await fresh.idbSet('retry-open', { ok: true });
    await fresh.idbSet('retry-open', { ok: false });
    indexedDB.open = openDB;
    return { fallbackSaved, fallbackRead, backupRead, recoveredRead, fallbackRemoved, ordered,
      failed, settingsFailed, warned, stillOld, otherFailureRemains, warningCleared, attempts };
  });
  ok(result.fallbackSaved && result.fallbackRead === 2, 'после отказа IDB читается новая запасная запись');
  ok(result.backupRead === 2, 'резервная копия содержит актуальные запасные данные');
  ok(result.recoveredRead === 3 && result.fallbackRemoved, 'успешная запись IDB убирает устаревший fallback');
  ok(result.ordered === 5, 'быстрые записи сохраняют снимки в порядке вызова');
  ok(result.failed === false && result.settingsFailed === false && result.warned && result.stillOld === 5, 'отказ обоих хранилищ: нет ложного успеха, старые данные целы, предупреждение видно');
  ok(result.otherFailureRemains && result.warningCleared, 'успех одного ключа не скрывает ошибку другого');
  ok(result.attempts === 2, 'после отказа открытия IDB подключение пробуется снова');
  const readFailure = await page.evaluate(async () => {
    const s = await import('./js/storage.js');
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function(...args) {
      if (args[1] === 'readonly') throw new DOMException('unavailable', 'UnknownError');
      return transaction.apply(this, args);
    };
    const rejects = async (fn) => { try { await fn(); return false; } catch { return true; } };
    try { return { read: await rejects(() => s.idbGet('unreadable')), backup: await rejects(() => s.makeBackup()) }; }
    finally { IDBDatabase.prototype.transaction = transaction; }
  });
  ok(readFailure.read && readFailure.backup, 'ошибка чтения не превращается в пустой предмет или неполную резервную копию');

  const importResult = await page.evaluate(async () => {
    window.__savedPut = IDBObjectStore.prototype.put;
    window.__savedSet = Storage.prototype.setItem;
    const before = localStorage.getItem('kd.subjects');
    IDBObjectStore.prototype.put = function(value, key) {
      if (String(key).startsWith('project:')) throw new DOMException('quota', 'QuotaExceededError');
      return window.__savedPut.call(this, value, key);
    };
    Storage.prototype.setItem = function(key, value) {
      if (key.startsWith('kd.idb.project:')) throw new DOMException('quota', 'QuotaExceededError');
      return window.__savedSet.call(this, key, value);
    };
    return before;
  });
  await page.locator('#importInput').setInputFiles({
    name: 'notes.konspekt.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ format: 'konspekt-diktor', project: {
      topics: [{ id: 't', title: 'Test', status: 'ready', chunks: [{ t: 'Test' }] }],
    } })),
  });
  await page.waitForFunction(() => document.getElementById('toast').textContent.includes('Не получилось открыть'));
  ok(await page.evaluate(() => localStorage.getItem('kd.subjects')) === importResult, 'отказ импорта не публикует пустой предмет и не меняет список сохранённых');
  await page.evaluate(() => {
    IDBObjectStore.prototype.put = window.__savedPut;
    Storage.prototype.setItem = window.__savedSet;
  });

  const english = await open({ settings: { uiLang: 'en' }, locale: 'en-US' });
  await english.page.evaluate(async () => {
    const s = await import('./js/storage.js');
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new DOMException('quota', 'QuotaExceededError'); };
    s.saveSettings({});
    Storage.prototype.setItem = original;
  });
  ok(await english.page.locator('#storageWarning').isVisible() &&
    (await english.page.textContent('#storageWarning')).includes('Changes could not be saved'), 'предупреждение о сохранении доступно и на английском');
};
