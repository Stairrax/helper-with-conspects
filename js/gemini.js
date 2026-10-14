// Клиент Gemini API (REST, без SDK): повторы, лимиты, JSON, потоковые ответы.

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

export class GeminiError extends Error {
  constructor(message, { status = 0, code = '', retryable = false } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function modelPath(model) {
  return 'models/' + String(model || '').trim().replace(/^models\//, '');
}

function waitOnline() {
  if (navigator.onLine !== false) return Promise.resolve();
  return new Promise((r) => window.addEventListener('online', () => r(), { once: true }));
}

function parseRetryDelay(err) {
  const details = err?.error?.details || [];
  for (const d of details) {
    if (String(d['@type'] || '').endsWith('RetryInfo') && d.retryDelay) {
      const s = parseFloat(d.retryDelay);
      if (!isNaN(s)) return s * 1000;
    }
  }
  return 0;
}

function humanError(status, body) {
  const msg = body?.error?.message || '';
  if (status === 400 && /API key/i.test(msg)) return 'Неверный ключ Gemini API. Проверьте его в настройках.';
  if (status === 403) return 'Доступ запрещён (403): ключ недействителен или API не включён. ' + msg;
  if (status === 404) return 'Модель не найдена (404). Выберите другую модель в настройках. ' + msg;
  if (status === 429) return 'Превышен лимит запросов Gemini (429). ' + msg;
  if (status >= 500) return `Сервер Gemini временно недоступен (${status}).`;
  return `Ошибка Gemini ${status}: ${msg}`;
}

function buildBody({ system, parts, json, temperature, maxOutputTokens }) {
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature },
  };
  if (json) body.generationConfig.responseMimeType = 'application/json';
  if (maxOutputTokens) body.generationConfig.maxOutputTokens = maxOutputTokens;
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  return body;
}

function extractText(data) {
  const cand = data?.candidates?.[0];
  if (!cand) {
    const block = data?.promptFeedback?.blockReason;
    if (block) throw new GeminiError('Запрос заблокирован фильтром Gemini: ' + block, { code: 'BLOCKED' });
    return { text: '', finish: '' };
  }
  const text = (cand.content?.parts || []).filter((p) => !p.thought && p.text).map((p) => p.text).join('');
  return { text, finish: cand.finishReason || '' };
}

/**
 * Одиночный запрос с повторами.
 * opts: apiKey, model, system, parts, json, temperature, maxOutputTokens, onStatus, retries, signal
 */
export async function generate(opts) {
  const { apiKey, model, onStatus = () => {}, retries = 5, signal } = opts;
  if (!apiKey) throw new GeminiError('Не задан ключ Gemini API (Настройки).', { code: 'NO_KEY' });
  const body = JSON.stringify(buildBody({ temperature: 0.3, ...opts }));
  let attempt = 0;
  for (;;) {
    attempt++;
    let res, data;
    try {
      await waitOnline();
      res = await fetch(`${BASE}/${modelPath(model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body,
        signal,
      });
      data = await res.json().catch(() => ({}));
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      if (attempt > retries) throw new GeminiError('Нет связи с Gemini. Проверьте интернет.', { code: 'NETWORK', retryable: true });
      const wait = Math.min(2000 * 2 ** (attempt - 1), 30000);
      onStatus(`Нет сети, повтор через ${Math.round(wait / 1000)} с…`);
      await sleep(wait);
      continue;
    }
    if (res.ok) {
      const { text, finish } = extractText(data);
      if (finish === 'MAX_TOKENS') throw new GeminiError('Ответ обрезан по длине', { code: 'MAX_TOKENS' });
      if (!text) {
        if (attempt > retries) throw new GeminiError('Пустой ответ Gemini' + (finish ? ` (${finish})` : ''), { code: 'EMPTY' });
        onStatus('Пустой ответ, повторяю…');
        await sleep(1500);
        continue;
      }
      return text;
    }
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt > retries) {
      throw new GeminiError(humanError(res.status, data), { status: res.status, retryable });
    }
    let wait = res.status === 429 ? parseRetryDelay(data) || 15000 * attempt : 2000 * 2 ** (attempt - 1);
    wait = Math.min(wait + 500, 65000);
    onStatus(res.status === 429
      ? `Лимит запросов Gemini, жду ${Math.round(wait / 1000)} с…`
      : `Gemini недоступен (${res.status}), повтор через ${Math.round(wait / 1000)} с…`);
    await sleep(wait);
  }
}

export function parseJSON(text) {
  let t = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(t); } catch { /* попробуем вырезать объект */ }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
  throw new Error('bad json');
}

/** Запрос, ожидающий JSON. При битом JSON — повтор. */
export async function generateJSON(opts) {
  let lastErr;
  for (let i = 0; i < 3; i++) {
    const text = await generate({ ...opts, json: true });
    try { return parseJSON(text); } catch (e) {
      lastErr = e;
      (opts.onStatus || (() => {}))('Ответ не разобран, повторяю запрос…');
    }
  }
  throw new GeminiError('Gemini вернул некорректный JSON', { code: 'BAD_JSON', cause: lastErr });
}

/**
 * Потоковый ответ (SSE). onText(delta) вызывается по мере поступления.
 * Если поток не удался до первого текста — откат на обычный запрос.
 */
export async function stream(opts) {
  const { apiKey, model, onText, signal, onStatus = () => {} } = opts;
  if (!apiKey) throw new GeminiError('Не задан ключ Gemini API (Настройки).', { code: 'NO_KEY' });
  let got = false;
  try {
    await waitOnline();
    const res = await fetch(`${BASE}/${modelPath(model)}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(buildBody({ temperature: 0.4, ...opts })),
      signal,
    });
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => ({}));
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable) throw new GeminiError(humanError(res.status, data), { status: res.status });
      throw new GeminiError('stream failed', { status: res.status, retryable: true });
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
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const { text } = extractText(JSON.parse(payload));
          if (text) { got = true; onText(text); }
        } catch (e) {
          if (e instanceof GeminiError) throw e;
        }
      }
    }
    if (!got) throw new GeminiError('empty stream', { retryable: true });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    if (got) return; // часть ответа уже есть — не дублируем
    if (e instanceof GeminiError && !e.retryable) throw e;
    onStatus('Повторяю запрос…');
    const text = await generate({ ...opts, retries: 3 });
    onText(text);
  }
}

/** Список моделей, поддерживающих generateContent. */
export async function listModels(apiKey) {
  const res = await fetch(`${BASE}/models?pageSize=200`, { headers: { 'x-goog-api-key': apiKey } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new GeminiError(humanError(res.status, data), { status: res.status });
  return (data.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''));
}
