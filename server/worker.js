// Сервер бесплатного режима: приложение шлёт запросы сюда, а сервер — нейросети со своим ключом.
// Так пользователю не нужен свой ключ. Ключ лежит в секрете OPENROUTER_KEY и в браузер не попадает.
//
// Нейросеть — OpenRouter или любой сервис с OpenAI-совместимым API (UPSTREAM).
// MODELS = "free" — бесплатные модели OpenRouter. Платная модель для конспектов
// включается отдельно и только при наличии специального ключа с месячным лимитом.
//
// Чтобы ключ не потратили чужие:
//  - запросы принимаются только со страниц из ALLOWED_ORIGINS (сайт приложения);
//  - модель выбирает сервер (MODELS), а не тот, кто прислал запрос; длина ответа ограничена (MAX_TOKENS);
//  - общий дневной лимит, лимит на устройство и на IP в Durable Object.
//    Идентификатор устройства и Origin можно подделать; ограничение расходов на ключе остаётся важным.
//
// Запасной вариант — Cloudflare Workers AI (привязка AI в wrangler.toml, отдельный бесплатный дневной запас, карта не нужна):
// когда у OpenRouter кончился дневной лимит, отказал ключ или не ответили модели, сервер отвечает через него.
// Фото он не читает — такие запросы запасному не передаются.
//
// Работает в Cloudflare Workers; настройки — переменные окружения (wrangler.toml или панель Cloudflare).

const OPENROUTER = 'https://openrouter.ai/api/v1';
const MAX_BODY = 12 * 1024 * 1024; // фото страниц приходят картинками в base64
const MAX_ALLOWED_TOKENS = 16000;
const MAX_HEALTH_IDENTITIES = 4096;

// Timeouts for small JSON requests cover both response headers and body parsing.
// For inference only the initial response headers have a deadline: once they
// arrive, the SSE body may legitimately stream for much longer.
const timeoutMs = (env, key, fallback) => {
  const n = Number(opt(env, key, fallback));
  return Number.isSafeInteger(n) && n >= 100 && n <= 120000 ? n : fallback;
};
function boundedTokens(value, fallback) {
  const n = (typeof value === 'number' || (typeof value === 'string' && value.trim())) ? Number(value) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? Math.min(n, MAX_ALLOWED_TOKENS) : fallback;
}
async function withDeadline(ms, task) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('upstream-timeout'));
    }, ms);
  });
  try {
    // Promise.race also works if a mocked or broken fetch ignores AbortSignal.
    return await Promise.race([Promise.resolve().then(() => task(controller.signal)), deadline]);
  } finally {
    clearTimeout(timer);
    // Do not abort on success: the caller may still need to read an SSE body.
  }
}
const healthCounters = new Map();
let healthDay = '';
function countHealth(who) {
  const day = new Date().toISOString().slice(0, 10);
  if (healthDay !== day) { healthDay = day; healthCounters.clear(); }
  const n = healthCounters.get(who) || 0;
  if (n >= 30) return false;
  // Fail closed when the daily capacity is full; evicting would let a caller
  // reset their rate limit simply by forcing enough new IPs into the map.
  if (n === 0 && healthCounters.size >= MAX_HEALTH_IDENTITIES) return false;
  healthCounters.set(who, n + 1);
  return true;
}

let freeCache = { at: 0, list: [] }; // подобранные бесплатные модели (обновляются раз в 6 часов)
let modelsError = '';                // почему не удалось получить список моделей в последний раз (для /health)
let aiLast = '';                     // что ответил запасной ИИ в последний раз (для /health)
let aiTried = [];                    // какие модели запасного ИИ отказали и почему — в последнем запросе (для /health)
let healthCache = { at: 0, data: null };

function opt(env, name, def) {
  const v = env[name];
  return v === undefined || v === '' ? def : v;
}

const upstream = (env) => String(opt(env, 'UPSTREAM', OPENROUTER)).replace(/\/+$/, '');
const isOpenRouter = (env) => upstream(env) === OPENROUTER;

