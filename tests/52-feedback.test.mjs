// Feedback link must be visible in settings, lead to a real GitHub form,
// and never send notes or settings from the browser.
export default async ({ open, ok }) => {
  const repoUrl = 'https://github.com/Stairrax/helper-with-conspects/issues/new?template=feedback.yml';
  const ru = await open();
  await ru.page.click('[data-tab=settings]');
  const link = ru.page.locator('#feedbackLink');
  ok(await link.isVisible(), 'отзыв доступен сразу в настройках');
  ok(await link.getAttribute('href') === repoUrl, 'ссылка открывает форму обратной связи репозитория');
  ok(await link.getAttribute('target') === '_blank' &&
     (await link.getAttribute('rel')).split(/\s+/).includes('noopener'),
     'внешний сайт открывается в новой вкладке безопасно');
  ok((await ru.page.locator('#feedbackCard').innerText()).includes('Не публикуйте учебные материалы'),
     'пользователь видит предупреждение о приватности');

  const en = await open({ settings: { uiLang: 'en' } });
  await en.page.click('[data-tab=settings]');
  const english = await en.page.locator('#feedbackCard').innerText();
  // Themes visually uppercase card titles; inspect the underlying translated text.
  const heading = (await en.page.locator('#feedbackCard .card-title').textContent()).trim();
  const cta = (await en.page.locator('#feedbackLink').textContent()).trim();
  ok(heading === 'Feedback' && cta === 'Leave feedback',
     'кнопка и заголовок переведены на английский: ' + heading + ' / ' + cta);
  ok(english.includes('Do not share study materials') && !/[а-яё]/i.test(english),
     'предупреждение переведено и не содержит русского текста');
  ok(await en.page.locator('#feedbackLink').getAttribute('href') === repoUrl,
     'английский интерфейс ведёт на ту же форму');
};
