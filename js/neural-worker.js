// Фоновый поток нейросетевого голоса (Piper): фонемизация espeak-ng + модель ONNX.
// Работает отдельно от интерфейса, поэтому кнопка «СТОП» не ждёт синтеза.
/* global ort, createPiperPhonemize */

const ORT_URLS = [
  'https://cdnjs.cloudflare.com/ajax/libs/onnxruntime-web/1.18.0/',
  'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/',
];
const PHONEMIZE_URLS = [
  'https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/',
  'https://unpkg.com/@diffusionstudio/piper-wasm@1.0.0/build/',
];
const CACHE = 'kd-voices';

let session = null;
let config = null;
let phonemizer = null;
let phonemeOut = null;
let loadedVoice = null;

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

async function init(voice) {
  if (loadedVoice === voice.id && session) return;
  post({ type: 'progress', stage: 'libs', loaded: 0, total: 0 });
  if (!self.ort) {
    const base = importFirst(ORT_URLS, 'ort.min.js');
    ort.env.wasm.wasmPaths = base;
    ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
  }
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
  // в памяти держим только один голос: старую модель выгружаем, иначе на телефоне кончается память
  if (session) {
    try { await session.release(); } catch { /* ignore */ }
    session = null;
    loadedVoice = null;
  }
  session = await ort.InferenceSession.create(model);
  model = null;
  config = cfg;
  loadedVoice = voice.id;
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
  if (m.type === 'synth' && m.voice.id !== wantedVoice && m.voice.id !== loadedVoice) {
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
        const pcm = await synth(m.text, m.rate);
        post({ type: 'audio', id: m.id, pcm, sampleRate: config.audio.sample_rate }, [pcm.buffer]);
      }
    } catch (err) {
      post({ type: 'error', id: m.id, message: String(err?.message || err) });
    }
  });
};
