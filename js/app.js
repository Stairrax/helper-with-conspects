// Интерфейс приложения: материал, план, диктовка, настройки.

import { loadSettings, saveSettings, loadProgress, saveProgress, clearProgress, idbGet, idbSet, idbDel } from './storage.js';
import { fileToSource } from './extract.js';
import {
  analyze, generateTopicChunks, orderTopics, activeSeq, estimateTopicSec, allocateBudget, fitPause,
} from './analyze.js';
import { listModels, conn, PROVIDERS, providerName } from './ai.js';
import { loadVoices, getVoices, speak, stopSpeaking, srSupported, ttsSupported } from './speech.js';
import { Dictation, STATE_TEXT } from './dictation.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 10);
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

let settings = loadSettings();
let sources = [];
let project = null;
let progress = null;

function freshProgress(projectId) {
  return { projectId, topicId: null, chunk: 0, done: {}, elapsedMs: 0, spoken: 0, qa: [] };
}

// ---------- Сохранение ----------

let saveProjectTimer = null;
function saveProject() {
  clearTimeout(saveProjectTimer);
  saveProjectTimer = setTimeout(() => { if (project) idbSet('project', project); }, 400);
}
const saveSources = () => idbSet('sources', sources);
const persistProgress = () => { if (progress) saveProgress(progress); };

// ---------- Утилиты ----------

function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  if (h) return `${h} ч ${String(m).padStart(2, '0')} мин`;
  if (m) return `${m} мин`;
  return `${sec} с`;
}
function fmtClock(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
}
const fmtChars = (n) => n >= 1000 ? `${(n / 1000).toFixed(1).replace('.', ',')} тыс. зн.` : `${n} зн.`;
const stars = (d) => '★'.repeat(d) + '☆'.repeat(5 - d);

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

// ---------- Вкладки ----------

let activeTab = 'load';
function switchTab(name) {
  activeTab = name;
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((s) => s.classList.toggle('active', s.id === 'tab-' + name));
  window.scrollTo({ top: 0 });
  render();
}
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

// ---------- Фоновая генерация кусков ----------

const gen = {
  running: false,
  status: '',
  pick(p) {
    const seq = activeSeq(p);
    const start = Math.max(0, seq.findIndex((t) => t.id === progress?.topicId));
    const ordered = [...seq.slice(start), ...seq.slice(0, start)];
    return ordered.find((t) => t.status === 'pending' ||
      (t.status === 'error' && (t.errors || 0) < 4 && Date.now() - (t.errorAt || 0) > 30000)) || null;
  },
  async loop() {
    if (this.running || !project) return;
    this.running = true;
    try {
      for (;;) {
        const p = project;
        if (!p) break;
        const t = this.pick(p);
        if (!t) break;
        t.status = 'generating';
        render();
        try {
          await generateTopicChunks(t, settings, (m) => { this.status = m; render(); });
          t.status = 'ready';
          t.error = '';
          t.errors = 0;
        } catch (e) {
          t.status = 'error';
          t.error = e.message || String(e);
          t.errors = (t.errors || 0) + 1;
          t.errorAt = Date.now();
          if (e.code === 'NO_KEY' || e.status === 400 || e.status === 403 || e.status === 404) {
            toast(t.error, 5000);
            if (p === project) saveProject();
            break;
          }
        }
        if (p === project) saveProject();
        render();
      }
    } finally {
      this.running = false;
      this.status = '';
      render();
    }
  },
};
// ошибочные темы перезапускаются автоматически
setInterval(() => { if (project && !gen.running && gen.pick(project)) gen.loop(); }, 15000);

// ---------- Диктовка ----------

let renderQueued = false;
function emit() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

const dict = new Dictation({
  getProject: () => project,
  getSettings: () => settings,
  saveSettings: () => { saveSettings(settings); renderSettings(); },
  get progress() { return progress; },
  saveProgress: persistProgress,
  emit,
  toast,
  kickGenerator: () => gen.loop(),
});

function resetDictation() {
  stopSpeaking();
  dict.token++;
  dict.abortAnswer();
  dict.clearQuestion();
  dict.resumePos = null;
  dict.lastSpoken = null;
  dict.announced = null;
  dict.gap = null;
  dict.state = 'idle';
  dict.message = '';
}

// ---------- Источники ----------

