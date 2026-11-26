export default async ({ open, prepare, FINANCE, ok }) => {
  const { page } = await open();
  const result = await page.evaluate(async () => {
    const s = await import('./js/storage.js');
    const key = 'ordered-delete';
    const first = s.idbSet(key, { revision: 1 });
    const second = s.idbSet(key, { revision: 2 });
    const deleted = s.idbDel(key);
    const results = await Promise.all([first, second, deleted]);
    const absent = await s.idbGet(key) === undefined;
    const remove = s.idbDel(key);
    const recreate = s.idbSet(key, { revision: 3 });
    await Promise.all([remove, recreate]);
    const recreated = (await s.idbGet(key)).revision;
    const originalDelete = IDBObjectStore.prototype.delete;
    let failed;
    try {
      IDBObjectStore.prototype.delete = function(k) {
        if (k === key) throw new DOMException('unavailable', 'UnknownError');
        return originalDelete.call(this, k);
      };
      failed = await s.idbDel(key);
    } finally {
      IDBObjectStore.prototype.delete = originalDelete;
    }
    const preserved = (await s.idbGet(key)).revision;
    const warned = s.storageFailures.has('idb:' + key);
    const cleaned = await s.idbDel(key);
    const warningCleared = !s.storageFailures.has('idb:' + key);

    const a = 'batch-a', b = 'batch-b';
    await Promise.all([s.idbSet(a, 1), s.idbSet(b, 2)]);
    let batchFailed;
    try {
      IDBObjectStore.prototype.delete = function(k) {
        if (k === b) throw new DOMException('unavailable', 'UnknownError');
        return originalDelete.call(this, k);
      };
      batchFailed = await s.idbDelMany([a, b]);
    } finally {
      IDBObjectStore.prototype.delete = originalDelete;
    }
    const batchPreserved = (await s.idbGet(a)) === 1 && (await s.idbGet(b)) === 2;
    await s.idbDelMany([a, b]);

    const fallback = 'delete-fallback';
    await s.idbSet(fallback, 1);
    localStorage.setItem('kd.idb.' + fallback, '2');
    const originalRemove = Storage.prototype.removeItem;
    let fallbackFailed;
    try {
      Storage.prototype.removeItem = function(k) {
        if (k === 'kd.idb.' + fallback) throw new DOMException('unavailable', 'UnknownError');
        return originalRemove.call(this, k);
      };
      fallbackFailed = await s.idbDel(fallback);
    } finally {
      Storage.prototype.removeItem = originalRemove;
    }
    const fallbackPreserved = await s.idbGet(fallback) === 2;
    await s.idbDel(fallback);

    const revision = 'backup-revision';
    await s.idbSet(revision, { value: 1 });
    localStorage.setItem('kd.auditRevision', '1');
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const live = { value: 1 };
    let backup;
    {
      const capture = s.makeBackup(() => {
        entered();
        return { idb: { 'live-notes': live }, localStorage: { 'kd.liveRevision': '1' } };
      });
      await started;
      const lateWrite = s.idbSet(revision, { value: 2 });
      localStorage.setItem('kd.auditRevision', '2');
      live.value = 2;
      const after = s.makeBackup();
      const during = await capture;
      const secondBackup = await after;
      await lateWrite;
      backup = { during, secondBackup };
    }
    const originalCursor = IDBObjectStore.prototype.openCursor;
    let rejected = false;
    try {
      IDBObjectStore.prototype.openCursor = function() { throw new DOMException('unavailable', 'UnknownError'); };
      try { await s.makeBackup(); } catch { rejected = true; }
    } finally {
      IDBObjectStore.prototype.openCursor = originalCursor;
    }
    const unlocked = await s.idbSet(revision, { value: 3 });
    return { results, absent, recreated, failed, preserved, warned, cleaned, warningCleared,
      batchFailed, batchPreserved, fallbackFailed, fallbackPreserved,
      firstRevision: backup.during.idb[revision].value, firstLocal: backup.during.localStorage['kd.auditRevision'],
      liveValue: backup.during.idb['live-notes'].value, secondRevision: backup.secondBackup.idb[revision].value,
      secondLocal: backup.secondBackup.localStorage['kd.auditRevision'], rejected, unlocked };
  });
  ok(result.results.every(Boolean) && result.absent, 'queued delete runs after earlier writes without resurrecting the record');
  ok(result.recreated === 3, 'later explicit write runs after the delete');
  ok(result.failed === false && result.preserved === 3 && result.warned && result.cleaned && result.warningCleared, 'failed delete reports failure and retains the record until retry');
  ok(result.batchFailed === false && result.batchPreserved, 'failed multi-key IDB deletion rolls back the whole transaction');
  ok(result.fallbackFailed === false && result.fallbackPreserved, 'fallback removal failure is not reported as success');
  ok(result.firstRevision === 1 && result.firstLocal === '1' && result.liveValue === 1, 'backup freezes queued mutations and clones live data at the snapshot boundary');
  ok(result.secondRevision === 2 && result.secondLocal === '2', 'a concurrent second backup waits for preceding queued writes');
  ok(result.rejected && result.unlocked, 'backup failure releases the mutation barrier');

  const phone = await open({ settings: { selfCheck: false, formulasApart: false } });
  const ui = phone.page;
  await prepare(ui, FINANCE, 'Проверка удаления');
  const subject = await ui.evaluate(async () => {
    const s = await import('./js/storage.js');
    const id = s.loadSubjects().current;
    await s.idbSet('analysis-cache:' + id, { entries: [] });
    const original = IDBObjectStore.prototype.delete;
    window.__restoreDelete = () => { IDBObjectStore.prototype.delete = original; };
    IDBObjectStore.prototype.delete = function(key) {
      if (key === 'sources:' + id) throw new DOMException('unavailable', 'UnknownError');
      return original.call(this, key);
    };
    return id;
  });
  ui.on('dialog', dialog => dialog.accept());
  const removeSubject = async () => {
    await ui.click('#subjectBtn');
    await ui.click('#subjectDelete');
    await ui.waitForFunction(() => !document.body.inert);
  };
  await removeSubject();
  await ui.waitForFunction(() => document.getElementById('toast').textContent.includes('Не удалось полностью удалить'));
  const failedSubject = await ui.evaluate(async id => {
    const s = await import('./js/storage.js');
    window.__restoreDelete();
    return s.loadSubjects().list.some(x => x.id === id) &&
      Boolean(await s.idbGet('project:' + id)) &&
      Boolean(await s.idbGet('sources:' + id)) &&
      Boolean(await s.idbGet('analysis-cache:' + id));
  }, subject);
  ok(failedSubject, 'failed subject deletion keeps its IDB records and does not claim success');
  await ui.click('[data-tab=plan]');
  await ui.locator('#planList [data-act=open]').first().click();
  await ui.locator('#planList [data-act=skip]').first().click();
  await removeSubject();
  await ui.waitForFunction(() => document.getElementById('toast').textContent === 'Предмет удалён');
  await ui.waitForTimeout(700);
  const deletedSubject = await ui.evaluate(async id => {
    const s = await import('./js/storage.js');
    return !s.loadSubjects().list.some(x => x.id === id) &&
      (await s.idbGet('project:' + id)) === undefined &&
      (await s.idbGet('sources:' + id)) === undefined &&
      (await s.idbGet('analysis-cache:' + id)) === undefined &&
      s.loadProgress(id) === null;
  }, subject);
  ok(deletedSubject, 'deleting a subject with pending autosave never recreates its old data');
};
