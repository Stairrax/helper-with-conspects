// Клиент OpenAI-совместимых API (OpenRouter, DeepSeek, Mistral, свой адрес): повторы, лимиты, потоковые ответы.
// Принимает части в формате Gemini ({text} / {inline_data}) и сам переводит их в сообщения chat/completions.

import { GeminiError as AIError } from './gemini.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitOnline() {
  if (navigator.onLine !== false) return Promise.resolve();
  return new Promise((r) => window.addEventListener('online', () => r(), { once: true }));
}

const trimBase = (u) => String(u || '').trim().replace(/\/+$/, '');

function headers(apiKey, baseUrl) {
  const h = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey };
  // необязательные заголовки атрибуции OpenRouter; другим API их не шлём, чтобы не сломать CORS
  if (/openrouter\.ai/.test(baseUrl)) { h['HTTP-Referer'] = location.origin; h['X-Title'] = 'Konspekt Diktor'; }
  return h;
}

function toMessages(system, parts) {
  const content = parts.map((p) => (p.inline_data
    ? { type: 'image_url', image_url: { url: `data:${p.inline_data.mime_type};base64,${p.inline_data.data}` } }
    : { type: 'text', text: p.text || '' }));
  const onlyText = content.every((c) => c.type === 'text');
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: onlyText ? content.map((c) => c.text).join('\n') : content });
  return messages;
}

function buildBody({ system, parts, temperature, maxOutputTokens, model, fallbacks }, streamMode) {
  const body = { model: String(model || '').trim(), messages: toMessages(system, parts), temperature };
  // OpenRouter: если основная модель перегружена или недоступна, запрос уйдёт на запасную
  const extra = (fallbacks || []).filter((m) => m && m !== body.model);
  if (extra.length) body.models = [body.model, ...extra].slice(0, 3);
  if (maxOutputTokens) body.max_tokens = maxOutputTokens;
  if (streamMode) body.stream = true;
  return body;
}

function errMessage(body) {
  const e = body?.error;
  if (!e) return '';
  const raw = e.metadata?.raw ? ` (${String(e.metadata.raw).slice(0, 200)})` : '';
  return (typeof e === 'string' ? e : e.message || JSON.stringify(e)) + raw;
}

const isDailyLimit = (body) => /per-day|free-models-per-day|daily/i.test(errMessage(body));

function humanError(status, body) {
  const msg = errMessage(body);
  if (status === 401) return 'Неверный API-ключ (401). Проверьте ключ в настройках.';
  if (status === 402) return 'Недостаточно средств на счёте провайдера (402). Выберите бесплатную модель (с «:free» на конце) или пополните баланс.';
  if (status === 403) return 'Доступ запрещён (403): ' + msg;
  if (status === 404) return 'Модель не найдена (404). Выберите другую модель в настройках. ' + msg;
  if (isDailyLimit(body)) return 'На сегодня бесплатные запросы OpenRouter закончились (лимит в день). Продолжите завтра или пополните баланс OpenRouter — тогда лимит станет намного больше.';
  if (status === 429) return 'Превышен лимит запросов (429). ' + msg;
  if (status >= 500) return `Сервер провайдера временно недоступен (${status}).`;
  if (/image|vision|multimodal/i.test(msg)) return 'Эта модель не принимает изображения. Для фото страниц выберите модель с поддержкой картинок. ' + msg;
  return `Ошибка API ${status}: ${msg}`;
}

function retryAfter(res) {
  const h = res.headers.get('retry-after');
  const s = parseFloat(h);
  return isNaN(s) ? 0 : s * 1000;
}

function extract(data) {
  const ch = data?.choices?.[0];
  if (!ch) {
    if (data?.error) throw new AIError(humanError(data.error.code || 0, data), { status: +data.error.code || 0, retryable: +data.error.code === 429 || +data.error.code >= 500 });
    return { text: '', finish: '' };
  }
  let text = ch.message?.content ?? '';
  if (Array.isArray(text)) text = text.map((c) => c.text || '').join('');
  return { text: String(text || ''), finish: ch.finish_reason || '' };
}