function renderSources() {
  const ul = $('sourceList');
  ul.innerHTML = sources.map((s) => `
    <li>
      <span>${s.kind === 'images' ? '📷' : '📄'}</span>
      <span class="name">${esc(s.name)}</span>
      <span class="size">${s.kind === 'images' ? `${s.images.length} стр.` : fmtChars((s.text || '').length)}</span>
      <button data-del="${s.id}" aria-label="Удалить">✕</button>
    </li>`).join('');
  $('sourcesEmpty').classList.toggle('hidden', sources.length > 0);
}

$('sourceList').addEventListener('click', (e) => {
  const id = e.target.closest('[data-del]')?.dataset.del;
  if (!id) return;
  sources = sources.filter((s) => s.id !== id);
  saveSources();
  renderSources();
});

$('addTextBtn').addEventListener('click', () => { $('pastePanel').classList.remove('hidden'); $('pasteText').focus(); });
$('pasteCancel').addEventListener('click', () => $('pastePanel').classList.add('hidden'));
$('pasteAdd').addEventListener('click', () => {
  const text = $('pasteText').value.trim();
  if (!text) return toast('Вставьте текст');
  sources.push({ id: uid(), name: $('pasteTitle').value.trim() || `Текст ${sources.length + 1}`, kind: 'text', text });
  $('pasteText').value = '';
  $('pasteTitle').value = '';
  $('pastePanel').classList.add('hidden');
  saveSources();
  renderSources();
});

$('addFileBtn').addEventListener('click', () => $('fileInput').click());
$('addPhotoBtn').addEventListener('click', () => $('photoInput').click());

$('fileInput').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  for (const f of files) {
    try {
      toast(`Читаю «${f.name}»…`, 8000);
      const src = await fileToSource(f, (m) => toast(m, 8000));
      if (src.kind === 'text' && !src.text.trim()) { toast(`«${f.name}»: текст не найден`); continue; }
      sources.push({ id: uid(), ...src });
      saveSources();
      renderSources();
      toast(`Добавлено: ${f.name}`);
    } catch (err) {
      toast(`Ошибка «${f.name}»: ${err.message}`, 5000);
    }
  }
});

