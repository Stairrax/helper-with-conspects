const DAY = 86400000;
const TEN_MINUTES = 600000;

// Correct guesses are not treated as mastered answers. The next due time is
// always recorded; passive listening must not call this function.
export function reviewResult(previous, score, confidence = 'unsure', now = Date.now()) {
  const st = { ...previous };
  st.ease = Math.max(1.3, Math.min(3, Number(st.ease) || 2.5));
  if (score < 1) {
    st.interval = 0;
    st.ease = Math.max(1.3, st.ease - 0.2);
    st.lapses = (st.lapses || 0) + 1;
    st.reviewStatus = st.lapses >= 6 ? 'leech' : 'learning';
    st.due = now + TEN_MINUTES;
  } else {
    const factor = confidence === 'sure' ? 1 : confidence === 'guessed' ? 0.6 : 0.8;
    st.interval = Math.max(1, Math.min(60, (st.interval || 1) * st.ease * factor));
    st.reviewStatus = st.interval < 21 ? 'young' : 'mature';
    st.due = now + st.interval * DAY;
  }
  st.best_conf = confidence === 'sure' ? 'sure' : st.best_conf || confidence;
  st.due_at = st.due;
  return st;
}
