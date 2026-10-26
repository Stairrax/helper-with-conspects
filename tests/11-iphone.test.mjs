// iPhone (Safari): подписи, инструкции, установка на экран «Домой». Проверяется в Chromium с userAgent iPhone.
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

export default async ({ open, ok }) => {
  const { page } = await open({ userAgent: UA });
  ok(await page.evaluate(() => document.body.classList.contains('ios')), 'iPhone распознан');
  await page.click('[data-tab=settings]');
  ok((await page.textContent('input[name=voiceEngine][value=system] + span')) === 'iPhone', 'переключатель голоса: «iPhone»');
  ok(await page.isVisible('summary:has-text("голос iPhone")') && !(await page.isVisible('summary:has-text("голос Android")')), 'инструкция для голоса iPhone вместо Android');
  ok(!(await page.isVisible('#remindRow')), 'фоновых напоминаний на iPhone нет — переключатель скрыт');
  ok(await page.evaluate(() => document.querySelector('link[rel=apple-touch-icon]')?.getAttribute('href')) === 'icons/apple-touch-icon.png', 'иконка для экрана «Домой»');
  await page.addStyleTag({ content: '.toast{display:block!important}' });
  await page.click('[data-tab=load]');
  await page.click('#installBtn');
  ok(/На экран „Домой“/.test(await page.textContent('#toast')), 'установка: подсказка про «Поделиться → На экран „Домой“»');

  // оформление iOS — само, пока не выбрали другое
  ok(await page.evaluate(() => document.documentElement.dataset.theme) === 'ios', 'на iPhone — оформление iOS');
  await page.click('[data-tab=settings]');
  ok(await page.isChecked('input[name=theme][value=ios]') && !(await page.isVisible('#rippleRow')), 'в настройках выбрано «iOS», «капли» нет');
  await page.evaluate(() => scrollTo(0, 800)); await page.waitForTimeout(500);
  ok(await page.evaluate(() => document.body.classList.contains('scrolled') && +getComputedStyle(document.querySelector('.ios-bar')).opacity > .9
    && document.getElementById('iosBarTitle').textContent === 'Настройки'), 'прокрутили — большой заголовок сменился компактной панелью');
  await page.evaluate(() => { const r = document.querySelector('input[name=theme][value=classic]'); r.checked = true; r.dispatchEvent(new Event('change')); });
  await page.reload(); await page.waitForTimeout(400);
  ok(await page.evaluate(() => !document.documentElement.dataset.theme), 'выбрали «Классику» — она и остаётся после перезапуска');

  const android = await open();
  ok(await android.page.evaluate(() => !document.body.classList.contains('ios')), 'на Android — как раньше');
  ok(await android.page.evaluate(() => document.documentElement.dataset.theme !== 'ios'), 'на Android оформление iOS само не включается');
};