$('photoInput').addEventListener('change', async (e) => {
  const files = [...e.target.files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  e.target.value = '';
  if (!files.length) return;
  const images = [];
  for (let i = 0; i < files.length; i++) {
    toast(`Обрабатываю фото ${i + 1} из ${files.length}…`, 8000);
    try {
      const src = await fileToSource(files[i]);
      images.push(...src.images);
    } catch (err) { toast(`Фото «${files[i].name}» не прочитано: ${err.message}`, 5000); }
  }
  if (!images.length) return;
  const n = sources.filter((s) => s.kind === 'images').length + 1;
  sources.push({ id: uid(), name: `Фото страниц ${n} (${images.length} шт.)`, kind: 'images', images });
  saveSources();
  renderSources();
  toast(`Добавлено фото: ${images.length}`);
});

// ---------- Время и приоритет ----------

$('timeChips').addEventListener('click', (e) => {
  const m = +e.target.dataset.min;
  if (!m) return;
  $('hours').value = Math.floor(m / 60);
  $('minutes').value = m % 60;
});
const getBudget = () => (Math.max(0, +$('hours').value || 0) * 60) + Math.max(0, +$('minutes').value || 0);
const getPriority = () => document.querySelector('input[name=priority]:checked')?.value || 'original';

// ---------- Анализ ----------

function logLine(msg, cls = '') {
  const li = document.createElement('li');
  li.textContent = msg;
  if (cls) li.className = cls;
  $('analyzeLog').appendChild(li);
  li.scrollIntoView({ block: 'nearest' });
}

$('analyzeBtn').addEventListener('click', async () => {
  if (!settings.apiKey) { toast(`Укажите ключ API (${providerName(settings)}) в настройках`); return switchTab('settings'); }
  if (!sources.length) return toast('Добавьте хотя бы один конспект');
  const budgetMin = getBudget();
  if (!budgetMin) return toast('Укажите, сколько у вас времени');
  if (project && !confirm('Текущий план и прогресс диктовки будут заменены. Продолжить?')) return;
  const btn = $('analyzeBtn');
  btn.disabled = true;
  $('analyzeCard').classList.remove('hidden');
  $('analyzeLog').innerHTML = '';
  $('analyzeBar').style.width = '2%';
  let lastStep = '';
  try {
    const p = await analyze({
      sources, budgetMin, priority: getPriority(), settings,
      log: (msg, frac) => {
        if (frac !== undefined) {
          $('analyzeBar').style.width = Math.round(frac * 100) + '%';
          if (msg !== lastStep) { logLine(msg); lastStep = msg; }
          $('analyzeStatus').textContent = '';
        } else $('analyzeStatus').textContent = msg;
      },
    });
    saveSources(); // распознанный текст фото сохраняется, повторно не распознаём
    resetDictation();
    project = p;
    progress = freshProgress(p.id);
    persistProgress();
    await idbSet('project', project);
    toast(`Найдено тем: ${p.topics.length}`);
    switchTab('plan');
    gen.loop();
  } catch (e) {
    logLine('Ошибка: ' + (e.message || e), 'err');
    $('analyzeStatus').textContent = 'Анализ не завершён. Исправьте проблему и нажмите «Анализировать» ещё раз.';
  } finally {
    btn.disabled = false;
  }
});

// ---------- План ----------

let openPoints = new Set();

function renderPlan() {
  const has = !!project;
  $('planEmpty').classList.toggle('hidden', has);
  $('planBody').classList.toggle('hidden', !has);
  if (!has) return;
  const byId = new Map(project.topics.map((t) => [t.id, t]));
  const seq = activeSeq(project);
  const alloc = allocateBudget(project);
  const total = seq.reduce((s, t) => s + estimateTopicSec(t, settings), 0);
  const budget = project.budgetMin * 60;
  const ready = seq.filter((t) => t.status === 'ready').length;
  let summary = `<b>${seq.length}</b> тем к диктовке из ${project.topics.length} · ` +
    `бюджет <b>${fmtDur(budget)}</b> · оценка диктовки <b>≈${fmtDur(total)}</b> (пауза ${settings.pause} с, скорость ${settings.rate})`;
  if (total > budget * 1.05) summary += `<div class="status" style="color:var(--warn)">Не укладываемся на ≈${fmtDur(total - budget)}. Пропустите часть тем, уменьшите паузу или увеличьте скорость.</div>`;
  else if (total < budget * 0.8) summary += `<div class="status">Есть запас ≈${fmtDur(budget - total)} — можно увеличить паузы («Подогнать паузу под время»).</div>`;
  summary += `<div class="status">Подготовлено тем: ${ready} из ${seq.length}</div>`;
  $('planSummary').innerHTML = summary;
  $('genStatus').textContent = gen.running ? '⏳ ' + gen.status : '';
  document.querySelectorAll('input[name=planPriority]').forEach((r) => { r.checked = r.value === project.priority; });

  const pos = new Map(project.plan.order.map((id, i) => [id, i]));
  let n = 0;
  $('planList').innerHTML = project.plan.order.map((id, i) => {
    const t = byId.get(id);
    if (!t) return '';
    const skipped = !!project.plan.skipped[id];
    if (!skipped) n++;
    const prereq = (t.prereq || []).map((p) => {
      const pt = byId.get(p);
      if (!pt) return '';
      const bad = pos.get(p) > i || project.plan.skipped[p];
      return `<span class="${bad ? 'bad' : ''}">«${esc(pt.title)}»${bad ? (project.plan.skipped[p] ? ' (пропущена)' : ' (идёт позже!)') : ''}</span>`;
    }).filter(Boolean).join(', ');
    let st = '';
    if (t.status === 'ready') {
      const c = t.coverage || { total: 0, covered: 0 };
      st = `${t.chunks.length} кусков · покрытие ${c.covered}/${c.total}${c.covered === c.total ? ' ✓' : ' ⚠'}${c.checked ? '' : ' (без проверки)'}`;
    } else if (t.status === 'generating') st = '⏳ готовится…';
    else if (t.status === 'error') st = `<span class="bad">⚠ ${esc(t.error)}</span>`;
    else st = 'в очереди на подготовку';
    const est = estimateTopicSec(t, settings);
    const isCur = progress?.topicId === id;
    const done = progress?.done?.[id];
    const points = openPoints.has(id) && t.points?.length
      ? `<ol class="points">${t.points.map((p) => `<li class="${p.c.length ? '' : 'miss'}">${esc(p.p)} <i>${p.c.length ? '→ куски ' + p.c.map((x) => x + 1).join(', ') : '— не покрыт'}</i></li>`).join('')}</ol>`
      : '';
    return `<li class="${skipped ? 'skipped' : ''} ${isCur ? 'current' : ''} ${done ? 'done' : ''}" data-id="${id}">
      <div class="phead">
        <span class="pnum">${skipped ? '–' : n}</span>
        <span class="ptitle">${esc(t.title)}</span>
        <span class="pmove"><button data-act="up" aria-label="Выше">↑</button><button data-act="down" aria-label="Ниже">↓</button></span>
      </div>
      <div class="pinfo">
        <span class="stars" title="Сложность">${stars(t.difficulty || 3)}</span> · ${fmtChars(t.chars)} · ≈${fmtDur(est)}${skipped ? '' : ` (по бюджету ${fmtDur(alloc[id] || 0)})`}
        ${t.summary ? `<br>${esc(t.summary)}` : ''}
        ${prereq ? `<br>Нужно знать: ${prereq}` : ''}
        <br>${st}
      </div>
      <div class="pactions">
        <button class="btn" data-act="skip">${skipped ? 'Вернуть' : 'Пропустить'}</button>
        ${skipped ? '' : '<button class="btn" data-act="from">Начать с этой темы</button>'}
        ${t.points?.length ? `<button class="btn" data-act="points">Пункты (${t.points.length})</button>` : ''}
        ${t.status === 'error' ? '<button class="btn" data-act="retry">Повторить</button>' : ''}
      </div>
      ${points}
    </li>`;
  }).join('');
}

$('planList').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  const li = e.target.closest('li[data-id]');
  if (!btn || !li || !project) return;
  const id = li.dataset.id;
  const order = project.plan.order;
  const i = order.indexOf(id);
  switch (btn.dataset.act) {
    case 'up': if (i > 0) [order[i - 1], order[i]] = [order[i], order[i - 1]]; break;
    case 'down': if (i < order.length - 1) [order[i + 1], order[i]] = [order[i], order[i + 1]]; break;
    case 'skip':
      if (project.plan.skipped[id]) delete project.plan.skipped[id]; else project.plan.skipped[id] = true;
      gen.loop();
      break;
    case 'from':
      resetDictation();
      progress.topicId = id;
      progress.chunk = 0;
      persistProgress();
      switchTab('dictate');
      dict.start();
      break;
    case 'points':
      if (openPoints.has(id)) openPoints.delete(id); else openPoints.add(id);
      break;
    case 'retry': {
      const t = project.topics.find((x) => x.id === id);
      t.status = 'pending'; t.errors = 0;
      gen.loop();
      break;
    }
  }
  saveProject();
  render();
});

