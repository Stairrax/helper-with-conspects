// Синтез речи (системный SpeechSynthesis или нейросетевой Piper), распознавание (SpeechRecognition),
// команды и защита от эха.

import * as neural from './neural.js';
import * as cloud from './cloud.js';

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

// ---------- Выбор движка ----------

let engine = 'system';        // 'system' | 'neural' | 'cloud'
let cloudCfg = null;          // { provider, voice, key, url, model }
let failures = 0;             // подряд неудачных фраз нейро/облачного голоса
let neuralVoice = 'irina';
let voiceStyle = 'none';      // 'none' | 'jarvis'

export function setStyle(style) { voiceStyle = neural.VOICE_STYLES[style] ? style : 'none'; }
const stylePitch = () => neural.VOICE_STYLES[voiceStyle].pitch;
// Тон понижаем замедлением воспроизведения, а скорость речи компенсируем при синтезе.
const neuralRate = (rate) => rate / stylePitch();
let onNeuralError = () => {};

export function setEngine(kind, voice, onError) {
  engine = kind === 'neural' || kind === 'cloud' ? kind : 'system';
  if (voice) neuralVoice = voice;
  if (onError) onNeuralError = onError;
  failures = 0;
}

export function setCloud(cfg) { cloudCfg = cfg; }

/** Сбой нейро/облачного голоса: эту фразу говорим голосом Android; после трёх сбоев подряд (или ошибки ключа) — сообщаем. */
function engineFailed(err, text, opts, resolve) {
  failures++;
  if (err?.fatal || failures >= 3) { failures = 0; onNeuralError(err); }
  speakSystem(text, opts).then(resolve);
}

/** Готовит следующие куски заранее (только для нейроголоса — системному не нужно). */
export function prefetch(texts, { rate = 1 } = {}) {
  if (engine === 'neural') for (const t of texts) if (t) neural.synth(t, { voice: neuralVoice, rate: neuralRate(rate) }).catch(() => {});
  if (engine === 'cloud' && cloudCfg) {
    const cfg = { ...cloudCfg, speed: cloud.speedPlan(cloudCfg.provider, rate).speed };
    for (const t of texts) if (t) cloud.audioFor(cfg, t).catch(() => {});
  }
}

/** Произносит текст. Promise -> 'end' | 'cancel' | 'error'. */
export function speak(text, opts = {}) {
  if (engine === 'neural') return speakNeural(text, opts);
  if (engine === 'cloud' && cloudCfg) return speakCloud(text, opts);
  return speakSystem(text, opts);
}

