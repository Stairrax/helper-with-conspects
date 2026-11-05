// Тест с вариантами ответа: вопросы готовит нейросеть один раз, прохождение — без запросов.
export default async ({ open, prepare, FINANCE, ok }) => {
  const { page, ai } = await open({ settings: { selfCheck: false } });

  // ---- разбор самого модуля: варианты перемешаны, итог считается верно
  const unit = await page.evaluate(async () => {
    const m = await import('./js/mcq.js');
    const project = { tests: { t1: { items: [{ q: 'В?', a: 'верно', w: ['н1', 'н2', 'н3'] }] } } };
    const topics = [{ id: 't1', title: 'Тема', status: 'ready' }, { id: 't2', title: 'Вторая', status: 'ready' }];
    let i = 7;
    const rnd = () => ((i = (i * 9301 + 49297) % 233280) / 233280);
    const quiz = m.buildQuiz(project, topics, 5, rnd);
    const res = m.testResult(
      [{ correct: 0, topicId: 'a', topicTitle: 'А' }, { correct: 1, topicId: 'a', topicTitle: 'А' }, { correct: 2, topicId: 'b', topicTitle: 'Б' }],
      [1, 0, 2], // по теме «А» обе мимо, по «Б» верно
    );
    return {
      quiz, res,
      toPrepare: m.topicsToPrepare(project, topics, 10).map((t) => t.id),
      enough: m.topicsToPrepare(project, topics, 1).map((t) => t.id),
    };
  });
  ok(unit.quiz.length === 1 && unit.quiz[0].options.length === 4 && unit.quiz[0].options[unit.quiz[0].correct] === 'верно',
    'вопрос собран: четыре варианта, верный отмечен — ' + JSON.stringify(unit.quiz[0].options));
  ok(unit.res.right === 1 && unit.res.total === 3 && unit.res.pct === 33 && unit.res.weak.join() === 'А',
    'итог: 1 из 3, в слабые попала тема, где верных меньше половины ' + JSON.stringify(unit.res.weak));
  ok(unit.toPrepare.join() === 't2' && unit.enough.join() === '', 'готовится только то, чего не хватает');

  await prepare(page, FINANCE, 'Финансы');

  // ---- вопросы составляются один раз
  await page.click('[data-tab=plan]');
  await page.click('#testBtn');
  ok(await page.isVisible('#testStart'), 'окно теста открылось');
  ok(/Вопросов ещё нет/.test(await page.textContent('#testPoolHint')), 'сказано, сколько запросов уйдёт: ' + await page.textContent('#testPoolHint'));
  await page.evaluate(() => { document.querySelector('input[name=testCount][value="5"]').click(); });
  const before = ai.mcq || 0;
  await page.click('#testStart');
  await page.waitForFunction(() => !document.getElementById('testRun').classList.contains('hidden'), null, { timeout: 15000 });
  ok((ai.mcq || 0) - before === 1, 'на пять вопросов ушёл один запрос к нейросети: ' + ((ai.mcq || 0) - before));
  ok(/Вопрос 1 из 5/.test(await page.textContent('#testNum')) && (await page.$$('#testOpts .test-opt')).length === 4, 'на экране вопрос и четыре варианта');

  // ---- прохождение: верный и неверный ответ, запросов не тратится
  const asked = ai.prompts.length;
  const correctIdx = () => page.evaluate(() => [...document.querySelectorAll('#testOpts .test-opt')].findIndex((b) => /^Верно /.test(b.textContent)));
  await page.click(`#testOpts .test-opt:nth-child(${(await correctIdx()) + 1})`);
  ok(await page.evaluate(() => !!document.querySelector('#testOpts .test-opt.right') && !document.querySelector('#testOpts .test-opt.wrong')),
    'верный ответ подсвечен сразу');
  ok(await page.isVisible('#testNext'), 'появилась кнопка «Дальше»');
  await page.click('#testNext');
  const wrong = (await correctIdx()) === 0 ? 2 : 1;
  await page.click(`#testOpts .test-opt:nth-child(${wrong})`);
  ok(await page.evaluate(() => !!document.querySelector('#testOpts .test-opt.wrong') && !!document.querySelector('#testOpts .test-opt.right')),
    'при ошибке видно и свой ответ, и правильный');
  ok(/1 \/ 1/.test(await page.textContent('#testScore')), 'счёт на экране');
  await page.click('#testStop');
  await page.waitForFunction(() => !document.getElementById('testDone').classList.contains('hidden'), null, { timeout: 10000 });
  ok(/Верно 1 из 2 — это 50 %/.test(await page.textContent('#testResultText')), 'итог: ' + await page.textContent('#testResultText'));
  ok(ai.prompts.length === asked, 'на прохождение теста не ушло ни одного запроса');
  ok(await page.evaluate(() => {
    const k = Object.keys(localStorage).find((x) => x.startsWith('kd.progress'));
    return Object.values(JSON.parse(localStorage.getItem(k)).stats || {}).reduce((n, s) => n + s.total, 0) >= 2;
  }), 'ответы засчитаны в статистику темы — слабые места попадут в «Повторение»');

  // ---- второй проход: вопросы уже есть, запросов снова ноль
  await page.click('#testAgain');
  ok(/Готовых вопросов: 5/.test(await page.textContent('#testPoolHint')), 'во второй раз вопросы уже готовы: ' + await page.textContent('#testPoolHint'));
  const before2 = ai.prompts.length;
  await page.click('#testStart');
  await page.waitForFunction(() => !document.getElementById('testRun').classList.contains('hidden'), null, { timeout: 15000 });
  ok(ai.prompts.length === before2, 'повторный тест не стоит ни одного запроса');
};
