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
  const layouts = await page.evaluate(() => {
    const root = document.documentElement, original = root.getAttribute('data-theme');
    const bar = document.getElementById('stopBar'), stop = document.getElementById('stopBtn');
    const result = ['aurora', 'ink', 'ios', 'android', 'neon', 'light', 'classic'].map(theme => {
      root.dataset.theme = theme;
      const r = bar.getBoundingClientRect(), b = stop.getBoundingClientRect();
      return b.width === 48 && b.height === 48 && r.width < 80 && r.right <= innerWidth &&
        getComputedStyle(stop.querySelector('.dict-control-label')).display === 'none' &&
        getComputedStyle(stop.querySelector('.dict-control-icon')).display !== 'none';
    });
    if (original === null) root.removeAttribute('data-theme'); else root.setAttribute('data-theme', original);
    return result;
  });
  ok(layouts.every(Boolean), 'компактная пауза размером 48 px помещается во всех темах');
  ok(await page.getAttribute('#stopIcon', 'href') === '#i-pause' && await page.getAttribute('#stopBtn', 'aria-label') === 'Пауза',
    'вне диктовки во время чтения показан значок паузы');
  await page.click('#stopBtn');
  await page.waitForFunction(() => document.body.dataset.dict === 'paused');
  ok(await page.getAttribute('body', 'data-tab') === 'plan' && await page.getAttribute('#stopIcon', 'href') === '#i-play',
    'пауза не уводит с плана и меняется на воспроизведение');
  ok(await page.locator('#openQuestionBtn .question-icon').isVisible() &&
    await page.getAttribute('#openQuestionBtn', 'aria-label') === 'Задать вопрос',
    'компактный знак вопроса имеет доступное текстовое название');
  await page.click('#stopBtn');
  await page.waitForFunction(() => document.body.dataset.dict === 'speaking' && window.speechSynthesis.speaking);
  ok(await page.getAttribute('body', 'data-tab') === 'plan', 'воспроизведение продолжается без смены вкладки');
  await page.evaluate(() => window.__headsetPause());
  await page.waitForFunction(() => document.body.dataset.dict === 'paused');
  ok(await page.textContent('#stopBtn') === 'Продолжить' && await page.isVisible('#openQuestionBtn'),
    'пауза через Media Session обновляет кнопку на вкладке «План»');
  await page.click('#openQuestionBtn');
  ok(await page.locator('body').getAttribute('data-tab') === 'dictate' && await page.isVisible('#questionInput'),
    'отдельная кнопка на вкладке «План» открывает текстовый вопрос');
};
