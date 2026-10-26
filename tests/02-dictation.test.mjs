// Главный сценарий: план, диктовка, «СТОП», вопрос, ответ, возврат к куску, команды, продолжение после перезапуска.
export default async ({ open, prepare, FINANCE, ok }) => {
  const { page, ai, say } = await open({ settings: { voiceCommands: true, listenWhileSpeaking: true, formulasApart: false } });
  await prepare(page, FINANCE, 'Финансы');
  ok(ai.segment === 1 && ai.plan === 1 && ai.generate === 2, `запросы: темы ${ai.segment}, план ${ai.plan}, куски ${ai.generate}`);
  ok((await page.$$('#planList li')).length === 2, 'в плане две темы');

  await page.click('#startBtn');
  await page.waitForFunction(() => window.__spoken.length >= 2 && window.speechSynthesis.speaking, null, { timeout: 10000 });
  ok(await page.evaluate(() => window.__spoken[0].startsWith('Тема:')), 'диктовка начинается с названия темы');
  const chunk = await page.evaluate(() => window.__spoken.at(-1));

  await page.dispatchEvent('#stopBtn', 'pointerdown');
  ok(await page.evaluate(() => !window.speechSynthesis.speaking), '«СТОП» сразу обрывает речь');
  await page.waitForTimeout(150); // надпись обновляется со следующим кадром
  ok(/Слушаю/.test(await page.textContent('#dictState')), 'после «СТОП» приложение слушает вопрос');

  await say('почему вклад растёт всё быстрее', true, 200);
  await page.waitForFunction(() => /Продолжаем/.test(window.__spoken.at(-1) || ''), null, { timeout: 10000 });
  ok(ai.answer === 1 && /проценты начисляются/.test(await page.textContent('#answer')), 'нейросеть ответила, ответ на экране');
  await say('да', true, 200);
  await page.waitForFunction((c) => window.__spoken.at(-1) === c, chunk, { timeout: 5000 });
  ok(true, 'после «да» — снова прерванный кусок');

  await say('стоп', true, 300);
  ok(await page.evaluate(() => !window.speechSynthesis.speaking), 'голосовое «стоп»');
  await say('пропусти тему', true, 600);
  ok(/Тема: Сложный процент/.test(await page.evaluate(() => window.__spoken.join('|'))), '«пропусти тему» — следующая тема');

  await page.reload();
  await page.waitForTimeout(500);
  await page.click('[data-tab=load]');
  ok(await page.isVisible('#resumeCard'), 'после перезапуска — карточка «Продолжить диктовку»');
};
