// Сервер бесплатного режима: приложение шлёт запросы сюда, а сервер — нейросети со своим ключом.
// Так пользователю не нужен свой ключ. Ключ лежит в секрете OPENROUTER_KEY и в браузер не попадает.
//
// Нейросеть — OpenRouter или любой сервис с OpenAI-совместимым API (UPSTREAM).
// MODELS = "free" — бесплатные модели OpenRouter, их сервер подбирает сам: платить не нужно,
// но у ключа без пополнения общий лимит — около 50 запросов в день на всё приложение.
//
// Чтобы ключ не потратили чужие:
//  - запросы принимаются только со страниц из ALLOWED_ORIGINS (сайт приложения);
//  - модель выбирает сервер (MODELS), а не тот, кто прислал запрос; длина ответа ограничена (MAX_TOKENS);
//  - лимит запросов в сутки на устройство (DAILY_PER_DEVICE) и на IP-адрес (DAILY_PER_IP).
//    Счётчики живут в памяти сервера и считают примерно — если ключ платный, главный предохранитель
//    всё равно лимит расходов на самом ключе (см. server/README.md).
//
// Работает в Cloudflare Workers; настройки — переменные окружения (wrangler.toml или панель Cloudflare).

const OPENROUTER = 'https://openrouter.ai/api/v1';
const MAX_BODY = 12 * 1024 * 1024; // фото страниц приходят картинками в base64

const counters = new Map(); // «сутки|кто» -> число запросов
let countersDay = '';
let freeCache = { at: 0, list: [] }; // подобранные бесплатные модели (обновляются раз в 6 часов)

function opt(env, name, def) {
  const v = env[name];
  return v === undefined || v === '' ? def : v;
}

const upstream = (env) => String(opt(env, 'UPSTREAM', OPENROUTER)).replace(/\/+$/, '');
const isOpenRouter = (env) => upstream(env).startsWith(OPENROUTER);

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

const LIMIT_TEXT = 'На сегодня бесплатные запросы закончились. Продолжите завтра или укажите свой ключ: Настройки → Настроить заново.';
const DOWN_TEXT = 'Бесплатный режим сейчас недоступен. Попробуйте позже или укажите свой ключ: Настройки → Настроить заново.';

/** Считает запрос; false — лимит на сегодня исчерпан. */
function count(who, limit) {
  const day = new Date().toISOString().slice(0, 10);
  if (day !== countersDay) { counters.clear(); countersDay = day; }
  const n = (counters.get(who) || 0) + 1;
  if (n > limit) return false;
  counters.set(who, n);
  return true;
}

// ---------- бесплатные модели OpenRouter ----------

const hasVision = (m) => (m.architecture?.input_modalities || []).includes('image');

/** Чем выше, тем лучше подходит для конспектов на русском (как при подборе модели в мастере приложения). */
function score(m) {
  const id = m.id.toLowerCase();
  let s = hasVision(m) ? 100 : 0; // фото страниц
  s += Math.min(60, (m.context_length || 0) / 4000);
  for (const [re, b] of [[/gemini/, 60], [/deepseek/, 45], [/qwen/, 40], [/llama-4|llama4/, 35], [/mistral|mixtral/, 30], [/gemma/, 25], [/llama/, 15]]) {
    if (re.test(id)) { s += b; break; }
  }
  if (/r1|reason|think|coder|math|guard|embed|tts|audio/.test(id)) s -= 50;
  // «думающие» модели сначала долго рассуждают — для диктовки это лишнее ожидание и расход токенов
  if ((m.supported_parameters || []).some((p) => p === 'reasoning' || p === 'include_reasoning')) s -= 60;
  const size = parseFloat((id.match(/(\d+(?:\.\d+)?)b\b/) || [])[1]);
  if (size && size < 12) s -= 80; else if (size && size < 30) s -= 20;
  if (/mini|nano|tiny/.test(id)) s -= 40;
  return s;
}

async function freeModels() {
  if (freeCache.list.length && Date.now() - freeCache.at < 6 * 3600e3) return freeCache.list;
  const res = await fetch(OPENROUTER + '/models');
  const data = await res.json();
  const list = (data.data || [])
    .filter((m) => m.id.endsWith(':free') && (m.architecture?.output_modalities || ['text']).includes('text'))
    .sort((a, b) => score(b) - score(a))
    .slice(0, 3)
    .map((m) => m.id);
  if (list.length) freeCache = { at: Date.now(), list };
  return list;
}

async function models(env) {
  const v = String(opt(env, 'MODELS', 'free')).trim();
  if (v === 'free') return freeModels();
  return v.split(',').map((s) => s.trim()).filter(Boolean);
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
      const list = await models(env).catch(() => []);
      return json(200, { data: list.map((id) => ({ id })) }, c.headers);
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
    if (!count('d|' + device, +opt(env, 'DAILY_PER_DEVICE', 300)) || !count('ip|' + ip, +opt(env, 'DAILY_PER_IP', 1500))) {
      return fail(429, 'daily_limit', LIMIT_TEXT, c.headers);
    }

    let list;
    try { list = await models(env); } catch { list = []; }
    if (!list.length) return fail(503, 'unavailable', DOWN_TEXT, c.headers);
    const maxTokens = +opt(env, 'MAX_TOKENS', 16000);
    const out = {
      model: list[0],
      messages: body.messages,
      temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
      max_tokens: Math.min(+body.max_tokens || maxTokens, maxTokens),
      stream: body.stream === true,
    };
    const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.OPENROUTER_KEY };
    if (isOpenRouter(env)) {
      if (list.length > 1) out.models = list.slice(0, 3); // запасные модели, если основная занята
      out.reasoning = { effort: 'low', exclude: true }; // если модель «думающая» — думать поменьше и рассуждения не присылать
      headers['HTTP-Referer'] = opt(env, 'APP_URL', 'https://stairrax.github.io/helper-with-conspects/');
      headers['X-Title'] = 'Konspekt Diktor';
    }

    let up;
    try {
      up = await fetch(upstream(env) + '/chat/completions', { method: 'POST', headers, body: JSON.stringify(out) });
    } catch {
      return fail(502, 'upstream', 'Сервер нейросети не отвечает. Попробуйте ещё раз.', c.headers);
    }
    // кончились деньги или лимит на ключе, ключ отозван — это забота владельца сервера, а не пользователя
    if ([401, 402, 403].includes(up.status)) return fail(503, 'unavailable', DOWN_TEXT, c.headers);
    // у бесплатных моделей дневной лимит на весь ключ — когда он кончился, повторять бессмысленно
    if (up.status === 429) {
      const text = await up.text();
      if (/per-day|daily/i.test(text)) return fail(429, 'daily_limit', LIMIT_TEXT, c.headers);
      return new Response(text, { status: 429, headers: { ...c.headers, 'Content-Type': 'application/json', 'Retry-After': up.headers.get('Retry-After') || '20' } });
    }
    // ответ (и потоковый тоже) отдаём как есть
    return new Response(up.body, {
      status: up.status,
      headers: { ...c.headers, 'Content-Type': up.headers.get('Content-Type') || 'application/json', 'Cache-Control': 'no-store' },
    });
  },
};
