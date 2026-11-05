// Тест с вариантами ответа. Вопросы готовит нейросеть — один запрос на тему, сразу несколько вопросов.
// Дальше тест проходится сколько угодно раз без единого запроса: правильный ответ известен приложению.
// Хранится в project.tests = { [id темы]: { at, items: [{ q, a, w: [3 неверных] }] } }.

import { generateJSON, conn } from './ai.js';

const PER_TOPIC = 5;      // вопросов на тему за один запрос
const TEXT_LIMIT = 14000; // столько текста темы уходит в запрос

const SYS = 'Ты методист: составляешь проверочные вопросы по конспекту студента. Отвечай только JSON.';

/** Готовые вопросы темы (пустой список, если их ещё нет). */
export const testItems = (project, topicId) => project?.tests?.[topicId]?.items || [];

/** Темы, по которым можно составить тест: подготовленные; сначала пройденные. */
export function testTopics(topics, done = {}) {
  const ready = topics.filter((t) => t.status === 'ready');
  return [...ready.filter((t) => done[t.id]), ...ready.filter((t) => !done[t.id])];
}

/** Сколько вопросов уже готово по этим темам. */
export const readyCount = (project, topics) => topics.reduce((n, t) => n + testItems(project, t.id).length, 0);

/** Один запрос: вопросы с вариантами ответа по теме. Кладёт их в project.tests. */
export async function makeTest(project, topic, settings, onStatus = () => {}) {
  const prompt =
`Тема: «${topic.title}».
ИСХОДНЫЙ ТЕКСТ:
<<<
${String(topic.text || '').slice(0, TEXT_LIMIT)}
>>>
Составь ${PER_TOPIC} вопросов с выбором ответа по самому важному в теме — то, что спросят на экзамене.
Для каждого вопроса:
"q" — вопрос одним предложением;
"a" — верный ответ, коротко (до 10 слов);
"w" — ровно три неверных варианта, правдоподобных и примерно той же длины, что верный: частые ошибки, соседние понятия, перепутанные формулировки.
Неверные варианты должны быть именно неверными, не «отчасти верными». Не используй «всё перечисленное», «ничего из перечисленного», «оба варианта».
Вопросы не повторяют друг друга. Без markdown, формулы — словами или как в конспекте.
Ответ JSON: {"items":[{"q":"…","a":"…","w":["…","…","…"]}]}`;
  onStatus(`Готовлю вопросы: «${topic.title}»…`);
  const res = await generateJSON({ ...conn(settings), system: SYS, parts: [{ text: prompt }], onStatus, temperature: 0.4 });
  const items = (Array.isArray(res.items) ? res.items : [])
    .map((x) => ({
      q: String(x.q || '').trim(),
      a: String(x.a || '').trim(),
      w: (Array.isArray(x.w) ? x.w : []).map((s) => String(s || '').trim()).filter(Boolean),
    }))
    // вариантов должно быть четыре и все разные, иначе вопрос бесполезен
    .filter((x) => x.q && x.a && x.w.length >= 3 && new Set([x.a.toLowerCase(), ...x.w.map((s) => s.toLowerCase())]).size === 4)
    .map((x) => ({ ...x, w: x.w.slice(0, 3) }));
  if (!items.length) throw new Error('Нейросеть не вернула вопросы');
  (project.tests ||= {})[topic.id] = { at: Date.now(), items };
  return items.length;
}

/** Случайный порядок (отдельный rnd — чтобы тесты были предсказуемыми). */
function shuffle(arr, rnd = Math.random) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/**
 * Вопросы для прохождения: count штук из указанных тем, вперемешку, варианты в случайном порядке.
 * -> [{ q, options: [4], correct: индекс, topicId, topicTitle }]
 */
export function buildQuiz(project, topics, count, rnd = Math.random) {
  const pool = topics.flatMap((t) => testItems(project, t.id).map((x) => ({ ...x, topicId: t.id, topicTitle: t.title })));
  return shuffle(pool, rnd).slice(0, count).map((x) => {
    const options = shuffle([x.a, ...x.w], rnd);
    return { q: x.q, options, correct: options.indexOf(x.a), topicId: x.topicId, topicTitle: x.topicTitle };
  });
}

/** Сколько тем нужно подготовить, чтобы набралось count вопросов. */
export function topicsToPrepare(project, topics, count) {
  let have = 0;
  const out = [];
  for (const t of topics) {
    if (have >= count) break;
    const n = testItems(project, t.id).length;
    if (n) { have += n; continue; }
    out.push(t);
    have += PER_TOPIC;
  }
  return out;
}

/** Итог: {right, total, pct, weak: [названия тем]} — слабые те, где меньше половины верных. */
export function testResult(quiz, answers) {
  const byTopic = new Map();
  let right = 0;
  quiz.forEach((q, i) => {
    const ok = answers[i] === q.correct;
    if (ok) right++;
    const s = byTopic.get(q.topicId) || { title: q.topicTitle, right: 0, total: 0 };
    s.total++;
    if (ok) s.right++;
    byTopic.set(q.topicId, s);
  });
  const weak = [...byTopic.values()].filter((s) => s.right * 2 < s.total).map((s) => s.title);
  return { right, total: quiz.length, pct: quiz.length ? Math.round((right / quiz.length) * 100) : 0, weak, byTopic };
}

export { PER_TOPIC };
