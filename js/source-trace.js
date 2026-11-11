// A matching source quotation is evidence of provenance, NOT proof that the
// model interpreted the quotation correctly.
const MIN_QUOTE_CHARS = 20; // Only meaningful excerpts receive a verified source marker.

const fold = text => String(text).toLowerCase()
  .replace(/ё/g, 'е')
  .replace(/[«»„“”]/g, '"')
  .replace(/[‐‑‒–—−]/g, '-')
  .replace(/\u00ad/g, '')
  .replace(/\s+/g, ' ');

/** Indexed normalization: keep original UTF-16 offsets even after folding. */
function indexedText(text, joinBrokenWords) {
  const chars = [], offsets = [];
  for (let i = 0; i < text.length; i++) {
    // OCR/text-layer hyphenation: "электро-\nмагнитный" -> "электромагнитный".
    // Only join alphabetic words split AT a line ending, never minus signs or
    // real in-line compounds; this fallback runs only after strict matching.
    if (joinBrokenWords && /\p{L}/u.test(text[i - 1] || '') &&
        /[-‐‑‒–—]/.test(text[i])) {
      const tail = text.slice(i).match(/^[-‐‑‒–—][ \t]*\r?\n[ \t]*(?=\p{L})/u);
      if (tail) { i += tail[0].length - 1; continue; }
    }
    const normalized = fold(text[i]);
    if (normalized === ' ' && chars.at(-1) === ' ') continue;
    for (const ch of normalized) {
      chars.push(ch);
      offsets.push(i);
    }
  }
  return { value: chars.join(''), offsets };
}

function matchSpan(source, quote, joinBrokenWords) {
  const text = indexedText(source, joinBrokenWords);
  const needle = indexedText(quote.trim(), joinBrokenWords).value.trim();
  if (needle.replace(/\s/g, '').length < MIN_QUOTE_CHARS) return null;
  const at = text.value.indexOf(needle);
  return at < 0 ? null : { start: text.offsets[at], end: text.offsets[at + needle.length - 1] + 1 };
}

export function sourceSpan(source, quote) {
  if (typeof source !== 'string' || typeof quote !== 'string' || !quote.trim()) return null;
  return matchSpan(source, quote, false) || matchSpan(source, quote, true);
}

export function traceClaim(source, quote) {
  const span = sourceSpan(source, quote);
  return span ? { quote: source.slice(span.start, span.end), ...span } : null;
}
