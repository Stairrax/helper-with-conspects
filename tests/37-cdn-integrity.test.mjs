// The audio encoder must never execute changed bytes from either CDN mirror.
export default async ({ browser, base, ok }) => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  await page.route(/lamejs@1\.2\.1\/lame\.min\.js/, (route) => route.fulfill({
    contentType: 'text/javascript',
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: 'window.__changedCdnCodeRan = true; window.lamejs = {};',
  }));
  await page.goto(base);
  const result = await page.evaluate(async () => {
    try {
      const { renderMp3 } = await import('./js/audiobook.js');
      await renderMp3([{ text: 'Проверка', pause: 0 }], { synth: async () => { throw new Error('Unexpected synthesis'); } });
      return { loaded: true, ran: !!window.__changedCdnCodeRan };
    } catch (error) {
      return { loaded: false, ran: !!window.__changedCdnCodeRan, message: error.message };
    }
  });
  ok(!result.loaded && !result.ran && result.message.includes('Не удалось загрузить кодировщик MP3'),
    'changed CDN code cannot execute or provide the MP3 encoder: ' + JSON.stringify(result));
  await context.close();
};