function speakCloud(text, opts) {
  const { rate = 1, onStart, echoTail = 900 } = opts;
  const myEpoch = epoch;
  return new Promise((resolve) => {
    const rec = remember(text, echoTail);
    let done = false, audio = null, url = null, wd = null, slow = null;
    const fin = (r) => {
      if (done) return;
      done = true;
      clearTimeout(wd); // снимает и setTimeout, и setInterval
      clearTimeout(slow);
      rec.end = Date.now();
      if (current?.fin === fin) current = null;
      if (audio) { audio.onended = audio.onerror = audio.onpause = null; audio.pause(); }
      if (url) URL.revokeObjectURL(url);
      if (r === 'end') failures = 0;
      resolve(r);
    };
    current = { fin, text };
    const fail = (err) => {
      if (done || myEpoch !== epoch) return fin('cancel');
      done = true;
      clearTimeout(slow);
      if (current?.fin === fin) current = null;
      recent.splice(recent.indexOf(rec), 1);
      engineFailed(err, text, opts, resolve);
    };
    // сервис молчит слишком долго (плохая связь) — эту фразу говорим голосом Android, а не стоим в тишине
    slow = setTimeout(() => { if (!audio) fail(new Error('облачный голос слишком долго не отвечает')); }, 8000);
    const plan = cloud.speedPlan(cloudCfg.provider, rate);
    cloud.audioFor({ ...cloudCfg, speed: plan.speed }, text).then((blob) => {
      if (done || myEpoch !== epoch) return fin('cancel');
      url = URL.createObjectURL(blob);
      audio = new Audio(url);
      audio.preservesPitch = true;  // скорость меняем без изменения тона
      audio.playbackRate = plan.playbackRate; // для Яндекса — 1: скорость уже задана при синтезе, без искажений
      audio.onended = () => fin('end');
      audio.onerror = () => fail(new Error('не удалось воспроизвести звук'));
      // «Чёткость голоса»: звук идёт через эквалайзер — только если звуковой контекст уже работает, иначе была бы тишина
      if (cloudCfg.clarity) {
        try {
          const ac = neural.audioContext();
          if (ac.state === 'running') ac.createMediaElementSource(audio).connect(neural.clarityInput());
        } catch { /* играем как есть */ }
      }
      // Android ставит звук на паузу, когда кто-то занимает аудио (микрофон, уведомление), — продолжаем с того же места
      audio.onpause = () => setTimeout(() => { if (!done && audio.paused && !audio.ended) audio.play().catch(() => {}); }, 250);
      audio.play().then(() => {
        onStart?.();
        // сторож по реальному ходу воспроизведения: пауза системы не обрывает кусок, а зависание — повторяется с начала
        let last = -1, still = Date.now();
        wd = setInterval(() => {
          if (done) return;
          if (audio.ended) return fin('end');
          if (audio.currentTime !== last) { last = audio.currentTime; still = Date.now(); return; }
          if (audio.paused) audio.play().catch(() => {});
          if (Date.now() - still > 8000) fin('error');
        }, 500);
      }).catch(async (err) => {
        // браузер не дал запустить звук элементом <audio> — играем через Web Audio (он разблокирован касанием)
        if (done || myEpoch !== epoch) return fin('cancel');
        try {
          const ac = neural.audioContext();
          const buf = await ac.decodeAudioData(await blob.arrayBuffer());
          if (done || myEpoch !== epoch) return fin('cancel');
          const src = ac.createBufferSource();
          src.buffer = buf;
          src.connect(cloudCfg.clarity ? neural.clarityInput() : ac.destination);
          src.onended = () => fin('end');
          audio = { pause: () => { try { src.stop(); } catch { /* ignore */ } } };
          onStart?.();
          src.start();
          wd = setTimeout(() => fin('end'), buf.duration * 1000 + 5000);
        } catch { fail(err); }
      });
    }).catch(fail);
  });
}

function remember(text, echoTail) {
  // короткое окно (< 0,5 с) — реплика, на которую ждём ответ («Продолжаем?»)
  const rec = { text, start: Date.now(), end: 0, tail: echoTail, prompt: echoTail < 500 };
  recent.push(rec);
  while (recent.length > 10) recent.shift();
  return rec;
}

function speakNeural(text, opts) {
  const { rate = 1, onStart, echoTail = 900 } = opts;
  const myEpoch = epoch;
  return new Promise((resolve) => {
    const rec = remember(text, echoTail);
    let done = false, src = null, wd = null;
    const fin = (r) => {
      if (done) return;
      done = true;
      clearTimeout(wd);
      rec.end = Date.now();
      if (current?.fin === fin) current = null;
      try { src?.stop(); } catch { /* уже остановлен */ }
      if (r === 'cancel') neural.cutTail();
      if (r === 'end') failures = 0;
      resolve(r);
    };
    current = { fin, text };
    const pitch = stylePitch();
    neural.synth(text, { voice: neuralVoice, rate: neuralRate(rate) }).then((buf) => {
      if (done || myEpoch !== epoch) return fin('cancel');
      const ac = neural.audioContext();
      src = ac.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = pitch;
      src.connect(neural.outputFor(voiceStyle));
      neural.restoreOut();
      src.onended = () => fin('end');
      onStart?.();
      src.start();
      // если звук не пошёл (контекст заблокирован) — сообщаем об ошибке, а не висим
      wd = setTimeout(() => fin(ac.state === 'running' ? 'end' : 'error'), (buf.duration / pitch) * 1000 + 4000);
    }).catch((err) => {
      if (done || myEpoch !== epoch) return fin('cancel');
      done = true;
      if (current?.fin === fin) current = null;
      recent.splice(recent.indexOf(rec), 1);
      // заготовка старым голосом после смены голоса — просто синтезируем заново
      if (err?.stale) { speakNeural(text, opts).then(resolve); return; }
      // нейроголос не сработал — эту фразу говорим голосом Android, чтобы диктовка не останавливалась
      engineFailed(err, text, opts, resolve);
    });
  });
}

