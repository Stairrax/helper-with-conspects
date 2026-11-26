export default async ({ open, ok }) => {
  const { page, ai } = await open({
    settings: { provider: 'free', apiKey: '', coverageCheck: false, selfCheck: false },
    freeProxy: 'https://free-proxy.test',
    titles: ['Доходы', 'Расходы'],
  });
  let fail = true;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route(/free-proxy\.test/, async (route) => {
    if (fail && route.request().method() === 'POST' &&
        (route.request().postData() || '').includes('пронумерованные блоки')) {
      fail = false;
      await gate;
      return route.fulfill({ status: 504, contentType: 'application/json',
        body: JSON.stringify({ error: { proxy: true, code: 'timeout', reason: 'fallback-timeout', message: 'Нейросеть не ответила.' } }) });
    }
    return route.fallback();
  });
  await page.click('#addTextBtn');
  await page.fill('#pasteTitle', 'Экономика');
  await page.fill('#pasteText', 'Доходы — денежные поступления.\n\nРасходы — средства, потраченные на товары и услуги.');
  await page.click('#pasteAdd');
  await page.click('#analyzeBtn');
  await page.waitForFunction(() => document.querySelector('#analyzeCard[data-state=working] [data-stage=topics][aria-current=step]'));
  const state = () => page.locator('#analyzeCard').getAttribute('data-state');
  ok(await page.locator('#analyzeTitle').textContent() === 'Подготавливаю конспект', 'working card shows the preparation title');
  ok(await page.locator('.analysis-dots').isVisible(), 'waiting indicator is visible during analysis');
  const themes = await page.evaluate(() => {
    const root = document.documentElement, previous = root.dataset.theme;
    const card = document.getElementById('analyzeCard');
    const result = ['aurora', 'ink', 'ios', 'android', 'neon', 'light'].map(theme => {
      root.dataset.theme = theme;
      const rect = card.getBoundingClientRect();
      return rect.width > 0 && card.scrollWidth <= card.clientWidth + 1 &&
        getComputedStyle(card.querySelector('.analysis-dots i')).animationName !== 'none';
    });
    root.dataset.theme = previous;
    return result;
  });
  ok(themes.every(Boolean), 'waiting card fits the mobile viewport across six themes');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  ok(await page.locator('.analysis-dots i').first().evaluate(el => getComputedStyle(el).animationName) === 'none',
    'reduced motion disables the waiting animation');
  release();
  await page.waitForFunction(() => document.getElementById('analyzeCard').dataset.state === 'error');
  ok(await state() === 'error' && !await page.locator('.analysis-dots').isVisible(), 'error stops the animation');
  ok(await page.locator('[data-retry-analysis]').isVisible(), 'existing retry action is preserved');
  await page.click('[data-retry-analysis]');
  await page.waitForFunction(() => document.body.dataset.tab === 'plan');
  ok(await state() === 'ready', 'successful retry shows the ready state');
  ok(await page.locator('#analyzeBar').evaluate(el => el.style.width) === '100%', 'progress completes only after the plan is saved');
  ok(ai.segment === 1, 'visual changes do not add extra segmentation requests');
  await page.click('[data-tab=load]');
  ok(!await page.locator('.analysis-dots').isVisible(), 'completed plan has no running waiting animation');
};
