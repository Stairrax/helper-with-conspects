// Интерфейс приложения: материал, план, диктовка, настройки.

import {
  loadSettings, saveSettings, loadProgress, saveProgress, clearProgress, idbGet, idbSet, idbDel, loadSubjects, saveSubjects,
} from './storage.js';
import { fileToSource } from './extract.js';
import {
  analyze, generateTopicChunks, generateExtras, orderTopics, activeSeq, estimateTopicSec, allocateBudget, fitPause,
} from './analyze.js';
import { listModels, conn, PROVIDERS, providerName } from './ai.js';
import { loadVoices, getVoices, speak, stopSpeaking, setEngine, srSupported, ttsSupported } from './speech.js';
import { prepare as prepareNeural, isDownloaded, NEURAL_VOICES, audioContext } from './neural.js';
import { enableMedia, disableMedia, updateMedia, mediaSupported } from './media.js';
import { Dictation, STATE_TEXT } from './dictation.js';
import { initOnboarding, onboardingDone } from './onboarding.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 10);

let settings = loadSettings();
let subjects = null;        // { list: [{id, title}], current }
let sources = [];
let project = null;
let progress = null;

const cur = () => subjects?.current;
const curSubject = () => subjects?.list.find((x) => x.id === cur());

function freshProgress(projectId) {
  return { projectId, topicId: null, chunk: 0, done: {}, elapsedMs: 0, spoken: 0, qa: [], stats: {} };
}

// ---------- Сохранение ----------

let saveProjectTimer = null;
function saveProject() {
  clearTimeout(saveProjectTimer);
  const id = cur(), p = project;
  saveProjectTimer = setTimeout(() => { if (p && id) idbSet('project:' + id, p); }, 400);
}
const saveSources = () => idbSet('sources:' + cur(), sources);
const persistProgress = () => { if (progress) saveProgress(progress, cur()); };

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
const TITLES = { load: 'Материал', plan: 'План', dictate: 'Диктовка', settings: 'Настройки' };
function switchTab(name) {
  activeTab = name;
  document.body.dataset.tab = name;
  $('screenTitle').textContent = TITLES[name];
  document.querySelectorAll('.navbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((s) => s.classList.toggle('active', s.id === 'tab-' + name));
  window.scrollTo({ top: 0 });
  render();
}
document.querySelectorAll('.navbar button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

// ---------- Фоновая генерация кусков ----------

const gen = {
  running: false,
  status: '',
  pick(p) {
    const seq = activeSeq(p);
    const start = Math.max(0, seq.findIndex((t) => t.id === progress?.topicId));
    const ordered = [...seq.slice(start), ...seq.slice(0, start)];
    return ordered.find((t) => t.status === 'pending' ||
      (t.status === 'error' && (t.errors || 0) < 4 && Date.now() - (t.errorAt || 0) > 30000)) ||
      // темы, подготовленные до появления самопроверки: досоздаём выжимку и вопросы (по одной, начиная с текущей)
      (settings.selfCheck ? ordered.slice(0, 2).find((t) => t.status === 'ready' && !t.quiz && !t.extrasFailed) : null) || null;
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
        if (t.status === 'ready') {
          // только выжимка и вопросы
          try { await generateExtras(t, settings, (m) => { this.status = m; render(); }); } catch { t.extrasFailed = true; }
          if (p === project) saveProject();
          continue;
        }
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
  onActivity: (playing) => updateMedia(dictTitle(), playing),
});
const dictTitle = () => (dict.mode === 'review' ? 'Повторение' : project?.topics.find((t) => t.id === progress?.topicId)?.title) || 'Диктор конспектов';

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
      <svg><use href="#i-${s.kind === 'images' ? 'camera' : 'doc'}"/></svg>
      <span class="name">${esc(s.name)}</span>
      <span class="size">${s.kind === 'images' ? `${s.images.length} стр.` : fmtChars((s.text || '').length)}</span>
      <button class="icon-btn small" data-del="${s.id}" aria-label="Удалить"><svg><use href="#i-close"/></svg></button>
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

let budgetMin = 120;
function renderBudget() {
  const h = Math.floor(budgetMin / 60), m = budgetMin % 60;
  $('timeValue').textContent = (h ? `${h} ч` : '') + (h && m ? ' ' : '') + (m ? `${m} мин` : '');
}
const stepBudget = (d) => {
  const step = (d < 0 ? budgetMin <= 60 : budgetMin < 60) ? 15 : 30;
  budgetMin = Math.max(15, Math.min(12 * 60, budgetMin + Math.sign(d) * step));
  renderBudget();
};
$('timeMinus').addEventListener('click', () => stepBudget(-1));
$('timePlus').addEventListener('click', () => stepBudget(1));
const getBudget = () => budgetMin;
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
  if (!settings.apiKey) { wizard.open(1); return; }
  if (!sources.length) return toast('Добавьте хотя бы один конспект');
  const budgetMin = getBudget();
  if (!budgetMin) return toast('Укажите, сколько у вас времени');
  if (project && !confirm('Текущий план и прогресс диктовки будут заменены. Продолжить?')) return;
  const btn = $('analyzeBtn');
  btn.disabled = true;
  $('analyzeCard').classList.remove('hidden');
  $('analyzeLog').innerHTML = '';
  $('analyzeBar').style.width = '2%';
  $('analyzeStatus').textContent = 'Начинаю…';
  let lastStep = '';
  try {
    const p = await analyze({
      sources, budgetMin, priority: getPriority(), settings,
      log: (msg, frac) => {
        if (frac !== undefined) {
          $('analyzeBar').style.width = Math.round(frac * 100) + '%';
          if (msg !== lastStep) { logLine(msg); lastStep = msg; }
          $('analyzeStatus').textContent = msg;
        } else $('analyzeStatus').textContent = msg;
      },
    });
    saveSources(); // распознанный текст фото сохраняется, повторно не распознаём
    resetDictation();
    project = p;
    progress = freshProgress(p.id);
    persistProgress();
    await idbSet('project:' + cur(), project);
    const subj = curSubject();
    if (subj && /^(Предмет|Новый предмет)/.test(subj.title) && sources[0]) {
      subj.title = sources[0].name.replace(/\.[a-z0-9]+$/i, '').slice(0, 40);
      saveSubjects(subjects);
      renderSubject();
    }
    toast(`Найдено тем: ${p.topics.length}`);
    switchTab('plan');
    gen.loop();
  } catch (e) {
    logLine('Ошибка: ' + (e.message || e), 'err');
    $('analyzeStatus').innerHTML = `<span style="color:var(--danger)">${esc(e.message || e)}</span>`;
  } finally {
    btn.disabled = false;
  }
});

