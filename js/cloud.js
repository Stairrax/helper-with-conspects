// Облачные голоса «как живой человек»: Яндекс SpeechKit, Gemini TTS, ElevenLabs.
// Озвученные куски сохраняются на телефоне (Cache Storage), повторное прослушивание бесплатно.

const CACHE = 'kd-tts';

export const CLOUD_PROVIDERS = {
  yandex: {
    name: 'Яндекс SpeechKit',
    voices: {
      alena: 'Алёна (женский, лучший)',
      jane: 'Джейн (женский)',
      omazh: 'Омаж (женский)',
      filipp: 'Филипп (мужской)',
      ermil: 'Ермил (мужской)',
      madirus: 'Мадирус (мужской, низкий)',
      zahar: 'Захар (мужской)',
    },
    voice: 'alena',
    persistent: true,
  },
  gemini: {
    name: 'Gemini TTS (Google)',
    voices: {
      Leda: 'Leda (молодой женский)',
      Aoede: 'Aoede (лёгкий женский)',
      Kore: 'Kore (уверенный женский)',
      Despina: 'Despina (мягкий женский)',
      Sulafat: 'Sulafat (тёплый женский)',
      Charon: 'Charon (спокойный мужской)',
      Iapetus: 'Iapetus (чёткий мужской)',
      Orus: 'Orus (твёрдый мужской)',
      Puck: 'Puck (бодрый мужской)',
    },
    voice: 'Leda',
    persistent: false, // несжатый звук — храним только в памяти
  },
  elevenlabs: {
    name: 'ElevenLabs',
    voices: {
      EXAVITQu4vr4xnSDxMaL: 'Sarah (молодой женский)',
      XrExE9yKIg1WjnnlVkGX: 'Matilda (тёплый женский)',
      pFZP5JQG7iQjIQuC4Bku: 'Lily (мягкий женский)',
      cgSgspJ2msm6clMCkdW9: 'Jessica (живой женский)',
      onwK4e9ZLuTAKqWW03F9: 'Daniel (спокойный мужской)',
      JBFqnCBsd6RMkjVDRZzb: 'George (тёплый мужской)',
      nPczCjzI2devNBz1zQrb: 'Brian (глубокий мужской)',
    },
    voice: 'EXAVITQu4vr4xnSDxMaL',
    model: 'eleven_multilingual_v2',
    persistent: true,
  },
};

export class CloudError extends Error {
  constructor(message, { status = 0, fatal = false } = {}) {
    super(message);
    this.status = status;
    this.fatal = fatal; // ключ/доступ — повторять бессмысленно
  }
}

// ---------- Кэш ----------

const memory = new Map(); // ключ -> Promise<Blob>

