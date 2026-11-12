// Integration regression: a real DOCX and the real pinned Mammoth browser
// script, not a hand-authored HTML response or mocked convertToHtml().
import fs from 'node:fs/promises';

export default async ({ open, ok }) => {
  const b64 = (await fs.readFile(new URL('./fixtures/study-lines.docx.base64', import.meta.url), 'utf8')).trim();
  const {page} = await open({desktop:true});

  // The same real DOCX first goes through the application's extraction path.
  const result = await page.evaluate(async (encoded) => {
    const {fileToSource} = await import('./js/extract.js');
    const bin = atob(encoded);
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    const makeFile = () => new File([bytes], 'study-lines.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    const extracted = await fileToSource(makeFile());
    // Inspect real Mammoth HTML separately, without replacing Mammoth.
    const {value:html} = await window.mammoth.convertToHtml({
      arrayBuffer: await makeFile().arrayBuffer(),
    });
    return {kind:extracted.kind, text:extracted.text, html};
  }, b64);

  const html = result.html;
  console.log('REAL MAMMOTH HTML:', html);
  console.log('REAL DOCX EXTRACTED TEXT:', JSON.stringify(result.text));

  ok(/<p\b/i.test(html) && /<br\s*\/?\s*>/i.test(html) &&
     /<table\b/i.test(html) && /<ul\b/i.test(html) && /<li\b/i.test(html),
     'real Mammoth HTML contains paragraphs, an inline BR, a table and a list');
  ok(result.kind === 'text' &&
     result.text.includes('Первый абзац: закон инерции.\n\nВторой абзац: второй закон Ньютона.'),
     'htmlToText preserves paragraph boundaries from real Mammoth HTML');
  ok(result.text.includes('Внутри одного абзаца: F = ma\nСтрока после Shift+Enter: ускорение a = F/m'),
     'htmlToText preserves the DOCX Shift+Enter line break');
  ok(result.text.includes('Величина | Значение\nМасса m | 2 кг'),
     'htmlToText separates table columns and rows');
  ok(result.text.includes('- Маркер списка: масса m\n- Маркер списка: сила F'),
     'htmlToText preserves list items');
  ok(/F\/m\s+после TAB/.test(result.text),
     'Mammoth + htmlToText preserves a separator after the DOCX tab');

  // Repeat via the actual file input: the student's normal upload path.
  const bytes = Buffer.from(b64, 'base64');
  await page.locator('#fileInput').setInputFiles({
    name:'study-lines.docx',
    mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer:bytes,
  });
  await page.waitForFunction(() =>
    [...document.querySelectorAll('#sourceList .name')]
      .some(el => el.textContent.includes('study-lines.docx')),
  {timeout:15000});
  await page.waitForFunction(async () => {
    const storage = await import('./js/storage.js');
    const subject = storage.loadSubjects().current;
    const sources = await storage.idbGet('sources:' + subject);
    return sources?.some(s => s.name === 'study-lines.docx');
  }, null, {timeout:15000});
  const stored = await page.evaluate(async () => {
    const storage = await import('./js/storage.js');
    const id = storage.loadSubjects().current;
    const sources = await storage.idbGet('sources:' + id);
    return sources.find(s => s.name === 'study-lines.docx')?.text;
  });
  console.log('APP UPLOAD SAVED TEXT:', JSON.stringify(stored));
  ok(stored === result.text, 'actual application upload saves the exact extracted DOCX text');
};
