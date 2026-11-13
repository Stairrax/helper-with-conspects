import worker, { RequestLimits } from '../server/worker.js';

// All provider calls below are mocked: no live OpenRouter traffic or API-key costs.
export default async ({ ok }) => {
  const realFetch = globalThis.fetch;
  const records = new Map();
  const store = {
    async transaction(fn) {
      const draft = new Map(records);
      const tx = {
        get: async key => draft.get(key),
        put: async (key, value) => { draft.set(key, value); },
        delete: async key => { draft.delete(key); },
      };
      const answer = await fn(tx);
      records.clear();
      for (const [key, value] of draft) records.set(key, value);
      return answer;
    },
    getAlarm: async () => null,
    setAlarm: async () => {},
    deleteAll: async () => records.clear(),
  };
  const limiter = new RequestLimits({ storage: store });
  const limits = { idFromName: () => 'today', get: () => ({ fetch: (url, init) => limiter.fetch(new Request(url, init)) }) };
  const base = { OPENROUTER_KEY: 'fake-test-key', UPSTREAM: 'https://provider.test/v1',
    MODELS: 'test-model', REQUEST_LIMITS: limits };
  let serial = 0;
  const request = (body = {}, id = '') => new Request('https://server.test/v1/chat/completions', {
    method: 'POST',
    headers: { Origin: 'https://stairrax.github.io', Authorization: 'Bearer test-device',
      ...(id ? { 'Idempotency-Key': id } : {}) },
    body: JSON.stringify({ kd_purpose: 'notes', messages: [{ role: 'user', content: 'no real data' }], ...body }),
  });
  const uniqueId = () => 'kd_' + String(++serial).padStart(32, '0');
  try {
    // 1. Both settings and requested token budgets must be safe integers.
    const tokenCases = [
      { config: 'NaN', client: null, expected: 16000 },
      { config: '-100', client: -5, expected: 16000 },
      { config: '1.5', client: 1.5, expected: 16000 },
      { config: '200000', client: 30000, expected: 16000 },
      { config: '4096', client: 100000, expected: 4096 },
      { config: '2048', client: 300, expected: 300 },
      { config: '4096', client: true, expected: 4096 },
      { config: '4096', client: '512', expected: 512 },
    ];
    for (const item of tokenCases) {
      let seen;
      globalThis.fetch = async (_url, init) => {
        seen = JSON.parse(init.body).max_tokens;
        return Response.json({ choices: [{ message: { content: 'ok' } }] });
      };
      const res = await worker.fetch(request({ max_tokens: item.client }, uniqueId()),
        { ...base, MAX_TOKENS: item.config });
      ok(res.status === 200 && seen === item.expected,
        'token limits normalize server=' + JSON.stringify(item.config)
          + ' client=' + JSON.stringify(item.client) + ' to ' + item.expected);
    }

    // 2. A hung key check must not keep /health waiting forever.
    let keyAborted;
    globalThis.fetch = (_url, init) => {
      keyAborted = init.signal;
      return new Promise(() => {}); // simulate fetch ignoring AbortSignal
    };
    const healthStart = Date.now();
    const healthRes = await worker.fetch(new Request('https://server.test/health', {
      headers: { 'CF-Connecting-IP': '198.51.100.1' },
    }), { ...base, UPSTREAM: 'https://openrouter.ai/api/v1', KEY_CHECK_TIMEOUT_MS: '100' });
    const healthData = await healthRes.json();
    ok(healthRes.status === 200 && healthData.keyCheck?.status === 'unreachable' &&
      Date.now() - healthStart < 3000 && keyAborted.aborted,
      'health key check stops a stalled fetch and returns usable diagnostics');

    // 3. Hung model catalogue body (not only headers) gets a bounded deadline.
    globalThis.fetch = async (_url, init) => ({ ok: true, status: 200, json: () => new Promise(() => {}), signal: init.signal });
    const modelsStart = Date.now();
    const modelsRes = await worker.fetch(request({}, uniqueId()), {
      ...base, MODELS: 'free', MODEL_LIST_TIMEOUT_MS: '100',
    });
    ok(modelsRes.status === 503 && Date.now() - modelsStart < 3000,
      'model list JSON parsing is bounded, including both catalogue attempts');

    // 4. A provider header timeout must retain the potentially charged reservation.
    let inferenceSignal;
    globalThis.fetch = async (_url, init) => {
      inferenceSignal = init.signal;
      return new Promise(() => {});
    };
    const stalledId = uniqueId();
    const begin = Date.now();
    const timedOut = await worker.fetch(request({}, stalledId), {
      ...base, UPSTREAM_HEADERS_TIMEOUT_MS: '100',
    });
    const repeated = await worker.fetch(request({}, stalledId), base);
    ok(timedOut.status === 502 && repeated.status === 409 &&
      Date.now() - begin < 3000 && inferenceSignal.aborted && records.get('total') > 0,
      'stalled inference headers time out; ambiguous reservation stays protected');

    // 5. Do not abort a valid streamed response after its headers were received.
    let activeSignal;
    globalThis.fetch = async (_url, init) => {
      activeSignal = init.signal;
      return new Response(new ReadableStream({
        start(controller) {
          setTimeout(() => {
            controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
            controller.close();
          }, 180);
        },
      }), { headers: { 'Content-Type': 'text/event-stream' } });
    };
    const streamed = await worker.fetch(request({ stream: true }, uniqueId()), {
      ...base, UPSTREAM_HEADERS_TIMEOUT_MS: '100',
    });
    const streamedText = await streamed.text();
    ok(streamed.status === 200 && streamedText.includes('[DONE]') && !activeSignal.aborted,
      'a healthy SSE stream stays alive past the header-only timeout');

    // 6. Bounded /health map: saturation cannot evict an existing user's quota.
    const quickHealth = ip => worker.fetch(new Request('https://server.test/health', {
      headers: { 'CF-Connecting-IP': ip },
    }), { MODELS: 'fixed', UPSTREAM: 'https://provider.test/v1' });
    let allAllowed = true;
    for (let i = 2; i <= 4096; i++) {
      const r = await quickHealth('198.51.' + Math.floor(i / 256) + '.' + (i % 256));
      if (r.status !== 200) allAllowed = false;
    }
    const capped = await quickHealth('203.0.113.250');
    const known = await quickHealth('198.51.100.1');
    ok(allAllowed && capped.status === 429 && known.status === 200,
      '/health caps distinct identities without evicting an existing IP');
    let successes = 0;
    for (let i = 0; i < 30; i++) {
      const r = await quickHealth('198.51.100.1');
      if (r.status === 200) successes++;
    }
    ok(successes === 28 && (await quickHealth('198.51.100.1')).status === 429,
      '/health rate limit still permits only 30 daily requests per IP');
  } finally {
    globalThis.fetch = realFetch;
  }
};
