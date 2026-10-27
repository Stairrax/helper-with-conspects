// Экзаменационные билеты: список вопросов к экзамену, ответ на каждый по конспекту, «тяни билет».
// Билет: { id, q, a (готовый ответ), topics: [id тем], status: 'pending' | 'ready' | 'error' }.
// Ответы готовятся пачками по несколько билетов — так меньше запросов к нейросети.

import { generateJSON, conn } from './ai.js';
import { norm } from './speech.js';

const uid = () => Math.random().toString(36).slice(2, 10);
const BATCH = 5;
const MAX_TICKETS = 150;
const TEXT_LIMIT = 24000; // столько текста конспекта уходит на одну пачку билетов

// «Билет 3.», «Вопрос № 12)», «7.», «—» — в начале строки
const PREFIX = /^\s*(?:(?:билет|вопрос|ticket|question)\s*(?:№|no\.?|#)?\s*\d+\s*[.):-]?\s*|№\s*\d+\s*[.):-]?\s*|\d{1,3}\s*[.)]\s*|[-•*–—]\s+)+/i;

/** Текст, вставленный студентом, -> вопросы (строка — вопрос; перенос строки внутри вопроса склеивается). */
export function parseTickets(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const q = line.replace(PREFIX, '').trim();
    const numbered = q !== line;
    // заголовок списка: «Вопросы к экзамену по …:»
    if (!numbered && /[:：]$/.test(q) && /вопрос|билет|question|exam/i.test(q)) continue;
    // продолжение предыдущей строки (текст из PDF рвётся посередине вопроса)
    if (!numbered && out.length && /^[a-zа-яё(«"]/.test(q)) { out[out.length - 1] += ' ' + q; continue; }
    if (q.replace(/[^\p{L}\p{N}]/gu, '').length < 4) continue;
    out.push(q);
  }
  return out.slice(0, MAX_TICKETS);
}

/** Новый список билетов; у вопросов, которые уже были, сохраняются ответ и id (а значит, и оценки). */
export function mergeTickets(old, questions) {
  const byQ = new Map((old || []).map((t) => [norm(t.q), t]));
  return questions.map((q) => byQ.get(norm(q)) || { id: 't' + uid(), q, a: '', topics: [], status: 'pending' });
}

const stems = (s) => norm(s).split(' ').filter((w) => w.length >= 4).map((w) => w.slice(0, Math.max(4, Math.ceil(w.length * 0.7))));

/** Темы конспекта, где скорее всего ответ на вопрос: по словам из вопроса в названии, выжимке и тексте темы. */
export function relevantTopics(topics, question, max = 3) {
  const q = [...new Set(stems(question))];
  if (!q.length) return [];
  const scored = topics.map((t) => {
    const title = stems(t.title), sum = stems(t.summary || ''), body = norm(t.text || '').slice(0, 40000);
    let s = 0;
    for (const w of q) {
      if (title.some((x) => x.startsWith(w) || w.startsWith(x))) s += 5;
      if (sum.some((x) => x.startsWith(w) || w.startsWith(x))) s += 2;
      const hits = body.split(' ' + w).length - 1;
      s += Math.min(4, hits) * 0.5;
    }
    return { t, s };
  }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  return scored.slice(0, max).map((x) => x.t);
}

/** Текст конспекта для пачки билетов: весь, если короткий, иначе — подходящие темы. -> { text, topics } */
function contextFor(project, batch) {
  const topics = project.topics.filter((t) => t.text);
  const full = topics.reduce((n, t) => n + t.text.length, 0);
  const pick = full <= TEXT_LIMIT ? topics : [...new Set(batch.flatMap((b) => relevantTopics(topics, b.q)))];
  const per = Math.max(2500, Math.floor(TEXT_LIMIT / Math.max(1, pick.length)));
  const parts = pick.map((t, i) => `[${i + 1}] ${t.title}\n${t.text.slice(0, per)}`);
  return { text: parts.join('\n\n'), topics: pick };
}

const SYS = 'Ты — преподаватель, который помогает студенту готовиться к устному экзамену по его конспекту. Отвечай строго JSON.';

/** Готовит ответы для следующей пачки билетов. -> сколько билетов подготовлено (0 — готовить нечего). */
export async function prepareNextBatch(project, settings, onStatus = () => {}) {
  const batch = (project.tickets || []).filter((t) => t.status !== 'ready' && (t.errors || 0) < 3).slice(0, BATCH);
  if (!batch.length) return 0;
  const { text, topics } = contextFor(project, batch);
  const prompt =
`КОНСПЕКТ (темы пронумерованы):
<<<
${text}
>>>
Вопросы экзаменационных билетов:
${batch.map((b, i) => `${i + 1}. ${b.q}`).join('\n')}

Для каждого вопроса подготовь ответ, который студент расскажет на экзамене за 2–3 минуты: 6–12 коротких ясных предложений по плану —
определение или суть, главные положения, пример или формула, если есть. Опирайся на конспект; если в нём чего-то нет — дополни из общих знаний, коротко.
Части ответа можно разделять переносом строки. Без markdown, формулы — как в конспекте.
"t" — номера тем конспекта, на которые опирается ответ.
Ответ JSON: {"answers":[{"n":1,"a":"…","t":[1]}]}`;
  onStatus(`Готовлю ответы на билеты: ${batch.length}…`);
  let res;
  try {
    res = await generateJSON({ ...conn(settings), system: SYS, parts: [{ text: prompt }], onStatus, temperature: 0.3 });
  } catch (e) {
    for (const b of batch) { b.errors = (b.errors || 0) + 1; b.status = 'error'; }
    throw e;
  }
  const list = Array.isArray(res.answers) ? res.answers : [];
  batch.forEach((b, i) => {
    const x = list.find((y) => +y.n === i + 1) || list[i];
    const a = String(x?.a || '').trim();
    if (!a) { b.errors = (b.errors || 0) + 1; b.status = 'error'; return; }
    b.a = a;
    b.topics = (Array.isArray(x.t) ? x.t : []).map((n) => topics[+n - 1]?.id).filter(Boolean);
    if (!b.topics.length) b.topics = relevantTopics(project.topics, b.q, 2).map((t) => t.id);
    b.status = 'ready';
    delete b.errors;
  });
  return batch.length;
}

// ---------- Оценки ----------

export const GRADES = {
  5: ['отлично', 'excellent'],
  4: ['хорошо', 'good'],
  3: ['удовлетворительно', 'satisfactory'],
  2: ['неудовлетворительно', 'fail'],
};

/** Первое слово ответа экзаменатора -> оценка 5…2 или 0. */
export function gradeOf(text) {
  const first = norm(text).split(' ')[0];
  for (const [g, words] of Object.entries(GRADES)) if (words.includes(first)) return +g;
  if (['unsatisfactory', 'failed', 'poor'].includes(first)) return 2;
  return 0;
}

/** Оценка за билет -> балл темы для повторения (как у самопроверки: 1, 0.5, 0). */
export const gradeScore = (g) => ({ 5: 1, 4: 0.75, 3: 0.5, 2: 0 }[g] ?? null);

/**
 * Какой билет тянуть: сначала те, на которые ещё не отвечали, потом — с оценкой ниже пятёрки, потом любой.
 * rnd — для автотестов.
 */
export function drawTicket(tickets, results = {}, rnd = Math.random) {
  if (!tickets?.length) return null;
  const fresh = tickets.filter((t) => !results[t.id]);
  const weak = tickets.filter((t) => results[t.id] && results[t.id].grade < 5);
  const pool = fresh.length ? fresh : weak.length ? weak : tickets;
  return pool[Math.floor(rnd() * pool.length)];
}

/** Сводка: сколько готово, на сколько отвечено, средняя оценка. */
export function ticketSummary(tickets, results = {}) {
  const ready = tickets.filter((t) => t.status === 'ready').length;
  const answered = tickets.filter((t) => results[t.id]);
  const avg = answered.length ? answered.reduce((s, t) => s + results[t.id].grade, 0) / answered.length : 0;
  return { total: tickets.length, ready, answered: answered.length, avg };
}

/** Фраза-окончание длинного ответа: «всё», «я закончил», «у меня всё». -> текст без неё или null. */
export function endOfAnswer(text) {
  const t = norm(text);
  const re = /(?:^|\s)(?:(?:ну |вот |так |у меня |это |я |на этом )?(?:все|закончил[аи]?|закончила|закончено|готово|конец ответа|ответ окончен|все сказал)|that s all|that s it|i m done|i am done|i m finished|done|finished|end of answer)$/;
  if (!re.test(t)) return null;
  const words = t.split(' ');
  // одиночное «всё» в конце длинной фразы — часто просто слово в ответе («…включает всё»): засчитываем только явное окончание
  const tail = t.match(re)[0].trim();
  if (words.length > 4 && /^(?:все|готово|done|finished)$/.test(tail) && !/[.!?…]\s*\S+[.!?…]*\s*$/.test(String(text).trim())) return null;
  // убираем из исходного текста столько слов с конца, сколько их в окончании (знаки препинания словами не считаем)
  const tokens = String(text).trim().split(/\s+/);
  let k = tail.split(' ').length;
  while (tokens.length && k > 0) { const n = norm(tokens.pop()); if (n) k -= n.split(' ').length; }
  return tokens.join(' ').replace(/[\s,;:—-]+$/, '');
}
