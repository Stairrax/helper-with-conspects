import { traceClaim } from '../js/source-trace.js';

export default async ({ ok, open, prepare, FINANCE }) => {
  const original = 'Доходы — это поступления.\nФормула расчёта: S = P(1 + r)^n.\nТемпература −5 °C.';
  const found = traceClaim(original, 'доходы - это поступления.');
  ok(found && original.slice(found.start, found.end) === found.quote,
    'verified quote resolves to its exact saved span');
  const formula = traceClaim(original, 'Формула расчёта: S = P(1 + r)^n.');
  ok(formula?.quote === 'Формула расчёта: S = P(1 + r)^n.',
    'meaningful formula quote resolves without rewriting symbols');
  ok(!traceClaim(original, 'S = P(1 + r)^n') && !traceClaim(original, 'Ставка 10%'),
    'short formula fragments and invented facts stay unverified');
  ok(!traceClaim(original, 'Температура +5 °C'),
    'changed sign cannot pass as a source quote');
  const withYo = 'Мы изучили электропроводность берёзы в лаборатории.';
  const normalized = traceClaim(withYo, 'электропроводность березы');
  ok(normalized?.quote === 'электропроводность берёзы',
    'ё/е folding preserves the original highlighted source');
  const hyphenated = 'Электро-\nмагнитные колебания исследуют по формулам.';
  const joined = traceClaim(hyphenated, 'электромагнитные колебания');
  ok(joined?.quote === 'Электро-\nмагнитные колебания',
    'line-break hyphenation matches the exact original source span');
  const reverse = traceClaim('Электромагнитные колебания.', 'электро-\nмагнитные колебания');
  ok(reverse?.quote === 'Электромагнитные колебания',
    'line-break hyphenation in a model quote also works');
  ok(!traceClaim('Было 5 % скидки.', '5 %') &&
    !traceClaim('Два определения. Да.', 'да'),
    'short snippets are never marked verified');
  ok(!traceClaim('По-настоящему важные принципы.', 'понастоящему важные принципы'),
    'real compound-word hyphens do not disappear');
  ok(!traceClaim('Знак минус −5 °C, плюс +5 °C.', 'Знак минус +5 °C'),
    'hyphenation never weakens sign matching');

  // Keep the existing end-to-end test: real displayed citation from saved notes.
  const { page } = await open();
  await prepare(page, FINANCE, 'Источник');
  await page.waitForTimeout(700);
  const quote = await page.evaluate(async () => {
    const storage = await import('./js/storage.js');
    const subject = storage.loadSubjects().current;
    const project = await storage.idbGet('project:' + subject);
    const topic = project.topics[0];
    const quote = topic.text.slice(0, 55);
    topic.points = [
      { p: quote, c: [0], citation: { quote, start: 0, end: quote.length } },
      { p: 'Несуществующий факт', c: [0], citation: null },
    ];
    await storage.idbSet('project:' + subject, project);
    return quote;
  });
  await page.reload();
  await page.click('[data-tab=plan]');
  await page.locator('#planList [data-act=open]').first().click();
  await page.locator('#planList [data-act=points]').first().click();
  const details = await page.locator('#planList details').count();
  const visible = details > 0 && await page.locator('#planList details summary').first().isVisible();
  const excerpt = details > 0 && await page.locator('#planList blockquote').first().textContent() || '';
  ok(visible && excerpt.includes(quote), 'verified quote opens its exact original context');
  ok((await page.locator('#planList').textContent()).includes('Источник не подтверждён'),
    'unverified claim stays visibly marked');
};
