// Карточки для Anki и напоминание «пора повторить».
export default async ({ open, prepare, FINANCE, ok }) => {
  const { page, ctx } = await open({ settings: { selfCheck: true }, permissions: ['notifications'] });
  await prepare(page, FINANCE, 'Финансы');
  const anki = await page.evaluate(async () => {
    let out = null; navigator.canShare = () => true;
    navigator.share = async ({ files }) => { out = { name: files[0].name, text: await files[0].text() }; };
    document.getElementById('ankiBtn').click();
    await new Promise((r) => setTimeout(r, 400));
    return out;
  });
  const lines = anki.text.trim().split('\n');
  const cards = lines.filter((l) => !l.startsWith('#'));
  ok(lines[0] === '#separator:tab' && lines.includes('#deck:Финансы'), 'файл для Anki: заголовки и колода');
  ok(cards.length === 5 && cards.every((l) => l.split('\t').length === 3), 'карточки: 2 вопроса и 3 формулы');

  await page.evaluate(() => { const e = document.getElementById('remind'); e.checked = true; e.dispatchEvent(new Event('change')); });
  await page.waitForTimeout(600);
  ok(await page.evaluate(() => JSON.parse(localStorage.getItem('kd.settings')).remind) === true, 'напоминания включены');
  const tid = await page.evaluate(async () => {
    const subj = JSON.parse(localStorage.getItem('kd.subjects')).current;
    const db = await new Promise((r) => { const q = indexedDB.open('konspekt-diktor', 1); q.onsuccess = () => r(q.result); });
    return new Promise((r) => { const q = db.transaction('kv').objectStore('kv').get('project:' + subj); q.onsuccess = () => r(q.result.topics[0].id); });
  });
  // срок повторения — до запуска приложения, иначе его перезапишет текущий прогресс
  await page.addInitScript((tid) => {
    if (sessionStorage.getItem('__due')) return;
    sessionStorage.setItem('__due', '1');
    for (const k of Object.keys(localStorage).filter((k) => k.startsWith('kd.progress'))) {
      const p = JSON.parse(localStorage.getItem(k));
      p.stats = { [tid]: { asked: 0, right: 1, total: 2, studiedAt: Date.now() - 2e8, due: Date.now() - 1000, weak: true } };
      localStorage.setItem(k, JSON.stringify(p));
    }
  }, tid);
  await page.reload(); await page.waitForTimeout(2500);
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
  // уведомление перехватываем: облегчённый Chromium в GitHub Actions их не показывает даже с разрешением
  const notes = await sw.evaluate(async () => {
    const shown = [];
    self.registration.showNotification = async (title, o) => { shown.push(`${title}: ${o.body}`); };
    await remindDue();
    await remindDue();
    return shown;
  });
  ok(notes.length === 1 && notes[0] === 'Пора повторить: «Доходы и расходы»', 'уведомление, не чаще раза в сутки: ' + JSON.stringify(notes));
};