function cors(req, env) {
  const origin = req.headers.get('Origin') || '';
  const allowed = String(opt(env, 'ALLOWED_ORIGINS', 'https://stairrax.github.io')).split(',').map((s) => s.trim()).filter(Boolean);
  const ok = allowed.includes('*') || allowed.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return {
    ok,
    headers: {
      'Access-Control-Allow-Origin': ok ? origin || '*' : 'null',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Idempotency-Key',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    },
  };
}

function json(status, data, headers) {
  return new Response(JSON.stringify(data), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });
}

// ошибки сервера — в формате OpenAI, с пометкой: приложение покажет текст как есть.
// reason — короткий код причины («upstream-401», «models-empty»): приложение дописывает его к сообщению,
// чтобы по скриншоту было видно, что именно сломалось.
const fail = (status, code, message, headers, reason) => json(status, { error: { code, message, proxy: true, ...(reason ? { reason } : {}) } }, headers);

const LIMIT_TEXT = 'На сегодня бесплатные запросы закончились. Продолжите завтра или укажите свой ключ: Настройки → Настроить заново.';
const DOWN_TEXT = 'Бесплатный режим сейчас недоступен. Попробуйте позже или укажите свой ключ: Настройки → Настроить заново.';

// Один объект ведёт общий счётчик для всех экземпляров Worker. Транзакция
// проверяет и увеличивает все три лимита вместе; отказ не тратит другие лимиты.
export class RequestLimits {
  constructor(state) { this.storage = state.storage; }
  async fetch(request) {
    const { action, device, ip, limits, purpose, requestId, fingerprint, token } = await request.json();
    const dedupKey = requestId ? 'request:' + device + ':' + ip + ':' + requestId : null;
    if (action === 'release') {
      // Only the exact reservation owner can roll back an explicitly rejected
      // request. The token prevents an old failure from erasing a newer claim.
      if (!dedupKey || !token) return Response.json({ released: false });
      const released = await this.storage.transaction(async (tx) => {
        const existing = await tx.get(dedupKey);
        if (!existing || existing.token !== token || existing.fingerprint !== fingerprint) return false;
        for (const key of existing.keys) {
          const count = await tx.get(key) || 0;
          await tx.put(key, Math.max(0, count - 1));
        }
        await tx.delete(dedupKey);
        return true;
      });
      return Response.json({ released });
    }
    const result = await this.storage.transaction(async (tx) => {
      // Reserve a logical request before quota increments or any upstream call.
      // Retry with a different body is an explicit conflict, never a free bypass.
      if (dedupKey) {
        const existing = await tx.get(dedupKey);
        if (existing) return { accepted: false, duplicate: true, conflict: existing.fingerprint !== fingerprint };
      }
      const keys = ['total', 'device:' + device, 'ip:' + ip];
      if (purpose === 'notes' || purpose === 'question') keys.push('purpose:' + purpose + ':' + device);
      const values = await Promise.all(keys.map((key) => tx.get(key)));
      const blocked = values.findIndex((v, i) => (v || 0) >= limits[i]);
      if (blocked >= 0) return { accepted: false, category: blocked === 3 };
      for (let i = 0; i < keys.length; i++) await tx.put(keys[i], (values[i] || 0) + 1);
      if (dedupKey) await tx.put(dedupKey, { fingerprint, token, keys });
      return { accepted: true, ...(dedupKey ? { token } : {}) };
    });
    if (!await this.storage.getAlarm()) await this.storage.setAlarm(Date.now() + 48 * 3600e3);
    return Response.json(result);
  }
  async alarm() { await this.storage.deleteAll(); }
}

const positiveLimit = (v, fallback) => Number.isSafeInteger(+v) && +v > 0 ? +v : fallback;
async function countRequest(env, device, ip, purpose, requestId = '', fingerprint = '', token = '', day = new Date().toISOString().slice(0, 10)) {
  const ns = env.REQUEST_LIMITS;
  if (!ns) throw new Error('Request limits unavailable');
  const stub = ns.get(ns.idFromName('daily:' + day));
  const response = await stub.fetch('https://limits.internal/', {
    method: 'POST', body: JSON.stringify({ device, ip, purpose, requestId, fingerprint, token, limits: [
      positiveLimit(opt(env, 'DAILY_TOTAL', 900), 900),
      positiveLimit(opt(env, 'DAILY_PER_DEVICE', 170), 170),
      positiveLimit(opt(env, 'DAILY_PER_IP', 500), 500),
      purpose === 'notes' ? positiveLimit(opt(env, 'DAILY_NOTES', 100), 100) : positiveLimit(opt(env, 'DAILY_QUESTIONS', 70), 70),
    ] }),
  });
  if (!response.ok) throw new Error('Request limits unavailable');
  const result = await response.json();
  if (typeof result.accepted !== 'boolean') throw new Error('Invalid limits response');
  return result;
}

