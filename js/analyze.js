// Анализ конспектов: распознавание фото, разбиение на темы, план, генерация кусков с проверкой полноты.

import { generate, generateJSON, conn, AIError as GeminiError } from './ai.js';

const PART_CHARS = 12000;     // размер части для разбиения на темы
const SECTION_CHARS = 5000;   // размер секции для генерации кусков
export const CHARS_PER_SEC = 13; // скорость русской речи TTS при rate=1
const SPOKEN_FACTOR = 1.35;   // устный текст длиннее исходного (пояснения, формулы словами)
const AVG_CHUNK = 170;

const uid = () => Math.random().toString(36).slice(2, 10);

// ---------- Разбиение текста на блоки ----------

const HEADING_RE = /^\s*(#{1,6}\s|(\d+(\.\d+)*[.)]\s)|([IVXLC]+\.\s)|(§)|(тема|глава|раздел|лекция|параграф|часть|вопрос|билет)\b)/i;

function splitSentences(text, max) {
  const sents = text.match(/[^.!?…]+[.!?…]+[»")\]]*\s*|[^.!?…]+$/g) || [text];
  const out = [];
  let cur = '';
  for (const s of sents) {
    if (cur && cur.length + s.length > max) { out.push(cur.trim()); cur = ''; }
    cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  // предложения длиннее max режем по пробелам
  return out.flatMap((b) => {
    if (b.length <= max * 1.6) return [b];
    const parts = [];
    for (let i = 0; i < b.length; i += max) parts.push(b.slice(i, i + max));
    return parts;
  });
}

/** Текст -> массив смысловых блоков (абзацы/заголовки), каждый не длиннее ~900 символов. */
export function toBlocks(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').replace(/ /g, ' ').split('\n');
  const blocks = [];
  let cur = [];
  const flush = () => { const t = cur.join('\n').trim(); if (t) blocks.push(t); cur = []; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    if (!line.trim()) { flush(); continue; }
    const t = line.trim();
    const isHeading = HEADING_RE.test(t) && t.length < 120 ||
      (t.length < 70 && !/[.,;:!?…]$/.test(t) && /^[A-ZА-ЯЁ0-9]/.test(t) && lines[i + 1]?.trim());
    if (isHeading) flush();
    cur.push(line);
    if (cur.join('\n').length > 700) flush();
  }
  flush();
  return blocks.flatMap((b) => (b.length > 1200 ? splitSentences(b, 700) : [b]));
}

function groupBlocks(blocks, maxChars) {
  const groups = [];
  let cur = [], len = 0;
  for (const b of blocks) {
    if (cur.length && len + b.length > maxChars) { groups.push(cur); cur = []; len = 0; }
    cur.push(b); len += b.length + 2;
  }
  if (cur.length) groups.push(cur);
  return groups;
}

// ---------- Промпты ----------

const SYS_METHODIST = 'Ты — опытный преподаватель и методист. Работаешь с учебными конспектами на русском языке. ' +
  'Никогда не выбрасывай и не сокращай учебную информацию. Отвечай строго в формате JSON без пояснений.';

const SYS_DICTATION = 'Ты готовишь учебный конспект к устной диктовке студенту, который записывает от руки. ' +
  'Правила: 1) передать ВСЁ содержание исходника полностью — каждое определение, факт, формулу, число, дату, перечисление, пример, вывод; ' +
  'ничего не пропускать и не обобщать; 2) порядок — как в исходнике; 3) переформулировать для устной речи: короткие ясные предложения, ' +
  'без markdown, без символов и сокращений; 4) формулы, обозначения, индексы, степени, дроби, греческие буквы, единицы измерения, ' +
  'стрелки и знаки произносить словами (например «E равно эм цэ квадрат», «альфа с индексом один», «дробь: a, делённое на b»); ' +
  'числа и даты писать словами так, как их читают вслух; 5) каждый кусок — от одного до трёх предложений, удобных для записи; ' +
  '6) ответ — строго JSON.';

// ---------- Распознавание фото ----------
// (фото отправляются выбранной нейросети как изображения)

export async function ocrImage(img, settings, onStatus) {
  return generate({
    ...conn(settings), onStatus, temperature: 0.1,
    system: 'Ты точно переписываешь учебные материалы с фотографий.',
    parts: [
      { text: 'Перепиши ВЕСЬ текст с этой страницы конспекта дословно, сохраняя структуру: заголовки начинай с «# », списки с «- ». ' +
        'Формулы записывай текстом (как в LaTeX или обычными символами). Таблицы — строками через « | ». ' +
        'Схемы и рисунки опиши словами в квадратных скобках, включая все подписи. Неразборчивое отметь [неразборчиво]. ' +
        'Ничего не добавляй от себя и ничего не пропускай. Выведи только текст.' },
      { inline_data: { mime_type: img.mime, data: img.data } },
    ],
  });
}

// ---------- Разбиение на темы ----------

async function segmentPart(blocks, sourceName, prevTitle, settings, onStatus) {
  const numbered = blocks.map((b, i) => `[${i + 1}] ${b}`).join('\n\n');
  const n = blocks.length;
  if (n === 1) return [{ title: guessTitle(blocks), from: 1, to: 1, continues: !!prevTitle }];
  const prompt =
`Фрагмент конспекта «${sourceName}» разбит на пронумерованные блоки [1]…[${n}].
Разбей его на смысловые темы. Каждая тема — непрерывный диапазон блоков from..to (включительно).
Диапазоны идут по порядку и покрывают ВСЕ блоки от 1 до ${n} без пропусков и перекрытий.
Тема — законченный смысловой раздел (обычно 1500–6000 символов, 3–15 минут диктовки). Не дроби слишком мелко и не склеивай разные разделы.
Название темы — короткое и понятное, по-русски.
${prevTitle ? `Предыдущий фрагмент закончился темой «${prevTitle}». Если начало этого фрагмента продолжает её, поставь у первой темы "continues": true.` : ''}
Ответ JSON: {"topics":[{"title":"…","from":1,"to":4,"continues":false}]}

${numbered}`;
  let topics = [];
  try {
    const res = await generateJSON({ ...conn(settings), system: SYS_METHODIST, parts: [{ text: prompt }], onStatus, temperature: 0.2 });
    topics = Array.isArray(res.topics) ? res.topics : [];
  } catch (e) {
    if (!(e instanceof GeminiError) || e.code !== 'BAD_JSON') throw e;
  }
  return normalizeRanges(topics, n, blocks);
}

function guessTitle(blocks) {
  const first = (blocks[0] || '').split('\n')[0].replace(/^#+\s*/, '').trim();
  return first.length > 80 ? first.slice(0, 77) + '…' : first || 'Тема';
}

/** Гарантирует непрерывное покрытие всех блоков — информация не теряется ни при каком ответе модели. */
export function normalizeRanges(topics, n, blocks) {
  const t = topics
    .map((x) => ({ title: String(x.title || '').trim(), from: Math.round(+x.from), to: Math.round(+x.to), continues: !!x.continues }))
    .filter((x) => x.from >= 1 && x.from <= n && !isNaN(x.to))
    .sort((a, b) => a.from - b.from);
  const out = [];
  let next = 1;
  for (const x of t) {
    if (x.from > next && out.length) out[out.length - 1].to = x.from - 1; // дыра -> к предыдущей теме
    const from = out.length ? out[out.length - 1].to + 1 : 1;
    const to = Math.min(Math.max(x.to, from), n);
    if (from > n) break;
    if (to < from) continue;
    out.push({ ...x, from, to });
    next = to + 1;
  }
  if (!out.length) return [{ title: guessTitle(blocks), from: 1, to: n, continues: false }];
  out[out.length - 1].to = n;
  out.forEach((x) => { if (!x.title) x.title = guessTitle(blocks.slice(x.from - 1, x.to)); });
  return out;
}

// ---------- Планирование ----------

async function planTopics(topics, settings, onStatus) {
  const snip = topics.length > 100 ? 200 : 400;
  const list = topics.map((t) => ({
    id: t.id, title: t.title, chars: t.chars,
    start: t.text.slice(0, snip), end: t.text.length > snip ? t.text.slice(-150) : '',
  }));
  const prompt =
`Вот список тем учебного конспекта (в исходном порядке) с началом и концом текста каждой темы.
Для каждой темы определи:
- "difficulty": сложность от 1 до 5 (1 — простые факты и определения, 3 — нужна логика и связи, 5 — сложные формулы, выводы, абстракции);
- "prerequisites": id тем из этого списка, которые нужно знать ДО этой темы (только реальные смысловые зависимости, без циклов, можно пустой список);
- "summary": одно короткое предложение — о чём тема.
Ответ JSON: {"topics":[{"id":"…","difficulty":3,"prerequisites":["…"],"summary":"…"}]}

${JSON.stringify(list)}`;
  try {
    const res = await generateJSON({ ...conn(settings), system: SYS_METHODIST, parts: [{ text: prompt }], onStatus, temperature: 0.2 });
    const map = new Map((res.topics || []).map((x) => [x.id, x]));
    const ids = new Set(topics.map((t) => t.id));
    for (const t of topics) {
      const x = map.get(t.id) || {};
      const d = Math.round(+x.difficulty);
      t.difficulty = d >= 1 && d <= 5 ? d : 3;
      t.prereq = (Array.isArray(x.prerequisites) ? x.prerequisites : []).filter((p) => ids.has(p) && p !== t.id);
      t.summary = String(x.summary || '');
    }
  } catch (e) {
    if (e.code === 'NO_KEY' || e.status === 400 || e.status === 403) throw e;
    onStatus?.('Не удалось оценить сложность — ставлю среднюю.');
    topics.forEach((t) => { t.difficulty = t.difficulty || 3; t.prereq = t.prereq || []; t.summary = t.summary || ''; });
  }
  breakCycles(topics);
}

function breakCycles(topics) {
  const byId = new Map(topics.map((t) => [t.id, t]));
  const state = new Map();
  const visit = (t) => {
    state.set(t.id, 1);
    t.prereq = t.prereq.filter((p) => {
      const s = state.get(p);
      if (s === 1) return false; // ребро образует цикл — выбрасываем
      if (!s) visit(byId.get(p));
      return true;
    });
    state.set(t.id, 2);
  };
  topics.forEach((t) => { if (!state.get(t.id)) visit(t); });
}

/** Топологическая сортировка с учётом приоритета. */
export function orderTopics(topics, priority) {
  const done = new Set();
  const left = [...topics];
  const order = [];
  const better = (a, b) => {
    if (priority === 'hard' && a.difficulty !== b.difficulty) return a.difficulty > b.difficulty;
    if (priority === 'easy' && a.difficulty !== b.difficulty) return a.difficulty < b.difficulty;
    return a.origIndex < b.origIndex;
  };
  while (left.length) {
    let best = -1;
    for (let i = 0; i < left.length; i++) {
      if (!left[i].prereq.every((p) => done.has(p))) continue;
      if (best < 0 || better(left[i], left[best])) best = i;
    }
    if (best < 0) best = 0; // на всякий случай
    const [t] = left.splice(best, 1);
    done.add(t.id);
    order.push(t.id);
  }
  return order;
}

// ---------- Оценка времени ----------

export function pauseFor(topic, chunkText, settings) {
  let p = settings.pause;
  if (settings.scalePause) {
    const d = topic?.difficulty || 3;
    p *= 1 + Math.max(0, d - 2) * 0.25;
    const len = chunkText ? chunkText.length : AVG_CHUNK;
    p *= Math.min(1.75, Math.max(0.75, len / 160));
  }
  return Math.round(p * 1000);
}

/** Оценка времени диктовки темы в секундах (от куска fromChunk). */
export function estimateTopicSec(topic, settings, fromChunk = 0) {
  const rate = settings.rate || 1;
  if (topic.chunks?.length) {
    let s = 0;
    for (let i = fromChunk; i < topic.chunks.length; i++) {
      const c = topic.chunks[i].t;
      s += c.length / (CHARS_PER_SEC * rate) + pauseFor(topic, c, settings) / 1000;
    }
    return s;
  }
  const spoken = topic.chars * SPOKEN_FACTOR;
  const n = Math.max(1, Math.round(spoken / AVG_CHUNK));
  return spoken / (CHARS_PER_SEC * rate) + n * (pauseFor(topic, null, settings) / 1000);
}

/** Доля бюджета на тему: объём × сложность. */
export function allocateBudget(project) {
  const seq = activeSeq(project);
  const w = (t) => t.chars * (1 + 0.15 * ((t.difficulty || 3) - 1));
  const total = seq.reduce((s, t) => s + w(t), 0) || 1;
  const res = {};
  for (const t of seq) res[t.id] = (project.budgetMin * 60 * w(t)) / total;
  return res;
}

/** Подбирает базовую паузу, чтобы диктовка уложилась в бюджет. */
export function fitPause(project, settings) {
  const seq = activeSeq(project);
  const rate = settings.rate || 1;
  let speak = 0, pauseUnits = 0;
  for (const t of seq) {
    const one = { ...settings, pause: 1 };
    if (t.chunks?.length) {
      for (const c of t.chunks) { speak += c.t.length / (CHARS_PER_SEC * rate); pauseUnits += pauseFor(t, c.t, one) / 1000; }
    } else {
      const spoken = t.chars * SPOKEN_FACTOR;
      speak += spoken / (CHARS_PER_SEC * rate);
      pauseUnits += Math.max(1, Math.round(spoken / AVG_CHUNK)) * pauseFor(t, null, one) / 1000;
    }
  }
  const p = (project.budgetMin * 60 - speak) / (pauseUnits || 1);
  return Math.max(1, Math.min(15, Math.round(p * 2) / 2));
}

export function activeSeq(project) {
  const byId = new Map(project.topics.map((t) => [t.id, t]));
  return project.plan.order.map((id) => byId.get(id)).filter((t) => t && !project.plan.skipped[t.id]);
}

// ---------- Главный анализ ----------

/**
 * sources: [{id,name,kind,text?,images?}] -> project
 * log(msg, fraction)
 */
export async function analyze({ sources, budgetMin, priority, settings, log }) {
  const status = (m) => log(m);
  // 1. Фото -> текст
  const imgTotal = sources.reduce((s, x) => s + (x.kind === 'images' ? x.images.length : 0), 0);
  let imgDone = 0;
  for (const s of sources) {
    if (s.kind !== 'images' || s.text) continue;
    const texts = [];
    for (const img of s.images) {
      log(`Распознаю фото: «${s.name}» (${++imgDone}/${imgTotal})`, 0.05 + 0.25 * (imgDone / Math.max(1, imgTotal)));
      texts.push(await ocrImage(img, settings, status));
    }
    s.text = texts.join('\n\n');
  }

  // 2. Темы по частям
  const topics = [];
  const parts = [];
  for (const s of sources) {
    const blocks = toBlocks(s.text || '');
    if (!blocks.length) continue;
    for (const g of groupBlocks(blocks, PART_CHARS)) parts.push({ source: s, blocks: g });
  }
  if (!parts.length) throw new Error('В материалах не найден текст.');
  let prevTitle = null, prevSource = null;
  for (let i = 0; i < parts.length; i++) {
    const { source, blocks } = parts[i];
    log(`Разбиваю на темы: часть ${i + 1} из ${parts.length}`, 0.3 + 0.45 * (i / parts.length));
    const sameSource = prevSource === source;
    const ranges = await segmentPart(blocks, source.name, sameSource ? prevTitle : null, settings, status);
    ranges.forEach((r, j) => {
      const text = blocks.slice(r.from - 1, r.to).join('\n\n');
      if (j === 0 && r.continues && sameSource && topics.length) {
        const last = topics[topics.length - 1];
        last.text += '\n\n' + text;
        last.chars = last.text.length;
      } else {
        topics.push({ id: 't' + uid(), title: r.title, text, chars: text.length, source: source.name });
      }
    });
    prevTitle = topics[topics.length - 1]?.title;
    prevSource = source;
  }
  topics.forEach((t, i) => { t.origIndex = i; t.status = 'pending'; t.chunks = []; t.points = []; });

  // 3. Сложность, зависимости, план
  log(`Оцениваю сложность и зависимости (${topics.length} тем)`, 0.8);
  await planTopics(topics, settings, status);
  const project = {
    id: 'p' + uid(),
    createdAt: Date.now(),
    budgetMin,
    priority,
    sources: sources.map((s) => ({ name: s.name, chars: (s.text || '').length })),
    fullText: sources.map((s) => `=== ${s.name} ===\n${s.text || ''}`).join('\n\n'),
    topics,
    plan: { order: [], skipped: {} },
  };
  project.plan.order = orderTopics(topics, priority);
  log('План готов. Куски для диктовки готовятся в фоне.', 1);
  return project;
}

// ---------- Генерация кусков ----------

async function genSection(topic, text, prevChunks, settings, onStatus) {
  const prompt =
`Тема: «${topic.title}» (сложность ${topic.difficulty} из 5).
${prevChunks.length ? `Последние продиктованные куски (для связности, не повторяй их):\n${prevChunks.map((c) => '— ' + c).join('\n')}\n` : ''}
ИСХОДНЫЙ ТЕКСТ:
<<<
${text}
>>>

Задание:
1. "points": выпиши ВСЕ пункты исходного текста — каждое определение, факт, формулу, число, дату, элемент перечисления, пример, вывод — отдельным коротким пунктом, в порядке исходника.
2. "chunks": последовательность кусков для диктовки. Каждый кусок "t" — 1–3 предложения. Передай всё содержание полностью, по порядку, переформулировав для устной речи; формулы и обозначения — словами. Тип "k": "content".
3. В сложных местах${topic.difficulty >= 3 ? ' (в этой теме их, вероятно, много)' : ''} добавь отдельные куски с типом "k":"explain" (начинаются словами «Пояснение:») — короткое пояснение простыми словами, и/или "k":"example" (начинаются словами «Например:») — короткий пример. Это дополнение, а не замена содержания.
4. У каждого пункта "c" — номера кусков (с нуля), в которых он передан.
5. "recap": 1–3 предложения — самое главное из этого текста для быстрого повторения перед экзаменом, для устной речи.
6. "quiz": 1–2 вопроса для самопроверки по самому важному в этом тексте, с краткими правильными ответами "a" (одно-два предложения). Вопросы — такие, на которые можно ответить устно.
Ответ JSON: {"points":[{"p":"…","c":[0]}],"chunks":[{"t":"…","k":"content"}],"recap":"…","quiz":[{"q":"…","a":"…"}]}`;
  const res = await generateJSON({ ...conn(settings), system: SYS_DICTATION, parts: [{ text: prompt }], onStatus, temperature: 0.3 });
  const chunks = (res.chunks || []).map((c) => ({ t: String(c.t || c.text || '').trim(), k: ['explain', 'example'].includes(c.k) ? c.k : 'content' })).filter((c) => c.t);
  const points = (res.points || []).map((p) => ({ p: String(p.p || p.point || '').trim(), c: (p.c || []).map(Number).filter((n) => n >= 0 && n < chunks.length) })).filter((p) => p.p);
  if (!chunks.length) throw new GeminiError('Нейросеть не вернула куски для темы', { code: 'EMPTY' });
  return { chunks, points, recap: String(res.recap || '').trim(), quiz: cleanQuiz(res.quiz) };
}

function cleanQuiz(q) {
  return (Array.isArray(q) ? q : [])
    .map((x) => ({ q: String(x.q || x.question || '').trim(), a: String(x.a || x.answer || '').trim() }))
    .filter((x) => x.q && x.a);
}

/** Выжимка и вопросы для тем, подготовленных до появления самопроверки (один запрос). */
export async function generateExtras(topic, settings, onStatus) {
  const prompt =
`Тема: «${topic.title}».
ИСХОДНЫЙ ТЕКСТ:
<<<
${topic.text.slice(0, 12000)}
>>>
1. "recap": 2–4 предложения — самое главное из темы для быстрого повторения перед экзаменом, для устной речи (формулы словами).
2. "quiz": 3 вопроса для самопроверки по самому важному в теме, с краткими правильными ответами "a". Вопросы — такие, на которые можно ответить устно.
Ответ JSON: {"recap":"…","quiz":[{"q":"…","a":"…"}]}`;
  const res = await generateJSON({ ...conn(settings), system: SYS_METHODIST, parts: [{ text: prompt }], onStatus, temperature: 0.3 });
  topic.recap = String(res.recap || '').trim();
  topic.quiz = cleanQuiz(res.quiz).slice(0, 3);
}

async function verifySection(text, chunks, points, settings, onStatus) {
  const prompt =
`Проверь полноту диктовки. Ниже исходный текст, пронумерованные куски диктовки и пронумерованный список пунктов.
ИСХОДНЫЙ ТЕКСТ:
<<<
${text}
>>>
КУСКИ:
${chunks.map((c, i) => `[${i}] ${c.t}`).join('\n')}
ПУНКТЫ:
${points.map((p, i) => `(${i}) ${p.p}`).join('\n')}

1. "checks": для каждого пункта i укажи "c" — номера кусков, где он передан ПОЛНОСТЬЮ и верно (пустой список, если не передан или искажён).
2. "missing": информация из исходного текста, которой нет ни в одном пункте списка (каждый элемент — короткий пункт). Пустой список, если всё учтено.
Ответ JSON: {"checks":[{"i":0,"c":[0,1]}],"missing":["…"]}`;
  const res = await generateJSON({ ...conn(settings), system: SYS_METHODIST, parts: [{ text: prompt }], onStatus, temperature: 0.1 });
  const checks = new Map((res.checks || []).map((x) => [Number(x.i), (x.c || []).map(Number).filter((n) => n >= 0 && n < chunks.length)]));
  points.forEach((p, i) => { if (checks.has(i)) p.c = checks.get(i); });
  const missing = (res.missing || []).map((m) => String(m).trim()).filter(Boolean);
  return missing;
}

async function supplement(topic, text, chunks, uncovered, settings, onStatus) {
  const prompt =
`Тема: «${topic.title}». В диктовке пропущены или переданы не полностью следующие пункты исходного текста:
${uncovered.map((p, i) => `(${i}) ${p}`).join('\n')}

ИСХОДНЫЙ ТЕКСТ:
<<<
${text}
>>>
ТЕКУЩИЕ КУСКИ:
${chunks.map((c, i) => `[${i}] ${c.t}`).join('\n')}

Сгенерируй дополнительные куски (1–3 предложения, для устной речи, формулы словами), полностью передающие эти пункты.
Для каждого куска укажи "after" — номер существующего куска, после которого его вставить по смыслу (-1 — в самое начало), и "p" — номера пунктов, которые он покрывает.
Ответ JSON: {"chunks":[{"t":"…","k":"content","after":3,"p":[0]}]}`;
  const res = await generateJSON({ ...conn(settings), system: SYS_DICTATION, parts: [{ text: prompt }], onStatus, temperature: 0.3 });
  return (res.chunks || []).map((c) => ({
    t: String(c.t || '').trim(),
    k: ['explain', 'example'].includes(c.k) ? c.k : 'content',
    after: Math.max(-1, Math.min(chunks.length - 1, Math.round(+c.after))),
    p: (c.p || []).map(Number),
  })).filter((c) => c.t && !isNaN(c.after));
}

/** Вставляет новые куски и пересчитывает ссылки пунктов. */
function insertChunks(chunks, points, extra) {
  const map = [];
  const out = [];
  const byAfter = new Map();
  for (const e of extra) { if (!byAfter.has(e.after)) byAfter.set(e.after, []); byAfter.get(e.after).push(e); }
  const pushExtra = (k) => (byAfter.get(k) || []).forEach((e) => { e.newIndex = out.length; out.push({ t: e.t, k: e.k }); });
  pushExtra(-1);
  chunks.forEach((c, i) => { map[i] = out.length; out.push(c); pushExtra(i); });
  points.forEach((p) => { p.c = p.c.map((i) => map[i]); });
  return out;
}

/** Генерирует куски для темы (по секциям), проверяет полноту и догенерирует пропуски. */
export async function generateTopicChunks(topic, settings, onStatus) {
  const sections = groupBlocks(toBlocks(topic.text), SECTION_CHARS).map((g) => g.join('\n\n'));
  const allChunks = [];
  const allPoints = [];
  const recaps = [];
  const quizzes = [];
  for (let si = 0; si < sections.length; si++) {
    const text = sections[si];
    const tag = sections.length > 1 ? ` (часть ${si + 1}/${sections.length})` : '';
    onStatus(`«${topic.title}»${tag}: готовлю куски`);
    let res;
    try {
      res = await genSection(topic, text, allChunks.slice(-2).map((c) => c.t), settings, onStatus);
    } catch (e) {
      if (e.code !== 'MAX_TOKENS') throw e;
      // секция слишком большая для одного ответа — делим пополам
      const half = groupBlocks(toBlocks(text), Math.ceil(text.length / 2) + 1).map((g) => g.join('\n\n'));
      sections.splice(si, 1, ...half);
      si--;
      continue;
    }
    let { chunks, points } = res;
    recaps.push(res.recap);
    quizzes.push(res.quiz);
    if (settings.coverageCheck) {
      onStatus(`«${topic.title}»${tag}: проверяю полноту`);
      let missing = [];
      try { missing = await verifySection(text, chunks, points, settings, onStatus); } catch (e) {
        if (e.code === 'NO_KEY') throw e;
      }
      missing.forEach((m) => points.push({ p: m, c: [] }));
      const uncoveredIdx = points.map((p, i) => (p.c.length ? -1 : i)).filter((i) => i >= 0);
      if (uncoveredIdx.length) {
        onStatus(`«${topic.title}»${tag}: догенерирую ${uncoveredIdx.length} пропущенных пункт(ов)`);
        try {
          const extra = await supplement(topic, text, chunks, uncoveredIdx.map((i) => points[i].p), settings, onStatus);
          chunks = insertChunks(chunks, points, extra);
          for (const e of extra) for (const pi of e.p) {
            const p = points[uncoveredIdx[pi]];
            if (p && !p.c.includes(e.newIndex)) p.c.push(e.newIndex);
          }
        } catch (e) {
          if (e.code === 'NO_KEY') throw e;
        }
      }
    }
    const off = allChunks.length;
    allChunks.push(...chunks);
    allPoints.push(...points.map((p) => ({ p: p.p, c: p.c.map((i) => i + off) })));
  }
  topic.chunks = allChunks;
  topic.points = allPoints;
  topic.recap = recaps.filter(Boolean).join(' ');
  // до трёх вопросов: по одному из разных частей темы, затем остальные
  const first = quizzes.map((q) => q[0]).filter(Boolean);
  const rest = quizzes.flatMap((q) => q.slice(1));
  topic.quiz = [...first, ...rest].slice(0, 3);
  topic.coverage = { total: allPoints.length, covered: allPoints.filter((p) => p.c.length).length, checked: !!settings.coverageCheck };
}