function speakSystem(text, { rate = 1, voiceURI = '', onStart, echoTail = 900 } = {}) {
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
      if (voiceStyle === 'jarvis') u.pitch = 0.8; // голосу Android можно только понизить тон
      const rec = remember(text, echoTail);
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
  epoch++;
  const c = current;
  current = null;
  if (ttsSupported) synth.cancel();
  lastCancelAt = Date.now();
  if (c) c.fin('cancel');
  keepAlive = null;
}

// ---------- Нормализация и защита от эха ----------

export function norm(s) {
  return String(s).toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}
const stem = (w) => w.slice(0, 5);

const ECHO_LATE_MS = 25000;

/** Доля слов, идущих в том же порядке, что и в озвученном тексте (первое слово обязано оттуда быть). */
function orderedMatch(words, spoken) {
  const src = spoken.flatMap((r) => norm(r.text).split(' ')).filter((x) => x.length > 1).map(stem);
  const set = new Set(src);
  if (!set.has(words[0])) return 0;
  if (words.length <= 2) return words.every((x) => set.has(x)) ? 1 : 0;
  let j = 0, matched = 0;
  for (const x of words) {
    const k = src.indexOf(x, j);
    if (k >= 0) { matched++; j = k + 1; }
  }
  return matched / words.length;
}

/**
 * true, если распознанный текст похож на только что произнесённое синтезатором:
 * слова идут в том же порядке, что и в озвученном тексте, и первое слово тоже оттуда.
 * Вопрос («почему…», «а что…») эхом не считается, даже если повторяет термины из куска.
 * late: заодно отсеивать запоздавшее распознавание и то, как студент вполголоса повторяет
 * продиктованное, пока пишет (до 25 с назад, только фразы от трёх слов и почти дословно).
 * since: когда включился микрофон — то, что отзвучало раньше, он услышать не мог.
 */
export function isEcho(text, late = false, since = 0) {
  const now = Date.now();
  const words = norm(text).split(' ').filter((x) => x.length > 1).map(stem);
  const live = recent.filter((r) => (!r.end || now - r.end < r.tail) && (!r.end || r.end > since));
  if (live.length && (!words.length || orderedMatch(words, live) >= 0.7)) return true;
  if (!late || words.length < 3) return false;
  const old = recent.filter((r) => r.end && now - r.end < ECHO_LATE_MS);
  return old.length > 0 && orderedMatch(words, old) >= 0.8;
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
  // «записал» — студент дописал предыдущий кусок: в паузе это «дальше», а во время чтения нового куска его не пропускаем
  ['written', w('записал[аи]?|записано|написал[аи]?|готово|успел[аи]?')],
  ['next', w('дальше|следующий|следующее|пропусти(?:те)?|далее')],
];
const SPELL = w('по буквам|как пишется|как это пишется|как писать|по слогам');

/** Короткая фраза -> команда или null. */
export function matchCommand(text) {
  const t = norm(text);
  if (!t) return null;
  if (t.split(' ').length <= 6 && SPELL.test(t)) return 'spell';
  if (t.split(' ').length > 4) return null;
  for (const [name, re] of COMMANDS) if (re.test(t)) return name;
  return null;
}

