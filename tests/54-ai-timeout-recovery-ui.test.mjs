// A stalled/failed AI call must offer a clear, manual recovery without losing input.
export default async ({ open, ok }) => {
  const { page } = await open({
    settings: { provider: 'free', apiKey: '', coverageCheck: false, selfCheck: false },
    freeProxy: 'https://free-proxy.test', titles: ['Тема'],
  });
  const deadlines = await page.evaluate(async () => {
    const { defaultGenerationTimeoutMs } = await import('./js/openai.js');
    return [
      defaultGenerationTimeoutMs('notes', 'https://free-proxy.test'),
      defaultGenerationTimeoutMs('notes', 'https://openrouter.ai/api/v1'),
      defaultGenerationTimeoutMs('question', 'https://free-proxy.test'),
    ];
  });
  ok(JSON.stringify(deadlines) === JSON.stringify([240000, 180000, 120000]),
    'free notes allow server fallback to finish; direct notes and questions keep shorter deadlines');
  let first = true;
  const intercepted = [];
  // Fail the topic-segmentation request, not an incidental warm-up/API call.
  await page.route(/free-proxy\.test/, (route) => {
    intercepted.push({ url: route.request().url(), method: route.request().method(), hasBlocks: (route.request().postData() || '').includes('пронумерованные блоки') });
    if (route.request().method() === 'POST' && first &&
        (route.request().postData() || '').includes('пронумерованные блоки')) {
      first = false;
      return route.fulfill({
        status: 504, contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'timeout', proxy: true, reason: 'fallback-timeout',
          message: 'Запасной ИИ слишком долго не отвечает. Попробуйте позже.' } }),
      });
    }
    return route.fallback();
  });
  await page.click('#addTextBtn');
  // Several paragraphs are essential: a single toBlocks() block bypasses
  // segmentPart() entirely, so an error in segmentation would never be tested.
  const material = Array.from({ length: 12 }, (_, i) =>
    `Раздел ${i + 1}. Сложный процент начисляется на накопленную сумму. Бюджет включает доходы и расходы. Рассмотрим пример для темы ${i + 1}.`
  ).join('\\n\\n');
  const count = await page.evaluate(async (text) => (await import('./js/analyze.js')).toBlocks(text).length, material);
  ok(count > 1, 'fixture contains multiple blocks, so topic segmentation must call the AI');
  await page.fill('#pasteText', material);
  await page.fill('#pasteTitle', 'Финансовая грамотность');
  await page.click('#pasteAdd');
  await page.click('#analyzeBtn');
  try {
    await page.waitForFunction(() => document.querySelector('#analyzeStatus [data-retry-analysis]'), null, { timeout: 15000 });
  } catch (e) {
    const snapshot = await page.evaluate(() => ({
      analyzeStatus: document.getElementById('analyzeStatus')?.textContent,
      analyzeLog: document.getElementById('analyzeLog')?.textContent,
      analyzeDisabled: document.getElementById('analyzeBtn')?.disabled,
      currentTab: document.body.dataset.tab,
      sourceCount: document.querySelectorAll('#sourceList li').length,
      provider: JSON.parse(localStorage.getItem('kd.settings') || '{}').provider,
      proxy: localStorage.getItem('kd.freeProxy'),
    }));
    throw new Error('Timeout recovery UI missing: ' + JSON.stringify({ ...snapshot, intercepted }) + ' (' + e.message + ')');
  }
  ok((await page.textContent('#analyzeStatus')).includes('fallback-timeout'), 'показан диагностический код сервера');
  ok((await page.textContent('#analyzeStatus')).includes('Материалы не нужно добавлять заново'),
    'после тайм-аута ясно, что исходные материалы сохранены');
  ok(await page.locator('#sourceList li').count() === 1, 'материал не удаляется при тайм-ауте');
  await page.click('[data-retry-analysis]');
  await page.waitForFunction(() => document.body.dataset.tab === 'plan', null, { timeout: 15000 });
  ok(await page.locator('#planList li').count() >= 1, 'повтор по кнопке завершает составление плана');
};
