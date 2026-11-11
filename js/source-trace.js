// A source marker is evidence of a matching quote, not proof that the AI's
// interpretation of that quote is correct.
export function sourceSpan(source, quote) {
  if (typeof source !== 'string' || typeof quote !== 'string' || !quote.trim()) return null;
  const fold = text => text.toLocaleLowerCase().replace(/[«»„“”]/g, '"').replace(/[‐‑‒–—−]/g, '-').replace(/\u00ad/g, '').replace(/\s+/g, ' ');
  const chars = [], offsets = [];
  for (let i = 0; i < source.length; i++) {
    const normalized = fold(source[i]);
    if (/\s/.test(normalized) && chars.at(-1) === ' ') continue;
    for (const char of normalized) { chars.push(char); offsets.push(i); }
  }
  const needle = fold(quote.trim());
  const at = chars.join('').indexOf(needle);
  return at < 0 ? null : { start: offsets[at], end: offsets[at + needle.length - 1] + 1 };
}

export function traceClaim(source, quote) {
  const span = sourceSpan(source, quote);
  return span ? { quote: source.slice(span.start, span.end), ...span } : null;
}
