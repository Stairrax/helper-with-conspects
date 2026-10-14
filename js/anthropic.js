// Клиент Anthropic Messages API (Claude) прямо из браузера: повторы, лимиты, отказы, потоковые ответы.
// Без SDK: приложение работает без сборки, поэтому запросы идут через fetch.
// Принимает части в формате Gemini ({text} / {inline_data}) и сам переводит их в блоки content.

import { GeminiError as AIError } from './gemini.js';

const API_VERSION = '2023-06-01';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const trimBase = (u) => String(u || '').trim().replace(/\/+$/, '') || 'https://api.anthropic.com/v1';

function waitOnline() {
  if (navigator.onLine !== false) return Promise.resolve();
  return new Promise((r) => window.addEventListener('online', () => r(), { once: true }));
}

// Модели пятого поколения: усилие задаётся через output_config.effort, temperature не принимается.
const isGen5 = (m) => /^claude-(opus|sonnet|haiku|fable|mythos)-5/.test(m);
// Серверный откат при отказе фильтров безопасности (fallbacks: "default").
const supportsFallback = (m) => /^claude-(opus-5|sonnet-5-5|fable-5-1)/.test(m);

function headers(apiKey, model) {
  const h = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': API_VERSION,
    // разрешает прямые запросы из браузера (CORS); ключ хранится только у пользователя
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  if (supportsFallback(model)) h['anthropic-beta'] = FALLBACK_BETA;
  return h;
}

function toContent(parts) {
  return parts.map((p) => (p.inline_data
    ? { type: 'image', source: { type: 'base64', media_type: p.inline_data.mime_type, data: p.inline_data.data } }
    : { type: 'text', text: p.text || '' }));
}

/** effort: 'low' для быстрых ответов на вопросы, 'medium' для анализа. */
function buildBody({ system, parts, model, temperature, effort = 'medium' }, streamMode) {
  const m = String(model || '').trim();
  const body = {
    model: m,
    max_tokens: streamMode ? 32000 : 16000,
    messages: [{ role: 'user', content: toContent(parts) }],
  };
  if (system) body.system = system;
  if (isGen5(m)) body.output_config = { effort };
  else if (temperature !== undefined) body.temperature = temperature;
  if (supportsFallback(m)) body.fallbacks = 'default';
  if (streamMode) body.stream = true;
  return body;
}

function humanError(status, data) {
  const msg = data?.error?.message || '';
  if (status === 401) return 'Неверный ключ Anthropic API (401). Проверьте ключ в настройках.';
  if (status === 403) return 'Доступ запрещён (403). Anthropic API недоступен из вашей страны или для этого ключа. ' + msg;
  if (status === 404) return 'Модель не найдена (404). Выберите другую модель в настройках. ' + msg;
  if (status === 413) return 'Запрос слишком большой (413). ' + msg;
  if (status === 429) return 'Превышен лимит запросов Anthropic (429). ' + msg;
  if (status === 529) return 'Серверы Claude перегружены (529).';
  if (status >= 500) return `Сервер Anthropic временно недоступен (${status}).`;
  if (/credit balance/i.test(msg)) return 'На счёте Anthropic API нет средств. Пополните баланс в console.anthropic.com. ' + msg;
  return `Ошибка Anthropic ${status}: ${msg}`;
}

function retryAfter(res) {
  const s = parseFloat(res?.headers.get('retry-after'));
  return isNaN(s) ? 0 : s * 1000;
}

function extract(data) {
  if (data.stop_reason === 'refusal') {
    throw new AIError('Claude отказался обработать этот запрос (сработал фильтр безопасности). Попробуйте переформулировать.', { code: 'REFUSAL' });
  }
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { text, finish: data.stop_reason || '' };
}

export async function generate(opts) {
  const { apiKey, model, baseUrl, onStatus = () => {}, retries = 5, signal } = opts;
  if (!apiKey) throw new AIError('Не задан ключ Anthropic API (Настройки).', { code: 'NO_KEY' });
  const body = JSON.stringify(buildBody(opts, false));
  let attempt = 0;
  for (;;) {
    attempt++;
    let res, data;
    try {
      await waitOnline();
      res = await fetch(`${trimBase(baseUrl)}/messages`, { method: 'POST', headers: headers(apiKey, model), body, signal });
      data = await res.json().catch(() => ({}));
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      if (attempt > retries) throw new AIError('Нет связи с Anthropic API. Проверьте интернет.', { code: 'NETWORK', retryable: true });
      const wait = Math.min(2000 * 2 ** (attempt - 1), 30000);
      onStatus(`Нет сети, повтор через ${Math.round(wait / 1000)} с…`);
      await sleep(wait);
      continue;
    }
    if (res.ok) {
      const { text, finish } = extract(data);
      if (finish === 'max_tokens') throw new AIError('Ответ обрезан по длине', { code: 'MAX_TOKENS' });
      if (text) return text;
      if (attempt > retries) throw new AIError('Пустой ответ Claude', { code: 'EMPTY' });
      onStatus('Пустой ответ, повторяю…');
      await sleep(1500);
      continue;
    }
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt > retries) throw new AIError(humanError(res.status, data), { status: res.status, retryable });
    let wait = res.status === 429 ? retryAfter(res) || 15000 * attempt : 2000 * 2 ** (attempt - 1);
    wait = Math.min(wait + 500, 65000);
    onStatus(res.status === 429 ? `Лимит запросов Claude, жду ${Math.round(wait / 1000)} с…` : `Claude недоступен (${res.status}), повтор через ${Math.round(wait / 1000)} с…`);
    await sleep(wait);
  }
}

export async function stream(opts) {
  const { apiKey, model, baseUrl, onText, signal, onStatus = () => {} } = opts;
  if (!apiKey) throw new AIError('Не задан ключ Anthropic API (Настройки).', { code: 'NO_KEY' });
  let got = false;
  try {
    await waitOnline();
    const res = await fetch(`${trimBase(baseUrl)}/messages`, {
      method: 'POST', headers: headers(apiKey, model), body: JSON.stringify(buildBody(opts, true)), signal,
    });
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => ({}));
      throw new AIError(humanError(res.status, data), { status: res.status, retryable: res.status === 429 || res.status >= 500 });
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
        if (!line.startsWith('data:')) continue;
        let ev;
        try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
          got = true;
          onText(ev.delta.text);
        } else if (ev.type === 'message_delta' && ev.delta?.stop_reason === 'refusal' && !got) {
          throw new AIError('Claude отказался отвечать на этот вопрос. Попробуйте переформулировать.', { code: 'REFUSAL' });
        } else if (ev.type === 'error') {
          const t = ev.error?.type;
          throw new AIError('Ошибка Claude: ' + (ev.error?.message || t), { retryable: t === 'overloaded_error' || t === 'api_error' });
        }
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
  const res = await fetch(`${trimBase(baseUrl)}/models?limit=100`, { headers: headers(apiKey, '') });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new AIError(humanError(res.status, data), { status: res.status });
  return (data.data || []).map((m) => m.id);
}
