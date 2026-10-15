// Нейросетевой голос (Piper) — работает прямо на телефоне, без интернета после первой загрузки.
// Синтез — в фоновом потоке (neural-worker.js), воспроизведение — через Web Audio.

const HF = [
  'https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/ru/ru_RU',
  'https://huggingface.co/diffusionstudio/piper-voices/resolve/main/ru/ru_RU',
];

export const NEURAL_VOICES = {
  irina: 'Ирина (женский)',
  dmitri: 'Дмитрий (мужской)',
  denis: 'Денис (мужской)',
  ruslan: 'Руслан (мужской)',
};

function voiceSpec(id) {
  const file = `ru_RU-${id}-medium.onnx`;
  return {
    id,
    model: HF.map((b) => `${b}/${id}/medium/${file}`),
    config: HF.map((b) => `${b}/${id}/medium/${file}.json`),
  };
}

let worker = null;
let seq = 0;
const pending = new Map();      // id -> {resolve, reject}
const cache = new Map();        // ключ -> Promise<AudioBuffer>
let progressCb = null;
let ctx = null;

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./neural-worker.js', import.meta.url));
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') { progressCb?.(m); return; }
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.type === 'error') p.reject(new Error(m.message));
      else p.resolve(m);
    };
    worker.onerror = (e) => {
      for (const p of pending.values()) p.reject(new Error(e.message || 'Ошибка голосового модуля'));
      pending.clear();
    };
  }
  return worker;
}

function call(msg) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ ...msg, id });
  });
}

export function audioContext() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

/** Загружает голос (первый раз ~65 МБ). onProgress({stage, loaded, total}). */
export async function prepare(voiceId, onProgress) {
  progressCb = onProgress;
  try {
    await call({ type: 'init', voice: voiceSpec(voiceId) });
  } finally {
    progressCb = null;
  }
}

/** Синтезирует текст в AudioBuffer (с кэшем и опережением). */
export function synth(text, { voice = 'irina', rate = 1 } = {}) {
  const key = `${voice}|${rate}|${text}`;
  if (!cache.has(key)) {
    const p = call({ type: 'synth', voice: voiceSpec(voice), text, rate }).then((m) => {
      const ac = audioContext();
      const buf = ac.createBuffer(1, m.pcm.length, m.sampleRate);
      buf.copyToChannel(m.pcm, 0);
      return buf;
    });
    p.catch(() => cache.delete(key));
    cache.set(key, p);
    while (cache.size > 16) cache.delete(cache.keys().next().value);
  }
  return cache.get(key);
}

/** Есть ли уже скачанный голос (чтобы не начинать загрузку посреди диктовки). */
export async function isDownloaded(voiceId) {
  try {
    const c = await caches.open('kd-voices');
    const spec = voiceSpec(voiceId);
    for (const u of spec.model) if (await c.match(u)) return true;
  } catch { /* ignore */ }
  return false;
}
