export default async ({ open, ok, say: unused }) => {
  const { page, say } = await open();
  await page.click('#addLectureBtn');
  await page.evaluate(() => {
    window.originalSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function(k, v) {
      if (k === 'kd.lectureDraft') throw new DOMException('quota', 'QuotaExceededError');
      return window.originalSet.call(this, k, v);
    };
  });
  await say('важный текст лекции', true, 100);
  ok(await page.locator('#storageWarning').isVisible(), 'ошибка сохранения черновика показывается');
  await page.evaluate(() => { Storage.prototype.setItem = window.originalSet; });
  await page.click('#lecturePause');
  ok(await page.locator('#storageWarning').isHidden(), 'предупреждение исчезает после успешного сохранения');
  await page.evaluate(() => {
    window.originalPut = IDBObjectStore.prototype.put;
    Storage.prototype.setItem = function(k, v) {
      if (k.startsWith('kd.idb.sources:')) throw new DOMException('quota', 'QuotaExceededError');
      return window.originalSet.call(this, k, v);
    };
    IDBObjectStore.prototype.put = function(v, k) {
      if (String(k).startsWith('sources:')) throw new DOMException('quota', 'QuotaExceededError');
      return window.originalPut.call(this, v, k);
    };
  });
  await page.click('#lectureDone');
  await page.waitForTimeout(300);
  ok(await page.locator('#lecturePanel').isVisible() && (await page.textContent('#lectureText')).includes('важный текст'), 'при ошибке сохранения материала лекция остаётся на экране');
  ok(await page.evaluate(() => JSON.parse(localStorage.getItem('kd.lectureDraft')).text.includes('важный текст')), 'черновик не удалён при ошибке сохранения материала');
  await page.evaluate(() => { Storage.prototype.setItem = window.originalSet; IDBObjectStore.prototype.put = window.originalPut; });
  await page.evaluate(() => { document.getElementById('lectureTidy').checked = false; });
  await page.click('#lectureDone');
  await page.waitForFunction(() => document.querySelector('#lecturePanel').classList.contains('hidden'));
  ok(await page.evaluate(() => !localStorage.getItem('kd.lectureDraft')), 'после успешного сохранения черновик удалён');
  ok(await page.locator('#sourceList li').count() === 1, 'повторное сохранение не создаёт дубликат');
  const next = await open();
  await next.page.route(/generativelanguage\.googleapis|openrouter\.ai\/api/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.fallback();
  });
  await next.page.click('#addLectureBtn');
  await next.say('текст для обработки лекции', true, 100);
  await next.page.click('#lectureDone');
  await next.page.waitForSelector('#lectureWork:not(.hidden)');
  ok(await next.page.locator('#lectureWorkBar').isVisible(), 'во время обработки лекции виден индикатор');
  await next.page.waitForSelector('#lectureWork', { state: 'hidden' });
  ok(await next.page.locator('#lectureWorkBar').isHidden(), 'после обработки индикатор скрывается');
};
