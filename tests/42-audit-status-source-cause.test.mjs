// A source quote must be strong enough to survive normalization; Gemini errors keep their cause.
import { sourceSpan, traceClaim } from '../js/source-trace.js';
import { GeminiError } from '../js/gemini.js';

export default async ({ ok, open }) => {
  const source = 'В учебнике написано: Зелёная ёлка росла возле старой школы. Формула: S = P(1 + r)^n.';
  const long = traceClaim(source, 'зеленая елка росла возле старой школы');
  ok(long?.quote === 'Зелёная ёлка росла возле старой школы' &&
    source.slice(long.start, long.end) === long.quote,
    'long quote tolerates ё/е and case differences while retaining original source offsets');

  const exact = traceClaim(source, 'S = P(1 + r)^n');
  ok(exact?.quote === 'S = P(1 + r)^n',
    'short exact formula remains a valid citation');

  ok(traceClaim(source, 'зеленая елка') === null,
    'short fuzzy normalized quote is not strong enough to verify a claim');
  ok(sourceSpan('Ёлка росла.', 'ёлка росла.') === null,
    'short case-folded evidence is weak even when normalized text matches');
  ok(sourceSpan(source, '\u00ad') === null && sourceSpan(source, 'несуществующая длинная цитата') === null,
    'empty normalized and invented quotes are rejected');

  const error = new SyntaxError('invalid JSON');
  const wrapped = new GeminiError('Gemini returned bad JSON', { code: 'BAD_JSON', cause: error });
  ok(wrapped.cause === error && wrapped.code === 'BAD_JSON',
    'GeminiError retains the original cause and error classification');

  const { page } = await open({});
  const result = await page.evaluate(async () => {
    const { generateJSON } = await import('./js/gemini.js');
    const originalFetch = window.fetch;
    let calls = 0, cause = '', code = '';
    try {
      window.fetch = async () => {
        calls++;
        return Response.json({
          candidates: [{ content: { parts: [{ text: '{invalid' }] }, finishReason: 'STOP' }],
        });
      };
      try {
        await generateJSON({ apiKey: 'test', model: 'test', parts: [{ text: 'hello' }], timeoutMs: 4000 });
      } catch (err) {
        code = err.code;
        cause = err.cause?.message || '';
      }
      return { calls, code, cause };
    } finally {
      window.fetch = originalFetch;
    }
  });
  ok(result.calls === 3 && result.code === 'BAD_JSON' && result.cause === 'bad json',
    'generateJSON propagates a real parsing cause after bounded retries');
};
