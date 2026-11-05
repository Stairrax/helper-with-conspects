// План подготовки к экзамену в файл календаря (.ics): по событию на каждый день до экзамена.
// Открывается в Google Календаре, «Календаре» на iPhone и почти в любом другом.

/** Сколько новых тем в день, чтобы успеть к экзамену (последний день оставляем на повторение). */
export function perDayCount(left, days) {
  if (days <= 0) return 0;
  return Math.ceil(left / (days >= 2 ? days - 1 : 1));
}

const DAY_MS = 86400000;
const pad = (n) => String(n).padStart(2, '0');
const dayStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** Дата 'ГГГГ-ММ-ДД' как местный полдень: так сдвиг часового пояса не меняет день. */
const noon = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d, 12); };

/**
 * Расписание подготовки по дням: [{ date, kind: 'study' | 'review' | 'exam', titles }].
 * topics — непройденные темы по порядку, examDate — 'ГГГГ-ММ-ДД'.
 */
export function prepSchedule(topics, examDate, now = Date.now()) {
  if (!examDate) return [];
  const today = new Date(now); today.setHours(12, 0, 0, 0);
  const exam = noon(examDate);
  const days = Math.round((exam - today) / DAY_MS);
  if (days < 0) return [];
  const out = [];
  const left = [...topics];
  const perDay = perDayCount(left.length, days);
  // новые темы — до предпоследнего дня включительно, последний день перед экзаменом — повторение
  const studyDays = days >= 2 ? days - 1 : days >= 1 ? 1 : 0;
  for (let i = 0; i < studyDays; i++) {
    const titles = left.splice(0, perDay);
    if (!titles.length) break; // темы кончились раньше, чем дни: пустых событий в календаре не нужно
    out.push({ date: dayStr(new Date(today.getTime() + i * DAY_MS)), kind: 'study', titles });
  }
  // остаток (если тем больше, чем помещается) — в последний учебный день
  if (left.length && out.length) out[out.length - 1].titles.push(...left.splice(0));
  if (days >= 2) out.push({ date: dayStr(new Date(exam.getTime() - DAY_MS)), kind: 'review', titles: [] });
  out.push({ date: dayStr(exam), kind: 'exam', titles: [] });
  return out;
}

// ---------- .ics ----------

const escText = (s) => String(s).replace(/\\/g, '\\\\').replace(/[;,]/g, (c) => '\\' + c).replace(/\r?\n/g, '\\n');
const compact = (s) => s.replace(/-/g, '');

/** Строка .ics не длиннее 75 байт: продолжение — с пробела (RFC 5545). */
function fold(line) {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out = [];
  let cur = '', len = 0, limit = 75;
  for (const ch of line) {
    const n = new TextEncoder().encode(ch).length;
    if (len + n > limit) { out.push(cur); cur = ' '; len = 1; limit = 75; }
    cur += ch; len += n;
  }
  out.push(cur);
  return out.join('\r\n');
}

const stamp = (t) => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const nextDay = (d) => dayStr(new Date(noon(d).getTime() + DAY_MS));

/**
 * Файл календаря по расписанию. subject — название предмета, en — английские подписи,
 * remindAt — час напоминания в день события (0 — без напоминания).
 */
export function buildIcs(schedule, { subject = '', en = false, now = Date.now(), remindAt = 9 } = {}) {
  const L = (ru, eng) => (en ? eng : ru);
  const subj = subject ? `${subject}: ` : '';
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Study Helper//Exam plan//RU', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  schedule.forEach((d, i) => {
    const title = d.kind === 'exam' ? L('Экзамен', 'Exam')
      : d.kind === 'review' ? L('Повторение перед экзаменом', 'Review before the exam')
        : `${L('Подготовка', 'Study')}: ${d.titles.length} ${en ? (d.titles.length === 1 ? 'topic' : 'topics') : plural(d.titles.length, ['тема', 'темы', 'тем'])}`;
    const body = d.kind === 'study' ? d.titles.join('\n')
      : d.kind === 'review' ? L('Слабые места, билеты, шпаргалка.', 'Weak spots, tickets, the cheat sheet.')
        : L('Удачи!', 'Good luck!');
    lines.push('BEGIN:VEVENT',
      `UID:kd-${compact(d.date)}-${i}@study-helper`,
      `DTSTAMP:${stamp(now)}`,
      `DTSTART;VALUE=DATE:${compact(d.date)}`,
      `DTEND;VALUE=DATE:${compact(nextDay(d.date))}`,
      fold(`SUMMARY:${escText(subj + title)}`),
      fold(`DESCRIPTION:${escText(body)}`),
      'TRANSP:TRANSPARENT');
    if (remindAt > 0) {
      lines.push('BEGIN:VALARM', `TRIGGER:PT${remindAt}H`, 'ACTION:DISPLAY', fold(`DESCRIPTION:${escText(subj + title)}`), 'END:VALARM');
    }
    lines.push('END:VEVENT');
  });
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

function plural(n, forms) {
  const a = n % 100, b = n % 10;
  return a >= 11 && a <= 14 ? forms[2] : b === 1 ? forms[0] : b >= 2 && b <= 4 ? forms[1] : forms[2];
}
