// Компьютер: вкладки слева и клавиши.
export default async ({ open, prepare, FINANCE, ok }) => {
  const { page } = await open({ desktop: true });
  await prepare(page, FINANCE, 'Финансы');
  const nav = await page.locator('.navbar').boundingBox();
  ok(nav.width < 120 && nav.height > 700, 'вкладки — колонка слева');
  const state = () => page.textContent('#dictState');
  await page.evaluate(() => { window.__dur = 600000; document.activeElement?.blur(); });
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.__spoken.length >= 1, null, { timeout: 10000 });
  ok(await page.evaluate(() => document.body.dataset.tab) === 'dictate', 'пробел — начать диктовку');
  await page.waitForTimeout(200);
  await page.keyboard.press('Space'); await page.waitForTimeout(200);
  ok(/Пауза/.test(await state()), 'пробел — пауза');
  await page.keyboard.press('Space'); await page.waitForTimeout(200);
  ok(/Диктую/.test(await state()), 'пробел — продолжить');
  await page.keyboard.press('Shift+ArrowRight'); await page.waitForTimeout(300);
  ok((await page.textContent('#topicTitle')) === 'Сложный процент', 'Shift + → — следующая тема');
  await page.keyboard.press('Shift+ArrowLeft'); await page.waitForTimeout(300);
  ok((await page.textContent('#topicTitle')) === 'Доходы и расходы', 'Shift + ← — предыдущая тема');
  await page.keyboard.press('KeyF'); await page.waitForTimeout(200);
  ok(await page.isVisible('#fxSheet .fx-list'), 'F — формулы');
  await page.keyboard.press('Escape'); await page.waitForTimeout(200);
  ok(await page.evaluate(() => document.getElementById('fxSheet').classList.contains('hidden')), 'Esc — закрыть');
  await page.keyboard.press('KeyS'); await page.waitForTimeout(200);
  ok(/Слушаю/.test(await state()), 'S — СТОП / вопрос');
  await page.focus('#questionInput'); await page.keyboard.type('s 2');
  ok((await page.inputValue('#questionInput')) === 's 2' && await page.evaluate(() => document.body.dataset.tab) === 'dictate', 'в поле вопроса клавиши печатают');
};
