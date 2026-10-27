// Аудиоконспект (iPhone): конспект озвучивается нейросетевым голосом прямо на телефоне и сохраняется в MP3.
// Такой файл играет и с погасшим экраном (обычную озвучку Safari при этом обрывает) и без интернета —
// в приложении или в любом плеере. Голос телефона записать в файл нельзя, поэтому только нейроголос.
// MP3 кодирует lamejs (LGPL-3.0), загружается с CDN при первом использовании.

import * as neural from './neural.js';

const LAME = [
  'https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js',
  'https://unpkg.com/lamejs@1.2.1/lame.min.js',
];

let lameReady = null;
function loadLame() {
  if (window.lamejs) return Promise.resolve(window.lamejs);
  if (!lameReady) {
    lameReady = (async () => {
      for (const url of LAME) {
        try {
          await new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = url;
            s.onload = resolve;
            s.onerror = () => { s.remove(); reject(); };
            document.head.append(s);
          });
          if (window.lamejs) return window.lamejs;
        } catch { /* следующий адрес */ }
      }
      lameReady = null;
      throw new Error('Не удалось загрузить кодировщик MP3 (нужен интернет)');
    })();
  }
  return lameReady;
}

/**
 * Что читать: «Тема: …» и отрывки по порядку. topics — темы плана, spoken(chunk) — текст для голоса,
 * gap(topic, chunk) — пауза после отрывка в секундах.
 */
export function audioPieces(topics, { en = false, spoken, gap }) {
  const out = [];
  for (const t of topics) {
    if (t.status !== 'ready' || !t.chunks?.length) continue;
    out.push({ text: en ? `Topic: ${t.title}.` : `Тема: ${t.title}.`, pause: 0.8 });
    t.chunks.forEach((c, i) => {
      const text = String(spoken(c) || '').trim();
      if (text) out.push({ text, pause: i === t.chunks.length - 1 ? 2 : gap(t, c) });
    });
  }
  return out;
}

/**
 * Озвучивает куски и кодирует в MP3. -> { blob, seconds }.
 * opts: voice, rate, expressive, onProgress(done, total), signal; synth — для автотестов.
 */
export async function renderMp3(pieces, { voice, rate = 1, expressive = false, onProgress = () => {}, signal, synth = neural.synth } = {}) {
  const lame = await loadLame();
  let enc = null, sr = 0, seconds = 0;
  const out = [];
  const push = (pcm) => {
    for (let i = 0; i < pcm.length; i += 1152) {
      const b = enc.encodeBuffer(pcm.subarray(i, i + 1152));
      if (b.length) out.push(new Uint8Array(b));
    }
  };
  for (let i = 0; i < pieces.length; i++) {
    if (signal?.aborted) throw new DOMException('Отменено', 'AbortError');
    const p = pieces[i];
    const buf = await synth(p.text, { voice, rate, expressive });
    if (signal?.aborted) throw new DOMException('Отменено', 'AbortError');
    if (!enc) { sr = buf.sampleRate; enc = new lame.Mp3Encoder(1, sr, 64); }
    const ch = buf.getChannelData(0);
    const pcm = new Int16Array(ch.length);
    for (let j = 0; j < ch.length; j++) pcm[j] = Math.max(-1, Math.min(1, ch[j])) * 32767;
    push(pcm);
    const gap = Math.round((p.pause || 0) * sr);
    if (gap) push(new Int16Array(gap));
    seconds += ch.length / sr + (p.pause || 0);
    onProgress(i + 1, pieces.length);
    await new Promise((r) => setTimeout(r, 0)); // экран не замирает
  }
  if (!enc) throw new Error('Нечего озвучивать: темы ещё не подготовлены');
  out.push(new Uint8Array(enc.flush()));
  return { blob: new Blob(out, { type: 'audio/mpeg' }), seconds };
}
