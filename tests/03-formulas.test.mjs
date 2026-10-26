// Формулы отдельным блоком: подготовка, кнопка «∑ Формулы», переходы, пауза на время формул, экспорт.
export default async ({ open, prepare, FINANCE, ok }) => {
  const { page, ai } = await open();
  await prepare(page, FINANCE, 'Финансы');
  ok(ai.prompts.some((p) => p.includes('Если в этом тексте формул 3 или больше')), 'нейросеть решает по порогу «3 формулы»');
  const badges = await page.$$eval('#planList .badge.fx', (b) => b.map((x) => x.textContent));
  ok(badges.length === 1 && badges[0] === '∑ 3', 'в плане отметка «∑ 3»');

  await page.evaluate(() => { window.__dur = 600000; });
  await page.click('#startBtn');
  await page.waitForFunction(() => window.__spoken.length >= 2, null, { timeout: 10000 });
  ok(!(await page.evaluate(() => window.__spoken.join(' '))).includes('='), 'формулы не диктуются');
  await page.click('#fxBtn');
  const items = await page.$$eval('#fxList .fx-f', (x) => x.map((e) => e.textContent));
  ok(items.length === 3 && items[0] === 'S = P(1 + r)ⁿ', 'в окне три формулы, ^n стало ⁿ');
  ok(await page.evaluate(() => window.speechSynthesis.speaking), 'без настройки паузы диктовка идёт дальше');
  await page.click('#fxSheet .fx-close');

  await page.evaluate(() => { const e = document.getElementById('fxPause'); e.checked = true; e.dispatchEvent(new Event('change')); });
  await page.click('#fxBtn');
  await page.waitForTimeout(300);
  ok(/Пауза/.test(await page.textContent('#dictState')), '«Пауза, пока открыты формулы» — диктовка стоит');
  await page.click('#fxSheet .fx-close');
  await page.waitForTimeout(400);
  ok(await page.evaluate(() => window.speechSynthesis.speaking), 'закрыли окно — диктовка продолжилась');

  const md = await page.evaluate(async () => {
    let out = ''; navigator.canShare = () => true;
    navigator.share = async ({ files }) => { out = await files[0].text(); };
    document.getElementById('exportBtn').click();
    await new Promise((r) => setTimeout(r, 300));
    return out;
  });
  ok(md.includes('**Формулы:**') && md.includes('S = P(1 + r)ⁿ'), 'формулы есть в файле конспекта');
};
