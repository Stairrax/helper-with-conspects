// Статистика занятий: сколько минут занимались по дням, серия дней подряд, результаты экзаменов.
// Общая для всех предметов, хранится в localStorage (kd.stats) — только на этом устройстве.

const KEY = 'kd.stats';
const DAY = 86400000;

let data = null;
let unsaved = 0;

function load() {
  if (data) return data;
  try { data = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { data = null; }
  if (!data || typeof data !== 'object') data = {};
  data.days ||= {};   // 'ГГГГ-ММ-ДД' (по местному времени) -> секунды
  data.exams ||= [];  // { at, subject, right, n }
  return data;
}

function save() {
  unsaved = 0;
  try { localStorage.setItem(KEY, JSON.stringify(data)); } catch { /* ignore */ }
}

/** Дата по местному времени: занятие в 23:30 — сегодняшнее, а не завтрашнее по Гринвичу. */
export function dayKey(t = Date.now()) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** +секунды занятий сегодня (вызывается раз в секунду, пока идёт диктовка, вопросы, самопроверка). */
export function addStudy(sec = 1) {
  const s = load();
  const k = dayKey();
  s.days[k] = (s.days[k] || 0) + sec;
  if (++unsaved >= 10) save();
}

export function addExam({ subject = '', right = 0, n = 0, at = Date.now() }) {
  const s = load();
  s.exams.push({ at, subject, right, n });
  s.exams = s.exams.slice(-50);
  save();
}

export function flushStats() { if (data && unsaved) save(); }

/** Сводка для экрана: сегодня, серия дней, всего, последние 14 дней, последний экзамен. */
export function statsSummary(now = Date.now()) {
  const s = load();
  const sec = (t) => s.days[dayKey(t)] || 0;
  const MIN = 60; // день засчитывается в серию, если занимались хотя бы минуту
  let streak = 0;
  // серия не прерывается, если сегодня ещё не занимались
  let t = sec(now) >= MIN ? now : now - DAY;
  while (sec(t) >= MIN) { streak++; t -= DAY; }
  const last14 = [];
  for (let i = 13; i >= 0; i--) last14.push({ t: now - i * DAY, sec: sec(now - i * DAY) });
  return {
    today: sec(now),
    streak,
    total: Object.values(s.days).reduce((a, x) => a + x, 0),
    last14,
    lastExam: s.exams.at(-1) || null,
  };
}
