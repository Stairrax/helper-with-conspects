// Фоновый поток нейросетевого голоса: Silero (silero-core.js + 5 моделей ONNX)
// или Piper (фонемизация espeak-ng + модель ONNX).
// Работает отдельно от интерфейса, поэтому кнопка «СТОП» не ждёт синтеза.
/* global ort, createPiperPhonemize, SileroCore */

const ORT_URLS = [
  'https://cdnjs.cloudflare.com/ajax/libs/onnxruntime-web/1.18.0/',
  'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/',
];
const PHONEMIZE_URLS = [
  'https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/',
  'https://unpkg.com/@diffusionstudio/piper-wasm@1.0.0/build/',
];
const CACHE = 'kd-voices';

let session = null;   // Piper
let config = null;
let phonemizer = null;
let phonemeOut = null;
let silero = null;    // { sessions, frontend }
let loadedKey = null; // какая модель сейчас в памяти

const keyOf = (voice) => voice.key || voice.id;

function importFirst(urls, file) {
  let err;
  for (const base of urls) {
    try { importScripts(base + file); return base; } catch (e) { err = e; }
  }
  throw err || new Error('Не удалось загрузить ' + file);
}

/** Скачивает файл с прогрессом и хранит в Cache Storage (повторно не качает). */
async function fetchCached(urls, onProgress) {
  const cache = await caches.open(CACHE);
  for (const url of urls) {
    const hit = await cache.match(url);
    if (hit) return hit.arrayBuffer();
  }
  let lastErr;
  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const total = +res.headers.get('Content-Length') || 0;
      const reader = res.body.getReader();
      const parts = [];
      let loaded = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        loaded += value.length;
        onProgress?.(loaded, total);
      }
      const blob = new Blob(parts);
      await cache.put(url, new Response(blob)).catch(() => {});
      return blob.arrayBuffer();
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('Не удалось скачать голос');
}

function loadOrt() {
  if (self.ort) return;
  const base = importFirst(ORT_URLS, 'ort.min.js');
  ort.env.wasm.wasmPaths = base;
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
}

// в памяти держим только одну модель: старую выгружаем, иначе на телефоне кончается память
async function unload() {
  const all = [session, ...Object.values(silero?.sessions || {})].filter(Boolean);
  session = null;
  silero = null;
  loadedKey = null;
  for (const s of all) { try { await s.release(); } catch { /* ignore */ } }
}

async function init(voice) {
  if (loadedKey === keyOf(voice) && (session || silero)) return;
  post({ type: 'progress', stage: 'libs', loaded: 0, total: 0 });
  loadOrt();
  if (voice.kind === 'silero') return initSilero(voice);
  if (!phonemizer) {
    const base = importFirst(PHONEMIZE_URLS, 'piper_phonemize.js');
    phonemizer = await createPiperPhonemize({
      print: (line) => { phonemeOut = line; },
      printErr: () => {},
      locateFile: (f) => base + f,
    });
  }
  const cfg = JSON.parse(new TextDecoder().decode(await fetchCached(voice.config)));
  let model = await fetchCached(voice.model, (loaded, total) => post({ type: 'progress', stage: 'model', loaded, total }));
  post({ type: 'progress', stage: 'session', loaded: 0, total: 0 });
  await unload();
  session = await ort.InferenceSession.create(model);
  model = null;
  config = cfg;
  loadedKey = keyOf(voice);
}

const SILERO_MODELS = ['prosody', 'encoder', 'dec_pre', 'dec_post', 'vocoder'];

