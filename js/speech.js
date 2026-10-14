// Синтез речи (SpeechSynthesis), распознавание (SpeechRecognition), команды и защита от эха.

const synth = window.speechSynthesis;
export const ttsSupported = !!synth && 'SpeechSynthesisUtterance' in window;
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
export const srSupported = !!SR;

// ---------- TTS ----------

let voices = [];
let current = null;          // { fin, text }
let lastCancelAt = 0;
let epoch = 0;              // растёт при каждой остановке — отменяет отложенные запуски речи
const recent = [];           // недавно произнесённое: { text, start, end }
let keepAlive = null;        // защита от сборщика мусора (баг Chrome)

export function loadVoices() {
  if (!ttsSupported) return Promise.resolve([]);
  return new Promise((resolve) => {
    const done = () => { voices = synth.getVoices(); resolve(voices); };
    const v = synth.getVoices();
    if (v.length) { voices = v; resolve(v); return; }
    synth.addEventListener('voiceschanged', done, { once: true });
    setTimeout(done, 1500);
  });
}

export function getVoices() {
  const ru = voices.filter((v) => /^ru/i.test(v.lang));
  const other = voices.filter((v) => !/^ru/i.test(v.lang));
  return [...ru, ...other];
}

function pickVoice(uri) {
  return voices.find((v) => v.voiceURI === uri) || voices.find((v) => /^ru/i.test(v.lang)) || null;
}

export function isSpeaking() {
  return !!current || (ttsSupported && synth.speaking);
}

/** Произносит текст. Promise -> 'end' | 'cancel' | 'error'. */
export function speak(text, { rate = 1, voiceURI = '', onStart, echoTail = 900 } = {}) {
  if (!ttsSupported) return Promise.resolve('error');
  const myEpoch = epoch;
  return new Promise((resolve) => {
    const go = () => {
      if (myEpoch !== epoch) return resolve('cancel'); // успели нажать «стоп» до начала речи
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'ru-RU';
      const v = pickVoice(voiceURI);
      try { if (v) u.voice = v; } catch { /* голос недоступен */ }
      u.rate = rate;
      const rec = { text, start: Date.now(), end: 0, tail: echoTail };
      recent.push(rec);
      while (recent.length > 4) recent.shift();
      let done = false, seen = false;
      const started = Date.now();
      const maxMs = 8000 + (text.length / (8 * rate)) * 1000;
      const fin = (r) => {
        if (done) return;
        done = true;
        clearInterval(wd);
        rec.end = Date.now();
        if (current?.fin === fin) current = null;
        resolve(r === 'end' && !seen ? 'error' : r);
      };
      u.onstart = () => { seen = true; onStart?.(); };
      u.onend = () => { seen = true; fin('end'); };
      u.onerror = (e) => fin(e.error === 'interrupted' || e.error === 'canceled' ? 'cancel' : 'error');
      current = { fin, text };
      keepAlive = u;
      synth.speak(u);
      // Сторож: на Android onend иногда не приходит.
      const wd = setInterval(() => {
        if (synth.speaking) seen = true;
        const age = Date.now() - started;
        if (!synth.speaking && !synth.pending && age > 1500) fin('end');
        else if (age > maxMs) { synth.cancel(); fin(seen ? 'end' : 'error'); }
      }, 300);
    };
    const since = Date.now() - lastCancelAt;
    if (since < 150) setTimeout(go, 150 - since); else go();
  });
}

/** Мгновенно обрывает речь. */
export function stopSpeaking() {
  if (!ttsSupported) return;
  epoch++;
  const c = current;
  current = null;
  synth.cancel();
  lastCancelAt = Date.now();
  if (c) c.fin('cancel');
  keepAlive = null;
}

// ---------- Нормализация и защита от эха ----------

export function norm(s) {
  return String(s).toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}
const stem = (w) => w.slice(0, 5);

/**
 * true, если распознанный текст похож на только что произнесённое синтезатором:
 * слова идут в том же порядке, что и в озвученном тексте, и первое слово тоже оттуда.
 * Вопрос («почему…», «а что…») эхом не считается, даже если повторяет термины из куска.
 */
export function isEcho(text) {
  const now = Date.now();
  const spoken = recent.filter((r) => !r.end || now - r.end < r.tail);
  if (!spoken.length) return false;
  const words = norm(text).split(' ').filter((x) => x.length > 1).map(stem);
  if (!words.length) return true;
  const src = spoken.flatMap((r) => norm(r.text).split(' ')).filter((x) => x.length > 1).map(stem);
  const set = new Set(src);
  if (!set.has(words[0])) return false;
  if (words.length <= 2) return words.every((x) => set.has(x));
  let j = 0, matched = 0;
  for (const x of words) {
    const k = src.indexOf(x, j);
    if (k >= 0) { matched++; j = k + 1; }
  }
  return matched / words.length >= 0.7;
}

export function ttsRecentlyActive() {
  if (isSpeaking()) return true;
  const now = Date.now();
  return recent.some((r) => (!r.end && now - r.start < 60000) || (r.end && now - r.end < r.tail));
}

