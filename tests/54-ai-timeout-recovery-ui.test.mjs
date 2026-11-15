// A stalled/failed AI call must offer a clear, manual recovery without losing input.
export default async ({ open, ok }) => {
  const { page } = await open({
    settings: { provider: 'free', apiKey: '', coverageCheck: false, selfCheck: false },
    freeProxy: 'https://free-proxy.test', titles: ['Тема'],
  });
  let first = true;
  await page.route(/free-proxy\.test/, (route) => {
    if (route.request().method() === 'POST' && first) {
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
  await page.fill('#pasteText', 'Сложный процент начисляется на накопленную сумму. Бюджет включает доходы и расходы.');
  await page.fill('#pasteTitle', 'Финансовая грамотность');
  await page.click('#pasteAdd');
  await page.click('#analyzeBtn');
  await page.waitForFunction(() => document.querySelector('#analyzeStatus [data-retry-analysis]'), null, { timeout: 15000 });
  ok((await page.textContent('#analyzeStatus')).includes('fallback-timeout'), 'показан диагностический код сервера');
  ok((await page.textContent('#analyzeStatus')).includes('Материалы не нужно добавлять заново'),
    'после тайм-аута ясно, что исходные материалы сохранены');
  ok(await page.locator('#sourceList li').count() === 1, 'материал не удаляется при тайм-ауте');
  await page.click('[data-retry-analysis]');
  await page.waitForFunction(() => document.body.dataset.tab === 'plan', null, { timeout: 15000 });
  ok(await page.locator('#planList li').count() >= 1, 'повтор по кнопке завершает составление плана');
};