async function initSilero(voice) {
  if (!self.SileroCore) importScripts('silero-core.js' + self.location.search);
  const file = (name) => voice.files.find((f) => f.name === name).urls;
  // сначала скачиваем недостающее (общий прогресс), потом по одной загружаем модели в память
  const cache = await caches.open(CACHE);
  const missing = [];
  for (const f of voice.files) if (!(await cache.match(f.urls[0]))) missing.push(f);
  const total = missing.reduce((a, f) => a + f.size, 0);
  let done = 0, homoOk = true;
  for (const f of missing) {
    try {
      const buf = await fetchCached(f.urls, (loaded) => post({ type: 'progress', stage: 'model', loaded: done + Math.min(loaded, f.size), total }));
      if (buf.byteLength !== f.size) {
        // вместо файла пришло что-то другое (обрыв, страница входа в Wi-Fi) — не храним, в следующий раз скачаем заново
        await Promise.all(f.urls.map((u) => cache.delete(u))).catch(() => {});
        throw new Error('файл голоса скачался не полностью');
      }
    } catch (e) {
      // без модели омографов голос работает (ударения как раньше) — докачаем при следующем запуске
      if (!f.optional) throw e;
      homoOk = false;
    }
    done += f.size;
  }
  await dropOldFiles(voice.files);
  post({ type: 'progress', stage: 'session', loaded: 0, total: 0 });
  await unload();
  const json = async (name) => JSON.parse(new TextDecoder().decode(await fetchCached(file(name))));
  const tts = await json('tts.json');
  const accentor = new SileroCore.Accentor(
    new TextDecoder().decode(await fetchCached(file('accentor-ngrams.txt'))),
    new Int8Array(await fetchCached(file('accentor-emb.bin'))),
    await json('accentor.json'),
  );
  const sessions = {};
  try {
    for (const k of SILERO_MODELS) sessions[k] = await ort.InferenceSession.create(await fetchCached(file(k + '.onnx')));
  } catch (e) {
    for (const s of Object.values(sessions)) { try { await s.release(); } catch { /* ignore */ } }
    throw e;
  }
  let homo = null;
  if (homoOk) {
    try {
      sessions.homo = await ort.InferenceSession.create(await fetchCached(file('homo.onnx')));
      const infer = async (x, T, start, end) => {
        const i64 = (v) => new ort.Tensor('int64', BigInt64Array.from([BigInt(v)]), [1]);
        const r = await sessions.homo.run({ emb: new ort.Tensor('float32', x, [1, T, x.length / T]), start: i64(start), end: i64(end) });
        return r.logit.data[0];
      };
      homo = new SileroCore.HomoSolver(
        await json('homo.json'),
        new TextDecoder().decode(await fetchCached(file('homo-vocab.txt'))),
        new Int8Array(await fetchCached(file('homo-emb.bin'))),
        infer,
      );
    } catch { homo = null; }
  }
  silero = { sessions, frontend: new SileroCore.Frontend(tts, accentor, homo) };
  loadedKey = keyOf(voice);
}

/** Удаляет из кэша файлы прошлых версий модели (другой ?r=). */
async function dropOldFiles(files) {
  try {
    const keep = new Set(files.flatMap((f) => f.urls));
    const dir = new URL('.', files[0].urls[0]).href;
    const cache = await caches.open(CACHE);
    for (const req of await cache.keys()) if (req.url.startsWith(dir) && !keep.has(req.url)) await cache.delete(req);
  } catch { /* ignore */ }
}

async function synthSilero(voice, text, rate) {
  const { sessions, frontend } = silero;
  const pcm = await SileroCore.synthesize(
    frontend,
    (k, feeds) => sessions[k].run(feeds),
    (type, data, dims) => new ort.Tensor(type, data, dims),
    text,
    { speaker: voice.speaker, rate: Math.max(0.5, Math.min(2, rate || 1)) },
  );
  return pcm.length ? pcm : new Float32Array(4800); // в тексте нет слов — короткая тишина
}

function phonemize(text) {
  phonemeOut = null;
  phonemizer.callMain(['-l', config.espeak.voice, '--input', JSON.stringify([{ text }]), '--espeak_data', '/espeak-ng-data']);
  if (!phonemeOut) throw new Error('phonemize failed');
  return JSON.parse(phonemeOut).phoneme_ids;
}

async function synth(text, rate) {
  const ids = phonemize(text);
  const inf = config.inference || {};
  const lengthScale = (inf.length_scale || 1) / Math.max(0.5, Math.min(2, rate || 1));
  const feeds = {
    input: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
    input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
    scales: new ort.Tensor('float32', Float32Array.from([inf.noise_scale ?? 0.667, lengthScale, inf.noise_w ?? 0.8]), [3]),
  };
  if (config.num_speakers > 1) feeds.sid = new ort.Tensor('int64', BigInt64Array.from([0n]), [1]);
  const { output } = await session.run(feeds);
  return Float32Array.from(output.data);
}

const post = (m, transfer) => self.postMessage(m, transfer || []);

// Синтез идёт по одному, в порядке очереди.
// Голос, выбранный последним: заготовки старым голосом после смены пропускаем,
// чтобы не перезагружать модели туда-обратно.
let wantedVoice = null;
let chain = Promise.resolve();
self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init' || !wantedVoice) wantedVoice = m.voice.id;
  if (m.type === 'synth' && m.voice.id !== wantedVoice && keyOf(m.voice) !== loadedKey) {
    post({ type: 'error', id: m.id, message: 'stale', stale: true });
    return;
  }
  chain = chain.then(async () => {
    try {
      if (m.type === 'init') {
        await init(m.voice);
        post({ type: 'ready', id: m.id });
      } else if (m.type === 'synth') {
        if (m.voice.id !== wantedVoice) { post({ type: 'error', id: m.id, message: 'stale', stale: true }); return; }
        await init(m.voice);
        const isSilero = m.voice.kind === 'silero';
        const pcm = isSilero ? await synthSilero(m.voice, m.text, m.rate) : await synth(m.text, m.rate);
        post({ type: 'audio', id: m.id, pcm, sampleRate: isSilero ? silero.frontend.tts.sample_rate : config.audio.sample_rate }, [pcm.buffer]);
      }
    } catch (err) {
      post({ type: 'error', id: m.id, message: String(err?.message || err) });
    }
  });
};
