const DAY = 86400000;
const TEN_MINUTES = 600000;
const MAX_INTERVAL_DAYS = 60;
const MIN_EASE = 1.3;
const MAX_EASE = 3;
const LEECH_LAPSES = 6;

// A failed card remains due, but is marked as a leech after repeated lapses.
// Passive listening must never count as a successful review.
export function reviewResult(previous, score, confidence = 'unsure', now = Date.now()) {
  const st = { ...(previous || {}) };
  const ease = Number(st.ease);
  st.ease = Math.max(MIN_EASE, Math.min(MAX_EASE, Number.isFinite(ease) && ease > 0 ? ease : 2.5));
  const interval = Number(st.interval);
  const priorInterval = Number.isFinite(interval) && interval > 0 ? interval : 1;
  const lapses = Number(st.lapses);
  st.lapses = Number.isSafeInteger(lapses) && lapses >= 0 ? lapses : 0;

  if (score < 1) {
    st.interval = 0;
    st.ease = Math.max(MIN_EASE, st.ease - 0.2);
    st.lapses += 1;
    st.reviewStatus = st.lapses >= LEECH_LAPSES ? 'leech' : 'learning';
    st.due = now + TEN_MINUTES;
  } else {
    const factor = confidence === 'sure' ? 1 : confidence === 'guessed' ? 0.6 : 0.8;
    st.interval = Math.max(1, Math.min(MAX_INTERVAL_DAYS, priorInterval * st.ease * factor));
    // Do not silently remove the leech flag after a single successful answer.
    st.reviewStatus = st.lapses >= LEECH_LAPSES ? 'leech' : st.interval < 21 ? 'young' : 'mature';
    st.due = now + st.interval * DAY;
  }
  if (score === 1) st.best_conf = confidence === 'sure' ? 'sure' : st.best_conf || confidence;
  st.due_at = st.due;
  return st;
}