// Roll back the dedup key AND all counters in the same Durable Object transaction.
// Never call this after an ambiguous network failure: upstream may have billed
// even when fetch() could not return a response.
async function releaseRequest(env, device, ip, requestId, fingerprint, token, day) {
  if (!requestId || !token) return false;
  const ns = env.REQUEST_LIMITS;
  if (!ns) throw new Error('Request limits unavailable');
  const stub = ns.get(ns.idFromName('daily:' + day));
  const response = await stub.fetch('https://limits.internal/', {
    method: 'POST', body: JSON.stringify({ action: 'release', device, ip, requestId, fingerprint, token }),
  });
  if (!response.ok) throw new Error('Request release unavailable');
  const result = await response.json();
  if (typeof result.released !== 'boolean') throw new Error('Invalid release response');
  return result.released;
}

// Платный режим включается только отдельным ключом с ограничением в OpenRouter.
async function paidKeyReady(env) {
  if (String(opt(env, 'PAID_NOTES_ENABLED', 'false')) !== 'true' || !env.OPENROUTER_PAID_KEY || env.OPENROUTER_PAID_KEY === env.OPENROUTER_KEY || !isOpenRouter(env)) return false;
  try {
    const d = await withDeadline(timeoutMs(env, 'KEY_CHECK_TIMEOUT_MS', 5000), async signal => {
      const r = await fetch(OPENROUTER + '/key', { headers: { ...FETCH_HEADERS, Authorization: 'Bearer ' + env.OPENROUTER_PAID_KEY }, signal });
      return r.ok ? (await r.json()).data : null;
    });
    return d?.limit_reset === 'monthly' && typeof d.limit === 'number' && d.limit > 0 && d.limit <= 20 && typeof d.limit_remaining === 'number' && d.limit_remaining > 0;
  } catch { return false; }
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

// OpenRouter стоит за защитой от ботов: запросу без User-Agent она может ответить страницей-проверкой, а не списком
const FETCH_HEADERS = { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; StudyHelperServer/1.0; +https://stairrax.github.io/helper-with-conspects/)' };

async function loadFreeList(env) {
  let lastErr = '';
  for (let i = 0; i < 2; i++) {
    try {
      const result = await withDeadline(timeoutMs(env, 'MODEL_LIST_TIMEOUT_MS', 8000), async signal => {
        const res = await fetch(OPENROUTER + '/models', { headers: FETCH_HEADERS, signal });
        return { status: res.status, ok: res.ok, data: res.ok ? await res.json() : null };
      });
      if (!result.ok) { lastErr = 'models-http-' + result.status; continue; }
      const data = result.data;
      const list = (data.data || [])
        .filter((m) => m.id.endsWith(':free') && (m.architecture?.output_modalities || ['text']).includes('text'))
        .sort((a, b) => score(b) - score(a))
        .slice(0, 3)
        .map((m) => m.id);
      if (list.length) return { list, error: '' };
      lastErr = 'models-empty';
    } catch (err) {
      lastErr = err?.message === 'upstream-timeout' ? 'models-timeout' : 'models-unreachable';
    }
  }
  return { list: [], error: lastErr };
}

async function freeModels(env) {
  if (freeCache.list.length && Date.now() - freeCache.at < 6 * 3600e3) return freeCache.list;
  const { list, error } = await loadFreeList(env);
  modelsError = error;
  if (list.length) { freeCache = { at: Date.now(), list }; return list; }
  // не получилось обновить — лучше работать со старым списком, чем отвечать «недоступно»
  return freeCache.list;
}

async function models(env) {
  const v = String(opt(env, 'MODELS', 'free')).trim();
  if (v === 'free') return freeModels(env);
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

// ---------- запасной ИИ: Cloudflare Workers AI ----------

// Сначала модели подешевле (бесплатного дневного запаса хватает на больше запросов), потом тяжёлая; первая, что ответит, и берётся.
// Каталог Cloudflare меняется: модель, к которой нет доступа или которую сняли с обслуживания, сервер на час пропускает
// и не тратит на неё время (список для проверки печатает выкладка, см. server.yml).
const AI_MODELS = ['@cf/mistralai/mistral-small-3.1-24b-instruct', '@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/google/gemma-3-12b-it', '@cf/meta/llama-3.1-8b-instruct'];
const aiBad = new Map(); // модель -> до какого времени пропускать
const aiModels = (env) => {
  const v = String(opt(env, 'FALLBACK_AI_MODELS', AI_MODELS.join(','))).trim();
  return v === 'off' ? [] : v.split(',').map((s) => s.trim()).filter(Boolean);
};

/** Сообщения без картинок (запасные модели их не читают). null — в запросе есть фото. */
function plainMessages(messages) {
  const out = [];
  for (const m of messages) {
    let c = m.content;
    if (Array.isArray(c)) {
      if (c.some((p) => p.type && p.type !== 'text')) return null;
      c = c.map((p) => p.text || '').join('\n');
    }
    out.push({ role: m.role, content: String(c ?? '') });
  }
  return out;
}

const answerText = (r) => {
  const t = r?.response ?? r?.result?.response ?? r?.choices?.[0]?.message?.content ?? r?.output_text ?? '';
  return typeof t === 'string' ? t : JSON.stringify(t);
};

/** Ответ запасной модели в формате OpenAI (обычный или потоковый). */
function aiResponse(res, model, stream, headers, budget) {
  const h = { ...headers, 'Cache-Control': 'no-store', 'X-Answered-By': 'workers-ai' };
  if (stream && res instanceof ReadableStream) {
    const enc = new TextEncoder(), dec = new TextDecoder();
    let buf = '', upstreamDone = false;
    // A closed transport is NOT a completed generation. Only forward a real upstream [DONE].
    const handleLine = (line, ctrl) => {
      if (!line.startsWith('data:') || upstreamDone) return;
      const payload = line.slice(5).trim();
      if (!payload) return;
      if (payload === '[DONE]') {
        upstreamDone = true;
        ctrl.enqueue(enc.encode('data: [DONE]\n\n'));
        return;
      }
      let event;
      try { event = JSON.parse(payload); }
      catch { throw new Error('Workers AI sent malformed SSE'); }
      if (event?.error) throw new Error('Workers AI returned an SSE error');
      const text = event?.response ?? event?.choices?.[0]?.delta?.content ?? '';
      if (text) ctrl.enqueue(enc.encode('data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\n'));
      // Preserve truncation metadata so the browser cannot treat an output limit as success.
      const finish = event?.choices?.[0]?.finish_reason;
      if (finish) ctrl.enqueue(enc.encode('data: ' + JSON.stringify({ choices: [{ finish_reason: finish }] }) + '\n\n'));
    };
    const toOpenAI = new TransformStream({
      transform(chunk, ctrl) {
        buf += typeof chunk === 'string' ? chunk : dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          handleLine(buf.slice(0, i).trim(), ctrl);
          buf = buf.slice(i + 1);
        }
        if (buf.length > 1024 * 1024) throw new Error('Workers AI SSE event too large');
      },
      flush(ctrl) {
        buf += dec.decode();
        if (buf.trim()) handleLine(buf.trim(), ctrl);
        // Throwing errors the response stream: partial text stays partial, no synthetic [DONE].
        if (!upstreamDone) throw new Error('Workers AI stream ended without [DONE]');
      },
    });
    return new Response(res.pipeThrough(toOpenAI), { headers: { ...h, 'Content-Type': 'text/event-stream' } });
  }
  const text = answerText(res);
  if (!text.trim()) return null;
  if (stream) { // модель ответила сразу целиком — отдаём как поток из одного куска
    const sse = 'data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\ndata: [DONE]\n\n';
    return new Response(sse, { headers: { ...h, 'Content-Type': 'text/event-stream' } });
  }
  // ответ упёрся в лимит длины — приложение разделит задачу пополам, как и с обычной моделью
  const cut = Number(res?.usage?.completion_tokens) >= budget - 1;
  return json(200, { id: 'cf-ai', object: 'chat.completion', model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: cut ? 'length' : 'stop' }] }, h);
}

