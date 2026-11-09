// Бесплатных запросов в день немного: большой конспект предупреждает, темы готовятся по мере чтения,
// когда запросы кончились — понятное сообщение, а готовые части плана не пропадают.
const TITLES = ['Первая', 'Вторая', 'Третья', 'Четвёртая', 'Пятая', 'Шестая'];
const FREE = { provider: 'free', apiKey: '', coverageCheck: false };
const textOf = (n) => Array.from({ length: n }, (_, i) => `Раздел ${i + 1}. Сложный процент начисляется на накопленную сумму. Бюджет — это план доходов и расходов.`).join('\n\n');
const LIMIT = { error: { code: 'daily_limit', proxy: true, message: 'На сегодня бесплатные запросы закончились. Продолжите завтра или укажите свой ключ: Настройки → Настроить заново.' } };

async function addText(page, text) {
  await page.click('[data-tab=load]');
  await page.click('#addTextBtn');
  await page.evaluate((t) => { document.getElementById('pasteText').value = t; }, text);
  await page.fill('#pasteTitle', 'Конспект');
  await page.click('#pasteAdd');
}
const ready = (page) => page.evaluate(() => document.querySelectorAll('#planList .pstate.ok').length);

export default async ({ open, ok }) => {
  // ---- темы — по мере чтения
  {
    const { page, ai } = await open({ settings: FREE, freeProxy: 'https://free-proxy.test', titles: TITLES });
    await addText(page, textOf(60));
    await page.click('#analyzeBtn');
    await page.waitForFunction(() => document.querySelectorAll('#planList li').length === 6, null, { timeout: 20000 });
    await page.waitForFunction(() => document.querySelectorAll('#planList .pstate.ok').length >= 3, null, { timeout: 20000 });
    await page.waitForTimeout(1500); // дальше трёх тем готовиться не должно
    ok(await ready(page) === 3 && ai.generate === 3, 'бесплатный режим: сразу готовы только три темы — запросов на подготовку: ' + ai.generate);
    ok(/остальные темы — по мере чтения/.test(await page.textContent('#genStatus')) && await page.isVisible('#prepAllBtn'), 'в плане сказано, что остальные — по мере чтения, и есть «Подготовить все темы сразу»');
    // дошли до четвёртой темы — она подготовится сама
    await page.click('#planList li:nth-child(4) .phead');
    await page.click('#planList li:nth-child(4) [data-act=from]');
    await page.waitForTimeout(300);
    await page.click('[data-tab=plan]');
    await page.waitForFunction(() => document.querySelectorAll('#planList .pstate.ok').length >= 4, null, { timeout: 20000 });
    ok(true, 'перешли на четвёртую тему — она и следующие готовятся');
  }
  // «Подготовить все темы сразу»
  {
    const { page } = await open({ settings: FREE, freeProxy: 'https://free-proxy.test', titles: TITLES });
    await addText(page, textOf(60));
    await page.click('#analyzeBtn');
    await page.waitForFunction(() => document.querySelectorAll('#planList .pstate.ok').length >= 3, null, { timeout: 20000 });
    await page.waitForTimeout(800);
    page.once('dialog', (d) => d.accept());
    await page.click('#prepAllBtn');
    await page.waitForFunction(() => document.querySelectorAll('#planList .pstate.ok').length === 6, null, { timeout: 20000 });
    ok(!(await page.isVisible('#prepAllBtn')), '«Подготовить все темы сразу» — готовы все шесть');
  }

  // ---- предупреждение о большом конспекте
  {
    const { page, ai } = await open({ settings: FREE, freeProxy: 'https://free-proxy.test', titles: TITLES });
    await addText(page, textOf(1500)); // ≈ 130 тыс. знаков
    let msg = '';
    page.once('dialog', (d) => { msg = d.message(); d.dismiss(); });
    await page.click('#analyzeBtn');
    await page.waitForTimeout(500);
    ok(/Конспект большой: на план уйдёт около \d+ запросов/.test(msg) && ai.segment === 0, 'большой конспект: предупреждение, и пока ничего не отправлено: ' + msg.slice(0, 60));
    page.once('dialog', (d) => d.accept());
    await page.click('#analyzeBtn');
    await page.waitForFunction(() => document.querySelectorAll('#planList li').length > 0, null, { timeout: 30000 });
    ok(ai.segment > 0, '«Продолжить» — план составляется');
  }

  // ---- лимит кончился на середине плана: сообщение, кнопка ключа, готовые части не пересчитываются
  {
    const { page, ai } = await open({ settings: FREE, freeProxy: 'https://free-proxy.test', titles: TITLES });
    let n = 0, blocked = true;
    await page.route(/free-proxy\.test/, (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      n++;
      if (blocked && n > 2) return route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify(LIMIT) });
      return route.fallback();
    });
    await addText(page, textOf(330)); // ≈ 3 части по 12 тыс. знаков
    await page.click('#analyzeBtn');
    await page.waitForFunction(() => /закончились/.test(document.getElementById('analyzeStatus').textContent), null, { timeout: 20000 });
    ok(await page.isVisible('#analyzeStatus [data-own-key]') && /Сохранённые результаты распознавания и разбора/.test(await page.textContent('#analyzeStatus')), 'лимит кончился: сообщение, «части сохранены» и кнопка «Подключить свой ключ»');
    const done = ai.segment;
    blocked = false;
    await page.click('#analyzeBtn');
    await page.waitForFunction(() => document.querySelectorAll('#planList li').length > 0, null, { timeout: 20000 });
    ok(done === 2 && ai.segment === 3 && ai.plan === 1, `повторный план берёт готовые части: на разбиение всего ${ai.segment} запроса вместо 5`);
    await page.click('#analyzeBtn').catch(() => {});
  }

  // ---- лимит кончился при подготовке тем: тема остаётся в очереди, повторов нет, есть кнопка ключа
  {
    const { page } = await open({ settings: FREE, freeProxy: 'https://free-proxy.test', titles: TITLES });
    let hits = 0;
    await page.route(/free-proxy\.test/, (route) => {
      if (route.request().method() === 'POST' && (route.request().postData() || '').includes('ИСХОДНЫЙ ТЕКСТ')) {
        hits++;
        return route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify(LIMIT) });
      }
      return route.fallback();
    });
    await addText(page, textOf(60));
    await page.click('#analyzeBtn');
    await page.waitForFunction(() => document.querySelectorAll('#planList li').length === 6, null, { timeout: 20000 });
    await page.waitForFunction(() => /бесплатные запросы на сегодня закончились/.test(document.getElementById('genStatus').textContent), null, { timeout: 20000 });
    await page.waitForTimeout(1200);
    ok(hits === 1, 'лимит: сервер спросили один раз, без повторов — запросов ' + hits);
    ok(await page.evaluate(() => document.querySelectorAll('#planList .pstate.err').length === 0), 'темы не помечены ошибкой — они просто ждут');
    ok(await page.isVisible('#limitKeyBtn') && !(await page.isVisible('#prepAllBtn')), 'есть «Подключить свой ключ», «Подготовить все» скрыто');
    await page.click('#limitKeyBtn');
    ok(await page.isVisible('#onboard'), '«Подключить свой ключ» открывает мастер');
    await page.evaluate(() => document.getElementById('onboard').classList.add('hidden'));
    // диктовка не зависает молча: сказано, что запросы кончились
    await page.click('#planList li:nth-child(1) .phead');
    await page.click('#planList li:nth-child(1) [data-act=from]');
    await page.waitForFunction(() => /Бесплатные запросы на сегодня закончились — эту тему подготовим позже/.test(document.getElementById('dictMsg').textContent), null, { timeout: 15000 });
    ok(true, 'в диктовке вместо вечного «Готовлю…» — понятное сообщение');

    // свой ключ подключён — подготовка продолжается сразу, а не через полчаса
    await page.click('[data-tab=settings]');
    await page.evaluate(() => { document.getElementById('manualAi').open = true; });
    await page.selectOption('#provider', 'openrouter');
    await page.fill('#apiKey', 'sk-or-test');
    await page.dispatchEvent('#apiKey', 'change');
    await page.click('[data-tab=plan]');
    await page.waitForFunction(() => document.querySelectorAll('#planList .pstate.ok').length >= 2, null, { timeout: 20000 });
    ok(!/запросы на сегодня закончились/.test(await page.textContent('#genStatus')), 'со своим ключом чужой дневной лимит больше не держит подготовку');
  }

  // ---- отложенная запись конспекта не теряется при закрытии приложения
  {
    const { page } = await open({ settings: FREE, freeProxy: 'https://free-proxy.test', titles: TITLES });
    await addText(page, textOf(60));
    await page.click('#analyzeBtn');
    await page.waitForFunction(() => document.querySelectorAll('#planList li').length === 6, null, { timeout: 20000 });
    await page.click('[data-tab=plan]');
    // меняем конспект и тут же «сворачиваем» приложение — запись отложена на 400 мс
    await page.evaluate(() => { document.getElementById('examDate').value = '2030-01-01'; document.getElementById('examDate').dispatchEvent(new Event('change')); });
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await page.waitForTimeout(200);
    const saved = await page.evaluate(async () => {
      const key = Object.keys(localStorage).find((k) => k.startsWith('kd.subjects'));
      const id = JSON.parse(localStorage.getItem(key)).current;
      return await new Promise((res) => {
        const r = indexedDB.open('konspekt-diktor', 1);
        r.onsuccess = () => { const q = r.result.transaction('kv', 'readonly').objectStore('kv').get('project:' + id); q.onsuccess = () => res(q.result?.examDate || ''); };
      });
    });
    ok(saved === '2030-01-01', 'конспект записан сразу при сворачивании, отложенная запись не пропала: ' + saved);
  }
};
