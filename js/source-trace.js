// A source marker is evidence of a matching quote, not proof that the AI's
// interpretation of that quote is correct.
// A normalized-only match needs enough context to avoid weak, accidental citations.
// Short exact excerpts (notably mathematical formulas) remain eligible.
const MIN_QUOTE = 20;

export function sourceSpan(source, quote) {
  if (typeof source !== 'string' || typeof quote !== 'string' || !quote.trim()) return null;
  const fold = text => text.toLowerCase().replace(/ё/g, 'е').replace(/[«»„“”]/g, '"').replace(/[‐‑‒–—−]/g, '-').replace(/\u00ad/g, '').replace(/\s+/g, ' ');
  const chars = [], offsets = [];
  for (let i = 0; i < source.length; i++) {
    const normalized = fold(source[i]);
    if (/\s/.test(normalized) && chars.at(-1) === ' ') continue;
    for (const char of normalized) { chars.push(char); offsets.push(i); }
  }
  const needle = fold(quote.trim());
  if (!needle) return null;
  const at = chars.join('').indexOf(needle);
  if (at < 0) return null;
  const start = offsets[at], end = offsets[at + needle.length - 1] + 1;
  // A short fuzzy match ('е' vs 'ё', typography, case or whitespace) can
  // accidentally label a model-generated claim as verified. Require 20+
  // normalized characters unless the original source contains the exact quote.
  if (needle.length < MIN_QUOTE && source.slice(start, end) !== quote.trim()) return null;
  return { start, end };
}

export function traceClaim(source, quote) {
  const span = sourceSpan(source, quote);
  return span ? { quote: source.slice(span.start, span.end), ...span } : null;
}
