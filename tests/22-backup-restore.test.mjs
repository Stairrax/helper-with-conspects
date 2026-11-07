// Restoring a backup must keep the previous snapshot durable until both stores commit.
const journalKey = '__kd_restore_journal_v1__';
export default async ({ open, ok }) => {
  const setup = async () => {
    const phone = await open();
    await phone.page.evaluate(async () => {
      const s = await import('./js/storage.js');
      await s.idbSet('restore-test', { text: 'original notes' });
      localStorage.setItem('kd.restore-test', 'original settings');
      localStorage.setItem('outside-app', 'untouched');
    });
    return phone;
  };
  {
    const { page } = await setup();
    const result = await page.evaluate(async (journalKey) => {
      const s = await import('./js/storage.js');
      const backup = await s.makeBackup();
      const incoming = structuredClone(backup);
      incoming.idb['restore-test'] = { text: 'replacement notes' };
      incoming.localStorage['kd.restore-test'] = 'replacement settings';
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function(v, k) {
        if (k === journalKey) throw new DOMException('quota', 'QuotaExceededError');
        return put.call(this, v, k);
      };
      let failed = false;
      try { await s.restoreBackup(incoming); } catch { failed = true; }
      IDBObjectStore.prototype.put = put;
      return { failed, value: await s.idbGet('restore-test'), local: localStorage.getItem('kd.restore-test') };
    }, journalKey);
    ok(result.failed && result.value.text === 'original notes' && result.local === 'original settings',
      'ошибка посреди IDB-транзакции откатывает clear и все записи, настройки остаются целы');
  }
  {
    const { page } = await setup();
    const result = await page.evaluate(async () => {
      const s = await import('./js/storage.js');
      const incoming = await s.makeBackup();
      incoming.idb['restore-test'] = { text: 'replacement notes' };
      incoming.localStorage['kd.restore-test'] = 'replacement settings';
      const set = Storage.prototype.setItem;
      let once = true;
      Storage.prototype.setItem = function(k, v) {
        if (k === 'kd.restore-test' && once) { once = false; throw new DOMException('quota', 'QuotaExceededError'); }
        return set.call(this, k, v);
      };
      let failed = false;
      try { await s.restoreBackup(incoming); } catch { failed = true; }
      Storage.prototype.setItem = set;
      return { failed, value: await s.idbGet('restore-test'), local: localStorage.getItem('kd.restore-test') };
    });
    ok(result.failed && result.value.text === 'original notes' && result.local === 'original settings',
      'ошибка localStorage после commit IDB восстанавливает оба старых хранилища');
  }
  {
    const { page } = await setup();
    await page.evaluate(async () => {
      const s = await import('./js/storage.js');
      const incoming = await s.makeBackup();
      incoming.idb['restore-test'] = { text: 'replacement notes' };
      incoming.localStorage['kd.restore-test'] = 'replacement settings';
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function(k, v) {
        if (k === 'kd.restore-test') throw new DOMException('quota', 'QuotaExceededError');
        return set.call(this, k, v);
      };
      try { await s.restoreBackup(incoming); } catch { /* rollback cannot finish either */ }
      Storage.prototype.setItem = set;
    });
    await page.reload();
    await page.waitForFunction(() => window.__kdReady);
    const recovered = await page.evaluate(async () => {
      const s = await import('./js/storage.js');
      return { value: await s.idbGet('restore-test'), local: localStorage.getItem('kd.restore-test'),
        journalInExport: Object.hasOwn((await s.makeBackup()).idb, '__kd_restore_journal_v1__') };
    });
    ok(recovered.value.text === 'original notes' && recovered.local === 'original settings' && !recovered.journalInExport,
      'после незавершённого отката перезапуск восстанавливает старые данные из журнала');
  }
  {
    const { page } = await setup();
    const validation = await page.evaluate(async () => {
      const s = await import('./js/storage.js');
      const invalid = await s.makeBackup();
      invalid.localStorage['outside-app'] = 'overwritten';
      let rejected = false;
      try { await s.restoreBackup(invalid); } catch { rejected = true; }
      return { rejected, original: (await s.idbGet('restore-test')).text, outside: localStorage.getItem('outside-app') };
    });
    ok(validation.rejected && validation.original === 'original notes' && validation.outside === 'untouched',
      'невалидная копия с посторонними ключами отклоняется до изменения данных');
    const success = await page.evaluate(async () => {
      const s = await import('./js/storage.js');
      const incoming = await s.makeBackup();
      incoming.idb['restore-test'] = { text: 'replacement notes' };
      incoming.localStorage['kd.idb.restore-test'] = JSON.stringify({ text: 'newer fallback' });
      incoming.localStorage['kd.restore-test'] = 'replacement settings';
      incoming.localStorage['kd.stats'] = JSON.stringify({ days: {}, exams: [{ right: 9 }] });
      const stats = await import('./js/stats.js');
      stats.addStudy(1);
      await s.restoreBackup(incoming);
      stats.flushStats();
      return { lateWrite: await s.idbSet('restore-test', { text: 'stale background result' }),
        lateSettings: s.saveSettings({}), outside: localStorage.getItem('outside-app'),
        statsPreserved: JSON.parse(localStorage.getItem('kd.stats')).exams[0].right === 9 };
    });
    ok(success.lateWrite === false && success.lateSettings === false && success.outside === 'untouched' && success.statsPreserved,
      'после восстановления старые фоновые записи блокируются до перезапуска');
    await page.reload();
    await page.waitForFunction(() => window.__kdReady);
    const restored = await page.evaluate(async () => ({
      value: await (await import('./js/storage.js')).idbGet('restore-test'), local: localStorage.getItem('kd.restore-test'),
    }));
    ok(restored.value.text === 'newer fallback' && restored.local === 'replacement settings',
      'успешное восстановление сохраняется после перезапуска, legacy fallback имеет приоритет');
  }
};
