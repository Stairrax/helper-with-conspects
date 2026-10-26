// Бесплатный режим: сервер (server/worker.js) и приложение без своего ключа.
import worker from '../server/worker.js';

const ENV = { OPENROUTER_KEY: 'sk-or-SECRET', MODELS: 'google/gemini-2.5-flash,google/gemini-2.5-flash-lite', DAILY_PER_DEVICE: '3', MAX_TOKENS: '1000' };
const APP = 'https://stairrax.github.io';
const call = (path, { origin = APP, body, device = 'kd-test', method = body ? 'POST' : 'GET', ip = '1.1.1.1' } = {}) => worker.fetch(new Request('https://w.test' + path, {
  method, headers: { Origin: origin, Authorization: 'Bearer ' + device, 'CF-Connecting-IP': ip, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body),
}), ENV);

export default async ({ open, prepare, FINANCE, ok }) => {
  // ---- сервер: OpenRouter подменён, смотрим, что именно ушло бы туда
  const realFetch = globalThis.fetch;
  let sent = null;
  globalThis.fetch = async (url, init) => {
    sent = { url, headers: init.headers, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }), { headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const msg = { messages: [{ role: 'user', content: 'привет' }], model: 'openai/gpt-5-pro', max_tokens: 999999, stream: false };
    let r = await call('/chat/completions', { body: msg });
    ok(r.status === 200 && r.headers.get('Access-Control-Allow-Origin') === APP, 'запрос с сайта приложения проходит');
    ok(sent.headers.Authorization === 'Bearer sk-or-SECRET', 'в OpenRouter уходит ключ с сервера');
    ok(sent.body.model === 'google/gemini-2.5-flash' && sent.body.models.length === 2 && sent.body.max_tokens === 1000, 'модель и длину ответа выбирает сервер, а не запрос');
    r = await call('/chat/completions', { body: msg, origin: 'https://evil.example' });
    ok(r.status === 403, 'с чужого сайта — отказ');
    r = await call('/v1/models');
    ok((await r.json()).data[0].id === 'google/gemini-2.5-flash', 'список моделей — только свои');
    await call('/chat/completions', { body: msg }); await call('/chat/completions', { body: msg });
    r = await call('/chat/completions', { body: msg });
    const e = (await r.json()).error;
    ok(r.status === 429 && e.code === 'daily_limit' && e.proxy, 'дневной лимит на устройство');
    r = await call('/chat/completions', { body: msg, device: 'kd-other' });
    ok(r.status === 200, 'у другого устройства лимит свой');
    globalThis.fetch = async () => new Response('{}', { status: 402 });
    r = await call('/chat/completions', { body: msg, device: 'kd-third' });
    ok(r.status === 503 && (await r.json()).error.code === 'unavailable', 'кончились деньги на ключе — понятная ошибка, ключ не раскрывается');
    r = await worker.fetch(new Request('https://w.test/chat/completions', { method: 'POST', headers: { Origin: APP }, body: JSON.stringify(msg) }), {});
    ok(r.status === 503, 'без ключа на сервере — «не настроен»');

    // MODELS = "free": сервер сам подбирает бесплатные модели OpenRouter
    const FREE = { OPENROUTER_KEY: 'sk-or-SECRET', MODELS: 'free' };
    const catalog = { data: [
      { id: 'google/gemini-2.5-flash', pricing: { prompt: '0.0000003' } },
      { id: 'meta-llama/llama-3.2-3b-instruct:free', context_length: 131072 },
      { id: 'google/gemini-2.0-flash-exp:free', context_length: 1048576, architecture: { input_modalities: ['text', 'image'] } },
      { id: 'deepseek/deepseek-chat-v3:free', context_length: 163840 },
      { id: 'google/gemini-3-flash-think:free', context_length: 1048576, architecture: { input_modalities: ['text', 'image'] }, supported_parameters: ['reasoning'] },
    ] };
    let upstream = () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith('/models')) return new Response(JSON.stringify(catalog));
      sent = { url, headers: init.headers, body: JSON.parse(init.body) };
      return upstream();
    };
    const req = (env, device) => worker.fetch(new Request('https://w.test/v1/chat/completions', {
      method: 'POST', headers: { Origin: APP, Authorization: 'Bearer ' + device, 'Content-Type': 'application/json' }, body: JSON.stringify(msg),
    }), env);
    r = await req(FREE, 'kd-free');
    ok(r.status === 200 && sent.body.model === 'google/gemini-2.0-flash-exp:free' && sent.body.models.every((m) => m.endsWith(':free')),
      'MODELS=free: только бесплатные модели, лучшая (с фото) первой: ' + sent.body.model);
    ok(sent.body.model !== 'google/gemini-3-flash-think:free', '«думающая» модель не первая, даже если умеет читать фото');
    ok(sent.body.reasoning?.exclude === true, 'OpenRouter просят не присылать рассуждения');
    upstream = () => new Response(JSON.stringify({ error: { code: 429, message: 'Rate limit exceeded: free-models-per-day' } }), { status: 429 });
    r = await req(FREE, 'kd-free2');
    ok(r.status === 429 && (await r.json()).error.code === 'daily_limit', 'кончились бесплатные запросы ключа — «на сегодня закончились», без повторов');
    upstream = () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
    r = await req({ OPENROUTER_KEY: 'k', MODELS: 'gpt-x', UPSTREAM: 'https://api.other.test/v1' }, 'kd-other2');
    ok(r.status === 200 && sent.url === 'https://api.other.test/v1/chat/completions' && !sent.body.models && !sent.body.reasoning && !sent.headers['X-Title'],
      'другой провайдер (UPSTREAM): без полей, которые понимает только OpenRouter');
  } finally {
    globalThis.fetch = realFetch;
  }

  // ---- приложение: первый запуск без ключа
  const { page, ai } = await open({ settings: null, freeProxy: 'https://free-proxy.test' });
  ok((await page.textContent('#obStart')) === 'Начать' && await page.isVisible('#obOwnKey'), 'мастер: «Начать» без ключа и «У меня свой ключ»');
  await page.click('#obStart');
  ok(await page.isVisible('#obFinish') && (await page.textContent('#obStep2')) === 'Последний шаг', 'сразу к звуку и микрофону, шаг с ключом пропущен');
  await page.click('#obFinish');
  ok(await page.evaluate(() => JSON.parse(localStorage.getItem('kd.settings')).provider) === 'free', 'включён бесплатный режим');
  await prepare(page, FINANCE, 'Финансы');
  ok(ai.generate > 0 && /^Bearer kd-[0-9a-f]{24}$/.test(ai.auth), 'конспект готовится через сервер, вместо ключа — номер устройства');
  await page.click('[data-tab=settings]');
  ok((await page.textContent('#aiSummary')).startsWith('Бесплатно, без ключа') && !(await page.isVisible('#apiKey')), 'в настройках: «Бесплатно, без ключа», поля ключа нет');

  // без адреса сервера всё как раньше — нужен ключ
  const old = await open({ settings: null });
  ok((await old.page.textContent('#obStart')) === 'Настроить' && !(await old.page.isVisible('#obOwnKey')), 'без сервера мастер, как раньше, просит ключ');
};
