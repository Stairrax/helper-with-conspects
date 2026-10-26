// Запись лекции: пока идёт пара, распознавание речи пишет расшифровку; потом она становится материалом.
// Распознаёт Chrome (на Android — сервисом Google, нужен интернет). Звук не сохраняется — только текст.
// Черновик пишется в localStorage после каждой фразы: закрыли приложение — запись продолжится с того же места.

import { Recognizer, srSupported, keepAwake } from './speech.js';
import { generate, conn } from './ai.js';

const DRAFT = 'kd.lectureDraft';

export const lectureSupported = srSupported;

export class LectureRecorder {
  /** onUpdate({ text, interim, ms, running, error }) — на каждую фразу и раз в секунду. */
  constructor(onUpdate) {
    this.onUpdate = onUpdate;
    this.text = '';
    this.interim = '';
    this.ms = 0;          // сколько уже записано (без пауз)
    this.since = 0;       // когда запустили текущий отрезок
    this.running = false;
    this.error = '';
    this.title = '';
    this.rec = new Recognizer({
      onResult: (r) => this.onResult(r),
      onFatal: (msg) => { this.error = msg; this.pause(); },
    });
    const d = loadDraft();
    if (d) Object.assign(this, { text: d.text || '', ms: d.ms || 0, title: d.title || '' });
  }

  get hasDraft() { return !!this.text; }

  elapsed() { return this.ms + (this.running ? Date.now() - this.since : 0); }

  start() {
    if (this.running) return;
    this.error = '';
    this.running = true;
    this.since = Date.now();
    this.rec.start();
    keepAwake(true); // погаснет экран — Chrome остановит распознавание
    clearInterval(this.tick);
    this.tick = setInterval(() => this.emit(), 1000);
    this.emit();
  }

  pause() {
    if (this.running) this.ms += Date.now() - this.since;
    this.running = false;
    this.rec.stop();
    clearInterval(this.tick);
    keepAwake(false);
    this.commitInterim();
    this.save();
    this.emit();
  }

  onResult(r) {
    const t = r.text.trim();
    if (!t) return;
    if (r.final) {
      this.text = this.text ? `${this.text} ${t}` : t;
      this.interim = '';
      this.save();
    } else this.interim = t;
    this.emit();
  }

  /** Недослушанная фраза при паузе — тоже в текст. */
  commitInterim() {
    if (!this.interim) return;
    this.text = this.text ? `${this.text} ${this.interim}` : this.interim;
    this.interim = '';
  }

  /** Готово: текст расшифровки, черновик очищается. */
  finish() {
    this.pause();
    const text = this.text.trim();
    this.discard();
    return text;
  }

  discard() {
    this.pause();
    this.text = '';
    this.interim = '';
    this.ms = 0;
    this.title = '';
    try { localStorage.removeItem(DRAFT); } catch { /* ignore */ }
    this.emit();
  }

  save() {
    try { localStorage.setItem(DRAFT, JSON.stringify({ text: this.text, ms: this.elapsed(), title: this.title, at: Date.now() })); } catch { /* ignore */ }
  }

  emit() {
    this.onUpdate({ text: this.text, interim: this.interim, ms: this.elapsed(), running: this.running, error: this.error });
  }
}

function loadDraft() {
  try { return JSON.parse(localStorage.getItem(DRAFT) || 'null'); } catch { return null; }
}

export function fmtClock(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(sec)}` : `${p(m)}:${p(sec)}`;
}

/** Без нейросети: абзацы примерно по 600 знаков по границе слова, первая буква — заглавная. */
export function roughParagraphs(text) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  const out = [];
  let cur = [];
  let len = 0;
  for (const w of words) {
    cur.push(w);
    len += w.length + 1;
    if (len > 600 && /[.!?]$/.test(w)) { out.push(cur.join(' ')); cur = []; len = 0; }
    else if (len > 900) { out.push(cur.join(' ')); cur = []; len = 0; }
  }
  if (cur.length) out.push(cur.join(' '));
  return out.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('\n\n');
}

/** Части по ~6000 знаков по границе слова — чтобы ответ нейросети не обрезался. */
function parts(text, size = 6000) {
  const out = [];
  let rest = text.trim();
  while (rest.length > size) {
    let cut = rest.lastIndexOf(' ', size);
    if (cut < size / 2) cut = size;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Расшифровка с распознавания — сплошной текст без знаков препинания и с ошибками.
 * Нейросеть расставляет знаки и абзацы и исправляет явные ошибки распознавания, не меняя смысла.
 */
export async function tidyTranscript(text, settings, onStatus = () => {}) {
  const ps = parts(text);
  const out = [];
  for (let i = 0; i < ps.length; i++) {
    onStatus(ps.length > 1 ? `Навожу порядок в расшифровке: часть ${i + 1} из ${ps.length}` : 'Навожу порядок в расшифровке');
    const res = await generate({
      ...conn(settings),
      system: 'Ты редактор расшифровок лекций на русском языке. Отвечай только готовым текстом, без пояснений и markdown.',
      parts: [{ text:
`Это кусок автоматической расшифровки лекции: без знаков препинания, с ошибками распознавания речи.
Расставь знаки препинания и заглавные буквы, раздели на абзацы по смыслу (абзацы — через пустую строку), исправь явные ошибки распознавания (термины, имена, числа — цифрами), убери слова-паразиты и случайные повторы.
Ничего не добавляй от себя и не сокращай учебное содержание. Верни только исправленный текст.

<<<
${ps[i]}
>>>` }],
      temperature: 0.2,
    });
    out.push(String(res || '').trim() || roughParagraphs(ps[i]));
  }
  return out.join('\n\n');
}