export async function generate(opts) {
  const { apiKey, baseUrl, onStatus = () => {}, retries = 5, signal } = opts;
  if (!apiKey) throw new AIError('Не задан API-ключ (Настройки).', { code: 'NO_KEY' });
  if (!baseUrl) throw new AIError('Не задан адрес API (Настройки).', { code: 'NO_KEY' });
  const payload = buildBody({ temperature: 0.3, ...opts }, false);
  let body = JSON.stringify(payload);
  let attempt = 0;
  for (;;) {
    attempt++;
    let res, data;
    try {
      await waitOnline();
      res = await fetch(`${trimBase(baseUrl)}/chat/completions`, { method: 'POST', headers: headers(apiKey, baseUrl), body, signal });
      data = await res.json().catch(() => ({}));
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      if (attempt > retries) throw new AIError('Нет связи с API (сеть или CORS). Проверьте интернет и адрес API.', { code: 'NETWORK', retryable: true });
      const wait = Math.min(2000 * 2 ** (attempt - 1), 30000);
      onStatus(`Нет сети, повтор через ${Math.round(wait / 1000)} с…`);
      await sleep(wait);
      continue;
    }
    let err = null;
    if (res.ok) {
      try {
        const { text, finish } = extract(data);
        if (finish === 'length') throw new AIError('Ответ обрезан по длине', { code: 'MAX_TOKENS' });
        if (text) return text;
        err = new AIError('Пустой ответ модели', { code: 'EMPTY', retryable: true });
      } catch (e) {
        if (!(e instanceof AIError) || !e.retryable) throw e;
        err = e;
      }
    } else if (res.status === 400 && payload.models) {
      // сервис не принял список запасных моделей — повторяем без него
      delete payload.models;
      body = JSON.stringify(payload);
      attempt--;
      continue;
    } else {
      err = new AIError(humanError(res.status, data), { status: res.status, retryable: (res.status === 429 && !isDailyLimit(data)) || res.status >= 500 });
    }
    if (!err.retryable || attempt > retries) throw err;
    let wait = err.status === 429 ? retryAfter(res) || 15000 * attempt : 2000 * 2 ** (attempt - 1);
    wait = Math.min(wait + 500, 65000);
    onStatus(err.status === 429 ? `Лимит запросов, жду ${Math.round(wait / 1000)} с…` : `Повтор через ${Math.round(wait / 1000)} с…`);
    await sleep(wait);
  }
}

export async function stream(opts) {
  const { apiKey, baseUrl, onText, signal, onStatus = () => {} } = opts;
  if (!apiKey) throw new AIError('Не задан API-ключ (Настройки).', { code: 'NO_KEY' });
  let got = false;
  try {
    await waitOnline();
    const res = await fetch(`${trimBase(baseUrl)}/chat/completions`, {
      method: 'POST', headers: headers(apiKey, baseUrl), body: JSON.stringify(buildBody({ temperature: 0.4, ...opts }, true)), signal,
    });
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => ({}));
      const noFallbacks = res.status === 400 && (opts.fallbacks || []).length > 0; // повторим обычным запросом без них
      throw new AIError(humanError(res.status, data), { status: res.status, retryable: (res.status === 429 && !isDailyLimit(data)) || res.status >= 500 || noFallbacks });
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue; // в т.ч. служебные комментарии OpenRouter «: PROCESSING»
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let j;
        try { j = JSON.parse(payload); } catch { continue; }
        if (j.error) throw new AIError(humanError(+j.error.code || 0, j), { status: +j.error.code || 0 });
        const d = j.choices?.[0]?.delta?.content;
        if (d) { got = true; onText(d); }
      }
    }
    if (!got) throw new AIError('empty stream', { retryable: true });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    if (got) return;
    if (e instanceof AIError && !e.retryable) throw e;
    onStatus('Повторяю запрос…');
    onText(await generate({ ...opts, retries: 3 }));
  }
}

export async function listModels(apiKey, baseUrl) {
  const res = await fetch(`${trimBase(baseUrl)}/models`, { headers: { Authorization: 'Bearer ' + apiKey } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new AIError(humanError(res.status, data), { status: res.status });
  const list = (data.data || data.models || []).map((m) => m.id || m.name).filter(Boolean);
  // бесплатные модели OpenRouter — в начало списка
  return [...list.filter((m) => m.endsWith(':free')), ...list.filter((m) => !m.endsWith(':free'))];
}
