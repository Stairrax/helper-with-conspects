// Regression: paragraphs and soft breaks inside real DOCX table cells
// must survive extraction, rather than merging into one line.
import fs from 'node:fs/promises';

export default async ({ open, ok }) => {
  // A compact, valid DOCX fixture containing a two-cell table with multiple
  // paragraphs, an inline Shift+Enter break, and text outside the table.
  const encoded = (await fs.readFile(new URL('./fixtures/study-table-paragraphs.docx.base64', import.meta.url), 'utf8')).trim();
  const { page } = await open({ desktop: true });
  const result = await page.evaluate(async (b64) => {
    const { fileToSource } = await import('./js/extract.js');
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const file = () => new File([bytes], 'study-table-paragraphs.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });

    // Genuine end-to-end DOCX conversion with pinned Mammoth; no mocking.
    const real = (await fileToSource(file())).text;

    // A separate, narrow HTML regression also isolates the rendering logic.
    const original = window.mammoth.convertToHtml;
    let isolated;
    try {
      window.mammoth.convertToHtml = async () => ({
        value: '<table><tr><td><p>Первое определение</p><p>Второе определение</p></td>' +
          '<td><p>F = ma<br>m = F/a</p><p>единица: Н</p></td></tr></table>',
      });
      isolated = (await fileToSource(file())).text;
    } finally {
      window.mammoth.convertToHtml = original;
    }
    return { real, isolated };
  }, encoded);

  const expected = 'Первое определение\nВторое определение | F = ma\nm = F/a\nединица: Н';
  ok(result.real.includes(expected), 'real DOCX: table paragraphs, cell columns and Shift+Enter are preserved');
  ok(result.real.includes('Перед таблицей') && result.real.includes('После таблицы'),
    'real DOCX: surrounding paragraphs are retained');
  ok(!result.real.includes('Первое определениеВторое определение'),
    'real DOCX: consecutive paragraphs do not run together');
  ok(result.isolated.includes(expected), 'HTML regression: preserves paragraph and inline breaks');
};
