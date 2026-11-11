// Recovery of review leeches, safe Gemini EMPTY, bounded direct API output, and IDB fallback.
export default async ({ open, ok }) => {
  const { page } = await open({});
  const results = await page.evaluate(async () => {
    const { reviewResult } = await import('./js/review-schedule.js');
    const old = { reviewStatus: 'leech', lapses: 9, interval: 1, ease: 2.4 };
    const now = 1700000000000;
    const one = reviewResult(old, 1, 'sure', now);
    const two = reviewResult(one, 1, 'sure', now);
    const three = reviewResult(two, 1, 'sure', now);
    const afterFail = reviewResult(three, 0, 'unsure', now);
    const migrate = reviewResult({ lapses: 6, interval: 1, reviewStatus: 'leech' }, 1, 'guessed', now);
    const neutral = reviewResult(old, 1, 'unsure', now);
    const { generate: gemini } = await import('./js/gemini.js');
    const { generate: openai } = await import('./js/openai.js');
    const { idbSet, idbGet, storageFailures } = await import('./js/storage.js');
    const originalFetch = window.fetch;
    let validEmptyCalls = 0, badJsonCalls = 0, geminiError = '', openaiDefault = 0, openaiCustom = 0;
    const responses = { one, two, three, afterFail, migrate, neutral };
    try {
      window.fetch = async () => {
        validEmptyCalls++;
        return Response.json({ candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] });
      };
      try {
        await gemini({ apiKey: 'test', model: 'gemini-test', parts:[{text:'hello'}], retries:3, timeoutMs:4000 });
      } catch (e) { geminiError = e.code; }
      window.fetch = async () => {
        badJsonCalls++;
        return new Response('invalid json', { status:200, headers:{'Content-Type':'application/json'} });
      };
      try {
        await gemini({ apiKey:'test', model:'gemini-test', parts:[{text:'hello'}], retries:1, timeoutMs:5500 });
      } catch {}
      window.fetch = async (url, opts) => {
        const requestBody = JSON.parse(opts.body);
        if (openaiDefault === 0) openaiDefault = requestBody.max_tokens;
        else openaiCustom = requestBody.max_tokens;
        return Response.json({ choices:[{message:{content:'okay'},finish_reason:'stop'}] });
      };
      const opts = {apiKey:'key',baseUrl:'https://custom.test/v1',
        model:'some-model',parts:[{text:'hello'}],retries:0,timeoutMs:3000};
      await openai(opts);
      await openai({...opts,maxOutputTokens:13500});

      const key = 'p2-storage-corrupt-fallback-test';
      await idbSet(key, { safe: 'from-idb' });
      storageFailures.delete('idb:' + key);
      localStorage.setItem('kd.idb.' + key, '{invalid');
      const loaded = await idbGet(key);
      responses.storage = { loaded, failed:storageFailures.has('idb:' + key) };
      localStorage.removeItem('kd.idb.' + key);
    } finally { window.fetch = originalFetch; }
    return {...responses,validEmptyCalls,badJsonCalls,geminiError,openaiDefault,openaiCustom};
  });
  ok(results.one.reviewStatus === 'leech' && results.two.reviewStatus === 'leech',
    'one or two confident successes must not clear leech');
  ok(results.three.reviewStatus !== 'leech' && results.three.recentLapses === 0 &&
    results.three.lapses === 9, 'three confident successes rehabilitate leech while preserving lifetime lapses');
  ok(results.afterFail.reviewStatus === 'learning' && results.afterFail.recentLapses === 1,
    'a recovered leech does not revert immediately after one lapse');
  ok(results.migrate.reviewStatus === 'leech' && results.neutral.reviewStatus === 'leech',
    'legacy leeches migrate and unsure/guessed answers cannot clear flag');
  ok(results.validEmptyCalls === 1 && results.geminiError === 'EMPTY',
    'Gemini valid empty 200 never replays a potentially billed inference');
  ok(results.badJsonCalls === 2,
    'Gemini may retry unreadable JSON with bounded exponential backoff');
  ok(results.openaiDefault === 8192 && results.openaiCustom === 13500,
    'direct OpenAI requests have default max_tokens and respect explicit output limits');
  ok(results.storage.loaded?.safe === 'from-idb' && !results.storage.failed,
    'corrupt localStorage fallback does not mark healthy IndexedDB failed');
};
