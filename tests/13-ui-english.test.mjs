// Английский интерфейс: на экранах не остаётся русского текста (кроме самого конспекта), смена языка — в настройках и в мастере.
const TEXT = `Compound interest is interest on interest. The final amount: S = P(1 + r)^n. Income: D = S - P. Real rate: R = r - i.

A budget is a plan of income and expenses. A surplus is when income exceeds expenses.`;

// русский текст, видимый на экране вне содержимого конспекта
const leftovers = (all = false) => {
  const out = [];
  const it = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = it.nextNode(); n; n = it.nextNode()) {
    const el = n.parentElement;
    if (!/[а-яё]/i.test(n.data) || el.closest('[data-no-i18n],svg,script,style,#voiceSelect')) continue;
    if (!all && (!el.getClientRects().length || getComputedStyle(el).visibility === 'hidden')) continue;
    out.push(n.data.trim().slice(0, 80));
  }
  for (const el of document.querySelectorAll('[placeholder],[aria-label],[title]')) {
    for (const a of ['placeholder', 'aria-label', 'title']) if (/[а-яё]/i.test(el.getAttribute(a) || '') && !el.closest('[data-no-i18n]')) out.push(`${a}: ${el.getAttribute(a)}`);
  }
  return [...new Set(out)];
};

export default async ({ open, prepare, ok }) => {
  // первый запуск в браузере на английском — мастер по-английски
  {
    const { page } = await open({ settings: null, locale: 'en-US' });
    ok(await page.isVisible('#onboard'), 'мастер открыт');
    ok((await page.textContent('#obStart')) === 'Set up', 'мастер по-английски: ' + await page.textContent('#obStart'));
    ok(await page.evaluate(() => document.documentElement.lang) === 'en', '<html lang="en">');
    const left = await page.evaluate(leftovers);
    ok(!left.length, 'в мастере нет русского: ' + left.join(' | '));
    await page.click('#obLang');
    await page.waitForTimeout(800);
    ok((await page.textContent('#obStart')) === 'Настроить', 'кнопка «Русский» в мастере переключает на русский');
  }

  const { page } = await open({ settings: { uiLang: 'en', contentLang: 'en' }, titles: ['Income and expenses', 'Compound interest'] });
  for (const tab of ['load', 'plan', 'dictate', 'settings']) {
    await page.click(`[data-tab=${tab}]`);
    await page.waitForTimeout(150);
    const left = await page.evaluate(leftovers);
    ok(!left.length, `пустой экран ${tab} без русского: ` + left.join(' | '));
  }
  await prepare(page, TEXT, 'Finance');
  await page.click('#planList li .phead');
  await page.waitForTimeout(150);
  let left = await page.evaluate(leftovers);
  ok(!left.length, 'план без русского: ' + left.join(' | '));
  ok(/^\d+ topics? · ≈/.test(await page.textContent('.plan-sum .big')), 'итог плана: ' + await page.textContent('.plan-sum .big'));
  await page.click('#startBtn');
  await page.waitForTimeout(800);
  left = await page.evaluate(leftovers);
  ok(!left.length, 'диктовка без русского: ' + left.join(' | '));
  ok(/^Topic 1 of 2/.test(await page.textContent('#topicNum')), 'номер темы: ' + await page.textContent('#topicNum'));
  await page.click('#stopBtn');
  await page.waitForTimeout(300);
  ok(/Listening/.test(await page.textContent('#dictState')), 'состояние после СТОП: ' + await page.textContent('#dictState'));
  await page.click('[data-tab=settings]');
  await page.waitForTimeout(150);
  left = await page.evaluate(leftovers, true);
  ok(!left.length, 'вся страница (и скрытые части) без русского: ' + left.join(' | '));
  ok(await page.evaluate(() => !document.querySelector('.cmds[data-lang=en]').classList.contains('hidden') && document.querySelector('.cmds[data-lang=ru]').classList.contains('hidden')), 'голосовые команды — на языке конспекта');

  // обратно на русский — перезагрузка, интерфейс по-русски, открыты настройки
  await page.evaluate(() => { const r = document.querySelector('input[name=uiLang][value=ru]'); r.checked = true; r.dispatchEvent(new Event('change')); });
  await page.waitForTimeout(1200);
  ok((await page.textContent('[data-tab=settings]')).includes('Настройки'), 'интерфейс снова русский');
  ok(await page.evaluate(() => document.body.dataset.tab) === 'settings', 'после смены языка открыты настройки');
};
