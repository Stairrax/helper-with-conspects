import { traceClaim } from '../js/source-trace.js';

export default async ({ ok, open, prepare, FINANCE }) => {
  const original = 'Доходы — это поступления.\nФормула: S = P(1 + r)^n.\nТемпература −5 °C.';
  const found = traceClaim(original, 'доходы - это поступления.');
  ok(found && original.slice(found.start, found.end) === found.quote, 'verified quote resolves to its exact saved span');
  const formula = traceClaim(original, 'S = P(1 + r)^n');
  ok(formula?.quote === 'S = P(1 + r)^n', 'formula quote resolves without rewriting symbols');
  ok(!traceClaim(original, 'Температура +5 °C') && !traceClaim(original, 'Ставка 10%'), 'changed sign or invented fact stays unverified');
  const { page } = await open();
  await prepare(page, FINANCE, 'Источник');
  await page.waitForTimeout(700);
  const quote = await page.evaluate(async () => {
    const storage = await import('./js/storage.js');
    const subject = storage.loadSubjects().current;
    const project = await storage.idbGet('project:' + subject);
    const topic = project.topics[0];
    const quote = topic.text.slice(0, 20);
    topic.points = [{ p: quote, c: [0], citation: { quote, start: 0, end: quote.length } }, { p: 'Несуществующий факт', c: [0], citation: null }];
    await storage.idbSet('project:' + subject, project);
    return quote;
  });
  await page.reload();
  await page.click('[data-tab=plan]');
  await page.locator('#planList [data-act=open]').first().click();
  await page.locator('#planList [data-act=points]').first().click();
  const details = await page.locator('#planList details').count();
  const visible = details > 0 && await page.locator('#planList details summary').first().isVisible();
  const excerpt = details > 0 ? await page.locator('#planList blockquote').first().textContent() : '';
  ok(visible && excerpt.includes(quote), 'verified quote opens its exact original context');
  ok((await page.locator('#planList').textContent()).includes('Источник не подтверждён'), 'unverified claim is visibly marked');
};
