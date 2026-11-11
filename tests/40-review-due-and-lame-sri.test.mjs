// Due tickets must outrank future repeats; CDN scripts must fail closed under SRI.
export default async ({ open, ok }) => {
  const { page } = await open({});
  const result = await page.evaluate(async () => {
    const { drawTicket } = await import('./js/tickets.js');
    const now = Date.parse('2026-11-11T12:00:00Z');
    const tickets = [{ id: 'fresh' }, { id: 'due' }, { id: 'future' }, { id: 'legacy' }];
    const results = {
      due: { grade: 4, due_at: now - 1000 },
      future: { grade: 2, due_at: now + 86400000 },
      legacy: { grade: 3 },
    };
    const fresh = drawTicket(tickets, results, () => 0, now)?.id;
    const due = drawTicket(tickets.slice(1), results, () => 0, now)?.id;
    const iso = drawTicket([{id:'future'}, {id:'due'}], {
      future: {grade:2, due_at: new Date(now+5000).toISOString()},
      due: {grade:4, due_at: new Date(now-5000).toISOString()},
    }, ()=>0, now)?.id;
    const legacy = drawTicket([{id:'future'}, {id:'legacy'}], results, ()=>0, now)?.id;
    const fallback = drawTicket([{id:'future'}], results, ()=>0, now)?.id;
    const empty = drawTicket([], {}, ()=>0, now);

    const { renderMp3 } = await import('./js/audiobook.js');
    const head = document.head;
    const append = head.append;
    const seen = [];
    let message = '';
    window.lamejs = undefined;
    head.append = function(...nodes) {
      for (const script of nodes) {
        seen.push({src: script.src, integrity: script.integrity, crossOrigin: script.crossOrigin});
        queueMicrotask(() => script.onerror?.(new Event('error')));
      }
    };
    try {
      await renderMp3([{text:'test', pause:0}], {synth: async()=>{throw Error('should never synthesize')}});
    } catch (e) {
      message = String(e?.message || e);
    } finally {
      head.append = append;
    }
    return { fresh, due, iso, legacy, fallback, empty, seen, message };
  });
  ok(result.fresh === 'fresh', 'fresh tickets still go first');
  ok(result.due === 'due', 'a due ticket wins over legacy weak and future repeats');
  ok(result.iso === 'due', 'due_at accepts ISO timestamps as well as epoch milliseconds');
  ok(result.legacy === 'legacy', 'old grade-only results still get weak-ticket priority');
  ok(result.fallback === 'future' && result.empty === null, 'manual fallback and empty list remain compatible');
  ok(result.seen.length === 2 &&
     result.seen.every(s=>s.integrity.startsWith('sha256-') && s.crossOrigin === 'anonymous'),
     'both CDN mirrors enforce SRI and anonymous CORS');
  ok(/jsdelivr/.test(result.seen[0]?.src) && /unpkg/.test(result.seen[1]?.src) &&
     /Не удалось загрузить кодировщик/.test(result.message),
     'blocked/unavailable CDN scripts fall back safely and never execute');
};
