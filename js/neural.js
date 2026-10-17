// Нейросетевой голос — работает прямо на телефоне, без интернета после первой загрузки.
// Silero (живые голоса: Бая и др.; файлы лежат рядом с приложением, voices/silero-ru) и Piper (с Hugging Face).
// Синтез — в фоновом потоке (neural-worker.js), воспроизведение — через Web Audio.

const HF = [
  'https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/ru/ru_RU',
  'https://huggingface.co/diffusionstudio/piper-voices/resolve/main/ru/ru_RU',
];

export const NEURAL_VOICES = {
  'silero-baya': 'Бая (женский, живой)',
  'silero-xenia': 'Ксения (женский, живой)',
  'silero-kseniya': 'Ксюша (женский, живой)',
  'silero-aidar': 'Айдар (мужской, живой)',
  'silero-eugene': 'Евгений (мужской, живой)',
  irina: 'Ирина (женский)',
  dmitri: 'Дмитрий (мужской)',
  denis: 'Денис (мужской)',
  ruslan: 'Руслан (мужской)',
};

export const isSilero = (id) => id.startsWith('silero-');

// Файлы Silero и их размер (для прогресса загрузки). При замене файла укажите его новую версию
// в SILERO_REV — иначе у тех, кто уже скачал голос, останется старый (скачается только этот файл).
const SILERO_REV = { 'prosody.onnx': 2 }; // 2 — с логическим ударением (живая интонация)
const SILERO_FILES = {
  'tts.json': 47335,
  'accentor.json': 1304184,
  'accentor-ngrams.txt': 1087501,
  'accentor-emb.bin': 2024368,
  'prosody.onnx': 3280854,
  'encoder.onnx': 14205067,
  'dec_pre.onnx': 5460679,
  'dec_post.onnx': 6099427,
  'vocoder.onnx': 58290543,
  // ударения в омографах (зáмок/замóк) — без них голос тоже работает
  'homo.json': 1879053,
  'homo-vocab.txt': 946009,
  'homo-emb.bin': 19646016,
  'homo.onnx': 5290929,
};
const SILERO_OPTIONAL = /^homo/;
const SILERO_BASE = new URL('../voices/silero-ru/', import.meta.url).href;

function voiceSpec(id) {
  if (isSilero(id)) {
    return {
      id,
      kind: 'silero',
      key: 'silero-ru', // одна модель на все голоса Silero
      speaker: id.slice(7),
      files: Object.entries(SILERO_FILES).map(([name, size]) => ({
        name, size, optional: SILERO_OPTIONAL.test(name), urls: [`${SILERO_BASE}${name}?r=${SILERO_REV[name] || 1}`],
      })),
    };
  }
  const file = `ru_RU-${id}-medium.onnx`;
  return {
    id,
    model: HF.map((b) => `${b}/${id}/medium/${file}`),
    config: HF.map((b) => `${b}/${id}/medium/${file}.json`),
  };
}

/** Сколько мегабайт скачивается для голоса. */
export function voiceSizeMB(id) {
  return isSilero(id) ? Math.round(Object.values(SILERO_FILES).reduce((a, b) => a + b, 0) / 1e6) : 65;
}

let worker = null;
let seq = 0;
const pending = new Map();      // id -> {resolve, reject}
const cache = new Map();        // ключ -> Promise<AudioBuffer>
let progressCb = null;
let ctx = null;

function getWorker() {
  if (!worker) {
    // та же версия, что у приложения (?v=…), — чтобы не смешались файлы разных версий
    worker = new Worker(new URL('./neural-worker.js' + new URL(import.meta.url).search, import.meta.url));
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

/** Загружает голос (первый раз 65–90 МБ). onProgress({stage, loaded, total}). */
export async function prepare(voiceId, onProgress) {
  progressCb = onProgress;
  try {
    await call({ type: 'init', voice: voiceSpec(voiceId) });
  } finally {
    progressCb = null;
  }
}

/** Синтезирует текст в AudioBuffer (с кэшем и опережением). expressive — живая интонация (только Silero). */
export function synth(text, { voice = 'irina', rate = 1, expressive = false } = {}) {
  const ex = expressive && isSilero(voice);
  const key = `${voice}|${rate}|${ex ? 'x' : ''}|${text}`;
  if (!cache.has(key)) {
    const p = call({ type: 'synth', voice: voiceSpec(voice), text, rate, expressive: ex }).then((m) => {
      const ac = audioContext();
      const buf = ac.createBuffer(1, Math.max(1, m.pcm.length), m.sampleRate); // пустой буфер создать нельзя
      buf.copyToChannel(m.pcm, 0);
      return buf;
    });
    p.catch(() => cache.delete(key));
    cache.set(key, p);
    while (cache.size > 16) cache.delete(cache.keys().next().value);
  }
  return cache.get(key);
}

/** Сколько мегабайт голоса ещё не скачано (0 — всё на телефоне). */
export async function missingMB(voiceId) {
  const spec = voiceSpec(voiceId);
  try {
    const c = await caches.open('kd-voices');
    if (spec.files) {
      let bytes = 0;
      for (const f of spec.files) if (!(await c.match(f.urls[0]))) bytes += f.size;
      return Math.ceil(bytes / 1e6);
    }
    for (const u of spec.model) if (await c.match(u)) return 0;
  } catch { /* ignore */ }
  return voiceSizeMB(voiceId);
}

/** Есть ли уже скачанный голос (чтобы не начинать загрузку посреди диктовки). */
export async function isDownloaded(voiceId) {
  return (await missingMB(voiceId)) === 0;
}

// ---------- Чёткость голоса ----------
// У голоса Яндекса частоты 1–5 кГц (разборчивость, «присутствие») на 10–15 дБ тише, чем у обычной речи:
// в наушниках он звучит глухо, «как по телефону». Эквалайзер поднимает эту середину.

/** Цепочка эквалайзера к узлу dest; возвращает её вход. */
export function clarityChain(ac, dest) {
  const filter = (type, freq, q, gain) => {
    const f = ac.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q; f.gain.value = gain;
    return f;
  };
  const nodes = [
    filter('highpass', 90, 0.7, 0),
    filter('peaking', 1300, 1.0, 5),
    filter('peaking', 3000, 0.9, 9),
    filter('peaking', 4500, 1.2, 4),
  ];
  const trim = ac.createGain(); trim.gain.value = 0.9; // громкость та же, что без эквалайзера (−19 LUFS на фразе Яндекса)
  const limit = ac.createDynamicsCompressor(); // только от редких пиков
  limit.threshold.value = -2; limit.knee.value = 2; limit.ratio.value = 12; limit.attack.value = 0.003; limit.release.value = 0.1;
  [...nodes, trim, limit].reduce((a, b) => { a.connect(b); return b; }).connect(dest);
  return nodes[0];
}

let clarity = null;
/** Вход эквалайзера «чёткость голоса» в общем звуковом контексте. */
export function clarityInput() {
  const ac = audioContext();
  if (!clarity) clarity = clarityChain(ac, ac.destination);
  return clarity;
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
