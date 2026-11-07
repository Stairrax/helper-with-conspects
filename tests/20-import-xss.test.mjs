// Безопасность: идентификаторы из присланного .konspekt.json — недоверенные данные.
// Они не должны превращаться в HTML, даже если содержат кавычки и теги.
export default async ({ open, ok }) => {
  const { page } = await open({ settings: null });
  const badId = 't"><img src=x onerror="window.__kdInjected=1">';
  await page.evaluate(() => { window.__kdInjected = 0; });
  const data = {
    format: 'konspekt-diktor', version: 1, title: 'Проверка импорта',
    project: {
      budgetMin: 60, priority: 'original', sources: [], fullText: 'Проверочный конспект',
      topics: [{
        id: badId, title: 'Тема из файла', text: 'Проверочный конспект',
        status: 'ready', chunks: [{ t: 'Проверочный конспект', k: 'content' }],
        points: [], prereq: [],
      }],
      plan: { order: [badId], skipped: {} },
      tickets: [{ id: badId, q: 'Проверочный вопрос?', a: 'Проверочный ответ.', status: 'ready', topics: [badId] }],
    },
  };
  await page.locator('#importInput').setInputFiles({
    name: 'untrusted.konspekt.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(data)),
  });
  await page.waitForFunction(() => document.querySelector('#planList li[data-id]')?.dataset.id?.startsWith('t"'), null, { timeout: 10000 });
  await page.waitForTimeout(100);
  ok(await page.evaluate(() => window.__kdInjected === 0), 'план: недоверенный ID не исполняется как HTML');
  ok(await page.locator('#planList li[data-id]').first().getAttribute('data-id') === badId, 'план: экранирование сохраняет исходный ID');

  await page.evaluate(() => document.getElementById('ticketBtn').click()); // click независимо от адаптивной видимости кнопки
  await page.waitForFunction(() => document.querySelector('#ticketList li[data-id]'));
  ok(await page.evaluate(() => window.__kdInjected === 0), 'билеты: недоверенный ID не исполняется как HTML');
  ok(await page.locator('#ticketList li[data-id]').first().getAttribute('data-id') === badId, 'билеты: экранирование сохраняет исходный ID');
};