const YES = w('да|ага|угу|конечно|давай(?:те)?|продолжа[а-я]*|продолжи|дальше|поехали|ок|окей|хорошо|го|можно|вперед');
const NO = w('нет|не надо|не|стоп|подожди(?:те)?|погоди');
export const isYes = (t) => { const n = norm(t); return n.split(' ').length <= 4 && YES.test(n) && !/(?:^|\s)нет(?=\s|$)/.test(n); };
export const isNo = (t) => { const n = norm(t); return n.split(' ').length <= 3 && NO.test(n); };

/** Слово, которое просят продиктовать по буквам («как пишется фотосинтез» -> «фотосинтез»). */
export function spellTarget(text) {
  const m = String(text).match(/(?:пишется|писать|по буквам|по слогам)\s+(?:слово\s+)?(.+)$/i);
  return m ? m[1].replace(/[?.!,]+$/g, '').trim() : '';
}

// ---------- Склейка распознанного текста ----------

/** Остаток raw после prefix (по словам, без учёта регистра и знаков) или null, если raw с него не начинается. */
function afterPrefix(raw, prefix) {
  const pw = norm(prefix).split(' ').filter(Boolean);
  const tokens = String(raw).trim().split(/\s+/);
  let j = 0, k = 0;
  while (k < tokens.length && j < pw.length) {
    const n = norm(tokens[k]);
    if (!n) { k++; continue; }
    const parts = n.split(' ');
    if (!parts.every((p, q) => pw[j + q] === p)) return null;
    j += parts.length;
    k++;
  }
  return j >= pw.length ? tokens.slice(k).join(' ') : null;
}

/**
 * Склеивает распознанные куски речи без повторов. Chrome на Android присылает текст с наложением:
 * следующий кусок повторяет предыдущий целиком или частично, иногда чуть исправленным.
 */
export function mergeText(buf, part) {
  buf = String(buf || '').trim();
  part = String(part || '').trim();
  if (!buf || !norm(buf)) return part;
  if (!part || !norm(part)) return buf;
  if (afterPrefix(part, buf) !== null) return part; // новый кусок уже содержит всё сказанное
  const bw = norm(buf).split(' '), pw = norm(part).split(' ');
  if (pw.length <= bw.length && bw.slice(-pw.length).join(' ') === pw.join(' ')) return buf; // повтор конца
  // исправленный вариант всего сказанного: почти все слова (по основам) на месте и в том же порядке
  if (bw.length >= 3) {
    const ps = pw.map(stem);
    let j = 0, matched = 0;
    for (const x of bw.map(stem)) {
      const k = ps.indexOf(x, j);
      if (k >= 0 && k < j + 3) { matched++; j = k + 1; }
    }
    if (matched / bw.length >= 0.8) return part;
  }
  // конец сказанного совпадает с началом нового куска (от двух слов)
  for (let k = Math.min(bw.length, pw.length - 1); k >= 2; k--) {
    if (bw.slice(-k).join(' ') === pw.slice(0, k).join(' ')) {
      const rest = afterPrefix(part, pw.slice(0, k).join(' '));
      if (rest) return `${buf} ${rest}`;
    }
  }
  return `${buf} ${part}`;
}

