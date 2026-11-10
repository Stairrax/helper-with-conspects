const textOf = (n) => Array.from({ length: n }, (_, i) => `Раздел ${i + 1}. Сложный процент начисляется на накопленную сумму. Бюджет — это план доходов и расходов.`).join('\n\n');

export default async ({ open, ok }) => {
  const { page, ai } = await open({ settings: { provider: 'free', apiKey: '', coverageCheck: false }, freeProxy: 'https://free-proxy.test', titles: ['Первая', 'Вторая', 'Третья'] });
  let calls = 0, blocked = true;
  await page.route(/free-proxy\.test/, (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    calls++;
    if (blocked && calls > 2) return route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: { code: 'daily_limit', proxy: true, message: 'На сегодня бесплатные запросы закончились.' } }) });
    return route.fallback();
  });
  await page.click('#addTextBtn');
  await page.fill('#pasteText', textOf(330));
  await page.fill('#pasteTitle', 'Большой материал');
  await page.click('#pasteAdd');
  await page.click('#analyzeBtn');
  await page.waitForFunction(() => /закончились/.test(document.getElementById('analyzeStatus').textContent), null, { timeout: 30000 });
  const before = ai.segment;
  const cached = await page.evaluate(async () => {
    const id = JSON.parse(localStorage.getItem('kd.subjects')).current;
    return (await (await import('./js/storage.js')).idbGet('analysis-cache:' + id))?.entries?.length;
  });
  ok(cached === 2, 'две разобранные части сохранены в хранилище предмета');
  await page.reload();
  await page.waitForTimeout(500);
  blocked = false;
  await page.click('#analyzeBtn');
  await page.waitForFunction(() => document.querySelectorAll('#planList li').length > 0, null, { timeout: 30000 });
  ok(before === 2 && ai.segment === 3, `после перезагрузки повторно не отправляются две готовые части: ${before} → ${ai.segment}`);
  const cleared = await page.evaluate(async () => {
    const id = JSON.parse(localStorage.getItem('kd.subjects')).current;
    return await (await import('./js/storage.js')).idbGet('analysis-cache:' + id);
  });
  ok(!cleared, 'после завершения временные данные удалены');

  const other = await open({ settings: { provider: 'free', apiKey: '', coverageCheck: false }, freeProxy: 'https://free-proxy.test', titles: ['Первая', 'Вторая', 'Третья'] });
  await other.page.evaluate(() => {
    const put = IDBObjectStore.prototype.put, set = Storage.prototype.setItem;
    IDBObjectStore.prototype.put = function(value, key) {
      if (String(key).startsWith('analysis-cache:')) throw new DOMException('quota', 'QuotaExceededError');
      return put.call(this, value, key);
    };
    Storage.prototype.setItem = function(key, value) {
      if (key.startsWith('kd.idb.analysis-cache:')) throw new DOMException('quota', 'QuotaExceededError');
      return set.call(this, key, value);
    };
  });
  await other.page.click('#addTextBtn');
  await other.page.fill('#pasteText', textOf(330));
  await other.page.fill('#pasteTitle', 'Материал при ошибке');
  await other.page.click('#pasteAdd');
  await other.page.click('#analyzeBtn');
  await other.page.waitForFunction(() => /Не удалось сохранить промежуточные результаты/.test(document.getElementById('analyzeStatus').textContent), null, { timeout: 30000 });
  ok(other.ai.segment === 1 && await other.page.locator('#storageWarning').isVisible(), 'ошибка записи останавливает дальнейшие запросы и предупреждает пользователя');
  ok(await other.page.locator('#sourceList li').count() === 1, 'исходный материал остаётся доступным при ошибке записи');

  const pending = await open({ settings: { provider: 'free', apiKey: '', coverageCheck: false, selfCheck: false, formulasApart: false }, freeProxy: 'https://free-proxy.test', titles: ['Первая', 'Вторая', 'Третья'] });
  let generationCalls = 0, release;
  const gate = new Promise((resolve) => { release = resolve; });
  await pending.page.route(/free-proxy\.test/, async (route) => {
    if (route.request().method() === 'POST' && (route.request().postData() || '').includes('ИСХОДНЫЙ ТЕКСТ') && ++generationCalls === 2) await gate;
    try { await route.fallback(); } catch { /* request interrupted by reload */ }
  });
  await pending.page.click('#addTextBtn');
  await pending.page.fill('#pasteText', textOf(60));
  await pending.page.fill('#pasteTitle', 'Прерывание подготовки');
  await pending.page.click('#pasteAdd');
  await pending.page.click('#analyzeBtn');
  await pending.page.waitForFunction(() => document.querySelectorAll('#planList .pstate.ok').length >= 1 && /⏳/.test(document.getElementById('planList').textContent), null, { timeout: 30000 });
  await pending.page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await pending.page.waitForFunction(async () => {
    const s = await import('./js/storage.js');
    const project = await s.idbGet('project:' + s.loadSubjects().current);
    return project?.topics?.some((topic) => topic.status === 'generating');
  }, null, { timeout: 10000 });
  await pending.page.reload();
  release();
  await pending.page.waitForFunction(() => document.querySelectorAll('#planList .pstate.ok').length === 3, null, { timeout: 30000 });
  ok(generationCalls >= 3, 'после перезагрузки прерванная тема готовится повторно, готовые темы сохраняются');
};
