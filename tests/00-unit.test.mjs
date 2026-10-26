// Без браузера: чтение чисел и формул голосом Silero, сокращения.
import { createRequire } from 'node:module';
import { abbreviate } from '../js/abbr.js';

export default async ({ ok }) => {
  globalThis.self = globalThis;
  createRequire(import.meta.url)('../js/silero-core.js');
  const { normalize } = globalThis.SileroCore;
  const cases = [
    ['до 19 500 рублей', 'до девятнадцать тысяч пятьсот рублей'],
    ['150 000 рублей в год', 'сто пятьдесят тысяч рублей в год'],
    ['13 %', 'тринадцать процентов'],
    ['1 января 2026 года', 'первого января две тысячи двадцать шестого года'],
  ];
  for (const [src, want] of cases) ok(normalize(src) === want, `«${src}» → «${normalize(src)}»`);
  ok(/делить на/.test(normalize('a / b')), 'деление читается «делить на»');
  ok(/вэ/.test(normalize('w = 2')), 'латинская w — «вэ»');
  ok(abbreviate('налог на доходы физических лиц') === 'НДФЛ', 'сокращение НДФЛ');
  ok(abbreviate('Физических лиц много') === 'Физ. лиц много', 'сокращение с заглавной буквы');
};