/** Пробует запасные модели Workers AI по очереди. null — запасного нет, в запросе фото или все отказали (причина — в aiLast). */
async function viaAI(env, body, maxTokens, headers) {
  if (!env.AI) return null;
  const models = aiModels(env);
  const messages = models.length ? plainMessages(body.messages) : null;
  if (!messages) return null;
  const stream = body.stream === true;
  aiTried = [];
  const nowMs = Date.now();
  const skip = models.filter((m) => (aiBad.get(m) || 0) > nowMs);
  if (skip.length < models.length) models.splice(0, models.length, ...models.filter((m) => !skip.includes(m)));
  // у моделей свой потолок длины ответа: если отказались из-за него — пробуем покороче
  const budgets = [...new Set([maxTokens, Math.min(maxTokens, 4096)])];
  for (const model of models) {
    for (const budget of budgets) {
      try {
        const res = await env.AI.run(model, { messages, max_tokens: budget, stream, ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}) });
        const out = aiResponse(res, model, stream, headers, budget);
        if (out) { aiLast = 'ok ' + model; return out; }
        aiLast = 'empty ' + model;
        aiTried.push({ model, error: 'пустой ответ' });
        break;
      } catch (e) {
        const msg = String(e?.message || e);
        aiLast = (model + ': ' + msg).slice(0, 200);
        aiTried.push({ model, budget, error: msg.slice(0, 160) });
        if (!/token|length|context|exceed|large|too long/i.test(msg)) {
          if (/not allowed|deprecated|not found|no such|unknown model|5018|5028|5007/i.test(msg)) aiBad.set(model, Date.now() + 3600e3); // насовсем: час не трогаем
          break;
        }
      }
    }
  }
  return null;
}