async function sha(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function cacheUrl(cfg, text) {
  return `https://tts.cache/${cfg.provider}/${encodeURIComponent(cfg.voice)}/${await sha(text)}`;
}

async function fromCache(cfg, text) {
  if (!CLOUD_PROVIDERS[cfg.provider]?.persistent) return null;
  try {
    const hit = await (await caches.open(CACHE)).match(await cacheUrl(cfg, text));
    return hit ? hit.blob() : null;
  } catch { return null; }
}

async function toCache(cfg, text, blob) {
  if (!CLOUD_PROVIDERS[cfg.provider]?.persistent) return;
  try { await (await caches.open(CACHE)).put(await cacheUrl(cfg, text), new Response(blob)); } catch { /* нет места */ }
}

export async function isCached(cfg, text) {
  return !!(await fromCache(cfg, text));
}

/** Сколько места занимает сохранённая озвучка (МБ). */
export async function cacheSizeMB() {
  try {
    const est = await navigator.storage?.estimate?.();
    return est?.usageDetails?.caches ? Math.round(est.usageDetails.caches / 1048576) : null;
  } catch { return null; }
}

export async function clearCache() {
  memory.clear();
  try { await caches.delete(CACHE); } catch { /* ignore */ }
}

// ---------- Сервисы ----------

/** fetch с понятной ошибкой, если до сервиса не достучаться (блокировка, нет интернета, CORS). */
async function net(provider, url, opts) {
  try {
    return await fetch(url, opts);
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new CloudError(provider === 'Яндекс'
      ? 'Яндекс: нет связи с функцией-посредником — проверьте интернет, адрес функции и что она публичная.'
      : `${provider}: нет связи с сервисом — скорее всего, он недоступен из вашей сети. Включите VPN или выберите Яндекс.`, { network: true });
  }
}

function httpError(provider, status, body) {
  const msg = typeof body === 'string' ? body.slice(0, 200) : body?.error?.message || body?.detail?.message || body?.message || '';
  const code = typeof body === 'object' ? body?.detail?.status || body?.error?.status || '' : '';
  // ElevenLabs: бесплатный доступ блокируется при VPN/прокси, кончился лимит, у ключа нет прав
  if (code === 'detected_unusual_activity') return new CloudError('ElevenLabs заблокировал бесплатный доступ: сервис видит VPN или прокси. Бесплатно через VPN он не работает — нужен платный тариф или другой сервис.', { status, fatal: true });
  if (code === 'quota_exceeded') return new CloudError('ElevenLabs: закончился бесплатный лимит на этот месяц.', { status, fatal: true });
  if (code === 'missing_permissions') return new CloudError('ElevenLabs: у ключа нет разрешения Text to Speech — создайте ключ заново и включите это разрешение.', { status, fatal: true });
  if (status === 401 || status === 403) return new CloudError(`${provider}: ключ не подходит или нет доступа (${status}). ${msg}`, { status, fatal: true });
  if (status === 402) return new CloudError(`${provider}: закончились средства или бесплатный лимит. ${msg}`, { status, fatal: true });
  if (status === 429) return new CloudError(`${provider}: превышен лимит запросов. ${msg}`, { status });
  if (status === 404) return new CloudError(`${provider}: не найдено (404) — проверьте адрес или голос. ${msg}`, { status, fatal: true });
  if (/location|region|country/i.test(msg)) return new CloudError(`${provider} недоступен из вашей страны — включите VPN. ${msg}`, { status, fatal: true });
  return new CloudError(`${provider}: ошибка ${status}. ${msg}`, { status });
}

async function readError(res) {
  const t = await res.text().catch(() => '');
  try { return JSON.parse(t); } catch { return t; }
}

/** PCM 16 бит → WAV (для Gemini). */
function pcmToWav(b64, rate) {
  const bin = atob(b64);
  const len = bin.length;
  const buf = new ArrayBuffer(44 + len);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + len, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, len, true);
  const out = new Uint8Array(buf, 44);
  for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
  return new Blob([buf], { type: 'audio/wav' });
}

async function yandex(cfg, text, signal) {
  if (!cfg.url) throw new CloudError('Яндекс ещё не настроен: нужна функция-посредник в Yandex Cloud — инструкция в «Как подключить» (Настройки → Голос).', { fatal: true });
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.key) headers['X-Api-Key'] = cfg.key;
  const res = await net('Яндекс', cfg.url, { method: 'POST', headers, body: JSON.stringify({ text, voice: cfg.voice }), signal });
  if (!res.ok) throw httpError('Яндекс', res.status, await readError(res));
  return res.blob();
}

// Модели синтеза речи Google меняются часто: пробуем по очереди и запоминаем ту, что ответила.
const GEMINI_TTS_MODELS = ['gemini-3.1-flash-tts-preview', 'gemini-3.8-flash-tts', 'gemini-2.5-flash-preview-tts'];
let geminiModel = (() => { try { return localStorage.getItem('kd.geminiTts') || ''; } catch { return ''; } })();

async function gemini(cfg, text, signal) {
  if (!cfg.key) throw new CloudError('Gemini: укажите ключ Google AI Studio (Настройки → Голос).', { fatal: true });
  const order = cfg.model ? [cfg.model] : [...new Set([geminiModel, ...GEMINI_TTS_MODELS].filter(Boolean))];
  let lastErr;
  for (const model of order) {
    try {
      const blob = await geminiOnce(model, cfg, text, signal);
      if (model !== geminiModel) { geminiModel = model; try { localStorage.setItem('kd.geminiTts', model); } catch { /* ignore */ } }
      return blob;
    } catch (e) {
      lastErr = e;
      // модели нет или для неё нет бесплатного лимита — пробуем следующую
      if (!e.tryNext) throw e;
    }
  }
  if (lastErr?.status === 429) {
    throw new CloudError('Gemini: для вашего ключа нет бесплатного лимита на синтез речи (Google сейчас даёт его не всем). Нужен платный аккаунт Google AI или другой сервис.', { status: 429, fatal: true });
  }
  if (lastErr?.tryNext) throw new CloudError('Gemini: модели синтеза речи недоступны для вашего ключа.', { status: lastErr.status, fatal: true });
  throw lastErr;
}

