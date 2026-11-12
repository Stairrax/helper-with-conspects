const DAY = 86400000;
const TEN_MINUTES = 600000;
const MAX_INTERVAL_DAYS = 60;
const MIN_EASE = 1.3;
const MAX_EASE = 3;
const LEECH_LAPSES = 6;
const LEECH_RECOVERY_PER_SURE = 2; // three confident answers rehabilitate a leech

/** Local calendar day for a humane daily review budget (not a rolling UTC window). */
export function reviewDayKey(now = Date.now()) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// A failed card remains due, but is marked as a leech after repeated lapses.
// Passive listening must never count as a successful review.
export function reviewResult(previous, score, confidence = 'unsure', now = Date.now(), random = Math.random) {
  const st = { ...(previous || {}) };
  const ease = Number(st.ease);
  st.ease = Math.max(MIN_EASE, Math.min(MAX_EASE, Number.isFinite(ease) && ease > 0 ? ease : 2.5));
  const interval = Number(st.interval);
  const priorInterval = Number.isFinite(interval) && interval > 0 ? interval : 1;
  // Legacy intervals already imply a previous successful review.
  const oldReps = Number(st.reps);
  st.reps = Number.isSafeInteger(oldReps) && oldReps >= 0 ? oldReps : (Number.isFinite(interval) && interval > 0 ? 1 : 0);
  const lapses = Number(st.lapses);
  st.lapses = Number.isSafeInteger(lapses) && lapses >= 0 ? lapses : 0;
  // lapses is a lifetime statistic; recentLapses is the recoverable leech score.
  // Older saves have only lapses, so migrate them without resetting leeches.
  const recent = Number(st.recentLapses);
  st.recentLapses = Number.isSafeInteger(recent) && recent >= 0
    ? Math.min(LEECH_LAPSES, recent)
    : Math.min(LEECH_LAPSES, st.lapses);

  if (score < 1) {
    st.interval = 0;
    st.reps = 0;
    st.ease = Math.max(MIN_EASE, st.ease - 0.2);
    st.lapses += 1;
    st.recentLapses = Math.min(LEECH_LAPSES, st.recentLapses + 1);
    st.reviewStatus = (st.reviewStatus === 'leech' && st.recentLapses > 0) || st.recentLapses >= LEECH_LAPSES ? 'leech' : 'learning';
    st.due = now + TEN_MINUTES;
  } else {
    const factor = confidence === 'sure' ? 1 : confidence === 'guessed' ? 0.6 : 0.8;
    // A fixed first interval synchronizes every topic studied in one evening.
    // Jitter only the first correct review; later repetitions use normal SRS.
    const r = Number(random());
    const firstDays = 2 + (Number.isFinite(r) ? Math.min(0.999999, Math.max(0, r)) : 0.5);
    const nextDays = st.reps === 0 ? firstDays * factor : priorInterval * st.ease * factor;
    st.interval = Math.max(1, Math.min(MAX_INTERVAL_DAYS, nextDays));
    st.reps += 1;
    // Recover only after repeated confident, correct answers; keep total lapses.
    if (score === 1 && confidence === 'sure') {
      st.recentLapses = Math.max(0, st.recentLapses - LEECH_RECOVERY_PER_SURE);
    }
    st.reviewStatus = (st.reviewStatus === 'leech' && st.recentLapses > 0) || st.recentLapses >= LEECH_LAPSES
      ? 'leech' : st.interval < 21 ? 'young' : 'mature';
    st.due = now + st.interval * DAY;
  }
  if (score === 1) st.best_conf = confidence === 'sure' ? 'sure' : st.best_conf || confidence;
  st.due_at = st.due;
  return st;
}