/** Диагностика: есть ли ключ, принимает ли его OpenRouter, какие бесплатные модели видны. Секретов не раскрывает. */
async function health(req, env) {
  const who = req.headers.get('CF-Connecting-IP') || 'unknown';
  const h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' };
  if (!countHealth(who)) return new Response(JSON.stringify({ error: 'слишком часто, попробуйте позже' }), { status: 429, headers: h });
  const where = { colo: req.cf?.colo || null, country: req.cf?.country || null }; // через какой город и страну идут запросы
  if (!healthCache.data || Date.now() - healthCache.at > 60e3) {
    const out = { keyOnServer: !!env.OPENROUTER_KEY, upstream: upstream(env), mode: String(opt(env, 'MODELS', 'free')) };
    try {
      out.models = await models(env);
      if (!out.models.length) out.modelsProblem = modelsError || 'models-empty';
    } catch (e) {
      out.models = [];
      out.modelsProblem = modelsError || 'models-error';
    }
    if (env.OPENROUTER_KEY && isOpenRouter(env)) {
      try {
        const result = await withDeadline(timeoutMs(env, 'KEY_CHECK_TIMEOUT_MS', 5000), async signal => {
          const r = await fetch(OPENROUTER + '/key', { headers: { ...FETCH_HEADERS, Authorization: 'Bearer ' + env.OPENROUTER_KEY }, signal });
          return { status: r.status, data: r.ok ? (await r.json().catch(() => ({}))).data || {} : {} };
        });
        out.keyCheck = { status: result.status };
        if (result.status >= 200 && result.status < 300) {
          const d = result.data;
          out.keyCheck.freeTier = d.is_free_tier !== false; // true — ключ без пополнения: у бесплатных моделей общий лимит на день
          if (typeof d.limit_remaining === 'number') out.keyCheck.limitRemaining = d.limit_remaining;
        }
      } catch {
        out.keyCheck = { status: 'unreachable' };
      }
    }
    healthCache = { at: Date.now(), data: out };
  }
  // Passive diagnostics: never spend inference quota here.
  const fallback = { binding: !!env.AI, models: env.AI ? aiModels(env) : [] };
  const skipped = [...aiBad].filter(([, until]) => until > Date.now()).map(([m]) => m);
  if (skipped.length) fallback.skippedForAnHour = skipped;
  return new Response(JSON.stringify({ ...healthCache.data, fallback, where }, null, 2), { headers: h });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/v1(?=\/)/, '');
    const c = cors(req, env);

    if (req.method === 'OPTIONS') return new Response(null, { status: c.ok ? 204 : 403, headers: c.headers });
    if (path === '/' || path === '') return new Response('ok', { headers: c.headers });
    // /health — для владельца: что сервер видит из того места, куда обратились (можно открыть в браузере на телефоне)
    if (req.method === 'GET' && path === '/health') return health(req, env);
    if (!c.ok) return fail(403, 'origin', 'Этот сервер работает только для приложения «Помощник по учёбе».', c.headers);

    if (req.method === 'GET' && path === '/models') {
      const list = await models(env).catch(() => []);
      return json(200, { data: list.map((id) => ({ id })) }, c.headers);
    }
    if (req.method !== 'POST' || path !== '/chat/completions') return fail(404, 'not_found', 'Нет такого адреса.', c.headers);
    if (!env.OPENROUTER_KEY && !env.AI) return fail(503, 'unavailable', 'Бесплатный режим не настроен на сервере.', c.headers);

    if (+(req.headers.get('Content-Length') || 0) > MAX_BODY) return fail(413, 'too_large', 'Запрос слишком большой.', c.headers);
    let body, bodyBytes;
    try {
      const reader = req.body?.getReader();
      if (!reader) throw new Error('empty');
      const chunks = []; let size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_BODY) {
            await reader.cancel();
            return fail(413, 'too_large', 'Запрос слишком большой.', c.headers);
          }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      bodyBytes = bytes;
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch { return fail(400, 'bad_request', 'Неверный запрос.', c.headers); }
    if (!Array.isArray(body?.messages) || !body.messages.length) return fail(400, 'bad_request', 'Неверный запрос.', c.headers);

    // кто прислал: устройство (случайный номер из приложения) и IP-адрес
    const device = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').slice(0, 64) || 'none';
    const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
    const purpose = body.kd_purpose === 'question' ? 'question' : 'notes';
    const requestId = req.headers.get('Idempotency-Key') || '';
    if (requestId && !/^[a-zA-Z0-9_-]{16,100}$/.test(requestId))
      return fail(400, 'invalid_request_id', 'Некорректный идентификатор запроса.', c.headers);
    // Hash the exact request bytes only when deduplication is requested. Hashes
    // don't store study text or API keys inside the quota Durable Object.
    let fingerprint = '';
    if (requestId) {
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bodyBytes));
      fingerprint = Array.from(hash, b => b.toString(16).padStart(2, '0')).join('');
    }
    // Bind the release to the original day's Durable Object, even across UTC midnight.
    const reservationDay = new Date().toISOString().slice(0, 10);
    const reservationToken = requestId ? crypto.randomUUID() : '';
    let quota;
    try { quota = await countRequest(env, device, ip, purpose, requestId, fingerprint, reservationToken, reservationDay); }
    catch { return fail(503, 'unavailable', DOWN_TEXT, c.headers, 'limits-unavailable'); }
    if (!quota.accepted) {
      if (quota.duplicate) {
        // Replaying a request could spend a second provider quota or payment.
        // Respond explicitly rather than re-send: the previous request may still
        // be running or have completed while the connection was interrupted.
        return fail(409, quota.conflict ? 'idempotency_conflict' : 'duplicate_request',
          quota.conflict ? 'Идентификатор уже использован для другого запроса.' :
            'Повторный запрос не отправлен: предыдущая попытка могла уже выполниться. Проверьте результат и при необходимости повторите действие вручную.',
          c.headers);
      }
      const msg = quota.category ? (purpose === 'notes' ? 'На сегодня лимит подготовки конспектов исчерпан. Продолжите завтра.' : 'На сегодня лимит вопросов исчерпан. Продолжите завтра.') : LIMIT_TEXT;
      return fail(429, 'daily_limit', msg, c.headers);
    }

    const failedBeforeAnswer = async (response) => {
      // Only explicit upstream rejections are safe to release automatically.
      // A fetch exception or interrupted 200/stream is ambiguous: retain dedup.
      if (requestId && quota.token) {
        try {
          const released = await releaseRequest(env, device, ip, requestId, fingerprint, quota.token, reservationDay);
          if (!released) console.warn('Could not match request reservation for release');
        } catch (e) { console.warn('Failed to release request reservation', e); }
      }
      return response;
    };
    const maxTokens = boundedTokens(opt(env, 'MAX_TOKENS', 16000), MAX_ALLOWED_TOKENS);
    const requestedTokens = boundedTokens(body.max_tokens, maxTokens);
    const tokenBudget = Math.min(requestedTokens, maxTokens);
    // Вопросы сначала отправляем в Cloudflare. Для изображений viaAI возвращает null.
    const backup = () => viaAI(env, body, tokenBudget, c.headers);
    if (body.kd_purpose === 'question') {
      const answer = await backup();
      if (answer) return answer;
    }

    if (!env.OPENROUTER_KEY) return (await backup()) || failedBeforeAnswer(fail(503, 'unavailable', DOWN_TEXT, c.headers));

    let list;
    try { list = await models(env); } catch { list = []; }
    // Платные модели разрешены только через отдельный проверенный ключ и явный маршрут.
    if (isOpenRouter(env)) list = list.filter((id) => id.endsWith(':free'));
    const paid = body.kd_purpose === 'notes' && await paidKeyReady(env);
    if (paid) list = ['google/gemini-2.5-flash-lite', ...list].slice(0, 3);
    if (!list.length) return (await backup()) || failedBeforeAnswer(fail(503, 'unavailable', DOWN_TEXT, c.headers, modelsError || 'models-empty'));
    const out = {
      model: list[0],
      messages: body.messages,
      temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
      max_tokens: tokenBudget,
      stream: body.stream === true,
    };
    const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (paid ? env.OPENROUTER_PAID_KEY : env.OPENROUTER_KEY) };
    if (isOpenRouter(env)) {
      if (list.length > 1) out.models = list.slice(0, 3); // запасные модели, если основная занята
      if (paid) out.provider = { max_price: { prompt: 0.15, completion: 0.60 } };
      out.reasoning = { effort: 'low', exclude: true }; // если модель «думающая» — думать поменьше и рассуждения не присылать
      headers['HTTP-Referer'] = opt(env, 'APP_URL', 'https://stairrax.github.io/helper-with-conspects/');
      headers['X-Title'] = 'Konspekt Diktor';
    }

    let up;
    try {
      // Only wait for response headers here. Keeping a deadline active after
      // headers would prematurely interrupt legitimate long-running SSE output.
      up = await withDeadline(timeoutMs(env, 'UPSTREAM_HEADERS_TIMEOUT_MS', 90000), signal =>
        fetch(upstream(env) + '/chat/completions', { method: 'POST', headers, body: JSON.stringify(out), signal }));
    } catch {
      return (await backup()) || fail(502, 'upstream', 'Сервер нейросети не отвечает. Попробуйте ещё раз.', c.headers, 'upstream-unreachable');
    }
    // кончились деньги или лимит на ключе, ключ отозван — это забота владельца сервера, а не пользователя
    if ([401, 402, 403].includes(up.status)) return (await backup()) || failedBeforeAnswer(fail(503, 'unavailable', DOWN_TEXT, c.headers, 'upstream-' + up.status));
    // у бесплатных моделей дневной лимит на весь ключ — когда он кончился, повторять бессмысленно
    if (up.status === 429) {
      const text = await up.text();
      if (/per-day|daily/i.test(text)) return (await backup()) || failedBeforeAnswer(fail(429, 'daily_limit', LIMIT_TEXT, c.headers));
      return failedBeforeAnswer(new Response(text, { status: 429, headers: { ...c.headers, 'Content-Type': 'application/json', 'Retry-After': up.headers.get('Retry-After') || '20' } }));
    }
    // сбой на стороне нейросети — пробуем запасную
    if (up.status >= 500) { const alt = await backup(); if (alt) return alt; }
    // Explicitly rejected upstream requests free the logical request and its quota.
    // A successful response remains reserved, including while a stream is in flight.
    if (up.status >= 400) {
      await failedBeforeAnswer(null);
    }
    // ответ (и потоковый тоже) отдаём как есть
    return new Response(up.body, {
      status: up.status,
      headers: { ...c.headers, 'Content-Type': up.headers.get('Content-Type') || 'application/json', 'Cache-Control': 'no-store' },
    });
  },
};
