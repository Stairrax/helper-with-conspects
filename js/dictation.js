// Движок диктовки: озвучка кусков, паузы, мгновенное прерывание, вопросы и возврат к прерванному куску.

import {
  speak, stopSpeaking, isEcho, ttsRecentlyActive, matchCommand, isYes, isNo, looksLikeQuestion, stripCue, norm,
  Recognizer, srSupported, keepAwake,
} from './speech.js';
import { stream, conn } from './ai.js';
import { activeSeq, pauseFor } from './analyze.js';

const DICTATING = ['speaking', 'gap', 'waiting'];
const QA_STATES = ['thinking', 'answering'];
const MAX_CONTEXT = 400000;

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
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Dictation {
  /**
   * hooks: getProject(), getSettings(), saveSettings(), progress (объект), saveProgress(),
   *        emit(), toast(msg), kickGenerator()
   */
  constructor(hooks) {
    this.h = hooks;
    this.state = 'idle';
    this.token = 0;
    this.resumePos = null;
    this.lastSpoken = null;
    this.announced = null;
    this.gap = null;
    this.heard = '';
    this.message = '';
    this.qBuf = '';
    this.qTimer = null;
    this.consumed = new Set();
    this.answerCtrl = null;
    this.micForced = false;
    this.rec = new Recognizer({
      onResult: (r) => this.onSpeech(r),
      onState: (on) => { this.micOn = on; this.h.emit(); },
      onFatal: (msg) => { this.micError = msg; this.h.toast(msg); this.h.emit(); },
    });
    setInterval(() => {
      if (this.state === 'idle' || this.state === 'finished') return;
      const p = this.h.progress;
      p.elapsedMs = (p.elapsedMs || 0) + 1000;
      if (p.elapsedMs % 5000 === 0) this.h.saveProgress();
    }, 1000);
  }

  get pos() { return this.h.progress; }
  get settings() { return this.h.getSettings(); }
  get project() { return this.h.getProject(); }
  get qa() { return (this.h.progress.qa ||= []); }

  set(state, message = '') {
    this.state = state;
    this.message = message;
    this.h.emit();
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

  // ---------- Основной цикл ----------

  start() {
    if (!this.project) return;
    keepAwake(true);
    if (this.state === 'finished') {
      this.pos.done = {};
      this.pos.topicId = null;
      this.pos.chunk = 0;
    }
    if (['paused', 'listening', 'confirm', 'topicEnd'].includes(this.state)) return this.resume();
    if (DICTATING.includes(this.state)) return;
    this.mic(false);
    this.run();
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
      const topic = this.currentTopic();
      if (!topic) return this.finish(my);
      if (topic.status !== 'ready') {
        this.h.kickGenerator();
        this.set('waiting', topic.status === 'error' ? 'Ошибка подготовки темы: ' + (topic.error || '') : '');
        await sleep(400);
        continue;
      }
      if (this.pos.chunk >= topic.chunks.length) return this.endOfTopic(my, topic);
      if (this.pos.chunk === 0 && this.announced !== topic.id) {
        this.set('speaking');
        const r = await this.say(`Тема: ${topic.title}.`);
        if (my !== this.token) return;
        if (r !== 'error') this.announced = topic.id;
        await sleep(600);
        if (my !== this.token) return;
      }
      const idx = this.pos.chunk;
      const chunk = topic.chunks[idx];
      this.set('speaking');
      this.h.saveProgress();
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
      this.lastSpoken = { topicId: topic.id, chunk: idx };
      this.pos.chunk = idx + 1;
      this.pos.spoken = (this.pos.spoken || 0) + 1;
      this.h.saveProgress();
      const ms = pauseFor(topic, chunk.t, this.settings);
      this.gap = { start: Date.now(), ms };
      this.set('gap');
      const end = Date.now() + ms;
      while (Date.now() < end && my === this.token) await sleep(100);
      this.gap = null;
    }
  }

  /** prompt: короткая реплика, на которую ждём ответ, — окно защиты от эха после неё минимальное. */
  say(text, prompt = false) {
    const s = this.settings;
    return speak(text, { rate: s.rate, voiceURI: s.voiceURI, echoTail: prompt ? 250 : 900 });
  }

  async endOfTopic(my, topic) {
    this.pos.done = this.pos.done || {};
    this.pos.done[topic.id] = true;
    const nextId = this.nextTopicId(topic.id);
    this.h.saveProgress();
    if (!nextId) return this.finish(my);
    this.resumePos = { topicId: nextId, chunk: 0 };
    this.set('topicEnd');
    await this.say(`Конец темы «${topic.title}». Есть вопросы?`, true);
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
    await this.say('Диктовка завершена. Если остались вопросы — нажмите «Стоп, вопрос».');
    if (my !== this.token) return;
    keepAwake(false);
    this.micForced = false;
    this.rec.stop();
  }

  // ---------- Прерывание ----------

  /** Мгновенная остановка. kind: 'question' — слушаем вопрос, 'pause' — просто пауза. */
  interrupt(kind = 'question') {
    const st = this.state;
    stopSpeaking();
    this.token++;
    this.gap = null;
    if (DICTATING.includes(st)) this.resumePos = { topicId: this.pos.topicId, chunk: this.pos.chunk };
    if (QA_STATES.includes(st)) this.abortAnswer();
    if (st === 'idle' || st === 'finished') {
      if (kind === 'question') { this.mic(true); this.set(st, 'Задайте вопрос голосом или текстом'); }
      return;
    }
    this.mic(true);
    this.set(kind === 'pause' ? 'paused' : 'listening');
  }

  resume() {
    stopSpeaking();
    this.abortAnswer();
    this.clearQuestion();
    if (this.resumePos) {
      this.pos.topicId = this.resumePos.topicId;
      this.pos.chunk = this.resumePos.chunk;
    }
    this.resumePos = null;
    this.run();
  }

  next() {
    const st = this.state;
    if (st === 'speaking') { stopSpeaking(); this.pos.chunk++; this.run(); }
    else if (st === 'gap' || st === 'waiting') { this.run(); }
    else if (st === 'idle') this.start();
    else this.resume();
  }

  repeat() {
    const st = this.state;
    stopSpeaking();
    this.abortAnswer();
    this.clearQuestion();
    if (st === 'speaking') { /* та же позиция */ }
    else if (st === 'gap') this.pos.chunk = Math.max(0, this.pos.chunk - 1);
    else if (this.lastSpoken) { this.pos.topicId = this.lastSpoken.topicId; this.pos.chunk = this.lastSpoken.chunk; }
    else if (this.resumePos) { this.pos.topicId = this.resumePos.topicId; this.pos.chunk = this.resumePos.chunk; }
    this.resumePos = null;
    this.run();
  }

  repeatTopic() {
    stopSpeaking();
    this.abortAnswer();
    this.clearQuestion();
    if (this.resumePos && !DICTATING.includes(this.state) && this.state !== 'topicEnd') this.pos.topicId = this.resumePos.topicId;
    if (this.state === 'topicEnd' && this.lastSpoken) this.pos.topicId = this.lastSpoken.topicId;
    this.pos.chunk = 0;
    this.announced = null;
    this.resumePos = null;
    this.run();
  }

  skipTopic() {
    stopSpeaking();
    this.abortAnswer();
    this.clearQuestion();
    const cur = this.state === 'topicEnd' ? this.resumePos?.topicId : (this.resumePos?.topicId || this.pos.topicId);
    if (this.state !== 'topicEnd' && cur) {
      this.pos.done = this.pos.done || {};
      this.pos.done[cur] = true;
    }
    const nextId = this.state === 'topicEnd' ? this.nextTopicId(cur) : this.nextTopicId(cur);
    this.resumePos = null;
    this.pos.topicId = nextId;
    this.pos.chunk = 0;
    if (!nextId) { const my = ++this.token; this.finish(my); return; }
    this.run();
  }

  changeRate(delta) {
    const s = this.settings;
    s.rate = Math.round(Math.min(2, Math.max(0.5, s.rate + delta)) * 10) / 10;
    this.h.saveSettings();
    this.h.toast(`Скорость речи: ${s.rate.toFixed(1)}`);
    if (this.state === 'speaking') { stopSpeaking(); this.run(); }
    else this.h.emit();
  }

  command(cmd) {
    switch (cmd) {
      case 'stop': return this.interrupt('question');
      case 'pause': return this.interrupt('pause');
      case 'next': return this.next();
      case 'continue': return ['speaking', 'gap'].includes(this.state) ? null : this.resume();
      case 'repeat': return this.repeat();
      case 'repeatTopic': return this.repeatTopic();
      case 'skipTopic': return this.skipTopic();
      case 'slower': return this.changeRate(-0.1);
      case 'faster': return this.changeRate(0.1);
    }
  }

  // ---------- Распознанная речь ----------

  onSpeech(r) {
    const text = r.text.trim();
    if (!norm(text)) return;
    if (ttsRecentlyActive() && isEcho(text)) return; // эхо синтезатора
    this.heard = text;
    this.h.emit();
    const st = this.state;
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

    if (DICTATING.includes(st)) {
      if (cmd && cmd !== 'continue') { this.consumed.add(r.id); this.command(cmd); return; }
      if (looksLikeQuestion(text) || (this.settings.bargeIn && words.length >= 2)) {
        this.consumed.add(r.id);
        this.interrupt('question');
        if (r.final) this.addQuestionPart(stripCue(text));
      }
      return;
    }

    if (QA_STATES.includes(st)) {
      if (cmd === 'stop' || cmd === 'pause') { this.consumed.add(r.id); this.interrupt(cmd === 'stop' ? 'question' : 'pause'); }
      else if (cmd === 'continue' || cmd === 'next') { this.consumed.add(r.id); this.resume(); }
      return;
    }

    if (!r.final) {
      if (this.qTimer) this.armQuestionTimer(); // человек ещё говорит
      if (st === 'topicEnd' && !isNo(text) && !cmd) { this.token++; stopSpeaking(); this.set('listening'); }
      return;
    }
    this.consumed.add(r.id);

    if (st === 'confirm') {
      if (isYes(text)) return this.resume();
      if (isNo(text)) return this.set('paused');
      if (cmd) return this.command(cmd);
      if (words.length >= 2) return this.addQuestionPart(stripCue(text));
      return;
    }
    if (st === 'topicEnd') {
      if (isNo(text) || cmd === 'continue' || cmd === 'next') return this.resume();
      if (cmd) return this.command(cmd);
      if (/^(да|есть|ага|угу)( есть)?( вопрос\p{L}*)?$/u.test(norm(text))) { this.token++; stopSpeaking(); return this.set('listening'); }
      if (words.length >= 2) return this.addQuestionPart(stripCue(text));
      return;
    }
    if (['listening', 'paused', 'idle', 'finished'].includes(st)) {
      if (cmd && !this.qBuf) {
        if (st === 'finished' || st === 'idle') return cmd === 'stop' || cmd === 'pause' ? null : this.start();
        return this.command(cmd);
      }
      const q = stripCue(text);
      if (norm(q).split(' ').length >= 2 || looksLikeQuestion(q) || this.qBuf) this.addQuestionPart(q);
    }
  }

  addQuestionPart(t) {
    if (!t) return;
    this.qBuf = (this.qBuf + ' ' + t).trim();
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
      if (q) this.ask(q);
    }, 1400);
  }

  clearQuestion() {
    clearTimeout(this.qTimer);
    this.qTimer = null;
    this.qBuf = '';
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

  async ask(question) {
    question = question.trim();
    if (!question) return;
    this.clearQuestion();
    if (DICTATING.includes(this.state) || this.state === 'topicEnd') this.interrupt('question');
    stopSpeaking();
    this.abortAnswer();
    const my = ++this.token;
    const entry = { q: question, a: '', t: Date.now() };
    this.qa.push(entry);
    if (this.qa.length > 30) this.qa.splice(0, this.qa.length - 30);
    this.heard = '';
    this.set('thinking');
    const ctrl = new AbortController();
    this.answerCtrl = ctrl;
    const s = this.settings;
    const queue = [];
    let buf = '', streamDone = false, wake = null;
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
          if (this.state !== 'answering') this.set('answering');
          const text = queue.shift().replace(/[*_#`]/g, '');
          if (text) await this.say(text);
        } else if (streamDone) return;
        else await new Promise((r) => { wake = r; });
      }
    })();
    try {
      await stream({
        ...conn(s), effort: 'low', signal: ctrl.signal,
        system: 'Ты — репетитор, который помогает студенту во время диктовки конспекта. Отвечай по-русски, кратко (2–6 предложений), ' +
          'простыми словами, так, чтобы ответ было удобно слушать: без markdown, списков, таблиц и спецсимволов; формулы и обозначения — словами. ' +
          'Опирайся на конспект и на то, что уже продиктовано. Если в конспекте ответа нет — скажи об этом и дай короткий ответ из общих знаний.',
        parts: [{ text: this.buildContext(question) }],
        onText: (d) => { entry.a += d; buf += d; take(false); this.h.emit(); },
        onStatus: (m) => { this.message = m; this.h.emit(); },
      });
    } catch (e) {
      if (e.name === 'AbortError' || my !== this.token) return;
      entry.error = true;
      entry.a = '⚠ ' + (e.message || 'Ошибка');
      queue.push('Не получилось получить ответ. ' + (e.code === 'NETWORK' ? 'Нет интернета.' : ''));
    }
    streamDone = true;
    take(true);
    await speaker;
    if (my !== this.token) return;
    this.answerCtrl = null;
    this.h.saveProgress();
    if (!this.resumePos && !this.currentTopic()) { this.set('finished'); return; }
    this.set('confirm');
    await this.say('Продолжаем?', true);
  }
}
