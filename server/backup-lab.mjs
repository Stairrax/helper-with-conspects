// Experimental localhost-only backup API for the study-notes app.
// This is NOT a production deployment: no public interface, billable API or API keys.
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const HOST = '127.0.0.1';
const MAX_BODY = 256 * 1024;
const MAX_OLLAMA_LINE = 64 * 1024;
const DEFAULT_PORT = 4174;
const PER_DEVICE_LIMIT = 10;
const TOTAL_LIMIT = 30;
const corsOrigin = origin => /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d{1,5})?$/.test(origin);
const errorBody = (code, message) => ({ error: { code, message, proxy: true, reason: 'local-lab' } });
const jsonHeaders = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const sseHeaders = { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function sendJson(res, status, data) {
  if (res.destroyed || res.headersSent) return;
  res.writeHead(status, jsonHeaders);
  res.end(JSON.stringify(data));
}
function sseText(text, model) {
  return 'data: ' + JSON.stringify({
    id: 'local-backup-lab', object: 'chat.completion.chunk', model,
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  }) + '\n\n';
}
function sseDone(model) {
  return 'data: ' + JSON.stringify({
    id: 'local-backup-lab', object: 'chat.completion.chunk', model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  }) + '\n\ndata: [DONE]\n\n';
}
function replyJson(text, model) {
  return {
    id: 'local-backup-lab', object: 'chat.completion', model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
  };
}
function validTextMessages(messages) {
  return Array.isArray(messages) && messages.length >= 1 && messages.length <= 32 &&
    messages.every(m => m && ['system', 'user', 'assistant'].includes(m.role) && typeof m.content === 'string');
}
async function readJson(req) {
  const parts = [];
  let bytes = 0;
  for await (const part of req) {
    bytes += part.length;
    if (bytes > MAX_BODY) {
      const error = new Error('Запрос больше 256 КиБ. Для фото нужна отдельная реализация.');
      error.status = 413;
      throw error;
    }
    parts.push(part);
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch {
    const error = new Error('Неверный JSON.');
    error.status = 400;
    throw error;
  }
}

async function simulatedAnswer(res, stream, model) {
  const pieces = [
    '[ТЕСТОВЫЙ ОТВЕТ — НЕ НЕЙРОСЕТЬ] ',
    'Локальный резервный сервер принимает запросы Диктора конспектов. ',
    'Настоящие конспекты здесь не создаются, деньги и API-ключи не используются.',
  ];
  if (!stream) return sendJson(res, 200, replyJson(pieces.join(''), model));
  res.writeHead(200, sseHeaders);
  for (const piece of pieces) {
    if (res.destroyed) return;
    res.write(sseText(piece, model));
    await sleep(60);
  }
  if (!res.destroyed) res.end(sseDone(model));
}

async function ollamaAnswer(res, body, model, maxOutputTokens = 512) {
  // Hardcoded loopback endpoint: a user cannot make this server proxy arbitrary URLs.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);
  const close = () => { if (!res.writableEnded) controller.abort(); };
  res.once('close', close);
  try {
    const response = await fetch('http://127.0.0.1:11434/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model, stream: body.stream === true, messages: body.messages,
        options: { num_predict: Math.min(Number.isSafeInteger(body.max_tokens) && body.max_tokens > 0 ? body.max_tokens : maxOutputTokens, maxOutputTokens) },
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return sendJson(res, 502, errorBody('upstream', 'Ollama недоступна или модель не найдена.'));
    }
    if (body.stream !== true) {
      const data = await response.json();
      return sendJson(res, 200, replyJson(String(data.message?.content || ''), model));
    }
    if (!response.body) throw new Error('Ollama не вернула поток');
    res.writeHead(200, sseHeaders);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    let completed = false;
    try {
      while (!completed && !controller.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        if (pending.length > MAX_OLLAMA_LINE) throw new Error('Слишком длинное событие Ollama');
        let at;
        while ((at = pending.indexOf('\n')) >= 0 && !completed) {
          const line = pending.slice(0, at).trim();
          pending = pending.slice(at + 1);
          if (!line) continue;
          const event = JSON.parse(line);
          if (event.error) throw new Error('Ollama сообщила об ошибке');
          if (typeof event.message?.content === 'string' && event.message.content) {
            res.write(sseText(event.message.content, model));
          }
          if (event.done === true) completed = true;
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    if (!res.destroyed) {
      if (completed) res.end(sseDone(model));
      else res.destroy(); // Never pretend that a truncated AI generation succeeded.
    }
  } catch {
    if (!res.headersSent) sendJson(res, 503, errorBody('unavailable', 'Нет ответа локальной Ollama. Проверьте, что она запущена.'));
    else if (!res.destroyed) res.destroy();
  } finally {
    clearTimeout(timeout);
    res.off('close', close);
    controller.abort();
  }
}

/** Start an isolated loopback API. Nothing gets deployed or sent to a cloud. */
export async function startBackupLab({ port = DEFAULT_PORT, mode = 'mock', model = 'qwen2.5:0.5b', maxOutputTokens = 512, perDeviceLimit = PER_DEVICE_LIMIT, totalLimit = TOTAL_LIMIT } = {}) {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new RangeError('Invalid port');
  if (!['mock', 'ollama'].includes(mode)) throw new Error('BACKUP_LAB_MODE must be mock or ollama');
  if (typeof model !== 'string' || !model || model.length > 100) throw new Error('Invalid model name');
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 64 || maxOutputTokens > 2048) throw new RangeError('Invalid maxOutputTokens');
  if (!Number.isSafeInteger(perDeviceLimit) || perDeviceLimit < 1 || perDeviceLimit > 30) throw new RangeError('Invalid perDeviceLimit');
  if (!Number.isSafeInteger(totalLimit) || totalLimit < perDeviceLimit || totalLimit > 60) throw new RangeError('Invalid totalLimit');
  const devices = new Map();
  let acceptedRequests = 0;
  const server = createServer(async (req, res) => {
    res.setHeader('cache-control', 'no-store');
    const origin = req.headers.origin;
    // Explicitly deny the production site and any unrelated browser site.
    if (origin && !corsOrigin(origin)) return sendJson(res, 403, errorBody('origin', 'Только локальное тестирование.'));
    if (origin) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'Origin');
      res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
      res.setHeader('access-control-allow-headers', 'Content-Type, Authorization');
    }
    const path = new URL(req.url, 'http://127.0.0.1').pathname.replace(/^\/v1(?=\/)/, '');
    if (req.method === 'OPTIONS') {
      res.writeHead(origin ? 204 : 403).end();
      return;
    }
    if (req.method === 'GET' && path === '/') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('ok (local test only)');
    }
    if (req.method === 'GET' && path === '/health') {
      return sendJson(res, 200, { ok: true, localOnly: true, mode, requestsAccepted: acceptedRequests, cloudCostUsd: 0 });
    }
    if (req.method === 'GET' && path === '/models') {
      return sendJson(res, 200, { object: 'list', data: [{ id: 'auto', object: 'model' }] });
    }
    if (req.method !== 'POST' || path !== '/chat/completions') {
      return sendJson(res, 404, errorBody('not_found', 'Неизвестный адрес.'));
    }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
      return sendJson(res, 415, errorBody('invalid_type', 'Ожидается application/json.'));
    }
    let body;
    try { body = await readJson(req); }
    catch (error) { return sendJson(res, error.status || 400, errorBody('bad_request', error.message)); }
    if (!validTextMessages(body?.messages)) {
      return sendJson(res, 422, errorBody('text_only', 'Тестовый сервер принимает только текстовые сообщения (без фотографий).'));
    }
    // Strict limits for a demo, not a production rate-limiter or authorization.
    const device = (req.headers.authorization || 'no-device').slice(0, 80);
    const count = devices.get(device) || 0;
    if (acceptedRequests >= totalLimit || count >= perDeviceLimit) {
      return sendJson(res, 429, errorBody('daily_limit', 'Локальный тестовый лимит исчерпан. Перезапустите сервер.'));
    }
    acceptedRequests++;
    devices.set(device, count + 1);
    try {
      if (mode === 'mock') await simulatedAnswer(res, body.stream === true, 'backup-lab-mock');
      else await ollamaAnswer(res, body, model, maxOutputTokens);
    } catch {
      if (!res.headersSent) sendJson(res, 500, errorBody('internal', 'Ошибка тестового сервера.'));
      else if (!res.destroyed) res.destroy();
    }
  });

  await new Promise((resolve, reject) => {
    const onError = error => reject(error);
    server.once('error', onError);
    server.listen(port, HOST, () => { server.off('error', onError); resolve(); });
  });
  return { server, url: 'http://' + HOST + ':' + server.address().port, mode };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.BACKUP_LAB_PORT || DEFAULT_PORT);
  const mode = process.env.BACKUP_LAB_MODE || 'mock';
  const model = process.env.MODEL_NAME || 'qwen2.5:0.5b';
  startBackupLab({ port, mode, model }).then(({ url }) => {
    console.log('Local backup API: ' + url);
    console.log('Mode: ' + mode + ' (no Google Cloud / Cloudflare / OpenRouter calls)');
    console.log('Press Ctrl+C to stop. This server is bound to 127.0.0.1 only.');
  }).catch(error => {
    console.error('Could not start backup lab: ' + error.message);
    process.exitCode = 1;
  });
}
