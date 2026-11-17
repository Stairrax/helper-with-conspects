export default async ({ open, prepare, FINANCE, ok }) => {
  const { page } = await open({ desktop: true });
  await prepare(page, FINANCE);
  const saved = await page.evaluate(async () => {
    const { loadSubjects, idbGet } = await import('./js/storage.js');
    const id = loadSubjects().current;
    const project = await idbGet('project:' + id);
    return { key: 'kd.progress:' + id, projectId: project.id };
  });
  await page.addInitScript(({ key, projectId }) => {
    localStorage.setItem(key, JSON.stringify({
      projectId, done: {}, stats: {}, chunk: 0,
      qa: [{ q: 'Вопрос из истории', a: 'Сохранённый ответ', t: Date.now() - 60 * 60000 }],
    }));
  }, saved);
  await page.reload();
  await page.waitForFunction(() => window.__kdReady);
  await page.click('[data-tab=plan]');
  await page.waitForFunction(() => document.querySelectorAll('#planList [data-ready="true"]').length === 2);
  await page.evaluate(() => { window.__firstPlanRow = document.querySelector('#planList > li'); });
  await page.click('[data-tab=settings]');
  await page.click('[data-tab=plan]');
  ok(await page.evaluate(() => window.__firstPlanRow === document.querySelector('#planList > li')),
    'возврат в неизменившийся план сохраняет DOM списка');
  await page.locator('#planList [data-act=open]').first().click();
  await page.locator('#planList [data-act=skip]').first().click();
  ok(await page.locator('#planList > .skipped').count() === 1, 'изменение темы обновляет план');

  await page.click('#startBtn');
  await page.waitForFunction(() => window.speechSynthesis.speaking);
  await page.click('#stopBtn');
  await page.click('#openQuestionBtn');
  ok(await page.locator('#qaHistory .item').count() === 0, 'при входе закрытая история не создаёт элементы');
  await page.click('#historyTitle');
  await page.waitForFunction(() => document.querySelector('#qaHistory .a')?.textContent === 'Сохранённый ответ');
  ok(await page.locator('#qaHistory .q').textContent() === 'Вопрос из истории', 'открытие истории показывает сохранённые вопросы');
  await page.click('#historyTitle');
  await page.waitForFunction(() => document.getElementById('qaHistory').childElementCount === 0);
  ok(await page.locator('#qaHistory .item').count() === 0, 'закрытая история не держит лишние элементы');
};
