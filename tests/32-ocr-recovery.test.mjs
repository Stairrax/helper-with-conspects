const LIMIT = { error: { code: 'daily_limit', proxy: true, message: 'На сегодня бесплатные запросы закончились.' } };
const images = ['YQ==', 'Yg==', 'Yw=='];

export default async ({ open, ok }) => {
  const { page } = await open({ settings: { provider: 'free', apiKey: '', selfCheck: false, coverageCheck: false }, freeProxy: 'https://free-proxy.test' });
  const calls = [];
  let blocked = true;
  await page.route(/free-proxy\.test/, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const body = JSON.parse(route.request().postData());
    const image = body.messages.flatMap((m) => Array.isArray(m.content) ? m.content : []).find((p) => p.type === 'image_url');
    if (!image) return route.fallback();
    const data = image.image_url.url.split(',')[1];
    calls.push(data);
    if (blocked && data === images[2]) return route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify(LIMIT) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: `Страница ${data}. Учебный текст о сложном проценте и накоплениях.` }, finish_reason: 'stop' }] }) });
  });
  await page.evaluate(async (data) => {
    const s = await import('./js/storage.js');
    await s.idbSet('sources:' + s.loadSubjects().current, [{ id: 'photos', name: 'Страницы', kind: 'images', images: data.map((x) => ({ mime: 'image/png', data: x })) }]);
  }, images);
  await page.reload();
  await page.click('#analyzeBtn');
  await page.waitForFunction(() => /закончились/.test(document.getElementById('analyzeStatus').textContent), null, { timeout: 30000 });
  const snapshot = await page.evaluate(async () => {
    const s = await import('./js/storage.js');
    return await s.idbGet('analysis-cache:' + s.loadSubjects().current);
  });
  ok(snapshot?.ocrEntries?.length === 2 && snapshot.ocrEntries.every(([key]) => key.startsWith('sha256:') && !images.some((img) => key.includes(img))), 'две страницы сохранены отдельно от изображений');
  await page.reload();
  blocked = false;
  await page.click('#analyzeBtn');
  await page.waitForFunction(() => document.querySelectorAll('#planList li').length > 0, null, { timeout: 30000 });
  const source = await page.evaluate(async () => {
    const s = await import('./js/storage.js');
    return (await s.idbGet('sources:' + s.loadSubjects().current))[0];
  });
  ok(calls.filter((x) => x === images[0]).length === 1 && calls.filter((x) => x === images[1]).length === 1 && calls.filter((x) => x === images[2]).length === 2, 'после перезапуска повторяется только прерванная страница');
  ok(images.every((x, i) => source.text.indexOf(x) >= 0 && (i === 0 || source.text.indexOf(images[i - 1]) < source.text.indexOf(x))), 'все страницы сохранены в исходном порядке');

  const failed = await open({ settings: { provider: 'free', apiKey: '', selfCheck: false, coverageCheck: false }, freeProxy: 'https://free-proxy.test' });
  let ocrCalls = 0;
  await failed.page.route(/free-proxy\.test/, (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const body = JSON.parse(route.request().postData());
    if (!body.messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'))) return route.fallback();
    ocrCalls++;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: 'Распознанный текст страницы.' }, finish_reason: 'stop' }] }) });
  });
  await failed.page.evaluate(async (data) => {
    const s = await import('./js/storage.js');
    await s.idbSet('sources:' + s.loadSubjects().current, [{ id: 'photos', name: 'Страницы', kind: 'images', images: data.map((x) => ({ mime: 'image/png', data: x })) }]);
  }, images);
  await failed.page.reload();
  await failed.page.evaluate(() => {
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
  await failed.page.click('#analyzeBtn');
  await failed.page.waitForFunction(() => /Не удалось сохранить промежуточные результаты/.test(document.getElementById('analyzeStatus').textContent), null, { timeout: 30000 });
  ok(ocrCalls === 1 && await failed.page.locator('#storageWarning').isVisible(), 'ошибка сохранения останавливает распознавание до следующего запроса');
  ok(await failed.page.locator('#sourceList li').count() === 1, 'исходные фотографии остаются доступны при ошибке записи');

  const changed = await open({ settings: { provider: 'free', apiKey: '', selfCheck: false, coverageCheck: false }, freeProxy: 'https://free-proxy.test' });
  const changedCalls = [];
  let pause = true;
  await changed.page.route(/free-proxy\.test/, (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const body = JSON.parse(route.request().postData());
    const image = body.messages.flatMap((m) => Array.isArray(m.content) ? m.content : []).find((p) => p.type === 'image_url');
    if (!image) return route.fallback();
    const data = image.image_url.url.split(',')[1];
    changedCalls.push(data);
    if (pause && data === images[1]) return route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify(LIMIT) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: `Текст страницы ${data}.` }, finish_reason: 'stop' }] }) });
  });
  await changed.page.evaluate(async (data) => {
    const s = await import('./js/storage.js');
    await s.idbSet('sources:' + s.loadSubjects().current, [{ id: 'photos', name: 'Страницы', kind: 'images', images: data.slice(0, 2).map((x) => ({ mime: 'image/png', data: x })) }]);
  }, images);
  await changed.page.reload();
  await changed.page.click('#analyzeBtn');
  await changed.page.waitForFunction(() => /закончились/.test(document.getElementById('analyzeStatus').textContent), null, { timeout: 30000 });
  await changed.page.evaluate(async () => {
    const s = await import('./js/storage.js');
    const key = 'sources:' + s.loadSubjects().current;
    const src = await s.idbGet(key);
    src[0].images[0].data = 'ZA==';
    await s.idbSet(key, src);
  });
  await changed.page.reload();
  pause = false;
  await changed.page.click('#analyzeBtn');
  await changed.page.waitForFunction(() => document.querySelectorAll('#planList li').length > 0, null, { timeout: 30000 });
  const changedText = await changed.page.evaluate(async () => {
    const s = await import('./js/storage.js');
    return (await s.idbGet('sources:' + s.loadSubjects().current))[0].text;
  });
  ok(changedCalls.includes('ZA==') && changedText.includes('ZA==') && !changedText.includes(images[0]), 'заменённая фотография распознаётся заново без старого текста');

  const mixed = await open({ settings: { provider: 'free', apiKey: '', selfCheck: false, coverageCheck: false }, freeProxy: 'https://free-proxy.test' });
  let mixedOcr = 0, segmentRequests = 0, blockSegments = true;
  const segmentPrompts = [];
  await mixed.page.route(/free-proxy\.test/, (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const body = JSON.parse(route.request().postData());
    const image = body.messages.flatMap((m) => Array.isArray(m.content) ? m.content : []).find((p) => p.type === 'image_url');
    if (image) {
      mixedOcr++;
      const text = Array.from({ length: 180 }, (_, i) => `Раздел ${mixedOcr}-${i}. Изучаем сложный процент и план доходов и расходов.`).join('\n\n');
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }) });
    }
    if (body.messages.some((m) => typeof m.content === 'string' && m.content.includes('пронумерованные блоки'))) {
      segmentRequests++;
      segmentPrompts.push(body.messages.find((m) => typeof m.content === 'string' && m.content.includes('пронумерованные блоки')).content);
      if (blockSegments && segmentRequests === 2) return route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify(LIMIT) });
    }
    return route.fallback();
  });
  await mixed.page.evaluate(async (data) => {
    const s = await import('./js/storage.js');
    await s.idbSet('sources:' + s.loadSubjects().current, [{ id: 'photos', name: 'Страницы', kind: 'images', images: data.slice(0, 2).map((x) => ({ mime: 'image/png', data: x })) }]);
  }, images);
  await mixed.page.reload();
  await mixed.page.click('#analyzeBtn');
  await mixed.page.waitForFunction(() => /закончились/.test(document.getElementById('analyzeStatus').textContent), null, { timeout: 30000 });
  const mixedSaved = await mixed.page.evaluate(async () => {
    const s = await import('./js/storage.js');
    return await s.idbGet('analysis-cache:' + s.loadSubjects().current);
  });
  ok(mixedSaved?.ocrEntries?.length === 2 && mixedSaved?.entries?.length === 1, 'результаты фото и текстового разбора сохраняются вместе');
  await mixed.page.reload();
  blockSegments = false;
  await mixed.page.click('#analyzeBtn');
  await mixed.page.waitForFunction(() => document.querySelectorAll('#planList li').length > 0, null, { timeout: 30000 });
  ok(mixedOcr === 2 && segmentPrompts.filter((p) => p === segmentPrompts[0]).length === 1, 'после перезапуска сохраняются и фото, и уже разобранная часть текста');
};
