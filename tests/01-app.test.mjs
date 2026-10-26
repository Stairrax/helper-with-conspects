// Запуск, мастер первого запуска, работа без интернета.
export default async ({ open, ok }) => {
  const fresh = await open({ settings: null });
  ok(await fresh.page.isVisible('#onboard'), 'новому пользователю показывается мастер');
  ok(await fresh.page.isVisible('#obImport'), 'в мастере есть «Мне прислали готовый конспект»');

  const { page, ctx } = await open();
  ok(await page.isVisible('#tab-load'), 'открывается вкладка «Материал»');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  ok(await page.evaluate(() => !!navigator.serviceWorker.controller), 'service worker управляет страницей');
  await ctx.setOffline(true);
  await page.reload();
  await page.waitForTimeout(500);
  ok((await page.title()) === 'Диктор конспектов' && await page.isVisible('#tab-load'), 'без интернета приложение открывается из кэша');
  await ctx.setOffline(false);
};