$('reorderBtn').addEventListener('click', () => {
  if (!project) return;
  project.priority = document.querySelector('input[name=planPriority]:checked')?.value || project.priority;
  project.plan.order = orderTopics(project.topics, project.priority);
  saveProject();
  render();
  toast('Порядок пересчитан с учётом зависимостей');
});

$('fitPauseBtn').addEventListener('click', () => {
  if (!project) return;
  settings.pause = fitPause(project, settings);
  saveSettings(settings);
  renderSettings();
  render();
  toast(`Базовая пауза: ${settings.pause} с`);
});

$('startBtn').addEventListener('click', () => { switchTab('dictate'); dict.start(); });

// ---------- Экран диктовки ----------

function displayedChunk() {
  const t = dict.currentTopic();
  if (!t || t.status !== 'ready') return { t, chunk: null, idx: -1 };
  let idx = progress.chunk;
  if (dict.state === 'gap') idx = progress.chunk - 1;
  else if (dict.resumePos && dict.resumePos.topicId === t.id) idx = dict.resumePos.chunk;
  if (dict.state === 'topicEnd' || idx >= t.chunks.length) idx = t.chunks.length - 1;
  return { t, chunk: t.chunks[Math.max(0, idx)], idx: Math.max(0, idx) };
}

function renderDictation() {
  const st = dict.state;
  const seq = project ? activeSeq(project) : [];
  const topicId = dict.resumePos && st !== 'topicEnd' ? dict.resumePos.topicId : progress?.topicId;
  const t = project?.topics.find((x) => x.id === topicId) || (project ? dict.currentTopic() : null);
  const ti = t ? seq.findIndex((x) => x.id === t.id) : -1;
  $('topicNum').textContent = t ? `Тема ${ti + 1} из ${seq.length} · ${stars(t.difficulty || 3)}` : '';
  $('topicTitle').textContent = t ? t.title : (project ? 'Нажмите «Старт»' : 'Нет плана');
  const { chunk, idx } = project ? displayedChunk() : { chunk: null, idx: -1 };
  const n = t?.chunks?.length || 0;
  const doneChunks = t && t.status === 'ready' ? Math.min(n, (st === 'topicEnd' ? n : progress.chunk)) : 0;
  $('topicBar').style.width = n ? `${(doneChunks / n) * 100}%` : '0';
  $('chunkNum').textContent = n ? `Кусок ${Math.min(idx + 1, n)} из ${n}` : (t?.status === 'generating' ? 'Тема готовится…' : '');
  $('topicTime').textContent = t ? `осталось по теме ≈${fmtDur(estimateTopicSec(t, settings, t.chunks?.length ? progress.chunk : 0))}` : '';
  const kinds = { explain: 'Пояснение', example: 'Пример', content: '' };
  $('chunkKind').textContent = chunk ? kinds[chunk.k] || '' : '';
  $('chunkKind').className = 'kind ' + (chunk?.k || '');
  $('chunkText').textContent = chunk ? chunk.t : (st === 'waiting' ? 'Готовлю куски для этой темы…' : '');
  $('chunkBox').classList.toggle('hidden-text', !settings.showText);
  $('toggleText').textContent = settings.showText ? '👁' : '🙈';

  const stateEl = $('dictState');
  stateEl.textContent = STATE_TEXT[st] || st;
  stateEl.className = 'state s-' + st;
  $('dictMsg').textContent = dict.message || '';
  $('heard').textContent = dict.heard ? `«${dict.heard}»` : '';

  const dictating = ['speaking', 'gap', 'waiting'].includes(st);
  const pausedLike = ['paused', 'listening', 'confirm', 'topicEnd'].includes(st);
  const play = $('playBtn');
  play.innerHTML = dictating ? '⏸<span>Пауза</span>' : pausedLike ? '▶<span>Продолжить</span>' : st === 'finished' ? '↻<span>Сначала</span>' : '▶<span>Старт</span>';
  play.disabled = !project;
  $('continueBtn').classList.toggle('hidden', !pausedLike && !['thinking', 'answering'].includes(st));
  $('continueBtn').textContent = st === 'topicEnd' ? '▶ Следующая тема' : '▶ Продолжить диктовку';
  $('stopBtn').classList.toggle('listening', st === 'listening');
  const errTopic = st === 'waiting' && t?.status === 'error';
  $('retryTopicBtn').classList.toggle('hidden', !errTopic);

  // ответ
  const last = progress?.qa?.[progress.qa.length - 1];
  const showAnswer = last && !dictating && st !== 'idle';
  $('answer').classList.toggle('hidden', !showAnswer);
  if (showAnswer) $('answer').innerHTML = `<div class="q">Вопрос: ${esc(last.q)}</div>${esc(last.a || '…')}`;

  // общий прогресс
  if (project) {
    let total = 0, remain = 0;
    const curIdx = seq.findIndex((x) => x.id === (progress.topicId || dict.resumePos?.topicId));
    seq.forEach((x, i) => {
      const full = estimateTopicSec(x, settings);
      total += full;
      if (progress.done?.[x.id] && x.id !== progress.topicId) return;
      if (x.id === progress.topicId) remain += estimateTopicSec(x, settings, x.chunks?.length ? progress.chunk : 0);
      else if (curIdx < 0 || i > curIdx || !progress.done?.[x.id]) remain += full;
    });
    if (st === 'finished') remain = 0;
    const frac = total ? 1 - remain / total : 0;
    const doneTopics = seq.filter((x) => progress.done?.[x.id]).length;
    $('overallBar').style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`;
    $('overallText').textContent = `тем ${doneTopics} из ${seq.length} · ${Math.round(frac * 100)}%`;
    $('timeText').textContent = `Прошло ${fmtClock(progress.elapsedMs || 0)} из ${fmtClock(project.budgetMin * 60000)}`;
    $('remainText').textContent = `осталось ≈${fmtDur(remain)}`;
  }

  // история
  $('qaHistory').innerHTML = (progress?.qa || []).slice().reverse()
    .map((x) => `<div class="item"><div class="q">${esc(x.q)}</div><div class="a">${esc(x.a)}</div></div>`).join('') || '<p class="muted">Пока нет вопросов.</p>';

  $('micState').classList.toggle('on', !!dict.micOn);
}

// пауза между кусками — плавная полоса
(function gapLoop() {
  const bar = $('gapBar');
  if (dict.state === 'gap' && dict.gap) {
    bar.style.width = `${Math.min(1, (Date.now() - dict.gap.start) / dict.gap.ms) * 100}%`;
  } else if (bar.style.width !== '0px') bar.style.width = '0px';
  requestAnimationFrame(gapLoop);
})();

function onStop(e) {
  e?.preventDefault();
  if (!project && dict.state === 'idle') { toast('Сначала загрузите материал'); return; }
  dict.interrupt('question');
  if (activeTab !== 'dictate') switchTab('dictate');
  if (!srSupported || dict.micError) $('questionInput').focus();
  else toast('Слушаю вопрос… Можно и написать его.', 2000);
}
$('stopBtn').addEventListener('pointerdown', onStop);
$('stopBtn').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') onStop(e); });

$('playBtn').addEventListener('click', () => {
  const st = dict.state;
  if (['speaking', 'gap', 'waiting'].includes(st)) dict.interrupt('pause');
  else dict.start();
});
$('continueBtn').addEventListener('click', () => dict.resume());
$('repeatBtn').addEventListener('click', () => dict.repeat());
$('nextBtn').addEventListener('click', () => dict.next());
$('repeatTopicBtn').addEventListener('click', () => dict.repeatTopic());
$('skipTopicBtn').addEventListener('click', () => dict.skipTopic());
$('slowerBtn').addEventListener('click', () => dict.changeRate(-0.1));
$('fasterBtn').addEventListener('click', () => dict.changeRate(0.1));
$('retryTopicBtn').addEventListener('click', () => {
  const t = dict.currentTopic();
  if (t) { t.status = 'pending'; t.errors = 0; gen.loop(); }
});
$('toggleText').addEventListener('click', () => { settings.showText = !settings.showText; saveSettings(settings); render(); });

function sendQuestion() {
  const q = $('questionInput').value.trim();
  if (!q) return;
  if (!settings.apiKey) { toast(`Укажите ключ API (${providerName(settings)}) в настройках`); return; }
  $('questionInput').value = '';
  $('questionInput').blur();
  dict.ask(q);
}
$('askBtn').addEventListener('click', sendQuestion);
$('questionInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendQuestion(); } });
$('questionInput').addEventListener('focus', () => {
  // начали печатать вопрос — останавливаем диктовку
  if (['speaking', 'gap', 'waiting', 'topicEnd'].includes(dict.state)) dict.interrupt('question');
});

// ---------- Настройки ----------

function renderVoices() {
  const vs = getVoices();
  const sel = $('voice');
  sel.innerHTML = '<option value="">По умолчанию (русский)</option>' +
    vs.map((v) => `<option value="${esc(v.voiceURI)}">${esc(v.name)} (${esc(v.lang)})</option>`).join('');
  sel.value = settings.voiceURI;
}

let modelsLoaded = false;
const PROVIDER_HINTS = {
  openrouter: 'Один ключ — доступ к моделям Google, Anthropic, DeepSeek и других; работает из России. Бесплатные модели оканчиваются на «:free» (нажмите «Проверить ключ» — они будут в начале списка), но у них низкие дневные лимиты.',
  anthropic: 'Claude напрямую. Нужен отдельный ключ API с оплатой в console.anthropic.com — подписка claude.ai (Pro/Max) не даёт доступа к API. Из России API не работает (блокировка по стране); Claude доступен и через OpenRouter.',
  gemini: 'Бесплатный ключ в Google AI Studio. Из России Google блокирует запросы — нужен VPN или свой прокси (поле «Адрес API»).',
  deepseek: 'Недорогая модель, работает из России. Фото страниц не распознаёт — для фото выберите другого провайдера.',
  mistral: 'Европейский провайдер, есть бесплатный тестовый тариф.',
  custom: 'Любой сервис с OpenAI-совместимым API (/chat/completions): укажите адрес, ключ и модель.',
};

function renderSettings() {
  const prov = PROVIDERS[settings.provider] || PROVIDERS.gemini;
  $('provider').value = settings.provider;
  $('apiKey').value = settings.apiKey;
  $('apiKey').placeholder = prov.keyHint || 'ключ API';
  $('model').value = settings.model;
  $('model').placeholder = prov.model || 'название модели';
  $('baseUrl').value = settings.baseUrl;
  $('baseUrl').placeholder = prov.base || 'https://…/v1';
  if (!modelsLoaded) $('modelList').innerHTML = (prov.models || []).map((m) => `<option value="${esc(m)}"></option>`).join('');
  $('providerHint').innerHTML = (PROVIDER_HINTS[settings.provider] || '') +
    (prov.keyUrl ? ` Ключ: <a href="${prov.keyUrl}" target="_blank" rel="noopener">${esc(prov.keyUrl.replace('https://', ''))}</a>` : '');
  $('rate').value = settings.rate;
  $('rateVal').textContent = Number(settings.rate).toFixed(1);
  $('pause').value = settings.pause;
  $('pauseVal').textContent = `${settings.pause} с`;
  $('scalePause').checked = settings.scalePause;
  $('voiceCommands').checked = settings.voiceCommands;
  $('bargeIn').checked = settings.bargeIn;
  $('coverageCheck').checked = settings.coverageCheck;
  document.querySelectorAll('input[name=mode]').forEach((r) => { r.checked = r.value === settings.mode; });
  $('voice').value = settings.voiceURI;
}

function bind(id, key, parse = (v) => v, ev = 'change') {
  $(id).addEventListener(ev, (e) => {
    settings[key] = parse(e.target.type === 'checkbox' ? e.target.checked : e.target.value);
    saveSettings(settings);
    renderSettings();
    render();
  });
}
bind('apiKey', 'apiKey', (v) => v.trim());
bind('model', 'model', (v) => v.trim().replace(/^models\//, '') || (PROVIDERS[settings.provider]?.model ?? ''));
bind('baseUrl', 'baseUrl', (v) => v.trim());

$('provider').innerHTML = Object.entries(PROVIDERS).map(([id, p]) => `<option value="${id}">${esc(p.name)}</option>`).join('');
$('provider').addEventListener('change', (e) => {
  // ключ/модель/адрес у каждого провайдера свои — сохраняем текущие и подставляем сохранённые
  const prev = settings.provider;
  settings.profiles = settings.profiles || {};
  settings.profiles[prev] = { apiKey: settings.apiKey, model: settings.model, baseUrl: settings.baseUrl };
  const next = e.target.value;
  const saved = settings.profiles[next] || {};
  settings.provider = next;
  settings.apiKey = saved.apiKey || '';
  settings.model = saved.model || PROVIDERS[next].model;
  settings.baseUrl = saved.baseUrl || '';
  modelsLoaded = false;
  $('keyStatus').textContent = '';
  saveSettings(settings);
  renderSettings();
  if (project && !gen.running && gen.pick(project)) gen.loop();
});
bind('rate', 'rate', Number, 'input');
bind('pause', 'pause', Number, 'input');
bind('scalePause', 'scalePause');
bind('bargeIn', 'bargeIn');
bind('coverageCheck', 'coverageCheck');
bind('voice', 'voiceURI');
$('voiceCommands').addEventListener('change', (e) => {
  settings.voiceCommands = e.target.checked;
  saveSettings(settings);
  if (!settings.voiceCommands) { if (!dict.micForced) dict.rec.stop(); } else if (dict.state !== 'idle' && dict.state !== 'finished') dict.mic(false);
  render();
});
document.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', () => {
  settings.mode = r.value;
  saveSettings(settings);
}));
$('showKey').addEventListener('click', () => {
  const k = $('apiKey');
  k.type = k.type === 'password' ? 'text' : 'password';
});
$('testVoice').addEventListener('click', () => {
  stopSpeaking();
  speak('Проверка голоса. Определение: производная — это скорость изменения функции.', { rate: settings.rate, voiceURI: settings.voiceURI });
});
$('checkKey').addEventListener('click', async () => {
  const key = $('apiKey').value.trim();
  if (!key) return toast('Введите ключ');
  settings.apiKey = key;
  saveSettings(settings);
  $('keyStatus').textContent = 'Проверяю…';
  try {
    const models = await listModels(conn(settings));
    const gem = models.filter((m) => !/embedding|tts|image-gen|imagen|live|audio|whisper|moderation|ocr/i.test(m));
    $('modelList').innerHTML = gem.map((m) => `<option value="${esc(m)}"></option>`).join('');
    modelsLoaded = true;
    const ok = gem.includes(settings.model);
    $('keyStatus').textContent = `✓ Ключ работает. Доступно моделей: ${gem.length}.` +
      (ok ? '' : ` Модель «${settings.model}» не найдена — выберите из списка (нажмите на поле «Модель»).`);
  } catch (e) {
    $('keyStatus').textContent = '✗ ' + e.message;
  }
});

$('resetProgress').addEventListener('click', () => {
  if (!project || !confirm('Сбросить прогресс диктовки и историю вопросов?')) return;
  resetDictation();
  progress = freshProgress(project.id);
  persistProgress();
  render();
  toast('Прогресс сброшен');
});
$('deleteProject').addEventListener('click', async () => {
  if (!confirm('Удалить план, куски и все загруженные конспекты?')) return;
  resetDictation();
  dict.rec.stop();
  project = null;
  progress = null;
  sources = [];
  clearProgress();
  await idbDel('project');
  await idbDel('sources');
  renderSources();
  switchTab('load');
  toast('Проект удалён');
});

// ---------- Карточка «продолжить» ----------

function renderResume() {
  const show = !!project && !!progress && (progress.spoken > 0 || progress.topicId) && dict.state === 'idle';
  $('resumeCard').classList.toggle('hidden', !show);
  if (!show) return;
  const t = project.topics.find((x) => x.id === progress.topicId);
  const seq = activeSeq(project);
  const done = seq.filter((x) => progress.done?.[x.id]).length;
  $('resumeText').innerHTML = t
    ? `Есть незавершённая диктовка: тема «${esc(t.title)}», кусок ${progress.chunk + 1}. Пройдено тем: ${done} из ${seq.length}.`
    : `Диктовка: пройдено тем ${done} из ${seq.length}.`;
}
$('resumeGo').addEventListener('click', () => { switchTab('dictate'); dict.start(); });
$('resumePlan').addEventListener('click', () => switchTab('plan'));

// ---------- Общий рендер ----------

function render() {
  if (activeTab === 'plan') renderPlan();
  if (activeTab === 'dictate') renderDictation();
  if (activeTab === 'load') renderResume();
  $('micState').classList.toggle('on', !!dict.micOn);
}

function renderWarnings() {
  const warn = [];
  if (!ttsSupported) warn.push('Этот браузер не поддерживает синтез речи. Откройте приложение в Chrome на Android.');
  if (!srSupported) {
    warn.push(isIOS
      ? 'На iPhone/iPad распознавание речи в Safari недоступно или работает нестабильно (особенно в режиме приложения с главного экрана). Голосовые команды отключены: используйте большую кнопку «СТОП / ВОПРОС», а вопросы задавайте текстом. Для полной функциональности — Chrome на Android.'
      : 'Этот браузер не поддерживает распознавание речи. Голосовые команды недоступны — используйте кнопку «СТОП / ВОПРОС» и текстовые вопросы. Рекомендуется Chrome на Android.');
  } else if (isIOS) {
    warn.push('На iOS распознавание речи может работать нестабильно. Если голосовые команды не срабатывают — пользуйтесь кнопкой «СТОП / ВОПРОС».');
  }
  if (location.protocol !== 'https:' && !/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
    warn.push('Страница открыта не по HTTPS — микрофон и установка приложения работать не будут. Разместите приложение на GitHub Pages или Netlify.');
  }
  $('srWarn').innerHTML = warn.map(esc).join('<br><br>');
  $('srWarn').classList.toggle('hidden', !warn.length);
}

// ---------- Старт ----------

async function init() {
  renderSettings();
  renderWarnings();
  $('appInfo').textContent = 'Данные хранятся только на этом устройстве. Позиция диктовки сохраняется автоматически.';
  loadVoices().then(renderVoices);
  if (ttsSupported) speechSynthesis.addEventListener?.('voiceschanged', () => { loadVoices().then(renderVoices); });

  sources = (await idbGet('sources')) || [];
  project = (await idbGet('project')) || null;
  progress = loadProgress();
  if (project) {
    project.topics.forEach((t) => { if (t.status === 'generating') t.status = 'pending'; });
    if (!progress || progress.projectId !== project.id) progress = freshProgress(project.id);
    $('hours').value = Math.floor(project.budgetMin / 60);
    $('minutes').value = project.budgetMin % 60;
    const r = document.querySelector(`input[name=priority][value=${project.priority}]`);
    if (r) r.checked = true;
    gen.loop();
  }
  renderSources();
  render();

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  window.addEventListener('pagehide', persistProgress);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') persistProgress(); });
}

init();
