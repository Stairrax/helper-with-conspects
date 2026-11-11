import assert from 'node:assert/strict';
import { sourceSpan, traceClaim } from '../js/source-trace.js';

const original = 'Формула расчёта: S = P(1 + r)^n.\nТемпература −5 °C.';
const cited = traceClaim(original, 'Формула расчёта: S = P(1 + r)^n.');
assert.equal(cited.quote,'Формула расчёта: S = P(1 + r)^n.');
assert.equal(original.slice(cited.start,cited.end),cited.quote);
assert.equal(traceClaim(original,'S = P(1 + r)^n'),null,'too-short formula was marked verified');
assert.equal(traceClaim(original,'Температура +5 °C'),null,'wrong sign was verified');
assert.equal(traceClaim('Доходы — это поступления.', 'доходы - это поступления.').quote,'Доходы — это поступления.');
assert.equal(traceClaim('Электро-\nмагнитные колебания.', 'электромагнитные колебания').quote,'Электро-\nмагнитные колебания');
assert.equal(traceClaim('Электромагнитные колебания.', 'электро-\nмагнитные колебания').quote,'Электромагнитные колебания');
assert.equal(traceClaim('Электропроводность берёзы.', 'электропроводность березы').quote,'Электропроводность берёзы');
assert.equal(sourceSpan('По-настоящему важные принципы.', 'понастоящему важные принципы'),null);
assert.equal(sourceSpan('Было 5 % скидки.', '5 %'),null);
console.log('PASS: quote length, ё/е, exact offsets, line-break hyphens, and false citations.');