// ---------- План ----------

let openTopic = null;
let openPoints = new Set();
const dots = (d) => '●'.repeat(d) + '○'.repeat(5 - d);

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
  let line = '';
  if (total > budget * 1.05) line = `<span class="warn">Не укладываемся на ≈${fmtDur(total - budget)} — пропустите часть тем или уменьшите паузу.</span>`;
  else if (total < budget * 0.8) line = `Есть запас ≈${fmtDur(budget - total)}.`;
  else line = 'Укладываемся в отведённое время.';
  $('planSummary').innerHTML = `<div class="plan-sum"><span class="big">${seq.length} тем · ≈${fmtDur(total)}</span>` +
    `<span class="muted">из ${fmtDur(budget)}. ${line}</span></div>`;
  $('fitPauseBtn').classList.toggle('hidden', !(total > budget * 1.05 || total < budget * 0.8));
  $('genStatus').textContent = ready < seq.length
    ? `Подготовлено ${ready} из ${seq.length}${gen.running && gen.status ? ' · ' + gen.status : ''}`
    : '';
  document.querySelectorAll('input[name=planPriority]').forEach((r) => { r.checked = r.value === project.priority; });
  const rv = reviewSets();
  $('reviewSummary').textContent = rv.studied.length
    ? `Пройдено тем: ${rv.studied.length}. ${rv.due.length ? `Пора повторить: ${rv.due.length}${rv.weak.length ? `, из них слабых: ${rv.weak.length}` : ''}.` : 'Сегодня повторять нечего.'}`
    : 'Темы появятся здесь после диктовки — с отметками, что пора повторить.';
  $('reviewDueBtn').disabled = !rv.due.length;
  $('reviewDueBtn').textContent = rv.due.length ? `Повторить нужное (${rv.due.length})` : 'Повторить нужное';
  $('reviewAllBtn').disabled = !rv.studied.length;

  const pos = new Map(project.plan.order.map((id, i) => [id, i]));
  let n = 0;
  $('planList').innerHTML = project.plan.order.map((id, i) => {
    const t = byId.get(id);
    if (!t) return '';
    const skipped = !!project.plan.skipped[id];
    if (!skipped) n++;
    const isCur = progress?.topicId === id;
    const done = progress?.done?.[id];
    const est = estimateTopicSec(t, settings);
    const stat = progress?.stats?.[id];
    let badges = '';
    if (stat?.studiedAt) {
      if (stat.weak) badges += '<span class="badge weak">слабая</span>';
      if (stat.due && stat.due <= Date.now()) badges += '<span class="badge due">повторить</span>';
      else if (!stat.weak && stat.total) badges += `<span class="badge good">${fmtScore(stat.right)}/${stat.total}</span>`;
    }
    let st = '', stCls = '';
    if (t.status === 'ready') {
      const c = t.coverage || { total: 0, covered: 0 };
      st = c.covered === c.total ? '✓' : '⚠'; stCls = c.covered === c.total ? 'ok' : 'err';
    } else if (t.status === 'generating') st = '⏳';
    else if (t.status === 'error') { st = '⚠'; stCls = 'err'; }
    let detail = '';
    if (openTopic === id) {
      const prereq = (t.prereq || []).map((p) => {
        const pt = byId.get(p);
        if (!pt) return '';
        const bad = pos.get(p) > i || project.plan.skipped[p];
        return `<span class="${bad ? 'bad' : ''}">«${esc(pt.title)}»${bad ? (project.plan.skipped[p] ? ' (пропущена)' : ' (идёт позже)') : ''}</span>`;
      }).filter(Boolean).join(', ');
      let stLong = '';
      if (t.status === 'ready') {
        const c = t.coverage || { total: 0, covered: 0 };
        stLong = `${t.chunks.length} кусков · покрыто пунктов ${c.covered} из ${c.total}${c.checked ? '' : ' (без проверки)'}`;
      } else if (t.status === 'generating') stLong = 'Готовится…';
      else if (t.status === 'error') stLong = `<span class="bad">${esc(t.error)}</span>`;
      else stLong = 'В очереди на подготовку';
      const points = openPoints.has(id) && t.points?.length
        ? `<ol class="points">${t.points.map((p) => `<li class="${p.c.length ? '' : 'miss'}">${esc(p.p)} <i>${p.c.length ? '→ ' + p.c.map((x) => x + 1).join(', ') : '— не покрыт'}</i></li>`).join('')}</ol>`
        : '';
      detail = `<div class="pdetail">
        ${t.summary ? `<p>${esc(t.summary)}</p>` : ''}
        ${prereq ? `<p>Нужно знать: ${prereq}</p>` : ''}
        <p>${stLong}${skipped ? '' : ` · по бюджету ${fmtDur(alloc[id] || 0)}`}</p>
        ${stat?.studiedAt ? `<p>${stat.total ? `Самопроверка: ${fmtScore(stat.right)} из ${stat.total}` : 'Самопроверки не было'}${stat.asked ? ` · вопросов задано: ${stat.asked}` : ''} · повторить ${fmtDue(stat.due)}</p>` : ''}
        <div class="pactions">
          <button class="icon-btn" data-act="up" aria-label="Выше"><svg><use href="#i-up"/></svg></button>
          <button class="icon-btn" data-act="down" aria-label="Ниже"><svg><use href="#i-down"/></svg></button>
          <button class="btn" data-act="skip">${skipped ? 'Вернуть' : 'Пропустить'}</button>
          ${skipped ? '' : '<button class="btn tonal" data-act="from">Начать отсюда</button>'}
          ${t.status === 'ready' && !skipped ? '<button class="btn" data-act="review">Повторить</button>' : ''}
          ${t.points?.length ? `<button class="btn" data-act="points">${openPoints.has(id) ? 'Скрыть пункты' : 'Пункты'}</button>` : ''}
          ${t.status === 'error' ? '<button class="btn" data-act="retry">Повторить</button>' : ''}
        </div>
        ${points}
      </div>`;
    }
    return `<li class="${skipped ? 'skipped' : ''} ${isCur ? 'current' : ''} ${done ? 'done' : ''}" data-id="${id}">
      <button class="phead" data-act="open">
        <span class="pnum">${skipped ? '–' : done ? '✓' : n}</span>
        <span class="pbody"><span class="ptitle">${esc(t.title)}${badges}</span>
          <span class="pmeta"><span class="dots">${dots(t.difficulty || 3)}</span> · ≈${fmtDur(est)}</span></span>
        <span class="pstate ${stCls}">${st}</span>
      </button>
      ${detail}
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
    case 'open': openTopic = openTopic === id ? null : id; break;
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
    case 'review':
      switchTab('dictate');
      dict.startReview([id]);
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

document.querySelectorAll('input[name=planPriority]').forEach((r) => r.addEventListener('change', () => {
  if (!project) return;
  project.priority = r.value;
  project.plan.order = orderTopics(project.topics, project.priority);
  saveProject();
  render();
  toast('Порядок пересчитан с учётом зависимостей');
}));

const fmtScore = (x) => (Number.isInteger(x) ? String(x) : x.toFixed(1).replace('.', ','));
function fmtDue(due) {
  if (!due) return '—';
  const days = Math.ceil((due - Date.now()) / 86400000);
  return days <= 0 ? 'сегодня' : days === 1 ? 'завтра' : `через ${days} дн.`;
}

/** Темы для повторения: слабые и с подошедшим сроком — первыми. */
function reviewSets() {
  const seq = project ? activeSeq(project) : [];
  const stats = progress?.stats || {};
  const studied = seq.filter((t) => stats[t.id]?.studiedAt && t.status === 'ready');
  const due = studied.filter((t) => stats[t.id].weak || (stats[t.id].due && stats[t.id].due <= Date.now()))
    .sort((a, b) => (stats[b.id].weak ? 1 : 0) - (stats[a.id].weak ? 1 : 0));
  return { studied, due, weak: due.filter((t) => stats[t.id].weak) };
}
$('reviewDueBtn').addEventListener('click', () => { const ids = reviewSets().due.map((t) => t.id); if (ids.length) { switchTab('dictate'); dict.startReview(ids); } });
$('reviewAllBtn').addEventListener('click', () => { const ids = reviewSets().studied.map((t) => t.id); if (ids.length) { switchTab('dictate'); dict.startReview(ids); } });

// ---------- Экспорт ----------

const TR = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
const translit = (s) => [...s].map((c) => { const l = c.toLowerCase(); const t = TR[l]; return t === undefined ? c : c === l ? t : t.charAt(0).toUpperCase() + t.slice(1); }).join('').replace(/\s+/g, '_');

function buildExport() {
  const subj = curSubject()?.title || 'Конспект';
  const stats = progress?.stats || {};
  const qa = progress?.qa || [];
  const lines = [`# ${subj}`, '', `Сохранено ${new Date().toLocaleString('ru-RU')} из приложения «Диктор конспектов».`, ''];
  for (const t of activeSeq(project)) {
    lines.push(`## ${t.title}`, '');
    if (t.chunks?.length) {
      for (const c of t.chunks) lines.push(c.k === 'explain' || c.k === 'example' ? `> ${c.t}` : c.t, '');
    } else lines.push(t.text, '');
    if (t.recap) lines.push(`**Главное:** ${t.recap}`, '');
    const st = stats[t.id];
    if (st?.total) lines.push(`Самопроверка: ${fmtScore(st.right)} из ${st.total}${st.weak ? ' — стоит повторить' : ''}`, '');
    if (t.quiz?.length) {
      lines.push('**Вопросы для самопроверки:**', '');
      t.quiz.forEach((q, i) => lines.push(`${i + 1}. ${q.q}`, `   Ответ: ${q.a}`));
      lines.push('');
    }
    const tqa = qa.filter((x) => x.topicId === t.id && x.a && !x.error);
    if (tqa.length) {
      lines.push('**Мои вопросы:**', '');
      for (const x of tqa) lines.push(`- ${x.q}`, `  ${x.a.trim()}`);
      lines.push('');
    }
  }
  const other = qa.filter((x) => !x.topicId && x.a && !x.error);
  if (other.length) {
    lines.push('## Другие вопросы', '');
    for (const x of other) lines.push(`- ${x.q}`, `  ${x.a.trim()}`);
  }
  return { name: `${subj.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'конспект'}.md`, text: lines.join('\n') };
}

$('exportBtn').addEventListener('click', async () => {
  if (!project) return;
  const { name, text } = buildExport();
  const file = new File([text], name, { type: 'text/markdown' });
  // на Android — системное меню «Поделиться» (Telegram, Google Диск, почта…), иначе — скачивание
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = translit(name); // браузеры иногда отбрасывают кириллицу в имени скачиваемого файла
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast('Файл сохранён в «Загрузки»');
});

$('fitPauseBtn').addEventListener('click', () => {
  if (!project) return;
  settings.pause = fitPause(project, settings);
  saveSettings(settings);
  renderSettings();
  render();
  toast(`Пауза между кусками: ${settings.pause} с`);
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

const PAUSED = ['paused', 'listening', 'confirm', 'topicEnd', 'break'];
const DICTATING = ['speaking', 'gap', 'waiting', 'reviewing', 'spelling'];
const QUIZ = ['quiz', 'quizListen', 'quizGrade'];

function renderDictation() {
  const st = dict.state;
  const seq = project ? activeSeq(project) : [];
  const topicId = dict.resumePos && st !== 'topicEnd' ? dict.resumePos.topicId : progress?.topicId;
  // во время самопроверки и повторения в шапке — проверяемая тема
  const special = (QUIZ.includes(st) && dict.quiz?.topic) ||
    (dict.mode === 'review' && dict.review && project?.topics.find((x) => x.id === dict.review.ids[dict.review.i]));
  const t = special || project?.topics.find((x) => x.id === topicId) || (project ? dict.currentTopic() : null);
  const ti = t ? seq.findIndex((x) => x.id === t.id) : -1;
  $('topicNum').textContent = t ? `Тема ${ti + 1} из ${seq.length}` : '';
  $('topicTitle').textContent = t ? t.title : (project ? 'Всё продиктовано' : 'Сначала составьте план');
  const { chunk, idx } = project ? displayedChunk() : { chunk: null, idx: -1 };
  const n = t?.chunks?.length || 0;
  const doneChunks = t && t.status === 'ready' ? Math.min(n, (st === 'topicEnd' ? n : progress.chunk)) : 0;
  $('topicBar').style.width = n ? `${(doneChunks / n) * 100}%` : '0';
  $('chunkNum').textContent = n ? `${Math.min(idx + 1, n)} / ${n}` : '';
  const kinds = { explain: 'Пояснение', example: 'Пример', content: '' };
  $('chunkKind').textContent = chunk ? kinds[chunk.k] || '' : '';
  let text = chunk ? chunk.t : '';
  // самопроверка: на карточке — текущий вопрос
  if (QUIZ.includes(st) && dict.quiz) {
    const q = dict.quiz.qs[dict.quiz.i];
    $('chunkKind').textContent = `Самопроверка · вопрос ${dict.quiz.i + 1} из ${dict.quiz.qs.length}`;
    text = q?.q || '';
  } else if (st === 'reviewing' && dict.review) {
    const rt = project?.topics.find((x) => x.id === dict.review.ids[dict.review.i]);
    $('chunkKind').textContent = `Повторение · ${dict.review.i + 1} из ${dict.review.ids.length}`;
    text = rt ? `${rt.title}. ${rt.recap || ''}` : '';
  }
  if (!text) {
    if (!project) text = 'Добавьте конспект на вкладке «Материал».';
    else if (st === 'waiting' || t?.status === 'generating' || t?.status === 'pending') text = 'Готовлю эту тему…';
    else if (st === 'idle') text = 'Нажмите ▶, чтобы начать.';
  }
  $('chunkText').textContent = text;
  $('chunkBox').classList.toggle('hidden-text', !settings.showText && !!chunk && !QUIZ.includes(st) && st !== 'reviewing');
  $('toggleText').textContent = settings.showText ? 'Скрыть текст' : 'Показать текст';

  $('dictState').textContent = STATE_TEXT[st] || st;
  $('stateDot').className = 'dot s-' + st;
  $('dictMsg').textContent = dict.message || '';
  $('heard').textContent = dict.heard && st !== 'idle' ? `«${dict.heard}»` : '';

  const dictating = DICTATING.includes(st);
  const pausedLike = PAUSED.includes(st);
  $('playIcon').setAttribute('href', dictating ? '#i-pause' : '#i-play');
  $('playBtn').setAttribute('aria-label', dictating ? 'Пауза' : 'Продолжить');
  ['playBtn', 'repeatBtn', 'nextBtn', 'moreBtn'].forEach((id) => { $(id).disabled = !project; });
  $('stopBtn').classList.toggle('listening', st === 'listening');
  $('retryTopicBtn').classList.toggle('hidden', !(st === 'waiting' && t?.status === 'error'));

  // панель вопроса — только когда диктовка остановлена
  const qaOpen = pausedLike || ['thinking', 'answering', 'quiz', 'quizListen', 'quizGrade'].includes(st) || (st === 'finished' && progress?.qa?.length);
  $('quizBtns').classList.toggle('hidden', st !== 'quizListen');
  $('questionInput').placeholder = st === 'quizListen' ? 'Ваш ответ — голосом или текстом' : 'Спросите голосом или напишите';
  $('stopReviewBtn').classList.toggle('hidden', dict.mode !== 'review');
  $('breakCard').classList.toggle('hidden', st !== 'break');
  $('qaPanel').classList.toggle('hidden', !qaOpen);
  $('tab-dictate').classList.toggle('qa-open', !!qaOpen);
  $('continueBtn').classList.toggle('hidden', (!pausedLike && !['thinking', 'answering'].includes(st)) || st === 'break');
  $('continueBtn').textContent = st === 'topicEnd' ? 'Следующая тема' : dict.mode === 'review' ? 'Продолжить повторение' : 'Продолжить диктовку';
  const qa = progress?.qa || [];
  const last = qa[qa.length - 1];
  const showAnswer = last && (['thinking', 'answering', 'confirm'].includes(st) || (pausedLike && Date.now() - last.t < 10 * 60000));
  const fb = QUIZ.includes(st) ? dict.feedback : null;
  $('answer').classList.toggle('hidden', !showAnswer && !fb);
  if (fb) $('answer').innerHTML = `<div class="q">Ваш ответ: ${esc(fb.answer)}</div>${esc(fb.entry.a || '…')}`;
  else if (showAnswer) $('answer').innerHTML = `<div class="q">${esc(last.q)}</div>${esc(last.a || '…')}`;
  const older = showAnswer ? qa.slice(0, -1) : qa;
  $('historyCard').classList.toggle('hidden', !older.length);
  $('historyTitle').textContent = `Предыдущие вопросы (${older.length})`;
  $('qaHistory').innerHTML = older.slice().reverse()
    .map((x) => `<div class="item"><div class="q">${esc(x.q)}</div><div class="a">${esc(x.a)}</div></div>`).join('');

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
    $('overallBar').style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`;
    $('timeText').textContent = `${fmtClock(progress.elapsedMs || 0)} из ${fmtClock(project.budgetMin * 60000)}`;
    $('remainText').textContent = `${Math.round(frac * 100)}% · осталось ≈${fmtDur(remain)}`;
  } else {
    $('timeText').textContent = '';
    $('remainText').textContent = '';
  }
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
  if (!project && dict.state === 'idle') { toast('Сначала составьте план'); return; }
  navigator.vibrate?.(30);
  dict.interrupt('question');
  if (activeTab !== 'dictate') switchTab('dictate');
  if (!srSupported || dict.micError) $('questionInput').focus();
}
$('stopBtn').addEventListener('pointerdown', onStop);
$('stopBtn').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') onStop(e); });

$('playBtn').addEventListener('click', () => {
  if (DICTATING.includes(dict.state)) dict.interrupt('pause');
  else dict.start();
});
$('continueBtn').addEventListener('click', () => dict.resume());
$('quizDontKnow').addEventListener('click', () => dict.submitText('не знаю'));
$('quizSkip').addEventListener('click', () => dict.next());
$('stopReviewBtn').addEventListener('click', () => dict.stopReview());
$('breakSkip').addEventListener('click', () => dict.resume());
// обратный отсчёт перерыва
setInterval(() => {
  if (dict.state !== 'break' || !dict.breakUntil) return;
  const left = Math.max(0, dict.breakUntil - Date.now());
  $('breakText').textContent = `Перерыв: осталось ${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}`;
}, 500);
$('repeatBtn').addEventListener('click', () => dict.repeat());
$('nextBtn').addEventListener('click', () => dict.next());

// меню «ещё»
const openSheet = (on) => $('sheet').classList.toggle('hidden', !on);
$('moreBtn').addEventListener('click', () => openSheet(true));
$('sheet').addEventListener('click', (e) => {
  if (e.target.closest('[data-close]') || e.target.closest('.sheet-item')) openSheet(false);
});
$('repeatTopicBtn').addEventListener('click', () => dict.repeatTopic());
$('skipTopicBtn').addEventListener('click', () => dict.skipTopic());
$('slowerBtn').addEventListener('click', () => dict.changeRate(-0.1));
$('fasterBtn').addEventListener('click', () => dict.changeRate(0.1));
$('retryTopicBtn').addEventListener('click', () => {
  const t = dict.currentTopic();
  if (t) { t.status = 'pending'; t.errors = 0; gen.loop(); }
});
const toggleText = () => { settings.showText = !settings.showText; saveSettings(settings); render(); };
$('toggleText').addEventListener('click', toggleText);
$('chunkBox').addEventListener('click', toggleText);

// подсказка про наушники — до первого закрытия
const tipHidden = () => { try { return localStorage.getItem('kd.tipHidden') === '1'; } catch { return false; } };
$('tipClose').addEventListener('click', () => {
  try { localStorage.setItem('kd.tipHidden', '1'); } catch { /* ignore */ }
  $('headphonesTip').classList.add('hidden');
});

// поле вопроса растёт вместе с текстом
$('questionInput').addEventListener('input', (e) => {
  e.target.style.height = 'auto';
  e.target.style.height = Math.min(120, e.target.scrollHeight) + 'px';
});

function sendQuestion() {
  const q = $('questionInput').value.trim();
  if (!q) return;
  if (!settings.apiKey) { toast(`Укажите ключ API (${providerName(settings)}) в настройках`); return; }
  $('questionInput').value = '';
  $('questionInput').style.height = '';
  $('questionInput').blur();
  dict.submitText(q);
}
$('askBtn').addEventListener('click', sendQuestion);
$('questionInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendQuestion(); } });
$('questionInput').addEventListener('focus', () => {
  // начали печатать вопрос — останавливаем диктовку
  if (['speaking', 'gap', 'waiting', 'topicEnd', 'reviewing'].includes(dict.state)) dict.interrupt('question');
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
  $('aiSummary').innerHTML = settings.apiKey
    ? `${esc(providerName(settings))} · ключ указан<span class="muted">Модель: ${esc(settings.model)}${settings.fallbackModels?.length && settings.provider === 'openrouter' ? ` (+${settings.fallbackModels.length} запасные)` : ''}</span>`
    : '<span style="color:var(--warn)">Ключ не указан — нажмите «Настроить заново».</span>';
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
  $('adaptivePause').checked = settings.adaptivePause;
  $('selfCheck').checked = settings.selfCheck;
  $('headsetButtons').checked = settings.headsetButtons;
  $('headsetButtons').disabled = !mediaSupported;
  $('breakEvery').value = settings.breakEvery;
  $('breakVal').textContent = +settings.breakEvery ? `каждые ${settings.breakEvery} мин` : 'выключено';
  document.querySelectorAll('input[name=pauseMode]').forEach((r) => { r.checked = r.value === settings.pauseMode; });
  document.querySelectorAll('input[name=voiceEngine]').forEach((r) => { r.checked = r.value === settings.voiceEngine; });
  $('systemVoiceBox').classList.toggle('hidden', settings.voiceEngine === 'neural');
  $('neuralBox').classList.toggle('hidden', settings.voiceEngine !== 'neural');
  $('neuralVoice').value = settings.neuralVoice;
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
bind('model', 'model', (v) => {
  settings.fallbackModels = []; // модель выбрана вручную — запасные от мастера больше не подходят
  return v.trim().replace(/^models\//, '') || (PROVIDERS[settings.provider]?.model ?? '');
});
bind('baseUrl', 'baseUrl', (v) => v.trim());

$('provider').innerHTML = Object.entries(PROVIDERS).map(([id, p]) => `<option value="${id}">${esc(p.name.replace(/ \(.*\)$/, ''))}</option>`).join('');
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
bind('adaptivePause', 'adaptivePause');
bind('selfCheck', 'selfCheck');
bind('breakEvery', 'breakEvery', Number, 'input');
$('headsetButtons').addEventListener('change', (e) => {
  settings.headsetButtons = e.target.checked;
  saveSettings(settings);
  if (settings.headsetButtons) { enableHeadset(); toast('Попробуйте кнопку пуск/пауза на наушниках во время диктовки'); } else disableMedia();
});
document.querySelectorAll('input[name=pauseMode]').forEach((r) => r.addEventListener('change', () => {
  settings.pauseMode = r.value;
  saveSettings(settings);
}));

// ---------- Нейросетевой голос ----------

$('neuralVoice').innerHTML = Object.entries(NEURAL_VOICES).map(([id, name]) => `<option value="${id}">${esc(name)}</option>`).join('');
let neuralFailNotified = false;

function applyEngine() {
  setEngine(settings.voiceEngine, settings.neuralVoice, (err) => {
    // нейроголос не сработал посреди занятия — дальше говорим голосом Android
    setEngine('system');
    if (!neuralFailNotified) { neuralFailNotified = true; toast('Нейросетевой голос не сработал — говорю голосом Android. ' + (err?.message || ''), 6000); }
  });
}

async function downloadNeural() {
  const st = $('neuralStatus');
  const id = settings.neuralVoice;
  setEngine('system'); // пока голос качается, говорим системным
  st.textContent = (await isDownloaded(id)) ? 'Загружаю голос…' : 'Скачиваю голос (около 90 МБ)…';
  try {
    await prepareNeural(id, (p) => {
      if (p.stage === 'model' && p.total) st.textContent = `Скачиваю голос: ${Math.round((p.loaded / p.total) * 100)}%`;
      else if (p.stage === 'session') st.textContent = 'Подготавливаю голос…';
    });
    if (settings.voiceEngine !== 'neural' || settings.neuralVoice !== id) return;
    neuralFailNotified = false;
    applyEngine();
    st.textContent = '✓ Голос готов и работает без интернета.';
  } catch (e) {
    st.textContent = '✗ Не удалось загрузить голос: ' + (e.message || e) + '. Пока говорю голосом Android — попробуйте позже или через Wi-Fi.';
  }
}

document.querySelectorAll('input[name=voiceEngine]').forEach((r) => r.addEventListener('change', () => {
  settings.voiceEngine = r.value;
  saveSettings(settings);
  renderSettings();
  if (settings.voiceEngine === 'neural') downloadNeural(); else applyEngine();
}));
$('neuralVoice').addEventListener('change', (e) => {
  settings.neuralVoice = e.target.value;
  saveSettings(settings);
  downloadNeural();
});
$('testNeural').addEventListener('click', async () => {
  audioContext();
  stopSpeaking();
  if ($('neuralStatus').textContent.startsWith('Скач')) return toast('Голос ещё скачивается');
  speak('Привет! Так звучит нейросетевой голос. Определение: производная — это скорость изменения функции.', { rate: settings.rate });
});

// звук Web Audio и кнопки наушников включаются только после касания экрана
document.addEventListener('pointerdown', () => {
  if (settings.voiceEngine === 'neural') audioContext();
  if (settings.headsetButtons && project) enableHeadset();
}, { capture: true });

function enableHeadset() {
  enableMedia({ toggle: () => dict.toggle(), next: () => dict.next(), previous: () => dict.repeat() });
  updateMedia(dictTitle(), ['speaking', 'gap', 'waiting', 'reviewing'].includes(dict.state));
}
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
$('deleteProject').addEventListener('click', () => deleteSubject());

// ---------- Предметы ----------

function renderSubject() {
  $('subjectName').textContent = curSubject()?.title || 'Предмет';
  $('subjectList').innerHTML = (subjects?.list || []).map((x) =>
    `<button class="sheet-item ${x.id === cur() ? 'active' : ''}" data-subject="${x.id}">${esc(x.title)}</button>`).join('');
}

async function openSubject(id) {
  resetDictation();
  dict.rec.stop();
  disableMedia();
  subjects.current = id;
  saveSubjects(subjects);
  sources = (await idbGet('sources:' + id)) || [];
  project = (await idbGet('project:' + id)) || null;
  progress = loadProgress(id);
  openTopic = null;
  if (project) {
    project.topics.forEach((t) => { if (t.status === 'generating') t.status = 'pending'; });
    if (!progress || progress.projectId !== project.id) progress = freshProgress(project.id);
    budgetMin = project.budgetMin;
    const r = document.querySelector(`input[name=priority][value=${project.priority}]`);
    if (r) r.checked = true;
    gen.loop();
  } else {
    progress = null;
  }
  renderSubject();
  renderSources();
  renderBudget();
  render();
}

function newSubject() {
  const title = (prompt('Название предмета', `Предмет ${subjects.list.length + 1}`) || '').trim();
  if (!title) return;
  const id = 's' + uid();
  subjects.list.push({ id, title: title.slice(0, 40) });
  saveSubjects(subjects);
  openSubject(id).then(() => switchTab('load'));
}

function renameSubject() {
  const s = curSubject();
  const title = (prompt('Новое название предмета', s.title) || '').trim();
  if (!title) return;
  s.title = title.slice(0, 40);
  saveSubjects(subjects);
  renderSubject();
}

async function deleteSubject() {
  const s = curSubject();
  if (!s || !confirm(`Удалить предмет «${s.title}» вместе с планом, конспектами и прогрессом?`)) return;
  await idbDel('project:' + s.id);
  await idbDel('sources:' + s.id);
  clearProgress(s.id);
  subjects.list = subjects.list.filter((x) => x.id !== s.id);
  if (!subjects.list.length) subjects.list.push({ id: 's' + uid(), title: 'Предмет 1' });
  await openSubject(subjects.list[0].id);
  switchTab('load');
  toast('Предмет удалён');
}

/** Первый запуск новой версии: переносим единственный проект в список предметов. */
async function loadOrMigrateSubjects() {
  subjects = loadSubjects();
  if (subjects?.list?.length) return;
  const id = 's' + uid();
  const oldProject = await idbGet('project');
  const oldSources = await idbGet('sources');
  const oldProgress = loadProgress();
  const name = oldProject?.sources?.[0]?.name || oldSources?.[0]?.name;
  subjects = { list: [{ id, title: name ? name.replace(/\.[a-z0-9]+$/i, '').slice(0, 40) : 'Предмет 1' }], current: id };
  if (oldProject) await idbSet('project:' + id, oldProject);
  if (oldSources) await idbSet('sources:' + id, oldSources);
  if (oldProgress) saveProgress(oldProgress, id);
  saveSubjects(subjects);
  if (oldProject) await idbDel('project');
  if (oldSources) await idbDel('sources');
  clearProgress();
}

const openSubjectSheet = (on) => $('subjectSheet').classList.toggle('hidden', !on);
$('subjectBtn').addEventListener('click', () => { renderSubject(); openSubjectSheet(true); });
$('subjectSheet').addEventListener('click', (e) => {
  const b = e.target.closest('[data-subject]');
  if (b) { openSubjectSheet(false); if (b.dataset.subject !== cur()) openSubject(b.dataset.subject); return; }
  if (e.target.closest('[data-close]')) openSubjectSheet(false);
});
$('subjectNew').addEventListener('click', () => { openSubjectSheet(false); newSubject(); });
$('subjectRename').addEventListener('click', () => { openSubjectSheet(false); renameSubject(); });
$('subjectDelete').addEventListener('click', () => { openSubjectSheet(false); deleteSubject(); });

// ---------- Карточка «продолжить» ----------

function renderResume() {
  const show = !!project && !!progress && (progress.spoken > 0 || progress.topicId) && dict.state === 'idle';
  $('resumeCard').classList.toggle('hidden', !show);
  if (!show) return;
  const t = project.topics.find((x) => x.id === progress.topicId);
  const seq = activeSeq(project);
  const done = seq.filter((x) => progress.done?.[x.id]).length;
  $('resumeText').textContent = t
    ? `«${t.title}» · пройдено тем ${done} из ${seq.length}`
    : `Пройдено тем ${done} из ${seq.length}`;
}
$('resumeCard').addEventListener('click', () => { switchTab('dictate'); dict.start(); });

// ---------- Общий рендер ----------

function render() {
  if (activeTab === 'plan') renderPlan();
  if (activeTab === 'dictate') renderDictation();
  if (activeTab === 'load') renderResume();
  $('micState').classList.toggle('on', !!dict.micOn);
  // СТОП: всегда на экране диктовки, на других — пока идёт диктовка
  const active = !['idle', 'finished'].includes(dict.state);
  const showStop = !!project && (activeTab === 'dictate' || active);
  $('stopBar').classList.toggle('hidden', !showStop);
  document.body.classList.toggle('has-stop', showStop);
  $('headphonesTip').classList.toggle('hidden', tipHidden() || !srSupported || !project);
}

function renderWarnings() {
  const warn = [];
  if (!ttsSupported) warn.push('Этот браузер не поддерживает синтез речи. Откройте приложение в Chrome на Android.');
  if (!srSupported) {
    warn.push('Этот браузер не распознаёт речь — голосовые команды недоступны. Откройте приложение в Chrome; пока можно пользоваться кнопкой «СТОП / ВОПРОС» и писать вопросы.');
  }
  if (location.protocol !== 'https:' && !/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
    warn.push('Страница открыта не по HTTPS — микрофон и установка приложения работать не будут. Разместите приложение на GitHub Pages или Netlify.');
  }
  $('srWarn').innerHTML = warn.map(esc).join('<br>');
  $('srWarn').classList.toggle('hidden', !warn.length);
}

// ---------- Мастер первого запуска ----------

const wizard = initOnboarding({
  getSettings: () => settings,
  save: () => { saveSettings(settings); renderSettings(); },
  onFinish: (goSettings) => {
    renderSettings();
    if (goSettings) { $('manualAi').open = true; switchTab('settings'); } else switchTab(project ? activeTab : 'load');
    if (project && !gen.running && gen.pick(project)) gen.loop();
  },
});
$('rerunWizard').addEventListener('click', () => wizard.open(1));

// ---------- Установка как приложения ----------

let installPrompt = null;
const isInstalled = () => matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches;

function renderInstall() {
  const show = !isInstalled();
  $('installCard').classList.toggle('hidden', !show);
  $('obInstall').classList.toggle('hidden', !show);
}

async function installApp() {
  if (installPrompt) {
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice.catch(() => ({}));
    installPrompt = null;
    if (outcome === 'accepted') toast('Устанавливаю… Потом открывайте приложение с иконки на экране.', 5000);
  } else {
    toast('Откройте меню Chrome ⋮ → «Установить приложение» (или «Добавить на главный экран»).', 6000);
  }
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); // показываем свою кнопку вместо всплывающей подсказки Chrome
  installPrompt = e;
  renderInstall();
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  toast('Приложение установлено — открывайте его с иконки «Диктор».', 5000);
});
$('installBtn').addEventListener('click', installApp);
$('obInstall').addEventListener('click', installApp);

// ---------- Старт ----------

async function init() {
  renderSettings();
  renderWarnings();
  $('appInfo').textContent = 'Данные хранятся только на этом устройстве. Позиция диктовки сохраняется автоматически.';
  loadVoices().then(renderVoices);
  if (ttsSupported) speechSynthesis.addEventListener?.('voiceschanged', () => { loadVoices().then(renderVoices); });

  applyEngine();
  if (settings.voiceEngine === 'neural') downloadNeural();
  await loadOrMigrateSubjects();
  await openSubject(subjects.current || subjects.list[0].id);
  renderInstall();
  if (!settings.apiKey && !onboardingDone()) wizard.open(0);
  // быстрое действие на иконке: «Продолжить диктовку»
  if (new URLSearchParams(location.search).get('go') === 'dictate' && project) switchTab('dictate');

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  window.addEventListener('pagehide', persistProgress);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') persistProgress(); });
}

init();
