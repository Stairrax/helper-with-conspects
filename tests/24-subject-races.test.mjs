// Delay real operation boundaries and ensure late results cannot mutate another subject.
export default async ({ open, prepare, FINANCE, ok }) => {
  const seed = async () => {
    const phone = await open();
    await phone.page.evaluate(async () => {
      const s = await import('./js/storage.js');
      const subjects = s.loadSubjects();
      for (const [id, title] of [['race-b', 'Beta'], ['race-c', 'Gamma']]) {
        subjects.list.push({ id, title });
        await s.idbSet('sources:' + id, [{ id, name: title, kind: 'text', text: title + ' material' }]);
      }
      s.saveSubjects(subjects);
    });
    await phone.page.reload();
    await phone.page.waitForFunction(() => window.__kdReady);
    return phone;
  };
  const switchTo = async (page, id) => {
    await page.evaluate((id) => {
      document.getElementById('subjectBtn').click();
      [...document.querySelectorAll('[data-subject]')].find(b => b.dataset.subject === id).click();
    }, id);
  };
  const addText = async (page, text) => {
    await page.click('[data-tab=load]');
    await page.click('#addTextBtn');
    await page.fill('#pasteText', text);
    await page.click('#pasteAdd');
  };
  const holdAnalysis = async (page) => {
    await page.evaluate(() => {
      const realFetch = window.fetch;
      const gate = new Promise(r => { window.__releaseAnalysis = r; });
      window.fetch = async (...args) => {
        if (!window.__analysisStarted && String(args[0]).includes('/chat/completions')) {
          window.__analysisStarted = true;
          try { await gate; return await realFetch(...args); }
          finally { window.__analysisFinished = true; }
        }
        return realFetch(...args);
      };
    });
    await page.click('#analyzeBtn');
    await page.waitForFunction(() => window.__analysisStarted);
  };
  {
    const { page } = await seed();
    await addText(page, FINANCE);
    await holdAnalysis(page);
    await switchTo(page, 'race-b');
    await page.waitForFunction(() => document.getElementById('subjectName').textContent === 'Beta');
    await page.evaluate(() => window.__releaseAnalysis());
    await page.waitForFunction(() => window.__analysisFinished);
    await page.waitForTimeout(300);
    const state = await page.evaluate(async () => {
      const s = await import('./js/storage.js');
      return { current: s.loadSubjects().current, project: await s.idbGet('project:race-b'), sources: await s.idbGet('sources:race-b') };
    });
    ok(state.current === 'race-b' && !state.project && state.sources[0].text === 'Beta material',
      'анализ предмета A не перезаписывает план и материалы предмета B');
  }
  {
    const { page } = await seed();
    await addText(page, FINANCE);
    await holdAnalysis(page);
    await addText(page, 'Новый материал после начала анализа.');
    await page.evaluate(() => window.__releaseAnalysis());
    await page.waitForFunction(() => window.__analysisFinished);
    const state = await page.evaluate(async () => {
      const s = await import('./js/storage.js'); const id = s.loadSubjects().current;
      return { project: await s.idbGet('project:' + id), sources: await s.idbGet('sources:' + id) };
    });
    ok(!state.project && state.sources.length === 2, 'изменение материалов отменяет старый анализ, оба источника сохранены');
  }
  {
    const { page } = await seed();
    await page.evaluate(() => {
      const transaction = IDBDatabase.prototype.transaction;
      window.__originalTransaction = transaction;
      IDBDatabase.prototype.transaction = function(store, mode, ...rest) {
        if (mode !== 'readonly') return transaction.call(this, store, mode, ...rest);
        const d = this;
        const fake = { objectStore: () => ({ get(key) {
          const req = {};
          if (String(key).endsWith('race-b')) window.__slowRead = true;
          setTimeout(() => {
            const t = transaction.call(d, store, mode, ...rest);
            const actual = t.objectStore('kv').get(key);
            t.oncomplete = () => { req.result = actual.result; fake.oncomplete?.(); };
            t.onerror = () => { fake.error = t.error; fake.onerror?.(); };
          }, String(key).endsWith('race-b') ? 350 : 0);
          return req;
        } }) };
        return fake;
      };
    });
    await switchTo(page, 'race-b');
    await page.waitForFunction(() => window.__slowRead);
    await switchTo(page, 'race-c');
    await page.waitForFunction(() => document.getElementById('subjectName').textContent === 'Gamma');
    await page.waitForTimeout(650);
    const state = await page.evaluate(() => {
      IDBDatabase.prototype.transaction = window.__originalTransaction;
      return { current: JSON.parse(localStorage.getItem('kd.subjects')).current,
        title: document.getElementById('subjectName').textContent, source: document.getElementById('sourceList').textContent };
    });
    ok(state.current === 'race-c' && state.title === 'Gamma' && state.source.includes('Gamma') && !state.source.includes('Beta'),
      'медленное открытие B после быстрого C не смешивает источники и выбранный предмет');
  }
  {
    const { page } = await seed();
    await page.evaluate(() => {
      const text = File.prototype.text;
      const gate = new Promise(r => { window.__releaseFile = r; });
      File.prototype.text = async function() {
        if (this.name === 'late.txt') { window.__fileStarted = true; await gate; window.__fileFinished = true; }
        return text.call(this);
      };
    });
    await page.locator('#fileInput').setInputFiles({ name: 'late.txt', mimeType: 'text/plain', buffer: Buffer.from('Late material') });
    await page.waitForFunction(() => window.__fileStarted);
    await switchTo(page, 'race-b');
    await page.waitForFunction(() => document.getElementById('subjectName').textContent === 'Beta');
    await page.evaluate(() => window.__releaseFile());
    await page.waitForFunction(() => window.__fileFinished);
    await page.waitForTimeout(100);
    ok(!(await page.textContent('#sourceList')).includes('late.txt'), 'поздно прочитанный файл не добавляется в другой предмет');
  }
  {
    const { page } = await open();
    const result = await page.evaluate(async () => {
      const { Dictation } = await import('./js/dictation.js');
      let project = { id: 'original' }, executed = [], release;
      const d = Object.create(Dictation.prototype);
      Object.assign(d, { token: 0, commandEpoch: 0, state: 'paused', h: {
        getProject: () => project,
        getSettings: () => ({ provider: 'custom', apiKey: 'test', baseUrl: 'https://commands.test', model: 'test' }),
      } });
      d.set = (state) => { d.state = state; };
      d.appCommand = async (c) => { executed.push(c.cmd); };
      const real = window.fetch;
      window.fetch = async () => {
        await new Promise(r => { release = r; });
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"cmd":"pauseLen","arg":-1}' } }] }));
      };
      try {
        const pending = d.tryCommand('сделай паузы совсем маленькими');
        while (!release) await new Promise(r => setTimeout(r, 0));
        project = { id: 'different' }; d.token++; d.state = 'idle';
        release(); await pending;
        const stale = executed.length === 0 && d.state === 'idle';
        release = null; d.state = 'paused';
        const older = d.tryCommand('сделай паузы совсем маленькими');
        while (!release) await new Promise(r => setTimeout(r, 0));
        await d.tryCommand('светлая тема');
        release(); await older;
        return { stale, newer: executed.length === 1 && executed[0] === 'theme' };
      } finally { window.fetch = real; }
    });
    ok(result.stale, 'поздняя AI-команда не исполняется после смены предмета или остановки');
    ok(result.newer, 'новая локальная команда отменяет применение старой AI-команды');
  }
  {
    const { page, say } = await seed();
    const original = await page.evaluate(() => JSON.parse(localStorage.getItem('kd.subjects')).current);
    await page.click('#addLectureBtn');
    await page.waitForTimeout(150);
    await say('сегодня мы изучаем сложный процент', true, 100);
    await page.fill('#lectureTitle', 'Saved lecture');
    await page.evaluate(() => {
      const real = window.fetch;
      window.fetch = async (...args) => {
        if (String(args[0]).includes('/chat/completions')) {
          window.__tidyStarted = true;
          await new Promise(r => { window.__releaseTidy = r; });
          try { return await real(...args); } finally { window.__tidyFinished = true; }
        }
        return real(...args);
      };
    });
    await page.click('#lectureDone');
    await page.waitForFunction(() => window.__tidyStarted);
    await switchTo(page, 'race-b');
    await page.waitForFunction(() => document.getElementById('subjectName').textContent === 'Beta');
    await page.evaluate(() => window.__releaseTidy());
    await page.waitForFunction(() => window.__tidyFinished);
    const data = await page.evaluate(async (id) => {
      const s = await import('./js/storage.js');
      return { original: await s.idbGet('sources:' + id), other: await s.idbGet('sources:race-b') };
    }, original);
    ok(data.original.some(s => s.name === 'Saved lecture' && /сложный процент/.test(s.text)) && data.other.length === 1,
      'смена предмета во время обработки лекции сохраняет исходную расшифровку в исходном предмете');
  }
  {
    const { page } = await seed();
    await addText(page, 'Unsaved material');
    const original = await page.evaluate(() => JSON.parse(localStorage.getItem('kd.subjects')).current);
    await page.evaluate((id) => {
      window.__putBeforeFailure = IDBObjectStore.prototype.put;
      window.__setBeforeFailure = Storage.prototype.setItem;
      IDBObjectStore.prototype.put = function(v, k) {
        if (k === 'sources:' + id) throw new DOMException('quota', 'QuotaExceededError');
        return window.__putBeforeFailure.call(this, v, k);
      };
      Storage.prototype.setItem = function(k, v) {
        if (k === 'kd.idb.sources:' + id) throw new DOMException('quota', 'QuotaExceededError');
        return window.__setBeforeFailure.call(this, k, v);
      };
    }, original);
    await switchTo(page, 'race-b');
    await page.waitForTimeout(150);
    ok(await page.evaluate(() => JSON.parse(localStorage.getItem('kd.subjects')).current) === original &&
      (await page.textContent('#sourceList')).includes('Текст'),
      'ошибка сохранения материалов блокирует переключение, исходные данные остаются на экране');
    await page.evaluate(() => { IDBObjectStore.prototype.put = window.__putBeforeFailure; Storage.prototype.setItem = window.__setBeforeFailure; });
  }
  {
    const { page } = await open();
    await prepare(page, FINANCE, 'Original plan');
    const previous = await page.evaluate(async () => {
      const s = await import('./js/storage.js');
      return (await s.idbGet('project:' + s.loadSubjects().current)).id;
    });
    let requests = 0, release;
    const gate = new Promise(r => { release = r; });
    await page.route(/chat\/completions/, async (route) => {
      if (++requests >= 2) await gate;
      try { await route.fallback(); } catch { /* page may close after the assertion */ }
    });
    await page.evaluate(() => {
      window.confirm = () => true;
      const priority = document.querySelector('input[name=priority][value=easy]');
      priority.checked = true; priority.dispatchEvent(new Event('change'));
      document.getElementById('analyzeBtn').click();
    });
    await page.waitForFunction(async (old) => {
      const s = await import('./js/storage.js');
      return (await s.idbGet('project:' + s.loadSubjects().current))?.id !== old;
    }, previous);
    await page.waitForTimeout(800);
    const saved = await page.evaluate(async () => {
      const s = await import('./js/storage.js');
      return (await s.idbGet('project:' + s.loadSubjects().current)).id;
    });
    release();
    ok(saved !== previous, 'отложенное сохранение старого плана не перезаписывает новый план');
  }
};
