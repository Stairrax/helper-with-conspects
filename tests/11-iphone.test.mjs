// iPhone (Safari): подписи, инструкции, установка на экран «Домой». Проверяется в Chromium с userAgent iPhone.
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

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

  // своё оформление, не системное: «как в системе» — «Чернила» или «Аврора»; iOS можно выбрать
  ok(await page.evaluate(() => document.documentElement.dataset.theme) === 'ink', 'на iPhone по умолчанию — своё оформление («Чернила» при светлой теме)');
  await page.click('[data-tab=settings]');
  ok(await page.isChecked('input[name=theme][value=auto]'), 'в настройках выбрано «Как в системе»');
  await page.evaluate(() => { const r = document.querySelector('input[name=theme][value=ios]'); r.checked = true; r.dispatchEvent(new Event('change')); });
  ok(await page.evaluate(() => document.documentElement.dataset.theme) === 'ios' && !(await page.isVisible('#rippleRow')), 'выбрали «iOS»: оформление iOS, «капли» нет');
  await page.evaluate(() => scrollTo(0, 800)); await page.waitForTimeout(500);
  ok(await page.evaluate(() => document.body.classList.contains('scrolled') && +getComputedStyle(document.querySelector('.ios-bar')).opacity > .9
    && document.getElementById('iosBarTitle').textContent === 'Настройки'), 'прокрутили — большой заголовок сменился компактной панелью');
  await page.evaluate(() => { const r = document.querySelector('input[name=theme][value=classic]'); r.checked = true; r.dispatchEvent(new Event('change')); });
  await page.reload(); await page.waitForTimeout(400);
  ok(await page.evaluate(() => !document.documentElement.dataset.theme), 'выбрали «Классику» — она и остаётся после перезапуска');

  const android = await open({ userAgent: ANDROID_UA });
  ok(await android.page.evaluate(() => !document.body.classList.contains('ios')), 'на Android — подписи Android');
  await android.page.emulateMedia({ colorScheme: 'dark' });
  await android.page.waitForTimeout(100);
  ok(await android.page.evaluate(() => document.documentElement.dataset.theme === 'aurora'), 'на Android с тёмной темой — «Аврора»');
  await android.page.click('[data-tab=settings]');
  await android.page.evaluate(() => { const r = document.querySelector('input[name=theme][value=android]'); r.checked = true; r.dispatchEvent(new Event('change')); });
  ok(await android.page.evaluate(() => document.documentElement.dataset.theme === 'android' && document.querySelector('meta[name=color-scheme]').content === 'light dark')
    && await android.page.isVisible('#rippleRow'), 'выбрали «Android»: оформление Android, «капля» есть');
  await android.page.evaluate(() => { const r = document.querySelector('input[name=theme][value=neon]'); r.checked = true; r.dispatchEvent(new Event('change')); });
  await android.page.reload(); await android.page.waitForTimeout(400);
  ok(await android.page.evaluate(() => document.documentElement.dataset.theme) === 'neon', 'выбрали «Неон» — он и остаётся после перезапуска');

  const desktop = await open();
  ok(await desktop.page.evaluate(() => document.documentElement.dataset.theme) === 'ink', 'на компьютере — тоже «как в системе»');
};
