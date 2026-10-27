// Голосовые и текстовые команды приложения.
export default async ({ open, prepare, FINANCE, ok }) => {
  const { page, ai, say } = await open({ settings: { voiceCommands: true, listenWhileSpeaking: true } });
  const parsed = await page.evaluate(async () => {
    const m = await import('./js/commands.js');
    const p = (t) => JSON.stringify(m.matchAppCommand(t));
    return {
      third: p('перейди к третьей теме'), byName: p('к теме налоги'), prev: p('предыдущая тема'), where: p('какая сейчас тема'),
      fx: p('покажи формулы'), fxNext: p('формулы следующей темы'), pause: p('паузы подольше'), light: p('светлая тема'), dark: p('тёмная тема'),
      question: p('почему вклад растет быстрее'), whatIs: p('что такое тема налогов'), stop: p('стоп'),
    };
  });
  ok(parsed.third === '{"cmd":"gotoTopic","arg":{"n":3}}', '«перейди к третьей теме» ' + parsed.third);
  ok(parsed.byName === '{"cmd":"gotoTopic","arg":{"q":"налоги"}}', '«к теме налоги» ' + parsed.byName);
  ok(parsed.prev === '{"cmd":"prevTopic"}' && parsed.where === '{"cmd":"where"}', 'предыдущая тема, какая сейчас тема');
  ok(parsed.fx === '{"cmd":"fx","arg":"cur"}' && parsed.fxNext === '{"cmd":"fx","arg":"next"}', 'формулы');
  ok(parsed.pause === '{"cmd":"pauseLen","arg":1}' && parsed.light === '{"cmd":"theme","arg":"ink"}' && parsed.dark === '{"cmd":"theme","arg":"aurora"}', 'настройки и оформление');
  ok(parsed.question === 'null' && parsed.whatIs === 'null' && parsed.stop === 'null', 'вопросы и короткие команды диктовки — не команды приложения');

  await prepare(page, FINANCE, 'Финансы');
  const titles = await page.$$eval('#planList .ptitle', (x) => x.map((e) => e.childNodes[0].textContent.trim()));
  await page.evaluate(() => { window.__dur = 600000; });
  await page.click('#startBtn');
  await page.waitForFunction(() => window.__spoken.length >= 2, null, { timeout: 10000 });
  const title = () => page.textContent('#topicTitle');
  await say('вторая тема'); ok((await title()) === titles[1], '«вторая тема»');
  await say('предыдущая тема'); ok((await title()) === titles[0], '«предыдущая тема»');
  await say('перейди к теме ' + titles[1].split(' ')[0].toLowerCase()); ok((await title()) === titles[1], '«к теме <слово из названия>»');
  await say('к первой теме'); ok((await title()) === titles[0], '«к первой теме»');
  await say('покажи формулы');
  ok(await page.isVisible('#fxSheet .fx-list'), '«покажи формулы»');
  await say('закрой формулы');
  ok(await page.evaluate(() => document.getElementById('fxSheet').classList.contains('hidden')), '«закрой формулы»');

  const settings = () => page.evaluate(() => JSON.parse(localStorage.getItem('kd.settings')));
  await say('стоп');
  const n = await page.evaluate(() => window.__spoken.length);
  await say('какая сейчас тема');
  ok(/Тема 1 из 2/.test(await page.evaluate((n) => window.__spoken.slice(n).join(' '), n)), '«какая сейчас тема» — ответ голосом');
  await say('паузы подольше'); ok((await settings()).pause === 4, '«паузы подольше»');
  await say('только слушаю'); ok((await settings()).listenOnly === true, '«только слушаю»');
  await say('режим записи'); ok((await settings()).listenOnly === false, '«режим записи»');
  await say('светлая тема'); ok(await page.evaluate(() => document.documentElement.dataset.theme) === 'ink', '«светлая тема» — «Чернила»');
  await say('сделай так чтобы паузы были короче', true, 3200);
  ok(ai.command === 1 && (await settings()).pause === 3, 'просьба своими словами — через нейросеть');
  await page.fill('#questionInput', 'открой план');
  await page.click('#askBtn');
  await page.waitForTimeout(400);
  ok(await page.evaluate(() => document.body.dataset.tab) === 'plan', 'команда текстом из поля вопроса');
  await page.click('[data-tab=dictate]');
  const answers = ai.answer;
  await page.fill('#questionInput', 'почему вклад растёт всё быстрее');
  await page.click('#askBtn');
  await page.waitForTimeout(1200);
  ok(ai.answer === answers + 1, 'настоящий вопрос по-прежнему уходит нейросети');
};
