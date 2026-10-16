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
// Качество звука: wav — без сжатия (лучше всего в наушниках), mp3 — сжатый, ogg — Opus, сильно сжатый.
const FORMATS = { wav: 'lpcm', mp3: 'mp3', ogg: 'oggopus' };
const MAX_WAV = 2.5 * 1024 * 1024; // ответ функции ограничен по размеру — длинную фразу отдаём в MP3

// Фильтр нижних частот для перехода 48 → 24 кГц (речь до ~10 кГц сохраняется целиком, файл вдвое меньше).
const TAPS = (() => {
  const n = 31, fc = 10500 / 48000, h = [];
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const x = i - (n - 1) / 2;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (n - 1));
    h.push(sinc * w);
    sum += sinc * w;
  }
  return h.map((v) => v / sum);
})();

/** PCM 16 бит 48 кГц (lpcm от SpeechKit) -> WAV 24 кГц. */
function wav24k(pcm) {
  const n = Math.floor(pcm.length / 2);
  const src = new Int16Array(n);
  for (let i = 0; i < n; i++) src[i] = pcm.readInt16LE(i * 2);
  const out = Math.floor(n / 2), rate = 24000, half = (TAPS.length - 1) / 2;
  const b = Buffer.alloc(44 + out * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + out * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(out * 2, 40);
  for (let j = 0; j < out; j++) {
    let acc = 0;
    for (let k = 0; k < TAPS.length; k++) {
      const idx = j * 2 + k - half;
      if (idx >= 0 && idx < n) acc += TAPS[k] * src[idx];
    }
    b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(acc))), 44 + j * 2);
  }
  return b;
}

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

  const speed = Math.min(3, Math.max(0.1, Number(req.speed) || 1));
  const synth = async (fmt) => {
    const form = new URLSearchParams({ text, lang: 'ru-RU', voice, speed: String(speed), format: FORMATS[fmt] });
    if (fmt === 'wav') form.set('sampleRateHertz', '48000');
    if (!apiKey && process.env.FOLDER_ID) form.set('folderId', process.env.FOLDER_ID);
    const res = await fetch(TTS_URL, {
      method: 'POST',
      headers: { Authorization: apiKey ? `Api-Key ${apiKey}` : `Bearer ${iam}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    if (!res.ok) return { error: reply(res.status, { message: (await res.text()).slice(0, 500) }) };
    return { audio: Buffer.from(await res.arrayBuffer()) };
  };

  let fmt = FORMATS[req.format] ? req.format : 'ogg';
  let r = await synth(fmt);
  if (r.error) return r.error;
  let audio = r.audio;
  if (fmt === 'wav') {
    audio = wav24k(audio);
    if (audio.length > MAX_WAV) {
      fmt = 'mp3';
      r = await synth(fmt);
      if (r.error) return r.error;
      audio = r.audio;
    }
  }
  const type = { wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg' }[fmt];
  return {
    statusCode: 200,
    headers: { ...CORS, 'Content-Type': type, 'Cache-Control': 'no-store' },
    body: audio.toString('base64'),
    isBase64Encoded: true,
  };
};