async function geminiOnce(model, cfg, text, signal) {
  const res = await net('Gemini', `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.key },
    body: JSON.stringify({
      contents: [{ parts: [{ text: `Прочитай спокойно, чётко и естественно, как живой преподаватель диктует конспект: ${text}` }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: cfg.voice } } },
      },
    }),
    signal,
  });
  if (!res.ok) {
    const body = await readError(res);
    const err = httpError('Gemini', res.status, body);
    const msg = JSON.stringify(body);
    err.tryNext = res.status === 404 || (res.status === 400 && /not found|not supported|does not support/i.test(msg)) ||
      (res.status === 429 && /limit: ?0\b/.test(msg));
    throw err;
  }
  const data = await res.json();
  const part = data?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (!part) throw new CloudError('Gemini: пустой ответ без звука');
  const rate = +(/rate=(\d+)/.exec(part.inlineData.mimeType || '')?.[1] || 24000);
  return pcmToWav(part.inlineData.data, rate);
}

async function elevenlabs(cfg, text, signal) {
  if (!cfg.key) throw new CloudError('ElevenLabs: укажите ключ API (Настройки → Голос).', { fatal: true });
  const model = cfg.model || CLOUD_PROVIDERS.elevenlabs.model;
  const res = await net('ElevenLabs', `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(cfg.voice)}?output_format=mp3_22050_32`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'xi-api-key': cfg.key, Accept: 'audio/mpeg' },
    body: JSON.stringify({
      text,
      model_id: model,
      // язык явно задают только модели v2.5 (Flash/Turbo); остальные определяют его сами
      ...(/v2_5|flash|turbo/.test(model) ? { language_code: 'ru' } : {}),
      voice_settings: { stability: 0.55, similarity_boost: 0.75, style: 0.1, use_speaker_boost: true },
    }),
    signal,
  });
  if (!res.ok) throw httpError('ElevenLabs', res.status, await readError(res));
  return res.blob();
}

const IMPL = { yandex, gemini, elevenlabs };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Звук для текста (Blob). cfg: { provider, voice, key, url, model }.
 * Сначала — память и сохранённая озвучка, потом — запрос с повторами.
 */
export function audioFor(cfg, text) {
  const key = `${cfg.provider}|${cfg.voice}|${text}`;
  if (!memory.has(key)) {
    const p = (async () => {
      const saved = await fromCache(cfg, text);
      if (saved) return saved;
      let lastErr;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const blob = await IMPL[cfg.provider](cfg, text);
          if (!blob?.size) throw new CloudError('пустой звук');
          toCache(cfg, text, blob);
          return blob;
        } catch (e) {
          lastErr = e;
          if (e.fatal || e.name === 'AbortError') break;
          await sleep(e.status === 429 ? 8000 * (attempt + 1) : 1500 * (attempt + 1));
        }
      }
      throw lastErr;
    })();
    p.catch(() => memory.delete(key));
    memory.set(key, p);
    while (memory.size > 24) memory.delete(memory.keys().next().value);
  }
  return memory.get(key);
}

/** Голоса ElevenLabs из аккаунта (включая добавленные вами). */
export async function listElevenVoices(key) {
  const res = await net('ElevenLabs', 'https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': key } });
  if (!res.ok) throw httpError('ElevenLabs', res.status, await readError(res));
  const data = await res.json();
  return (data.voices || []).map((v) => ({ id: v.voice_id, name: `${v.name}${v.labels?.gender ? ` (${v.labels.gender === 'female' ? 'женский' : v.labels.gender === 'male' ? 'мужской' : v.labels.gender})` : ''}` }));
}
