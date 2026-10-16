// Движок диктовки: озвучка кусков, паузы, мгновенное прерывание, вопросы и возврат к прерванному куску,
// самопроверка после темы, быстрое повторение, «по буквам», перерывы.

import {
  speak, stopSpeaking, prefetch, isEcho, matchCommand, isYes, isNo, looksLikeQuestion, stripCue, norm, mergeText,
  spellTarget, isDontKnow, Recognizer, srSupported, keepAwake,
} from './speech.js';
import { stream, conn } from './ai.js';
import { activeSeq, pauseFor } from './analyze.js';

const DICTATING = ['speaking', 'gap', 'waiting'];
const QA_STATES = ['thinking', 'answering'];
const PAUSED = ['paused', 'listening', 'confirm', 'topicEnd', 'break'];
const MAX_CONTEXT = 400000;
const DAY = 24 * 3600 * 1000;
const BREAK_MS = 5 * 60 * 1000;
const CMD_REPEAT_MS = 1500;    // одна и та же команда голосом чаще не выполняется (распознавание присылает её дважды)
const FALSE_STOP_MS = 6000;    // остановились «на вопрос», а вопроса так и не было — продолжаем сами

export const STATE_TEXT = {
  idle: 'Готов к диктовке',
  speaking: 'Диктую',
  gap: 'Записывайте',
  waiting: 'Готовлю следующую тему…',
  paused: 'Пауза',
  listening: 'Слушаю вопрос — или скажите «продолжай»',
  thinking: 'Думаю над ответом…',
  answering: 'Отвечаю',
  confirm: 'Продолжаем? Скажите «да» или задайте ещё вопрос',
  topicEnd: 'Тема закончена. Есть вопросы?',
  finished: 'Диктовка завершена',
  quiz: 'Самопроверка',
  quizListen: 'Ваш ответ? Можно сказать «не знаю» или «пропусти»',
  quizGrade: 'Проверяю ответ…',
  spelling: 'Диктую по буквам',
  reviewing: 'Быстрое повторение',
  break: 'Перерыв',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- По буквам ----------

const RU_LETTERS = {
  а: 'а', б: 'бэ', в: 'вэ', г: 'гэ', д: 'дэ', е: 'е', ё: 'ё', ж: 'жэ', з: 'зэ', и: 'и', й: 'и краткое', к: 'ка',
  л: 'эль', м: 'эм', н: 'эн', о: 'о', п: 'пэ', р: 'эр', с: 'эс', т: 'тэ', у: 'у', ф: 'эф', х: 'ха', ц: 'цэ',
  ч: 'че', ш: 'ша', щ: 'ща', ъ: 'твёрдый знак', ы: 'ы', ь: 'мягкий знак', э: 'э', ю: 'ю', я: 'я',
};
const EN_LETTERS = {
  a: 'эй', b: 'би', c: 'си', d: 'ди', e: 'и', f: 'эф', g: 'джи', h: 'эйч', i: 'ай', j: 'джей', k: 'кей', l: 'эль', m: 'эм',
  n: 'эн', o: 'оу', p: 'пи', q: 'кью', r: 'ар', s: 'эс', t: 'ти', u: 'ю', v: 'ви', w: 'дабл ю', x: 'экс', y: 'уай', z: 'зед',
};

export function spellOut(word) {
  const letters = [...word].map((ch) => {
    const low = ch.toLowerCase();
    const name = RU_LETTERS[low] || EN_LETTERS[low] || (ch === '-' ? 'дефис' : /\d/.test(ch) ? ch : '');
    if (!name) return '';
    return ch !== low ? `заглавная ${name}` : name;
  }).filter(Boolean);
  return `${word}. По буквам: ${letters.join(', ')}. Ещё раз: ${word}.`;
}

/** Термины из куска, которые стоит продиктовать по буквам. */
function pickTerms(text) {
  const words = (String(text).match(/[A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё-]*/g) || []);
  const terms = words.filter((w, i) => w.length >= 9 || /[A-Za-z]/.test(w) || (i > 0 && /^[А-ЯЁ]/.test(w) && w.length >= 4));
  const uniq = [...new Set((terms.length ? terms : words.filter((w) => w.length >= 6)).map((w) => w.replace(/-+$/, '')))];
  return uniq.sort((a, b) => b.length - a.length).slice(0, 2);
}

export class Dictation {
  /**
   * hooks: getProject(), getSettings(), saveSettings(), progress (объект), saveProgress(),
   *        emit(), toast(msg), kickGenerator(), onActivity(playing)
   */
  constructor(hooks) {
    this.h = hooks;
    this.state = 'idle';
    this.mode = 'dictate';      // 'dictate' | 'review'
    this.token = 0;
    this.resumePos = null;
    this.lastSpoken = null;
    this.announced = null;
    this.gap = null;
    this.pendingGap = false;
    this.heard = '';
    this.message = '';
    this.qBuf = '';
    this.qTimer = null;
    this.consumed = new Set();
    this.answerCtrl = null;
    this.micForced = false;
    this.quiz = null;
    this.waiter = null;
    this.review = null;
    this.breakUntil = 0;
    this.cur = null;            // кусок, который сейчас звучит: { topicId, chunk }
    this.lastCmd = null;        // последняя голосовая команда: { cmd, at }
    this.holdDepth = 0;
    this.holdTimer = null;
    this.autoTimer = null;
    this.rec = new Recognizer({
      onResult: (r) => this.onSpeech(r),
      onState: (on) => { this.micOn = on; this.h.emit(); },
      onFatal: (msg) => { this.micError = msg; this.h.toast(msg); this.h.emit(); },
    });
    setInterval(() => {
      if (!this.h.progress || this.state === 'idle' || this.state === 'finished') return;
      const p = this.h.progress;
      p.elapsedMs = (p.elapsedMs || 0) + 1000;
      if (DICTATING.includes(this.state) || this.state === 'reviewing') p.sinceBreakMs = (p.sinceBreakMs || 0) + 1000;
      if (p.elapsedMs % 5000 === 0) this.h.saveProgress();
    }, 1000);
  }

  get pos() { return this.h.progress; }
  get settings() { return this.h.getSettings(); }
  get project() { return this.h.getProject(); }
  get qa() { return (this.h.progress.qa ||= []); }

  /** Обращение к студенту («, сэр») — если выбрано в настройках. */
  get a() { const x = this.settings.address; return x ? `, ${x}` : ''; }

  /** Дополнение к инструкции нейросети: манера ассистента. */
  get manner() {
    const x = this.settings.address;
    return x ? ` Говори в манере вежливого и немного ироничного ИИ-ассистента, обращайся к студенту «${x}».` : '';
  }

  /** Сохраняет прогресс и место в текущей теме (чтобы вернуться к ней с того же куска). */
  save() {
    const p = this.pos;
    if (p.topicId) (p.topicPos ||= {})[p.topicId] = p.chunk;
    this.h.saveProgress();
  }

  set(state, message = '') {
    this.state = state;
    this.message = message;
    this.h.onActivity?.(DICTATING.includes(state) || state === 'reviewing' || state === 'spelling');
    this.h.emit();
  }

  // ---------- Статистика и повторение ----------

  stat(id) {
    const all = (this.pos.stats ||= {});
    return (all[id] ||= { asked: 0, right: 0, total: 0 });
  }

  /** Назначает дату повторения: слабые темы — завтра, остальные — через 3 дня, после повторений — реже. */
  schedule(id, fromReview = false) {
    const st = this.stat(id);
    const score = st.total ? st.right / st.total : 1;
    st.weak = score < 0.7 || st.asked >= 2;
    if (fromReview) st.interval = Math.min(30, Math.max(1, (st.interval || 1) * (st.weak ? 1.2 : 2.5)));
    else st.interval = st.weak ? 1 : 3;
    st.studiedAt = Date.now();
    st.due = Date.now() + st.interval * DAY;
    this.h.saveProgress();
  }

  // ---------- Навигация по темам ----------

  seq() { return this.project ? activeSeq(this.project) : []; }

  topicById(id) { return this.project?.topics.find((t) => t.id === id) || null; }

  currentTopic() {
    const seq = this.seq();
    let t = seq.find((x) => x.id === this.pos.topicId);
    if (!t) {
      t = seq.find((x) => !this.pos.done?.[x.id]) || null;
      this.pos.topicId = t?.id || null;
      this.pos.chunk = 0;
    }
    return t;
  }

  nextTopicId(id) {
    const seq = this.seq();
    const i = seq.findIndex((x) => x.id === id);
    if (i >= 0) return seq[i + 1]?.id || null;
    return seq.find((x) => x.id !== id && !this.pos.done?.[x.id])?.id || null;
  }

  // ---------- Микрофон ----------

  mic(force) {
    if (!srSupported) return;
    if (force) this.micForced = true;
    if (this.settings.voiceCommands || this.micForced) this.rec.start();
  }

  micAfterResume() {
    this.micForced = false;
    if (!this.settings.voiceCommands) this.rec.stop();
  }

  /** Пока звучит голос, микрофон выключен (если не включено «Слушать, пока говорю»). after — через сколько включить снова. */
  holdMic(on, after = 350) {
    if (on) {
      this.holdDepth++;
      clearTimeout(this.holdTimer);
      if (!this.settings.listenWhileSpeaking) this.rec.hold(true);
      return;
    }
    this.holdDepth = Math.max(0, this.holdDepth - 1);
    if (this.holdDepth) return;
    clearTimeout(this.holdTimer);
    // между фразами подряд микрофон не дёргаем — включаем, только если голос действительно замолчал
    this.holdTimer = setTimeout(() => { if (!this.holdDepth) this.rec.hold(false); }, after);
  }

  // ---------- Основной цикл ----------

  start() {
    if (!this.project) return;
    keepAwake(true);
    if (this.state === 'finished') {
      this.pos.done = {};
      this.pos.topicId = null;
      this.pos.chunk = 0;
    }
    if (PAUSED.includes(this.state)) return this.resume();
    if (DICTATING.includes(this.state)) return;
    if (this.state === 'idle' && this.pos.review?.ids?.length) return this.startReview(this.pos.review.ids, this.pos.review.i);
    this.mode = 'dictate';
    this.resumeNote = this.state === 'idle';
    this.mic(false);
    this.run();
  }

  /** Тема, которая сейчас на экране (по ней и перематываем). */
  seekTopic() {
    if (this.state === 'topicEnd') return this.topicById(this.lastSpoken?.topicId) || this.currentTopic();
    return this.topicById(this.resumePos?.topicId) || this.currentTopic();
  }

  /** Перемотка к куску i текущей темы. */
  seek(i) {
    const t = this.seekTopic();
    if (!t || t.status !== 'ready' || !t.chunks.length) return;
    i = Math.max(0, Math.min(t.chunks.length - 1, Math.round(i)));
    const st = this.state;
    const active = DICTATING.includes(st);
    stopSpeaking();
    this.token++;
    this.gap = null;
    this.resolveWaiter(null);
    this.abortAnswer();
    this.clearQuestion();
    this.quiz = null;
    this.mode = 'dictate';
    this.review = null;
    this.pos.topicId = t.id;
    this.pos.chunk = i;
    this.announced = t.id;
    this.endedTopic = null;
    this.resumePos = null;
    this.save();
    if (active) return this.run();
    if (st === 'idle' || st === 'finished') return this.set('idle');
    this.resumePos = { topicId: t.id, chunk: i, partial: true }; // «повтори» — именно выбранный кусок
    this.set('paused');
  }

  async run() {
    const my = ++this.token;
    try {
      await this.loop(my);
    } catch (e) {
      if (my !== this.token) return;
      console.error(e);
      this.token++;
      stopSpeaking();
      this.set('paused', 'Сбой диктовки: ' + (e.message || e) + '. Нажмите «Продолжить».');
    }
  }

  async loop(my) {
    keepAwake(true);
    this.micAfterResume();
    this.mic(false);
    while (my === this.token) {
      this.cur = null;
      const topic = this.currentTopic();
      if (!topic) return this.finish(my);
      if (topic.status !== 'ready') {
        this.h.kickGenerator();
        this.set('waiting', topic.status === 'error' ? 'Ошибка подготовки темы: ' + (topic.error || '') : '');
        await sleep(400);
        continue;
      }
      // после «по буквам» в паузе — снова даём время записать
      if (this.pendingGap) {
        this.pendingGap = false;
        const prev = topic.chunks[Math.max(0, this.pos.chunk - 1)];
        if (!(await this.doGap(my, topic, prev?.t))) return;
      }
      if (this.pos.chunk >= topic.chunks.length) {
        // тема уже закончена (например, после вопроса к последней теме) — не повторяем самопроверку
        if (this.endedTopic === topic.id) {
          const n = this.nextTopicId(topic.id);
          if (!n) return this.finish(my);
          this.pos.topicId = n;
          this.pos.chunk = 0;
          continue;
        }
        return this.endOfTopic(my, topic);
      }
      if (this.pos.chunk === 0 && this.endedTopic === topic.id) this.endedTopic = null; // тему начали заново
      if (this.needBreak()) return this.takeBreak(my);
      if (this.pos.chunk === 0 && this.announced !== topic.id) {
        this.set('speaking');
        const r = await this.say(`Тема: ${topic.title}.`);
        if (my !== this.token) return;
        if (r === 'end') this.announced = topic.id;
        await sleep(600);
        if (my !== this.token) return;
      }
      // вернулись к занятию с середины темы — напоминаем, где мы
      if (this.resumeNote && this.pos.chunk > 0) {
        this.resumeNote = false;
        this.set('speaking');
        await this.say(`Продолжаем тему «${topic.title}».`);
        if (my !== this.token) return;
        await sleep(400);
        if (my !== this.token) return;
      }
      this.resumeNote = false;
      const idx = this.pos.chunk;
      const chunk = topic.chunks[idx];
      this.set('speaking');
      this.save();
      prefetch(topic.chunks.slice(idx + 1, idx + 4).map((c) => c.t), { rate: this.settings.rate });
      this.cur = { topicId: topic.id, chunk: idx };
      let r = await this.say(chunk.t);
      if (my !== this.token) return;
      if (r === 'error') {
        await sleep(300);
        if (my !== this.token) return;
        r = await this.say(chunk.t);
        if (my !== this.token) return;
        if (r === 'error') {
          this.resumePos = { topicId: topic.id, chunk: idx };
          this.token++;
          return this.set('paused', 'Синтез речи не отвечает. Нажмите «Продолжить». Проверьте, установлен ли русский голос.');
        }
      }
      this.cur = null;
      this.lastSpoken = { topicId: topic.id, chunk: idx };
      this.pos.chunk = idx + 1;
      this.pos.spoken = (this.pos.spoken || 0) + 1;
      // кусок прошёл без «повтори» — пауза понемногу возвращается к обычной
      this.pos.pauseBoost = Math.max(1, (this.pos.pauseBoost || 1) * 0.97);
      this.save();
      if (!(await this.doGap(my, topic, chunk.t))) return;
    }
  }

  /** Пауза после куска: по времени или пока не скажут «дальше». false — если прервали. */
  async doGap(my, topic, text) {
    if (this.settings.pauseMode === 'wait') {
      this.gap = { wait: true };
      this.set('gap', 'Скажите «дальше» или нажмите ⏭, когда запишете');
      while (my === this.token) await sleep(150);
      this.gap = null;
      return false; // продолжит next()
    }
    const boost = this.settings.adaptivePause ? (this.pos.pauseBoost || 1) : 1;
    const ms = Math.round(pauseFor(topic, text, this.settings) * boost);
    this.gap = { start: Date.now(), ms };
    this.set('gap');
    const end = Date.now() + ms;
    while (Date.now() < end && my === this.token) await sleep(100);
    this.gap = null;
    return my === this.token;
  }

  /** prompt: короткая реплика, на которую ждём ответ, — окно защиты от эха после неё минимальное. */
  async say(text, prompt = false, rateK = 1) {
    const s = this.settings;
    this.holdMic(true);
    try {
      return await speak(text, { rate: Math.min(2, s.rate * rateK), voiceURI: s.voiceURI, echoTail: prompt ? 250 : 900 });
    } finally {
      this.holdMic(false, prompt ? 0 : 350); // после «Продолжаем?» ответ ждём сразу
    }
  }

  async endOfTopic(my, topic) {
    this.endedTopic = topic.id;
    if (this.pos.topicPos) delete this.pos.topicPos[topic.id];
    this.pos.done = this.pos.done || {};
    this.pos.done[topic.id] = true;
    const nextId = this.nextTopicId(topic.id);
    this.resumePos = nextId ? { topicId: nextId, chunk: 0 } : null;
    this.schedule(topic.id);
    if (this.settings.selfCheck && topic.quiz?.length) {
      await this.runQuiz(my, topic);
      if (my !== this.token) return;
    }
    if (!nextId) return this.finish(my);
    this.set('topicEnd');
    await this.say(`Тема «${topic.title}» завершена${this.a}. Есть вопросы?`, true);
    if (my !== this.token) return;
    if (this.settings.mode === 'all') {
      // короткая пауза на вопросы, потом — дальше
      const end = Date.now() + 6000;
      while (Date.now() < end && my === this.token && this.state === 'topicEnd') await sleep(100);
      if (my === this.token && this.state === 'topicEnd') this.resume();
    }
  }

  async finish(my) {
    this.pos.topicId = null;
    this.pos.chunk = 0;
    this.resumePos = null;
    this.h.saveProgress();
    this.set('finished');
    await this.say(`Диктовка завершена${this.a}. Если остались вопросы — нажмите «Стоп, вопрос».`);
    if (my !== this.token) return;
    keepAwake(false);
    this.micForced = false;
    this.rec.stop();
  }

  // ---------- Перерывы ----------

  needBreak() {
    const every = +this.settings.breakEvery || 0;
    return every > 0 && (this.pos.sinceBreakMs || 0) >= every * 60000;
  }

  async takeBreak(my) {
    const minutes = Math.round((this.pos.sinceBreakMs || 0) / 60000);
    this.pos.sinceBreakMs = 0;
    this.resumePos = { topicId: this.pos.topicId, chunk: this.pos.chunk };
    this.breakUntil = Date.now() + BREAK_MS;
    this.set('break', 'Отдохните 5 минут. Скажите «продолжай», если хотите раньше.');
    await this.say(`Вы занимаетесь уже ${minutes} минут${this.a}. Сделайте перерыв пять минут: встаньте, разомнитесь, попейте воды. Я напомню, когда пора продолжать.`);
    while (my === this.token && Date.now() < this.breakUntil) await sleep(500);
    if (my !== this.token) return;
    this.breakUntil = 0;
    this.set('confirm');
    await this.say(`Перерыв окончен${this.a}. Продолжаем?`, true);
  }

  // ---------- Самопроверка ----------

  async runQuiz(my, topic) {
    const qs = topic.quiz.slice(0, 3);
    this.quiz = { topic, qs, i: 0, results: [] };
    this.set('quiz');
    await this.say(`Самопроверка по теме «${topic.title}». ${qs.length === 1 ? 'Один вопрос' : `${qs.length} вопроса`}. Отвечайте вслух или текстом. Можно сказать «не знаю» или «пропусти».`);
    for (let i = 0; i < qs.length; i++) {
      if (my !== this.token) return;
      const q = qs[i];
      this.quiz.i = i;
      this.feedback = null;
      this.set('quiz');
      await this.say(`Вопрос ${i + 1}. ${q.q}`, true);
      if (my !== this.token) return;
      const ans = await this.waitAnswer(my);
      if (!ans || my !== this.token) return;
      if (ans.type === 'repeat') { i--; continue; }
      if (ans.type === 'end') break;
      if (ans.type === 'skip') { this.quiz.results.push(null); continue; }
      let score;
      if (ans.type === 'dontknow') {
        score = 0;
        this.feedback = { q: q.q, answer: 'не знаю', entry: { a: `Правильный ответ: ${q.a}` } };
        this.set('quiz');
        await this.say(`Правильный ответ: ${q.a}`);
      } else {
        score = await this.grade(my, topic, q, ans.text);
      }
      if (my !== this.token) return;
      this.quiz.results.push(score);
      if (score !== null) {
        const st = this.stat(topic.id);
        st.total += 1;
        st.right += score;
        this.schedule(topic.id);
      }
    }
    const done = this.quiz.results.filter((x) => x !== null);
    const right = done.reduce((s, x) => s + x, 0);
    this.quiz = null;
    if (done.length) {
      this.set('quiz');
      const r = Number.isInteger(right) ? right : right.toFixed(1).replace('.', ',');
      await this.say(`Результат: ${r} из ${done.length}.${right / done.length < 0.7 ? ' Эту тему стоит повторить — я отмечу её в плане.' : ` Отлично${this.a}!`}`);
    }
  }

  waitAnswer(my) {
    this.heard = '';
    this.set('quizListen');
    this.mic(true);
    return new Promise((resolve) => { this.waiter = { my, resolve }; });
  }

  resolveWaiter(v) {
    const w = this.waiter;
    this.waiter = null;
    w?.resolve(v);
  }

  /** Проверка ответа нейросетью; ответ озвучивается по мере генерации. -> 1 | 0.5 | 0 | null */
  async grade(my, topic, q, answer) {
    this.set('quizGrade');
    const entry = { a: '' };
    this.feedback = { q: q.q, answer, entry };
    let failed = false;
    await this.streamSpeak(my, {
      system: 'Ты — доброжелательный экзаменатор. Оцени устный ответ студента по смыслу, а не дословно; ответ распознан с голоса и может содержать ошибки распознавания. ' +
        'Начни строго с одного слова: «Верно.», «Частично.» или «Неверно.» Затем одно-два коротких предложения: что упущено или как правильно. Без markdown, формулы словами.' + this.manner,
      parts: [{ text: `Тема: ${topic.title}\nФрагмент конспекта:\n<<<\n${topic.text.slice(0, 6000)}\n>>>\nВопрос: ${q.q}\nЭталонный ответ: ${q.a}\nОтвет студента: ${answer}` }],
    }, entry, () => { failed = true; });
    if (my !== this.token) return null;
    if (failed) {
      await this.say(`Не получилось проверить ответ. Правильный ответ: ${q.a}`);
      return null;
    }
    const first = norm(entry.a).split(' ')[0];
    return first === 'верно' ? 1 : first === 'частично' ? 0.5 : first === 'неверно' ? 0 : null;
  }

  // ---------- Быстрое повторение ----------

  startReview(ids, from = 0) {
    const topics = ids.map((id) => this.topicById(id)).filter(Boolean);
    if (!topics.length) return;
    stopSpeaking();
    this.abortAnswer();
    this.clearQuestion();
    this.resolveWaiter(null);
    this.resumePos = null;
    this.mode = 'review';
    this.review = { ids: topics.map((t) => t.id), i: Math.max(0, Math.min(from, topics.length - 1)), resumed: from > 0 };
    this.pos.review = { ids: this.review.ids, i: this.review.i };
    this.save();
    this.runReview();
  }

  async runReview() {
    const my = ++this.token;
    keepAwake(true);
    this.micAfterResume();
    this.mic(false);
    const rv = this.review;
    if (rv.i === 0) {
      this.set('reviewing');
      await this.say(`Быстрое повторение: ${rv.ids.length === 1 ? 'одна тема' : `тем — ${rv.ids.length}`}.`);
    } else if (rv.resumed) {
      rv.resumed = false;
      this.set('reviewing');
      await this.say('Продолжаем повторение.');
    }
    while (my === this.token && rv.i < rv.ids.length) {
      const t = this.topicById(rv.ids[rv.i]);
      if (t) {
        this.set('reviewing');
        const text = t.recap || t.chunks?.filter((c) => c.k === 'content').slice(0, 3).map((c) => c.t).join(' ') || '';
        const r = await this.say(`${t.title}. ${text}`, false, 1.1);
        if (my !== this.token) return;
        if (r !== 'error') this.schedule(t.id, true);
        await sleep(700);
        if (my !== this.token) return;
      }
      rv.i++;
      this.pos.review = { ids: rv.ids, i: rv.i };
      this.save();
    }
    if (my !== this.token) return;
    this.mode = 'dictate';
    this.review = null;
    delete this.pos.review;
    this.save();
    this.set('idle');
    await this.say('Повторение закончено.');
  }

  stopReview() {
    stopSpeaking();
    this.token++;
    this.mode = 'dictate';
    this.review = null;
    delete this.pos.review;
    this.save();
    this.set('idle');
  }

  // ---------- По буквам ----------

  async spell(text) {
    const st = this.state;
    let words = [];
    const target = spellTarget(text || '');
    if (target) words = target.split(/\s+/).slice(0, 2);
    else {
      const cur = st === 'speaking' ? this.topicById(this.pos.topicId)?.chunks[this.pos.chunk]?.t : this.lastSpokenText();
      words = pickTerms(cur || '');
    }
    if (DICTATING.includes(st)) this.resumePos = { topicId: this.pos.topicId, chunk: this.pos.chunk };
    stopSpeaking();
    const my = ++this.token;
    this.set('spelling');
    if (!words.length) await this.say('Скажите «как пишется» и само слово.');
    for (const w of words) {
      await this.say(spellOut(w), false, 0.85);
      if (my !== this.token) return;
    }
    if (my !== this.token) return;
    if (DICTATING.includes(st)) {
      if (st === 'gap') this.pendingGap = true; // снова даём время записать
      this.resume();
    } else if (st === 'reviewing') this.runReview();
    else this.set(PAUSED.includes(st) || st === 'idle' || st === 'finished' ? st : 'paused');
  }

  // ---------- Прерывание ----------

  /**
   * Мгновенная остановка. kind: 'question' — слушаем вопрос, 'pause' — просто пауза.
   * guess: остановились по догадке (похоже на вопрос) — если вопроса не будет, через несколько секунд продолжим сами.
   */
  interrupt(kind = 'question', guess = false) {
    const st = this.state;
    stopSpeaking();
    this.token++;
    this.gap = null;
    this.resolveWaiter(null);
    this.cancelAutoResume();
    // кусок прервали на середине (или ещё до него — на «Тема: …») — после вопроса и на «повтори» он прозвучит с начала
    if (DICTATING.includes(st)) this.resumePos = { topicId: this.pos.topicId, chunk: this.pos.chunk, partial: st === 'speaking' };
    this.cur = null;
    if (['quiz', 'quizListen', 'quizGrade'].includes(st)) this.quiz = null; // самопроверку не продолжаем
    if (QA_STATES.includes(st) || st === 'quizGrade') this.abortAnswer();
    if (st === 'idle' || st === 'finished') {
      if (kind === 'question') { this.mic(true); this.set(st, 'Задайте вопрос голосом или текстом'); }
      return;
    }
    this.mic(true);
    this.set(kind === 'pause' ? 'paused' : 'listening');
    if (guess && DICTATING.includes(st)) {
      this.autoTimer = setTimeout(() => {
        this.autoTimer = null;
        if (this.state === 'listening' && !this.qBuf && !this.qTimer) this.resume();
      }, FALSE_STOP_MS);
    }
  }

  cancelAutoResume() {
    clearTimeout(this.autoTimer);
    this.autoTimer = null;
  }

  resume() {
    this.cancelAutoResume();
    stopSpeaking();
    this.abortAnswer();
    this.clearQuestion();
    this.resolveWaiter(null);
    this.breakUntil = 0;
    if (this.mode === 'review' && this.review) return this.runReview();
    if (this.resumePos) {
      this.pos.topicId = this.resumePos.topicId;
      this.pos.chunk = this.resumePos.chunk;
    }
    this.resumePos = null;
    this.run();
  }

  next() {
    const st = this.state;
    if (st === 'quizListen') return this.resolveWaiter({ type: 'skip' });
    if (st === 'reviewing') {
      stopSpeaking();
      this.review.i++;
      this.pos.review = { ids: this.review.ids, i: this.review.i };
      this.save();
      return this.runReview();
    }
    if (st === 'speaking') {
      // во время «Тема: …» или «Продолжаем тему…» пропускаем только объявление, а не кусок
      const c = this.cur;
      stopSpeaking();
      if (c && c.topicId === this.pos.topicId && c.chunk === this.pos.chunk) this.pos.chunk++;
      else if (this.pos.chunk === 0) this.announced = this.pos.topicId;
      this.resumeNote = false;
      this.cur = null;
      this.run();
    } else if (st === 'gap' || st === 'waiting') { this.run(); }
    else if (st === 'idle') this.start();
    else this.resume();
  }

  repeat() {
    const st = this.state;
    if (st === 'quizListen') return this.resolveWaiter({ type: 'repeat' });
    stopSpeaking();
    this.abortAnswer();
    this.clearQuestion();
    if (st === 'reviewing') return this.runReview();
    // просят повторить — значит, не успевают: пауза немного длиннее
    this.pos.pauseBoost = Math.min(2, (this.pos.pauseBoost || 1) * 1.15);
    this.cancelAutoResume();
    if (st === 'speaking') { /* та же позиция */ }
    else if (st === 'gap') this.pos.chunk = Math.max(0, this.pos.chunk - 1);
    else if (this.resumePos?.partial || (this.resumePos && !this.lastSpoken)) { this.pos.topicId = this.resumePos.topicId; this.pos.chunk = this.resumePos.chunk; }
    else if (this.lastSpoken) { this.pos.topicId = this.lastSpoken.topicId; this.pos.chunk = this.lastSpoken.chunk; }
    this.resumePos = null;
    this.run();
  }

  repeatTopic() {
    stopSpeaking();
    this.abortAnswer();
    this.clearQuestion();
    this.resolveWaiter(null);
    this.mode = 'dictate';
    if (this.resumePos && !DICTATING.includes(this.state) && this.state !== 'topicEnd') this.pos.topicId = this.resumePos.topicId;
    if (this.state === 'topicEnd' && this.lastSpoken) this.pos.topicId = this.lastSpoken.topicId;
    this.pos.chunk = 0;
    this.announced = null;
    this.endedTopic = null;
    this.resumePos = null;
    this.run();
  }

  skipTopic() {
    if (this.state === 'quizListen') return this.resolveWaiter({ type: 'end' });
    stopSpeaking();
    this.abortAnswer();
    this.clearQuestion();
    this.resolveWaiter(null);
    this.mode = 'dictate';
    const cur = this.state === 'topicEnd' ? this.resumePos?.topicId : (this.resumePos?.topicId || this.pos.topicId);
    if (this.state !== 'topicEnd' && cur) {
      this.pos.done = this.pos.done || {};
      this.pos.done[cur] = true;
    }
    const nextId = this.nextTopicId(cur);
    this.resumePos = null;
    this.pos.topicId = nextId;
    this.pos.chunk = 0;
    if (!nextId) { const my = ++this.token; this.finish(my); return; }
    this.run();
  }

  changeRate(delta) {
    const s = this.settings;
    s.rate = Math.round(Math.min(2, Math.max(0.5, s.rate + delta)) * 10) / 10;
    if (delta < 0) this.pos.pauseBoost = Math.min(2, (this.pos.pauseBoost || 1) * 1.1);
    this.h.saveSettings();
    this.h.toast(`Скорость речи: ${s.rate.toFixed(1)}`);
    if (this.state === 'speaking') { stopSpeaking(); this.run(); }
    else this.h.emit();
  }

  /** Кнопка наушников / «пуск-пауза»: остановить или продолжить. */
  toggle() {
    if (DICTATING.includes(this.state) || this.state === 'reviewing') this.interrupt('pause');
    else if (this.project) this.start();
  }

  command(cmd, text = '') {
    switch (cmd) {
      case 'stop': return this.interrupt('question');
      case 'pause': return this.interrupt('pause');
      case 'next': return this.next();
      // «записал/готово»: в паузе — дальше; пока читается новый кусок — ничего не пропускаем
      case 'written':
        if (this.state === 'speaking' || this.state === 'waiting' || this.state === 'spelling') return null;
        if (this.state === 'reviewing') return null;
        return this.next();
      case 'continue':
        if (this.state === 'gap' && this.settings.pauseMode === 'wait') return this.next();
        return ['speaking', 'gap', 'reviewing'].includes(this.state) ? null : this.resume();
      case 'repeat': return this.repeat();
      case 'repeatTopic': return this.repeatTopic();
      case 'skipTopic': return this.skipTopic();
      case 'slower': return this.changeRate(-0.1);
      case 'faster': return this.changeRate(0.1);
      case 'spell': return this.spell(text);
    }
  }

  // ---------- Распознанная речь ----------

  onSpeech(r) {
    const text = r.text.trim();
    if (!norm(text)) return;
    const st = this.state;
    const dictating = DICTATING.includes(st) || st === 'reviewing' || st === 'spelling';
    // эхо синтезатора; во время диктовки — и запоздавшее эхо, и повтор продиктованного вслух, пока пишут
    if (isEcho(text, dictating || st === 'topicEnd', r.since)) return;
    // пока человек договаривает вопрос — показываем всё сказанное целиком, а не только последний кусок
    this.heard = this.qBuf && !dictating ? mergeText(this.qBuf, text) : text;
    this.h.emit();
    const words = norm(text).split(' ');

    if (this.consumed.has(r.id)) {
      // по этому результату уже было действие (по промежуточному варианту); финальный — может содержать вопрос
      if (r.final && ['listening', 'paused'].includes(this.state)) {
        const rest = stripCue(text);
        if (norm(rest).split(' ').length >= 2 && !matchCommand(rest)) this.addQuestionPart(rest);
      }
      return;
    }
    const cmd = matchCommand(text);
    // одну и ту же команду распознавание часто присылает дважды (промежуточный и финальный вариант,
    // а на Android — ещё и повтором в следующем результате): второй раз не выполняем
    if (cmd && cmd !== 'spell' && this.lastCmd?.cmd === cmd && Date.now() - this.lastCmd.at < CMD_REPEAT_MS) {
      this.consumed.add(r.id);
      return;
    }
    const run = (c) => { this.lastCmd = { cmd: c, at: Date.now() }; this.consumed.add(r.id); return this.command(c, text); };

    if (dictating) {
      if (cmd === 'spell' && !r.final) return; // ждём слово целиком
      if (cmd && cmd !== 'continue' || cmd === 'continue' && st === 'gap') { run(cmd); return; }
      if (st !== 'spelling' && (this.isQuestion(text, r.final) || (this.settings.bargeIn && words.length >= 2))) {
        this.consumed.add(r.id);
        this.interrupt('question', true);
        if (r.final) this.addQuestionPart(stripCue(text));
      }
      return;
    }

    if (st === 'quiz' || st === 'quizGrade') {
      if (cmd === 'stop' || cmd === 'pause') run(cmd);
      return;
    }

    if (QA_STATES.includes(st)) {
      if (cmd === 'stop' || cmd === 'pause') run(cmd);
      else if (cmd === 'continue' || cmd === 'next' || cmd === 'written') { this.lastCmd = { cmd, at: Date.now() }; this.consumed.add(r.id); this.resume(); }
      return;
    }

    if (!r.final) {
      if (this.qTimer) this.armQuestionTimer(); // человек ещё говорит
      if (this.autoTimer && words.length >= 2) this.cancelAutoResume(); // начали говорить вопрос
      if (st === 'topicEnd' && !isNo(text) && !cmd && words.length >= 2) { this.token++; stopSpeaking(); this.set('listening'); }
      return;
    }
    this.consumed.add(r.id);
    if (cmd) this.lastCmd = { cmd, at: Date.now() };

    if (st === 'quizListen') {
      if (!this.qBuf) {
        if (cmd === 'stop' || cmd === 'pause') return this.interrupt(cmd === 'stop' ? 'question' : 'pause');
        if (cmd === 'repeat') return this.resolveWaiter({ type: 'repeat' });
        if (cmd === 'next') return this.resolveWaiter({ type: 'skip' });
        if (cmd === 'written') return; // дописывали последний кусок — это не ответ
        if (cmd === 'skipTopic') return this.resolveWaiter({ type: 'end' });
        if (isDontKnow(text)) return this.resolveWaiter({ type: 'dontknow' });
      }
      return this.addQuestionPart(text);
    }
    if (st === 'confirm') {
      if (isYes(text)) return this.resume();
      if (isNo(text)) return this.set('paused');
      if (cmd) return this.command(cmd, text);
      if (words.length >= 2) return this.addQuestionPart(stripCue(text));
      return;
    }
    if (st === 'topicEnd') {
      if (isNo(text) || cmd === 'continue' || cmd === 'next' || cmd === 'written') return this.resume();
      if (cmd) return this.command(cmd, text);
      if (/^(да|есть|ага|угу)( есть)?( вопрос\p{L}*)?$/u.test(norm(text))) { this.token++; stopSpeaking(); return this.set('listening'); }
      if (words.length >= 2) return this.addQuestionPart(stripCue(text));
      return;
    }
    if (['listening', 'paused', 'idle', 'finished', 'break'].includes(st)) {
      if (cmd && !this.qBuf) {
        if (st === 'finished' || st === 'idle') return cmd === 'stop' || cmd === 'pause' ? null : cmd === 'spell' ? this.spell(text) : this.start();
        return this.command(cmd, text);
      }
      const q = stripCue(text);
      if (norm(q).split(' ').length >= 2 || looksLikeQuestion(q) || this.qBuf) this.addQuestionPart(q);
    }
  }

  /** Похоже на начало вопроса? Одиночное «а», «как», «что» (часто это шум или чужая речь) — ещё нет. */
  isQuestion(text, final) {
    const n = norm(stripCue(text));
    if (/^вопрос/.test(norm(text))) return true;
    const count = n ? n.split(' ').length : 0;
    if (!looksLikeQuestion(n)) return false;
    if (/^а( |$)/.test(n)) return count >= 3;
    return final ? count >= 2 : count >= 3;
  }

  addQuestionPart(t) {
    if (!t) return;
    this.cancelAutoResume();
    this.qBuf = mergeText(this.qBuf, t);
    this.heard = this.qBuf;
    this.armQuestionTimer();
    this.h.emit();
  }

  armQuestionTimer() {
    clearTimeout(this.qTimer);
    this.qTimer = setTimeout(() => {
      this.qTimer = null;
      const q = this.qBuf.trim();
      this.qBuf = '';
      if (q) this.submitText(q);
    }, this.state === 'quizListen' ? 2500 : 2200); // на Android после паузы в речи микрофон перезапускается ~1 с — даём договорить
  }

  clearQuestion() {
    clearTimeout(this.qTimer);
    this.qTimer = null;
    this.qBuf = '';
  }

  /** Текст от пользователя (голосом или из поля): ответ на самопроверку или вопрос. */
  submitText(text) {
    text = String(text).trim();
    if (!text) return;
    if (this.state === 'quizListen' && this.waiter) {
      this.clearQuestion();
      this.heard = '';
      return this.resolveWaiter(isDontKnow(text) ? { type: 'dontknow' } : { type: 'answer', text });
    }
    return this.ask(text);
  }

  // ---------- Вопрос и ответ ----------

  abortAnswer() {
    if (this.answerCtrl) { try { this.answerCtrl.abort(); } catch { /* ignore */ } }
    this.answerCtrl = null;
  }

  buildContext(question) {
    const p = this.project;
    const seq = this.seq();
    const rp = this.resumePos || { topicId: this.pos.topicId, chunk: this.pos.chunk };
    const done = seq.filter((t) => this.pos.done?.[t.id] && t.id !== rp.topicId).map((t) => `«${t.title}»`);
    const cur = this.topicById(rp.topicId);
    const dictated = cur ? cur.chunks.slice(Math.max(0, rp.chunk - 15), rp.chunk).map((c) => c.t) : [];
    const curChunk = cur?.chunks[rp.chunk]?.t || this.lastSpokenText() || '';
    const prevQa = this.qa.slice(-5, -1).filter((x) => x.a && !x.error).map((x) => `В: ${x.q}\nО: ${x.a}`).join('\n\n');
    let full = p?.fullText || '';
    if (full.length > MAX_CONTEXT) full = full.slice(0, MAX_CONTEXT) + '\n[…конспект обрезан…]';
    return `ПОЛНЫЙ КОНСПЕКТ:
<<<
${full}
>>>

УЖЕ ПРОДИКТОВАННЫЕ ТЕМЫ: ${done.join(', ') || 'нет'}
ТЕКУЩАЯ ТЕМА: ${cur ? `«${cur.title}»` : '—'}
ПРОДИКТОВАНО В ТЕКУЩЕЙ ТЕМЕ (последние куски):
${dictated.map((c) => '— ' + c).join('\n') || '—'}
КУСОК, НА КОТОРОМ ОСТАНОВИЛИСЬ: ${curChunk || '—'}
${prevQa ? `\nПРЕДЫДУЩИЕ ВОПРОСЫ В ЭТОЙ СЕССИИ:\n${prevQa}\n` : ''}
ВОПРОС СТУДЕНТА: ${question}`;
  }

  lastSpokenText() {
    const l = this.lastSpoken;
    return l ? this.topicById(l.topicId)?.chunks[l.chunk]?.t : '';
  }

  /** Потоковый запрос к нейросети с озвучкой по предложениям. entry.a накапливает текст. */
  async streamSpeak(my, req, entry, onError) {
    // между предложениями ответа микрофон не включаем — иначе на Android голос будет обрываться
    this.holdMic(true);
    try {
      await this.streamAndSpeak(my, req, entry, onError);
    } finally {
      this.holdMic(false);
    }
  }

  async streamAndSpeak(my, req, entry, onError) {
    const ctrl = new AbortController();
    this.answerCtrl = ctrl;
    const s = this.settings;
    const queue = [];
    let buf = '', streamDone = false, wake = null;
    const speakingState = this.state === 'quizGrade' ? 'quizGrade' : 'answering';
    const kick = () => { const w = wake; wake = null; w?.(); };
    const take = (final) => {
      for (;;) {
        const m = buf.match(/^[\s\S]*?[.!?…](?=\s|$)/);
        if (!m || (m[0].length < 25 && !final && buf.length - m[0].length < 5)) break;
        queue.push(m[0].trim());
        buf = buf.slice(m[0].length);
      }
      if (final && buf.trim()) { queue.push(buf.trim()); buf = ''; }
      kick();
    };
    const speaker = (async () => {
      for (;;) {
        if (my !== this.token) return;
        if (queue.length) {
          if (this.state !== speakingState) this.set(speakingState);
          const text = queue.shift().replace(/[*_#`]/g, '');
          if (text) await this.say(text);
        } else if (streamDone) return;
        else await new Promise((r) => { wake = r; });
      }
    })();
    try {
      await stream({
        ...conn(s), effort: 'low', signal: ctrl.signal, ...req,
        onText: (d) => { entry.a += d; buf += d; take(false); this.h.emit(); },
        onStatus: (m) => { this.message = m; this.h.emit(); },
      });
    } catch (e) {
      if (e.name === 'AbortError' || my !== this.token) { streamDone = true; kick(); return; }
      streamDone = true;
      take(true);
      await speaker;
      await onError(e);
      if (this.answerCtrl === ctrl) this.answerCtrl = null;
      return;
    }
    streamDone = true;
    take(true);
    await speaker;
    if (this.answerCtrl === ctrl) this.answerCtrl = null;
  }

  async ask(question) {
    question = question.trim();
    if (!question) return;
    this.clearQuestion();
    this.resolveWaiter(null);
    if (DICTATING.includes(this.state) || this.state === 'topicEnd' || this.state === 'reviewing') this.interrupt('question');
    stopSpeaking();
    this.abortAnswer();
    const my = ++this.token;
    // вопрос относится к теме, которую только что слушали
    const topicId = this.lastSpoken?.topicId || this.resumePos?.topicId || this.pos.topicId || null;
    const entry = { q: question, a: '', t: Date.now(), topicId };
    if (topicId) {
      this.stat(topicId).asked += 1;
      if (this.pos.done?.[topicId]) this.schedule(topicId);
    }
    this.qa.push(entry);
    if (this.qa.length > 50) this.qa.splice(0, this.qa.length - 50);
    this.heard = '';
    this.set('thinking');
    await this.streamSpeak(my, {
      system: 'Ты — репетитор, который помогает студенту во время диктовки конспекта. Отвечай по-русски, кратко (2–6 предложений), ' +
        'простыми словами, так, чтобы ответ было удобно слушать: без markdown, списков, таблиц и спецсимволов; формулы и обозначения — словами. ' +
        'Опирайся на конспект и на то, что уже продиктовано. Если в конспекте ответа нет — скажи об этом и дай короткий ответ из общих знаний.' + this.manner,
      parts: [{ text: this.buildContext(question) }],
    }, entry, async (e) => {
      entry.error = true;
      entry.a = '⚠ ' + (e.message || 'Ошибка');
      await this.say('Не получилось получить ответ. ' + (e.code === 'NETWORK' ? 'Нет интернета.' : ''));
    });
    if (my !== this.token) return;
    this.h.saveProgress();
    if (this.mode !== 'review' && !this.resumePos && !this.currentTopic()) { this.set('finished'); return; }
    this.set('confirm');
    await this.say(`Продолжаем${this.a}?`, true);
  }
}
