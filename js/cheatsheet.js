// Шпаргалка: одна страница на предмет — главное по каждой теме, термины и формулы.
// Собирается из того, что уже есть в плане, без запросов к нейросети. Термины — определения вида «Х — это …».

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const sentences = (t) => String(t || '').split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);

/** Определения из текста темы: [{ term, def }]. */
export function extractTerms(topic) {
  const out = [];
  const seen = new Set();
  for (const c of topic.chunks || []) {
    if (c.k && c.k !== 'content') continue; // пояснения и примеры — не определения
    for (const s of sentences(c.t)) {
      const m = s.match(/^([^—:;!?]{2,60}?)\s+—\s+это\s+(.{6,260}?)[.!?]?$/) ||
        s.match(/^(?!(?:This|That|These|Those|It|There|They|He|She|We|You|I)\b)((?:An? |The )?[A-Z][^,;:]{1,50}?) (?:is|are) (?:an? |the )(.{6,260}?)[.!?]?$/);
      if (!m) continue;
      const term = m[1].trim().replace(/^[«"]|[»"]$/g, '');
      const key = term.toLowerCase();
      if (seen.has(key) || term.split(' ').length > 6) continue;
      seen.add(key);
      out.push({ term, def: m[2].trim() });
    }
  }
  return out;
}

/** Главное по теме: выжимка, а если её нет — первые отрывки. */
function gist(topic) {
  if (topic.recap) return topic.recap;
  return (topic.chunks || []).filter((c) => !c.k || c.k === 'content').slice(0, 2).map((c) => c.t).join(' ');
}

/**
 * HTML шпаргалки (только содержимое, без <html>). topics — темы по порядку плана.
 * en — заголовки разделов по-английски (конспект на английском).
 */
export function buildCheatsheet(title, topics, en = false) {
  const L = (ru, e) => (en ? e : ru);
  const ready = topics.filter((t) => t.status === 'ready');
  const parts = ready.map((t, i) => {
    const terms = extractTerms(t);
    const fx = t.formulas || [];
    return `<section>
<h2>${i + 1}. ${esc(t.title)}</h2>
${gist(t) ? `<p class="cs-gist">${esc(gist(t))}</p>` : ''}
${terms.length ? `<dl class="cs-terms">${terms.map((x) => `<dt>${esc(x.term)}</dt><dd>${esc(x.def)}</dd>`).join('')}</dl>` : ''}
${fx.length ? `<ul class="cs-fx">${fx.map((f) => `<li><span class="cs-f">${esc(f.f)}</span>${f.n ? ` — ${esc(f.n)}` : ''}${f.d ? `<small>${esc(f.d)}</small>` : ''}</li>`).join('')}</ul>` : ''}
</section>`;
  });
  return `<h1>${esc(title)}</h1>
<p class="cs-sub">${L('Шпаргалка', 'Cheat sheet')} · ${ready.length} ${en ? (ready.length === 1 ? 'topic' : 'topics') : plural(ready.length, ['тема', 'темы', 'тем'])}</p>
<div class="cs-cols">${parts.join('\n') || `<p>${L('Темы ещё не подготовлены.', 'No topics are prepared yet.')}</p>`}</div>`;
}

function plural(n, forms) {
  const a = n % 100, b = n % 10;
  return a >= 11 && a <= 14 ? forms[2] : b === 1 ? forms[0] : b >= 2 && b <= 4 ? forms[1] : forms[2];
}

/** Оформление шпаргалки: компактно, в две колонки, чёрным по белому — для печати и PDF. */
export const CHEATSHEET_CSS = `
.cheatsheet { font: 13px/1.35 Georgia, 'Times New Roman', serif; color: #111; background: #fff; }
.cheatsheet h1 { font: 700 20px/1.2 system-ui, sans-serif; margin: 0 0 2px; }
.cheatsheet .cs-sub { color: #555; margin: 0 0 10px; font: 12px system-ui, sans-serif; }
.cheatsheet .cs-cols { column-count: 2; column-gap: 18px; }
.cheatsheet section { break-inside: avoid; margin: 0 0 10px; }
.cheatsheet h2 { font: 700 14px/1.25 system-ui, sans-serif; margin: 0 0 3px; border-bottom: 1px solid #bbb; padding-bottom: 2px; }
.cheatsheet p { margin: 0 0 4px; }
.cheatsheet dl { margin: 0 0 4px; }
.cheatsheet dt { font-weight: 700; display: inline; }
.cheatsheet dt::after { content: ' — '; font-weight: 400; }
.cheatsheet dd { display: inline; margin: 0; }
.cheatsheet dd::after { content: ''; display: block; margin-bottom: 2px; }
.cheatsheet ul { margin: 0; padding-left: 16px; }
.cheatsheet .cs-f { font-family: 'Cambria Math', 'Noto Serif', Georgia, serif; font-weight: 700; }
.cheatsheet small { display: block; color: #444; font-size: 11px; }
`;

/** Отдельный HTML-файл: открывается в любом браузере, оттуда — печать или «Сохранить как PDF». */
export function cheatsheetFile(title, body, lang = 'ru') {
  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>body{margin:16px;background:#fff}${CHEATSHEET_CSS}@page{margin:12mm}</style></head>
<body><div class="cheatsheet">${body}</div></body></html>`;
}
