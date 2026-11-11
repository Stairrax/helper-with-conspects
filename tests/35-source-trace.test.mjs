import { traceClaim } from '../js/source-trace.js';

export default async ({ ok }) => {
  const original = 'Доходы — это поступления.\nФормула: S = P(1 + r)^n.\nТемпература −5 °C.';
  const found = traceClaim(original, 'доходы - это поступления.');
  ok(found && original.slice(found.start, found.end) === found.quote, 'verified quote resolves to its exact saved span');
  const formula = traceClaim(original, 'S = P(1 + r)^n');
  ok(formula?.quote === 'S = P(1 + r)^n', 'formula quote resolves without rewriting symbols');
  ok(!traceClaim(original, 'Температура +5 °C') && !traceClaim(original, 'Ставка 10%'), 'changed sign or invented fact stays unverified');
};
