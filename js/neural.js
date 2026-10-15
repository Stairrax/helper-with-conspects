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
      if (m.type === 'error') p.reject(Object.assign(new Error(m.message), { stale: !!m.stale }));
      else p.resolve(m);
    };
    worker.onerror = (e) => {
      // модуль упал (например, не хватило памяти) — пересоздадим его при следующей фразе
      for (const p of pending.values()) p.reject(new Error(e.message || 'Ошибка голосового модуля'));
      pending.clear();
      try { worker.terminate(); } catch { /* ignore */ }
      worker = null;
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

// ---------- Стиль голоса ----------
// «Ассистент в стиле Джарвиса» — стилизация, а не копия чьего-то голоса:
// тон чуть ниже, чёткая середина, лёгкий «цифровой» металлический оттенок и короткое эхо.

export const VOICE_STYLES = {
  none: { name: 'Обычный', pitch: 1 },
  jarvis: { name: 'ИИ-ассистент в стиле Джарвиса', pitch: 0.93 },
};

let chain = null; // { input, out }

function impulse(ac, seconds, decay) {
  const len = Math.round(ac.sampleRate * seconds);
  const buf = ac.createBuffer(2, len, ac.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return buf;
}

/** Узел, к которому подключать звук для выбранного стиля. */
export function outputFor(style) {
  const ac = audioContext();
  if (style !== 'jarvis') return ac.destination;
  if (chain) return chain.input;
  const input = ac.createGain();
  const hp = ac.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 110;
  const warmth = ac.createBiquadFilter(); warmth.type = 'lowshelf'; warmth.frequency.value = 220; warmth.gain.value = 2.5;
  const presence = ac.createBiquadFilter(); presence.type = 'peaking'; presence.frequency.value = 2800; presence.Q.value = 0.9; presence.gain.value = 4;
  const comp = ac.createDynamicsCompressor(); comp.threshold.value = -20; comp.ratio.value = 3;
  const out = ac.createGain(); out.gain.value = 0.95;
  // короткая задержка с обратной связью — «цифровой» металлический оттенок
  const dly = ac.createDelay(0.05); dly.delayTime.value = 0.011;
  const fb = ac.createGain(); fb.gain.value = 0.25;
  const wet = ac.createGain(); wet.gain.value = 0.22;
  // лёгкое эхо помещения
  const conv = ac.createConvolver(); conv.buffer = impulse(ac, 0.6, 3);
  const rev = ac.createGain(); rev.gain.value = 0.12;
  input.connect(hp); hp.connect(warmth); warmth.connect(presence); presence.connect(comp); comp.connect(out);
  comp.connect(dly); dly.connect(wet); wet.connect(out); dly.connect(fb); fb.connect(dly);
  comp.connect(conv); conv.connect(rev); rev.connect(out);
  out.connect(ac.destination);
  chain = { input, out };
  return input;
}

/** Мгновенно глушит хвост эха после «стоп». */
export function cutTail() {
  if (!chain) return;
  const ac = audioContext();
  const g = chain.out.gain;
  g.cancelScheduledValues(ac.currentTime);
  g.setValueAtTime(0, ac.currentTime);
}

/** Возвращает громкость перед новой фразой (после cutTail). */
export function restoreOut() {
  if (!chain) return;
  const ac = audioContext();
  chain.out.gain.cancelScheduledValues(ac.currentTime);
  chain.out.gain.setValueAtTime(0.95, ac.currentTime);
}
