import worker from '../server/worker.js';

export default async ({ ok, open, prepare, FINANCE }) => {
  const realFetch = globalThis.fetch;
  const seen = [];
  let keyData = { limit: 20, limit_reset: 'monthly', limit_remaining: 10 };
  let aiWorks = true;
  const counter = { idFromName: () => 'daily', get: () => ({ fetch: async () => Response.json({ accepted: true }) }) };
  const env = { REQUEST_LIMITS: counter, OPENROUTER_KEY: 'fake-free', OPENROUTER_PAID_KEY: 'fake-paid', MODELS: 'sample:free', PAID_NOTES_ENABLED: 'true', AI: { run: async () => { if (!aiWorks) throw new Error('unavailable'); return { response: 'ok' }; } } };
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/key')) return Response.json({ data: keyData });
    seen.push({ auth: init.headers.Authorization, body: JSON.parse(init.body) });
    return Response.json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
  };
  const call = async (purpose, settings = env) => {
    const body = { messages: [{ role: 'user', content: 'sample' }], ...(purpose ? { kd_purpose: purpose } : {}) };
    return worker.fetch(new Request('https://test/v1/chat/completions', { method: 'POST', headers: { Origin: 'https://stairrax.github.io' }, body: JSON.stringify(body) }), settings);
  };
  try {
    let r = await call('notes');
    ok(r.status === 200 && seen.at(-1).body.model === 'google/gemini-2.5-flash-lite' && seen.at(-1).auth === 'Bearer fake-paid' && seen.at(-1).body.provider.max_price.completion === 0.6, 'конспект использует платную модель с проверенным бюджетом и ограничением цены');
    for (const invalid of [{ limit: 21, limit_reset: 'monthly', limit_remaining: 10 }, { limit: null, limit_reset: 'monthly', limit_remaining: 10 }, { limit: 20, limit_reset: 'daily', limit_remaining: 10 }, { limit: 20, limit_reset: 'monthly', limit_remaining: 0 }]) {
      keyData = invalid; await call('notes');
      if (seen.at(-1).auth !== 'Bearer fake-free' || seen.at(-1).body.model !== 'sample:free') throw new Error('unsafe paid route');
    }
    ok(true, 'неподходящий, отсутствующий или исчерпанный бюджет не включает платную модель');
    keyData = { limit: 20, limit_reset: 'monthly', limit_remaining: 10 };
    await call('notes', { ...env, PAID_NOTES_ENABLED: 'false' });
    ok(seen.at(-1).auth === 'Bearer fake-free', 'платный режим выключен по умолчанию');
    const count = seen.length; r = await call('question');
    ok(r.status === 200 && r.headers.get('X-Answered-By') === 'workers-ai' && seen.length === count, 'вопрос вначале обрабатывается Cloudflare без платного запроса');
    aiWorks = false; r = await call('question');
    ok(r.status === 200 && seen.at(-1).auth === 'Bearer fake-free', 'при отказе Cloudflare вопрос идёт к бесплатной модели');
    await call(null);
    ok(seen.at(-1).auth === 'Bearer fake-free', 'старые версии приложения не включают платные запросы');
    const blocked = await call('notes', { ...env, REQUEST_LIMITS: null });
    ok(blocked.status === 503, 'при отказе счётчика запрос блокируется');
  } finally { globalThis.fetch = realFetch; }
  const { page, say } = await open({ freeProxy: 'https://free-proxy.test', settings: { provider: 'free', voiceCommands: true, listenWhileSpeaking: true } });
  const purposes = [];
  await page.route('https://free-proxy.test/**', async (route) => {
    if (route.request().method() === 'POST') purposes.push(JSON.parse(route.request().postData()).kd_purpose);
    await route.fallback();
  });
  await prepare(page, FINANCE, 'Проверка');
  ok(purposes.length > 0 && purposes.every((p) => p === 'notes'), 'план и конспект отправляются с категорией подготовки');
  await page.click('#startBtn');
  await page.waitForFunction(() => window.__spoken.length >= 2 && window.speechSynthesis.speaking, null, { timeout: 10000 });
  await page.dispatchEvent('#stopBtn', 'pointerdown');
  await page.waitForTimeout(150);
  await say('почему проценты растут', true, 200);
  await page.waitForFunction(() => /Продолжаем/.test(window.__spoken.at(-1) || ''), null, { timeout: 10000 });
  ok(purposes.includes('question'), 'вопрос во время диктовки отправляется отдельно от подготовки');
};
