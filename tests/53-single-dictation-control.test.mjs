// Пауза, текстовый вопрос и разрешённый пользователем голосовой ввод.
export default async ({ open, prepare, FINANCE, ok }) => {
  const { page } = await open({ settings: { selfCheck: false, voiceCommands: false, listenWhileSpeaking: false, headsetButtons: true } });
  await prepare(page, FINANCE, 'Единая кнопка');
  await page.evaluate(() => {
    window.__dur = 120000;
    const setActionHandler = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession);
    navigator.mediaSession.setActionHandler = (action, handler) => {
      if (action === 'pause') window.__headsetPause = handler;
      setActionHandler(action, handler);
    };
  });
  await page.click('#startBtn');
  await page.waitForFunction(() => document.body.dataset.dict === 'speaking' && window.speechSynthesis.speaking, null, { timeout: 10000 });
  ok(await page.textContent('#stopBtn') === 'Стоп' && !await page.isVisible('#openQuestionBtn'),
    'во время чтения видна кнопка «Стоп»');
  await page.click('#stopBtn');
  await page.waitForFunction(() => document.body.dataset.dict === 'paused');
  ok(!await page.evaluate(() => window.speechSynthesis.speaking), 'стоп сразу прекращает речь');
  ok(!await page.isVisible('#questionInput') && await page.isVisible('#openQuestionBtn') &&
    !await page.locator('#micState').evaluate(el => el.classList.contains('on')),
    'на паузе доступно отдельное действие, поле и микрофон закрыты');
  await page.click('#openQuestionBtn');
  ok(await page.locator('#questionInput').evaluate(el => el === document.activeElement) &&
    await page.getAttribute('#questionMic', 'aria-pressed') === 'false', 'текстовый вопрос открывается с выключенным микрофоном');
  await page.click('#questionMic');
  await page.waitForFunction(() => document.getElementById('questionMic').getAttribute('aria-pressed') === 'true');
  await page.click('#questionMic');
  await page.waitForFunction(() => document.getElementById('questionMic').getAttribute('aria-pressed') === 'false');
  ok(true, 'микрофон включается и выключается по отдельной кнопке');
  await page.click('#stopBtn');
  await page.waitForFunction(() => document.body.dataset.dict === 'speaking' && window.speechSynthesis.speaking, null, { timeout: 10000 });
  ok(true, '«Продолжить» возобновляет речь');
  await page.click('[data-tab=plan]');
  ok(await page.isVisible('#stopBtn'), 'кнопка доступна во время чтения с другой вкладки');
  await page.evaluate(() => window.__headsetPause());
  await page.waitForFunction(() => document.body.dataset.dict === 'paused');
  ok(await page.textContent('#stopBtn') === 'Продолжить' && await page.isVisible('#openQuestionBtn'),
    'пауза через Media Session обновляет кнопку на вкладке «План»');
  await page.click('#openQuestionBtn');
  ok(await page.locator('body').getAttribute('data-tab') === 'dictate' && await page.isVisible('#questionInput'),
    'отдельная кнопка на вкладке «План» открывает текстовый вопрос');
};
