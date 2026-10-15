// Посредник Яндекс SpeechKit для приложения «Диктор конспектов» (Yandex Cloud Functions, Node.js 18+).
// SpeechKit не принимает запросы прямо из браузера, поэтому приложение обращается сюда,
// а функция синтезирует речь и возвращает звук.
//
// Авторизация (любой вариант):
//  1) к функции привязан сервисный аккаунт с ролью ai.speechkit-tts.user — ключ не нужен;
//  2) переменная окружения YANDEX_API_KEY с API-ключом сервисного аккаунта;
//  3) ключ в заголовке X-Api-Key от приложения.

const TTS_URL = 'https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize';
const VOICES = ['alena', 'jane', 'omazh', 'filipp', 'ermil', 'madirus', 'zahar'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Api-Key',
  'Access-Control-Max-Age': '86400',
};

const reply = (statusCode, body, extra = {}) => ({
  statusCode,
  headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', ...extra },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

const header = (event, name) => {
  const h = event.headers || {};
  const key = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? h[key] : '';
};

module.exports.handler = async function (event, context) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { message: 'Нужен POST' });

  let req;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body || '{}';
    req = JSON.parse(raw);
  } catch {
    return reply(400, { message: 'Некорректный JSON' });
  }
  const text = String(req.text || '').trim();
  if (!text) return reply(400, { message: 'Пустой текст' });
  if (text.length > 4900) return reply(400, { message: 'Слишком длинный текст' });
  const voice = VOICES.includes(req.voice) ? req.voice : 'alena';

  const apiKey = header(event, 'X-Api-Key') || process.env.YANDEX_API_KEY || '';
  const iam = context?.token?.access_token || '';
  if (!apiKey && !iam) return reply(401, { message: 'Нет доступа: привяжите к функции сервисный аккаунт с ролью ai.speechkit-tts.user' });

  const form = new URLSearchParams({ text, lang: 'ru-RU', voice, format: 'oggopus' });
  if (!apiKey && process.env.FOLDER_ID) form.set('folderId', process.env.FOLDER_ID);
  const res = await fetch(TTS_URL, {
    method: 'POST',
    headers: { Authorization: apiKey ? `Api-Key ${apiKey}` : `Bearer ${iam}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  if (!res.ok) return reply(res.status, { message: (await res.text()).slice(0, 500) });
  const audio = Buffer.from(await res.arrayBuffer());
  return {
    statusCode: 200,
    headers: { ...CORS, 'Content-Type': 'audio/ogg', 'Cache-Control': 'no-store' },
    body: audio.toString('base64'),
    isBase64Encoded: true,
  };
};
