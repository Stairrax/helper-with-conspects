// Shared deadline helpers + free proxy fallback for HTTP errors, not only fetch throws.
export default async ({ open, ok }) => {
  const { page } = await open({ freeProxy: 'https://proxy-one.test,https://proxy-two.test' });
  const data = await page.evaluate(async () => {
    const { generate, stream } = await import('./js/openai.js');
    const { FREE_PROXY_LIST } = await import('./js/config.js');
    const old = window.fetch;
    const seen = [];
    const makeResponse = text => new Response(JSON.stringify({
      choices: [{ message: { content: text }, finish_reason: 'stop' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const makeError = (status, code) => new Response(JSON.stringify({ error: { proxy: true, code, message: 'temporarily unavailable' } }),
      { status, headers: { 'Content-Type': 'application/json' } });
    const opts = { apiKey: 'device-test', baseUrl: FREE_PROXY_LIST[0],
      model: 'auto', parts: [{ text: 'one' }], purpose: 'notes', retries: 0, timeoutMs: 3000 };
    const call = async (answer, isStreaming = false) => {
      seen.length = 0;
      window.fetch = async url => {
        seen.push(url);
        return url.startsWith(FREE_PROXY_LIST[0]) ? makeError(503, 'unavailable') : makeResponse(answer);
      };
      if (isStreaming) {
        let text = '';
        await stream({ ...opts, onText: t => { text += t; } });
        return { text, urls: [...seen] };
      }
      return { text: await generate(opts), urls: [...seen] };
    };
    try {
      const json = await call('second endpoint');
      const streaming = await call('stream fallback', true);
      let emptyCalls = 0, emptyCode = '';
      window.fetch = async () => { emptyCalls++; return makeResponse(''); };
      try { await generate({ ...opts, retries: 3 }); } catch (e) { emptyCode = e.code || ''; }
      let cycles = 0;
      window.fetch = async () => { cycles++; return makeError(503, 'unavailable'); };
      let failed = '';
      try { await generate(opts); } catch (e) { failed = e.message || ''; }
      return { json, streaming, emptyCalls, emptyCode, cycles, failed };
    } finally { window.fetch = old; }
  });
  ok(data.json.text === 'second endpoint' && data.json.urls.length === 2 &&
    /proxy-one\.test/.test(data.json.urls[0]) && /proxy-two\.test/.test(data.json.urls[1]),
    'HTTP 503 switches to backup free proxy before retry budget is spent');
  ok(data.streaming.text === 'stream fallback' && data.streaming.urls.length === 2,
    'stream HTTP 503 switches before delivering partial text');
  ok(data.emptyCalls === 1 && data.emptyCode === 'EMPTY',
    'empty successful response is not replayed on shared free quota');
  ok(data.cycles === 2 && data.failed, 'finite fallback never rotates proxies forever');
};
