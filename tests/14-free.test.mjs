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

    // ---- диагностика: по коду видно, что сломалось (каждый случай — на «свежем» сервере: у модуля свой кэш и счётчики)
    let inst = 0;
    const cold = async () => {
      const w = (await import('../server/worker.js?cold=' + ++inst)).default;
      return (env, device) => w.fetch(new Request('https://w.test/v1/chat/completions', {
        method: 'POST', headers: { Origin: APP, Authorization: 'Bearer ' + device, 'Content-Type': 'application/json' }, body: JSON.stringify(msg),
      }), env);
    };
    globalThis.fetch = async () => new Response('{}', { status: 401 });
    r = await (await cold())({ OPENROUTER_KEY: 'k', MODELS: 'gpt-x' }, 'kd-401');
    let e2 = (await r.json()).error;
    ok(r.status === 503 && e2.code === 'unavailable' && e2.reason === 'upstream-401', 'ключ отозван (401) — «недоступно» с кодом upstream-401');
    globalThis.fetch = async (url) => (String(url).endsWith('/models') ? new Response('<html>challenge</html>', { status: 403 }) : new Response('{}'));
    r = await (await cold())({ OPENROUTER_KEY: 'k', MODELS: 'free' }, 'kd-nomodels');
    e2 = (await r.json()).error;
    ok(r.status === 503 && /^models-/.test(e2.reason), 'список моделей не получен — «недоступно» с кодом ' + e2.reason);
    // OpenRouter ответил проверкой вместо списка один раз — второй попыткой список получается
    let tries = 0;
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith('/models')) {
        tries++;
        return tries === 1 ? new Response('<html>challenge</html>', { status: 403 }) : new Response(JSON.stringify(catalog));
      }
      sent = { url, headers: init.headers, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
    };
    const retryReq = await cold();
    r = await retryReq({ OPENROUTER_KEY: 'k', MODELS: 'free' }, 'kd-retry');
    ok(r.status === 200 && tries === 2 && sent.body.model.endsWith(':free'), 'список моделей не получился с первого раза — повтор, и всё работает');
    // а если потом OpenRouter недоступен — работаем со старым списком, а не отвечаем «недоступно»
    // (кэш живёт 6 часов, поэтому сначала «состарим» его, подменив время)
    const realNow = Date.now;
    Date.now = () => realNow() + 7 * 3600e3;
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith('/models')) throw new Error('network');
      sent = { url, headers: init.headers, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
    };
    r = await retryReq({ OPENROUTER_KEY: 'k', MODELS: 'free' }, 'kd-stale'); // тот же сервер: список в кэше уже есть
    Date.now = realNow;
    ok(r.status === 200 && sent.body.model.endsWith(':free'), 'не удалось обновить список моделей — работаем со старым');

    // /health: открывается без «Origin» (прямо в браузере), ключ не раскрывает
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/key')) return new Response(JSON.stringify({ data: { label: 'sk-or-v1-abc...xyz', is_free_tier: true, usage: 1.5 } }));
      return new Response(JSON.stringify(catalog));
    };
    const hr = await worker.fetch(new Request('https://w.test/health', { headers: { 'CF-Connecting-IP': '9.9.9.9' } }), { OPENROUTER_KEY: 'sk-or-SECRET-KEY', MODELS: 'free' });
    const htext = await hr.text();
    const hd = JSON.parse(htext);
    ok(hr.status === 200 && hd.keyOnServer === true && hd.keyCheck.status === 200 && hd.keyCheck.freeTier === true && hd.models.length > 0, '/health: ключ на месте и принят, бесплатные модели видны');
    ok(!/SECRET-KEY|sk-or/.test(htext), '/health не раскрывает ключ');
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

  // сервер недоступен: пользователь видит понятный текст и код причины — по нему можно найти поломку
  const down = await open({ settings: { provider: 'free', apiKey: '' }, freeProxy: 'https://free-proxy.test' });
  await down.page.route(/free-proxy\.test/, (route) => route.fulfill({
    status: 503, contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'unavailable', proxy: true, reason: 'upstream-403', message: 'Бесплатный режим сейчас недоступен. Попробуйте позже или укажите свой ключ: Настройки → Настроить заново.' } }),
  }));
  await down.page.click('[data-tab=load]');
  await down.page.click('#addTextBtn');
  await down.page.fill('#pasteText', FINANCE);
  await down.page.click('#pasteAdd');
  await down.page.click('#analyzeBtn');
  await down.page.waitForFunction(() => /код: upstream-403/.test(document.body.innerText), null, { timeout: 15000 });
  ok(/Бесплатный режим сейчас недоступен[\s\S]*\(код: upstream-403\)/.test(await down.page.evaluate(() => document.body.innerText)), 'сервер недоступен: текст ошибки и код причины на экране');
  const enText = await down.page.evaluate(async () => { const m = await import('./js/i18n.js'); m.setUiLang('en'); return m.T('Бесплатный режим сейчас недоступен. Попробуйте позже или укажите свой ключ: Настройки → Настроить заново. (код: upstream-403)'); });
  ok(/Free mode is unavailable right now[\s\S]*\(code: upstream-403\)/.test(enText), 'по-английски — тоже с кодом: ' + enText);

  // без адреса сервера всё как раньше — нужен ключ
  const old = await open({ settings: null });
  ok((await old.page.textContent('#obStart')) === 'Настроить' && !(await old.page.isVisible('#obOwnKey')), 'без сервера мастер, как раньше, просит ключ');
};
