// Regression: DOCX table cells may contain multiple paragraphs, each of
// which must remain a separate line instead of being silently concatenated.
import fs from 'node:fs/promises';

export default async ({ open, ok }) => {
  const encoded = (await fs.readFile(new URL('./fixtures/study-lines.docx.base64', import.meta.url), 'utf8')).trim();
  const { page } = await open({ desktop: true });
  const result = await page.evaluate(async (b64) => {
    const { fileToSource } = await import('./js/extract.js');
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const file = () => new File([bytes], 'study-lines.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    // Load and check the real pinned Mammoth library first.
    await fileToSource(file());
    const original = window.mammoth.convertToHtml;
    try {
      // Targeted HTML regression, not a claim about Mammoth's DOCX output.
      window.mammoth.convertToHtml = async () => ({
        value: '<table><tr><td><p>Первое определение</p><p>Второе определение</p></td>' +
          '<td><p>F = ma<br>m = F/a</p><p>единица: Н</p></td></tr></table>',
      });
      return (await fileToSource(file())).text;
    } finally {
      window.mammoth.convertToHtml = original;
    }
  }, encoded);
  ok(result.includes('Первое определение\nВторое определение | F = ma\nm = F/a\nединица: Н'),
    'DOCX table cell paragraphs and inline breaks are preserved');
  ok(!result.includes('Первое определениеВторое определение'),
    'DOCX table cell text must not run together');
};
