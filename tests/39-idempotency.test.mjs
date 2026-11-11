import worker, { RequestLimits } from '../server/worker.js';

// Simulates a single Durable Object with serialized transactions and concurrent requests.
export default async ({ open, ok }) => {
  const records = new Map();
  let pending = Promise.resolve(), alarm = null, modelCalls = 0;
  const storage = {
    transaction(fn) {
      const next = pending.then(async () => {
        const draft = new Map(records);
        const tx = { get: async k => draft.get(k), put: async (k,v) => draft.set(k,v), delete: async k => draft.delete(k) };
        const answer = await fn(tx);
        records.clear();
        for (const [key,value] of draft) records.set(key,value);
        return answer;
      });
      pending = next.catch(() => {});
      return next;
    },
    getAlarm: async () => alarm,
    setAlarm: async at => { alarm = at; },
    deleteAll: async () => records.clear(),
  };
  const limiter = new RequestLimits({ storage });
  const env = {
    REQUEST_LIMITS: { idFromName: () => 'today', get: () => ({ fetch: (url, init) => limiter.fetch(new Request(url, init)) }) },
    AI: { run: async () => { modelCalls++; return { response: 'model answered' }; } },
  };
  const key = 'kd_0123456789abcdef0123456789abcdef';
  const request = (id, text = 'hello') => new Request('https://test/chat/completions', {
    method: 'POST',
    headers: { Origin: 'https://stairrax.github.io', Authorization: 'Bearer student-one',
      ...(id ? { 'Idempotency-Key': id } : {}) },
    body: JSON.stringify({ kd_purpose: 'question', messages: [{role:'user', content:text}], stream:false }),
  });
  const firstTwo = await Promise.all([worker.fetch(request(key), env), worker.fetch(request(key), env)]);
  const status = firstTwo.map(x=>x.status).sort();
  ok(status.join() === '200,409' && modelCalls === 1 && records.get('total') === 1,
    'concurrent identical requests share one atomic reservation, quota and model call');
  const repeated = await worker.fetch(request(key), env);
  ok(repeated.status === 409 && (await repeated.json()).error.code === 'duplicate_request' &&
    modelCalls === 1 && records.get('total') === 1,
    'same request cannot be double billed after a dropped client response');
  const altered = await worker.fetch(request(key, 'different study input'), env);
  ok(altered.status === 409 && (await altered.json()).error.code === 'idempotency_conflict' &&
    modelCalls === 1, 'same key cannot silently represent different material');
  const second = await worker.fetch(request('kd_fedcba9876543210fedcba9876543210'), env);
  ok(second.status === 200 && modelCalls === 2 && records.get('total') === 2,
    'a new manual request still consumes an independent quota');
  const legacy = await worker.fetch(request(null), env);
  ok(legacy.status === 200 && modelCalls === 3, 'older clients without request IDs remain supported');
  const badEnv={...env,AI:undefined,OPENROUTER_KEY:'test-key',
    UPSTREAM:'https://upstream.test/v1',MODELS:'test-model'};
  const failedId='kd_33333333333333333333333333333333';
  const totalBefore=records.get('total');
  const realFetch=globalThis.fetch;
  try {
    globalThis.fetch=async url=>{
      if (String(url).includes('/chat/completions')) return Response.json({error:{message:'down'}},{status:503});
      throw new Error('Unexpected URL');
    };
    const rejected=await worker.fetch(request(failedId),badEnv);
    ok(rejected.status===503 && records.get('total')===totalBefore &&
      ![...records.keys()].some(k=>k.endsWith(failedId)),
      'explicit upstream 503 releases dedup and refunds all counters');
    const again=await worker.fetch(request(failedId),badEnv);
    ok(again.status===503 && records.get('total')===totalBefore,
      'the same logical request can retry following explicit rejection');
    globalThis.fetch=async()=>{throw new Error('connection lost after sending');};
    const uncertain=await worker.fetch(request('kd_44444444444444444444444444444444'),badEnv);
    const repeat=await worker.fetch(request('kd_44444444444444444444444444444444'),badEnv);
    ok(uncertain.status===502 && repeat.status===409,
      'ambiguous network interruption must retain dedup to avoid provider double charge');
  } finally { globalThis.fetch=realFetch; }
  const { page } = await open({ freeProxy: 'https://proxy-one.test,https://proxy-two.test' });
  const seen = await page.evaluate(async () => {
    const { generate } = await import('./js/openai.js');
    const orig = window.fetch, requests = [];
    const opts = { apiKey: 'student-one', baseUrl:'https://proxy-one.test', model:'test',
      parts:[{text:'hello'}], purpose:'question', retries:0, timeoutMs:2000 };
    try {
      window.fetch = async (url, options) => {
        requests.push({url, id:options.headers['Idempotency-Key']});
        return new Response(JSON.stringify(url.includes('proxy-one')
          ? {error:{code:'unavailable',proxy:true,message:'down'}}
          : {choices:[{message:{content:'ok'},finish_reason:'stop'}]}),
          {status:url.includes('proxy-one')?503:200,headers:{'Content-Type':'application/json'}});
      };
      return { answer: await generate(opts), requests };
    } finally {window.fetch = orig;}
  });
  ok(seen.answer === 'ok' && seen.requests.length === 2 &&
    seen.requests[0].id && seen.requests[0].id === seen.requests[1].id,
    'browser retries keep one idempotency key across alternate URLs');
};