export const isDontKnow = (t) => /^(я )?(не знаю|не помню|забыл[аи]?|без понятия|понятия не имею|сдаюсь|подскажи)/.test(norm(t));

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
    this.held = false;
    this.offAt = 0;      // когда микрофон в последний раз выключился
  }

  start() {
    if (!SR || this.wanted) return;
    this.wanted = true;
    // запуск — следующим шагом: если сразу за ним заговорит голос, микрофон даже не включится
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this._start(), 0);
  }

  /** Сколько мс микрофон уже выключен (0 — работает сейчас). */
  quietFor() {
    if (this.active || this.rec) return 0;
    return this.offAt ? Date.now() - this.offAt : Infinity;
  }

  /**
   * Пауза микрофона на время речи. На Android включённое распознавание забирает звук себе:
   * голос прерывается, глохнет и звучит «как по телефону».
   */
  hold(on) {
    on = !!on;
    if (on === this.held) return;
    this.held = on;
    clearTimeout(this.timer);
    if (on) {
      const rec = this.rec;
      this.rec = null;
      if (rec) this.offAt = Date.now();
      try { rec?.abort(); } catch { /* ignore */ }
      if (this.active) this._setActive(false);
    } else if (this.wanted && !this.rec) {
      this.backoff = 250;
      this._start();
    }
  }

  stop() {
    this.wanted = false;
    clearTimeout(this.timer);
    if (this.rec) this.offAt = Date.now();
    try { this.rec?.abort(); } catch { /* ignore */ }
    this.rec = null;
    this._setActive(false);
  }

  _setActive(v) {
    if (this.active && !v) this.offAt = Date.now();
    this.active = v;
    this.onState(v);
  }

  _start() {
    if (!this.wanted || this.held || this.rec) return;
    const rec = new SR();
    this.rec = rec;
    const sid = ++this.session;
    let phrase = 0;   // номер фразы в сессии: промежуточный и финальный варианты одной фразы получают один id
    let last = null;  // последний финальный результат сессии: { text, at }
    rec.lang = 'ru-RU';
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    const startedAt = Date.now();
    rec.onstart = () => { if (this.rec === rec) this._setActive(true); };
    rec.onresult = (e) => {
      if (this.rec !== rec) return; // результат уже остановленной сессии
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const raw = r[0].transcript;
        let text = raw;
        // Android: каждый следующий результат повторяет всё, что сказано раньше, — оставляем только новое
        const before = i > 0 ? e.results[i - 1] : null;
        const prev = before?.isFinal ? before[0]?.transcript : last?.text;
        if (prev) {
          const rest = afterPrefix(raw, prev);
          if (rest !== null) {
            if (!norm(rest)) {
              // тот же финальный результат пришёл ещё раз; через пару секунд это уже новая такая же фраза
              if (r.isFinal && (!last || Date.now() - last.at < 2000)) { if (last) last.at = Date.now(); continue; }
              if (!r.isFinal) continue;
            } else text = rest;
          }
        }
        this.onResult({ id: `${sid}:${phrase}`, text, final: r.isFinal, since: startedAt });
        if (r.isFinal) { last = { text: raw, at: Date.now() }; phrase++; }
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
      // сессия, которую мы сами остановили (стоп/пауза на время речи), — новую не запускаем, она уже есть или не нужна
      if (this.rec !== rec) return;
      this.rec = null;
      this._setActive(false);
      if (!this.wanted || this.held) return;
      // быстрые обрывы подряд — увеличиваем задержку перезапуска
      if (Date.now() - startedAt < 1000) this.backoff = Math.min(this.backoff * 2, 4000);
      else this.backoff = 250;
      this.timer = setTimeout(() => this._start(), this.backoff);
    };
    try { rec.start(); } catch {
      this.rec = null;
      this.timer = setTimeout(() => this._start(), 1000);
    }
  }
}

// ---------- Bluetooth-наушники ----------
// Обычные Bluetooth-наушники не умеют одновременно хороший звук и микрофон: как только телефон включает
// микрофон, они переходят в режим гарнитуры — голос звучит «как по телефону». Узнаём о них по списку
// устройств (названия видны, когда микрофон разрешён).

let btHeadset = false;
const btListeners = new Set();
export const hasBtHeadset = () => btHeadset;
export function onBtChange(fn) { btListeners.add(fn); }

export async function checkAudioDevices() {
  try {
    const list = await navigator.mediaDevices.enumerateDevices();
    const bt = list.some((d) => /bluetooth|hands-?free/i.test(d.label));
    if (bt !== btHeadset) {
      btHeadset = bt;
      btListeners.forEach((fn) => { try { fn(bt); } catch { /* ignore */ } });
    }
  } catch { /* список устройств недоступен */ }
}
if (navigator.mediaDevices?.enumerateDevices) {
  checkAudioDevices();
  navigator.mediaDevices.addEventListener?.('devicechange', checkAudioDevices);
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
