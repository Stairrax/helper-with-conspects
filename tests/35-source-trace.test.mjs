import { traceClaim } from '../js/source-trace.js';

export default async ({ ok }) => {
  const original = 'Доходы — это поступления.\nФормула: S = P(1 + r)^n.\nТемпература −5 °C.';
  const found = traceClaim(original, 'доходы - это поступления.');
  ok(found && original.slice(found.start, found.end) === found.quote,
    'source citations keep exact original offsets through punctuation normalization');
  const formula = traceClaim(original, 'S = P(1 + r)^n');
  ok(formula?.quote === 'S = P(1 + r)^n', 'meaningful formulas may still be cited');
  ok(!traceClaim(original, 'Температура +5 °C') && !traceClaim(original, 'Ставка 10%'),
    'changed signs and invented values do not match');
  const withYo = 'Мы изучили электропроводность берёзы в лаборатории.';
  const normalized = traceClaim(withYo, 'электропроводность березы');
  ok(normalized?.quote === 'электропроводность берёзы',
    'ё/е folding preserves the original highlighted Russian source');
  const hyphenated = 'Электро-\nмагнитные колебания исследуют по формулам.';
  const joined = traceClaim(hyphenated, 'электромагнитные колебания');
  ok(joined?.quote === 'Электро-\nмагнитные колебания',
    'line-break hyphenation matches the source without losing precise offsets');
  const reverse = traceClaim('Электромагнитные колебания.', 'электро-\nмагнитные колебания');
  ok(reverse?.quote === 'Электромагнитные колебания',
    'line-break hyphenation inside a model quote matches an unbroken original');
  ok(!traceClaim('Было 5 % скидки.', '5 %') && !traceClaim('Два определения. Да.', 'да') &&
    !traceClaim('Формула: F=ma.', 'F=ma'),
    'too-short generic snippets are never marked as verified citations');
  const compound = 'Изучим по-настоящему важные принципы.';
  ok(!traceClaim(compound, 'понастоящему важные принципы'),
    'real compound-word hyphens are never silently removed');
  const sign = 'Знак минус −5 °C, плюс +5 °C.';
  ok(!traceClaim(sign, 'Знак минус +5 °C'),
    'line-join fallback does not weaken number or sign matching');
};
