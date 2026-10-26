// Запись лекции: расшифровка на лету, черновик после перезапуска, порядок от нейросети, материал.
export default async ({ open, ok }) => {
  const { page, ai, say } = await open();
  await page.click('#addLectureBtn');
  await page.waitForTimeout(200);
  ok(await page.evaluate(() => document.getElementById('lectureDot').classList.contains('on')), 'запись началась');
  await say('сегодня мы поговорим о сложном проценте', true, 100);
  await say('это начисление процентов на', false, 100);
  ok((await page.textContent('#lectureText')).includes('начисление процентов на'), 'текст виден сразу, включая недоговорённое');
  await say('это начисление процентов на проценты', true, 100);
  await page.fill('#lectureTitle', 'Финансы, лекция 3');
  await page.waitForTimeout(1100);
  ok(/00:0[1-9]/.test(await page.textContent('#lectureClock')), 'идёт время');
  await page.reload(); await page.waitForTimeout(500);
  ok((await page.textContent('#lectureText')).includes('на проценты') && (await page.inputValue('#lectureTitle')) === 'Финансы, лекция 3', 'после перезапуска запись на месте');
  await page.click('#lecturePause'); await page.waitForTimeout(200);
  await say('итоговая сумма растет быстрее', true, 100);
  await page.click('#lectureDone');
  await page.waitForFunction(() => document.querySelectorAll('#sourceList li').length === 1, null, { timeout: 10000 });
  const src = await page.evaluate(async () => {
    const m = await import('./js/storage.js');
    return (await m.idbGet('sources:' + JSON.parse(localStorage.getItem('kd.subjects')).current))[0];
  });
  ok(src.name === 'Финансы, лекция 3' && src.text.startsWith('Сегодня') && src.text.includes('растет быстрее'), 'расшифровка стала материалом');
  ok(ai.tidy === 1, 'один запрос «навести порядок»');
  ok(await page.evaluate(() => !localStorage.getItem('kd.lectureDraft')), 'черновик удалён');
};
