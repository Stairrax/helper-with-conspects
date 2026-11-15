// Единая стилизованная кнопка: стоп/вопрос, возобновление и остановка с другой вкладки.
export default async ({ open, prepare, FINANCE, ok }) => {
  const { page } = await open({ settings: { selfCheck: false, voiceCommands: false, listenWhileSpeaking: false } });
  await prepare(page, FINANCE, 'Единая кнопка');
  await page.evaluate(() => { window.__dur = 120000; });
  ok(await page.evaluate(() => ['playBtn', 'continueBtn', 'breakSkip'].every((id) => !document.getElementById(id))),
    'нет дублирующих кнопок паузы и продолжения');
  await page.click('#startBtn');
  await page.waitForFunction(() => document.body.dataset.dict === 'speaking' && window.speechSynthesis.speaking, null, { timeout: 10000 });
  ok(await page.isVisible('#stopBtn') && /СТОП/.test(await page.textContent('#stopBtn')),
    'во время чтения одна основная кнопка «СТОП»');
  await page.click('#stopBtn');
  await page.waitForFunction(() => document.body.dataset.dict === 'listening', null, { timeout: 5000 });
  ok(!await page.evaluate(() => window.speechSynthesis.speaking), 'стоп сразу прекращает речь');
  ok(await page.isVisible('#qaPanel') && /Дальше/.test(await page.textContent('#stopBtn')),
    'после остановки можно задать вопрос, кнопка стала «Дальше»');
  await page.click('#stopBtn');
  await page.waitForFunction(() => document.body.dataset.dict === 'speaking', null, { timeout: 10000 });
  ok(await page.evaluate(() => window.speechSynthesis.speaking), '«Дальше» возобновляет речь');
  await page.click('[data-tab=plan]');
  ok(await page.isVisible('#stopBtn'), 'кнопка доступна во время чтения с другой вкладки');
  await page.click('#stopBtn');
  await page.waitForFunction(() => document.body.dataset.dict === 'listening', null, { timeout: 5000 });
  ok(await page.evaluate(() => document.body.dataset.tab === 'dictate'),
    'стоп на другой вкладке возвращает к вопросу');
};
