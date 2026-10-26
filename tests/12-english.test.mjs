// Конспект на английском: распознавание и голос — английские, нейросеть пишет по-английски, команды по-английски.
const TEXT = `Compound interest is interest on interest. The final amount: S = P(1 + r)^n. Income: D = S - P. Real rate: R = r - i.

A budget is a plan of income and expenses. A surplus is when income exceeds expenses.`;

export default async ({ open, prepare, ok }) => {
  const { page, ai, say } = await open({ settings: { contentLang: 'en', voiceCommands: true, listenWhileSpeaking: true }, titles: ['Income and expenses', 'Compound interest'] });
  await prepare(page, TEXT, 'Finance');
  ok(ai.prompts.length > 0 && ai.prompts.every((p, i) => true), 'запросы отправлены');
  const sys = await page.evaluate(async () => { const m = await import('./js/ai.js'); return JSON.stringify(m.conn(JSON.parse(localStorage.getItem('kd.settings')))); });
  ok(JSON.parse(sys).lang === 'en', 'язык конспекта уходит в запросы нейросети');
  await page.click('#startBtn');
  await page.waitForFunction(() => window.__spoken.length >= 2, null, { timeout: 10000 });
  ok(await page.evaluate(() => window.__spoken[0]) === 'Topic: Income and expenses.', 'диктор говорит по-английски: ' + await page.evaluate(() => window.__spoken[0]));
  ok(await page.evaluate(() => window.__ttsLang) === 'en-US' && await page.evaluate(() => window.__srLang) === 'en-US', 'голос и распознавание — en-US');
  await page.evaluate(() => { window.__dur = 600000; });
  await say('go to topic two');
  ok((await page.textContent('#topicTitle')) === 'Compound interest', '«go to topic two»');
  await say('previous topic');
  ok((await page.textContent('#topicTitle')) === 'Income and expenses', '«previous topic»');
  await say('show formulas');
  ok(await page.isVisible('#fxSheet .fx-list'), '«show formulas»');
  await say('close formulas');
  await say('stop', true, 300);
  ok(await page.evaluate(() => !window.speechSynthesis.speaking) && /Слушаю/.test(await page.textContent('#dictState')), '«stop»');
  await page.evaluate(() => { window.__dur = 0; });
  await say('why does the amount grow faster', true, 200);
  await page.waitForFunction(() => /Shall we continue/.test(window.__spoken.at(-1) || ''), null, { timeout: 10000 });
  ok(ai.answer === 1, 'вопрос по-английски — ответ нейросети, затем «Shall we continue?»');
  await say('yes', true, 400);
  ok(await page.evaluate(() => window.speechSynthesis.speaking), '«yes» — диктовка продолжилась');
  await say('next topic', true, 600);
  ok(/Topic: Compound interest/.test(await page.evaluate(() => window.__spoken.join('|'))), '«next topic»');

  // переключение обратно на русский — голос и распознавание тоже
  await page.click('[data-tab=settings]');
  await page.evaluate(() => { const r = document.querySelector('input[name=contentLang][value=ru]'); r.checked = true; r.dispatchEvent(new Event('change')); });
  await page.click('[data-tab=dictate]');
  await page.evaluate(() => window.__say('продолжай'));
  await page.waitForTimeout(600);
  ok(await page.evaluate(() => window.__ttsLang) === 'ru-RU', 'обратно на русский — голос ru-RU');
};
