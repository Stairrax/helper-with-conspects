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

  const android = await open();
  ok(await android.page.evaluate(() => !document.body.classList.contains('ios')), 'на Android — как раньше');
};
