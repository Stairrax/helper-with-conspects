// Storage safety: never suggest a backup is safe when IDB cannot be read;
// provider calls: model listing cannot hang, and Anthropic respects token budgets.
export default async ({open, ok}) => {
  const {page} = await open();
  const outcomes = await page.evaluate(async () => {
    const storage = await import('./js/storage.js');
    const results = {};
    const put = IDBObjectStore.prototype.put;
    const set = Storage.prototype.setItem;

    for (const type of ['quota', 'unavailable']) {
      const key = 'audit-storage-' + type;
      try {
        IDBObjectStore.prototype.put = function(value, k) {
          if (k === key) throw new DOMException(type, type === 'quota' ? 'QuotaExceededError' : 'UnknownError');
          return put.call(this, value, k);
        };
        Storage.prototype.setItem = function(k, v) {
          if (k === 'kd.idb.' + key) throw new DOMException('quota', 'QuotaExceededError');
          return set.call(this, k, v);
        };
        results[type] = {
          saved: await storage.idbSet(key, {important:true}),
          reason: storage.storageFailureReasons.get('idb:' + key),
          warning: document.getElementById('storageWarning').textContent,
          visible: !document.getElementById('storageWarning').classList.contains('hidden'),
        };
      } finally {
        IDBObjectStore.prototype.put = put;
        Storage.prototype.setItem = set;
        await storage.idbSet(key, {restored:true});
      }
    }
    results.cleared = document.getElementById('storageWarning').classList.contains('hidden');
    return results;
  });
  ok(!outcomes.quota.saved && outcomes.quota.visible &&
    outcomes.quota.reason === 'quota' && outcomes.quota.warning.includes('место в браузере закончилось'),
    'quota failure recommends freeing space without claiming backup already saved');
  ok(!outcomes.unavailable.saved && outcomes.unavailable.visible &&
    outcomes.unavailable.reason === 'unavailable' &&
    outcomes.unavailable.warning.includes('Резервная копия может быть неполной') &&
    outcomes.unavailable.warning.includes('Не закрывайте вкладку'),
    'unavailable IDB and fallback explicitly warn that backup may be incomplete');
  ok(outcomes.cleared, 'warning clears after the affected keys can be stored again');

  const provider = await page.evaluate(async () => {
    const gemini = await import('./js/gemini.js');
    const anthropic = await import('./js/anthropic.js');
    const fetchBefore = window.fetch;
    const out = {};
    try {
      window.fetch = async () => new Promise(() => {});
      const t = performance.now();
      try { await gemini.listModels('key','https://gemini.test',{timeoutMs:65}); }
      catch(err) { out.timeout=err.code; out.timeMs=performance.now()-t; }

      window.fetch = async () => Response.json({models:[
        {name:'models/gemini-test',supportedGenerationMethods:['generateContent']},
        {name:'models/embedding-only',supportedGenerationMethods:['embedContent']},
      ]});
      out.models = await gemini.listModels('key','https://gemini.test',{timeoutMs:500});

      const bodies = [];
      window.fetch = async (_url, init) => {
        bodies.push(JSON.parse(init.body));
        return Response.json({content:[{type:'text',text:'ok'}],stop_reason:'end_turn'});
      };
      const args = {apiKey:'key',model:'claude-sonnet-5-5',baseUrl:'https://anthropic.test',
        parts:[{text:'hello'}],retries:0,timeoutMs:1500};
      await anthropic.generate(args);
      await anthropic.generate({...args,maxOutputTokens:13500});
      out.anthropic = bodies.map(x=>x.max_tokens);
    } finally { window.fetch = fetchBefore; }
    return out;
  });
  ok(provider.timeout === 'REQUEST_TIMEOUT' && provider.timeMs < 2000,
    'Gemini model discovery is bounded even when fetch ignores abort');
  ok(JSON.stringify(provider.models) === '["gemini-test"]',
    'Gemini model discovery returns only generateContent models');
  ok(provider.anthropic[0] === 8192 && provider.anthropic[1] === 13500,
    'Anthropic generation defaults to 8192 max tokens and accepts explicit positive bounds');

  const english = await open({settings:{uiLang:'en'},locale:'en-US'});
  const translated = await english.page.evaluate(async () => {
    const storage = await import('./js/storage.js');
    const set = Storage.prototype.setItem;
    try {
      Storage.prototype.setItem = function(k,v) {
        if (k === 'kd.settings') throw new DOMException('full','QuotaExceededError');
        return set.call(this,k,v);
      };
      storage.saveSettings({test:true});
      return document.getElementById('storageWarning').textContent;
    } finally {
      Storage.prototype.setItem = set;
      storage.saveSettings(storage.loadSettings());
    }
  });
  ok(translated.includes('Changes could not be saved') && !/[а-яё]/i.test(translated),
    'quota warning remains translated for English UI');
};
