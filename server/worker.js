// Сервер бесплатного режима: приложение шлёт запросы сюда, а сервер — в OpenRouter со своим ключом.
// Так пользователю не нужен свой ключ. Ключ лежит в секрете OPENROUTER_KEY и в браузер не попадает.
//
// Чтобы ключ не потратили чужие:
//  - запросы принимаются только со страниц из ALLOWED_ORIGINS (сайт приложения);
//  - модель выбирает сервер (MODELS), а не тот, кто прислал запрос; длина ответа ограничена (MAX_TOKENS);
//  - лимит запросов в сутки на устройство (DAILY_PER_DEVICE) и на IP-адрес (DAILY_PER_IP).
//    Счётчики живут в памяти сервера и считают примерно — главный предохранитель всё равно
//    лимит расходов на самом ключе в OpenRouter (см. server/README.md).
//
// Работает в Cloudflare Workers; настройки — переменные окружения (wrangler.toml или панель Cloudflare).

const UPSTREAM = 'https://openrouter.ai/api/v1';
const MAX_BODY = 12 * 1024 * 1024; // фото страниц приходят картинками в base64

const counters = new Map(); // «сутки|кто» -> число запросов
let countersDay = '';

function opt(env, name, def) {
  const v = env[name];
  return v === undefined || v === '' ? def : v;
}

function cors(req, env) {
  const origin = req.headers.get('Origin') || '';
  const allowed = String(opt(env, 'ALLOWED_ORIGINS', 'https://stairrax.github.io')).split(',').map((s) => s.trim()).filter(Boolean);
  const ok = allowed.includes('*') || allowed.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return {
    ok,
    headers: {
      'Access-Control-Allow-Origin': ok ? origin || '*' : 'null',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    },
  };
}

function json(status, data, headers) {
  return new Response(JSON.stringify(data), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });
}

// ошибки сервера — в формате OpenAI, с пометкой: приложение покажет текст как есть
const fail = (status, code, message, headers) => json(status, { error: { code, message, proxy: true } }, headers);

/** Считает запрос; false — лимит на сегодня исчерпан. */
function count(who, limit) {
  const day = new Date().toISOString().slice(0, 10);
  if (day !== countersDay) { counters.clear(); countersDay = day; }
  const n = (counters.get(who) || 0) + 1;
  if (n > limit) return false;
  counters.set(who, n);
  return true;
}

function models(env) {
  return String(opt(env, 'MODELS', 'google/gemini-2.5-flash')).split(',').map((s) => s.trim()).filter(Boolean);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/v1(?=\/)/, '');
    const c = cors(req, env);

    if (req.method === 'OPTIONS') return new Response(null, { status: c.ok ? 204 : 403, headers: c.headers });
    if (path === '/' || path === '') return new Response('ok', { headers: c.headers });
    if (!c.ok) return fail(403, 'origin', 'Этот сервер работает только для приложения «Диктор конспектов».', c.headers);

    if (req.method === 'GET' && path === '/models') {
      return json(200, { data: models(env).map((id) => ({ id })) }, c.headers);
    }
    if (req.method !== 'POST' || path !== '/chat/completions') return fail(404, 'not_found', 'Нет такого адреса.', c.headers);
    if (!env.OPENROUTER_KEY) return fail(503, 'unavailable', 'Бесплатный режим не настроен на сервере.', c.headers);

    if (+(req.headers.get('Content-Length') || 0) > MAX_BODY) return fail(413, 'too_large', 'Запрос слишком большой.', c.headers);
    let body;
    try { body = await req.json(); } catch { return fail(400, 'bad_request', 'Неверный запрос.', c.headers); }
    if (!Array.isArray(body?.messages) || !body.messages.length) return fail(400, 'bad_request', 'Неверный запрос.', c.headers);

    // кто прислал: устройство (случайный номер из приложения) и IP-адрес
    const device = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').slice(0, 64) || 'none';
    const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
    const limitText = 'На сегодня бесплатные запросы закончились. Продолжите завтра или укажите свой ключ: Настройки → Настроить заново.';
    if (!count('d|' + device, +opt(env, 'DAILY_PER_DEVICE', 300)) || !count('ip|' + ip, +opt(env, 'DAILY_PER_IP', 1500))) {
      return fail(429, 'daily_limit', limitText, c.headers);
    }

    const list = models(env);
    const maxTokens = +opt(env, 'MAX_TOKENS', 16000);
    const out = {
      model: list[0],
      messages: body.messages,
      temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
      max_tokens: Math.min(+body.max_tokens || maxTokens, maxTokens),
      stream: body.stream === true,
    };
    if (list.length > 1) out.models = list.slice(0, 3);

    let up;
    try {
      up = await fetch(UPSTREAM + '/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + env.OPENROUTER_KEY,
          'HTTP-Referer': opt(env, 'APP_URL', 'https://stairrax.github.io/helper-with-conspects/'),
          'X-Title': 'Konspekt Diktor',
        },
        body: JSON.stringify(out),
      });
    } catch {
      return fail(502, 'upstream', 'Сервер нейросети не отвечает. Попробуйте ещё раз.', c.headers);
    }
    // кончились деньги или лимит на ключе, ключ отозван — это забота владельца сервера, а не пользователя
    if ([401, 402, 403].includes(up.status)) {
      return fail(503, 'unavailable', 'Бесплатный режим сейчас недоступен. Попробуйте позже или укажите свой ключ: Настройки → Настроить заново.', c.headers);
    }
    // ответ (и потоковый тоже) отдаём как есть
    return new Response(up.body, {
      status: up.status,
      headers: { ...c.headers, 'Content-Type': up.headers.get('Content-Type') || 'application/json', 'Cache-Control': 'no-store' },
    });
  },
};