// ---------- Команды ----------

const w = (alts) => new RegExp(`(?:^|\\s)(?:${alts})(?=\\s|$)`);
const COMMANDS = [
  ['repeatTopic', w('повтори(?:те)? (?:всю |эту )?тему|тему (?:с начала|заново|сначала)')],
  ['skipTopic', w('пропусти(?:те)? тему|следующая тема|следующую тему|дальше тема|другая тема')],
  ['stop', w('стоп|стой|стоять|хватит|остановись|остановите|замолчи|тихо')],
  ['pause', w('пауза|подожди(?:те)?|погоди(?:те)?|секунду|минутку')],
  ['repeat', w('повтори(?:те)?|еще раз|повтор|не расслышал[а]?|что что')],
  ['slower', w('медленнее|помедленнее|медленней|помедленней')],
  ['faster', w('быстрее|побыстрее|быстрей|побыстрей')],
  ['continue', w('продолжай(?:те)?|продолжить|продолжаем|продолжи|поехали|давай(?:те)? дальше|едем дальше')],
  ['next', w('дальше|следующий|следующее|пропусти(?:те)?|далее')],
];

/** Короткая фраза -> команда или null. */
export function matchCommand(text) {
  const t = norm(text);
  if (!t || t.split(' ').length > 4) return null;
  for (const [name, re] of COMMANDS) if (re.test(t)) return name;
  return null;
}

const YES = w('да|ага|угу|конечно|давай(?:те)?|продолжа[а-я]*|продолжи|дальше|поехали|ок|окей|хорошо|го|можно|вперед');
const NO = w('нет|не надо|не|стоп|подожди(?:те)?|погоди');
export const isYes = (t) => { const n = norm(t); return n.split(' ').length <= 4 && YES.test(n) && !/(?:^|\s)нет(?=\s|$)/.test(n); };
export const isNo = (t) => { const n = norm(t); return n.split(' ').length <= 3 && NO.test(n); };

const QUESTION_START = /^(вопрос|а |а$|почему|зачем|что|чем|как|какой|какая|какое|какие|каким|когда|где|куда|откуда|кто|сколько|объясни|поясни|расскажи|уточни|не понял|не поняла|непонятно|можно|разве|в чем|правильно ли|то есть|это значит)/;
export const looksLikeQuestion = (t) => QUESTION_START.test(norm(t));

/** Убирает служебные слова в начале вопроса. */
export function stripCue(t) {
  return String(t).trim().replace(/^(стоп|стой|пауза|подожди(те)?|вопрос|у меня вопрос|есть вопрос)[\s,.:!-]*/i, '').trim();
}

// ---------- Распознавание ----------

export class Recognizer {
  constructor({ onResult, onState, onFatal }) {
    this.onResult = onResult;
    this.onState = onState || (() => {});
    this.onFatal = onFatal || (() => {});
    this.wanted = false;
    this.session = 0;
    this.rec = null;
    this.backoff = 250;
    this.active = false;
  }

  start() {
    if (!SR || this.wanted) return;
    this.wanted = true;
    this._start();
  }

  stop() {
    this.wanted = false;
    clearTimeout(this.timer);
    try { this.rec?.abort(); } catch { /* ignore */ }
    this.rec = null;
    this._setActive(false);
  }

  _setActive(v) { this.active = v; this.onState(v); }

  _start() {
    if (!this.wanted) return;
    const rec = new SR();
    this.rec = rec;
    const sid = ++this.session;
    rec.lang = 'ru-RU';
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    const startedAt = Date.now();
    rec.onstart = () => this._setActive(true);
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        this.onResult({ id: `${sid}:${i}`, text: r[0].transcript, final: r.isFinal });
      }
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.wanted = false;
        this.onFatal(e.error === 'not-allowed'
          ? 'Доступ к микрофону запрещён. Разрешите микрофон для сайта в настройках браузера.'
          : 'Распознавание речи недоступно на этом устройстве. Пользуйтесь кнопкой СТОП и вводом текста.');
      } else if (e.error === 'network') {
        this.backoff = Math.min(this.backoff * 2, 5000);
      } else if (e.error === 'audio-capture') {
        this.backoff = 3000;
      }
    };
    rec.onend = () => {
      if (this.rec === rec) this.rec = null;
      this._setActive(false);
      if (!this.wanted) return;
      // быстрые обрывы подряд — увеличиваем задержку перезапуска
      if (Date.now() - startedAt < 1000) this.backoff = Math.min(this.backoff * 2, 4000);
      else this.backoff = 250;
      this.timer = setTimeout(() => this._start(), this.backoff);
    };
    try { rec.start(); } catch {
      this.timer = setTimeout(() => this._start(), 1000);
    }
  }
}

// ---------- Wake Lock ----------

let wakeLock = null;
let wakeWanted = false;
export async function keepAwake(on) {
  wakeWanted = on;
  if (!('wakeLock' in navigator)) return;
  try {
    if (on && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { /* например, вкладка не активна */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wakeWanted) keepAwake(true);
});
