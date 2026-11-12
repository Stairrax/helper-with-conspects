// Regression: DOCX soft breaks must survive HTML extraction before note generation.
export default async ({ open, ok }) => {
  const { page } = await open();
  const result = await page.evaluate(async () => {
    const { fileToSource } = await import('./js/extract.js');
    const originalAppend = document.head.appendChild;
    const originalMammoth = window.mammoth;
    let rawCalled = false;
    window.mammoth = {
      convertToHtml: async () => ({ value: [
        '<h2>Динамика<br>Законы</h2>',
        '<p>Первый закон<br>Формула F = ma</p>',
        '<ul><li>Сила<br><strong>масса</strong></li></ul>',
        '<table><tr><td>Температура<br>-5 °C</td><td>Изменение<br>+2 °C</td></tr></table>',
        '<p>Коэффициент <strong>k</strong> равен 2</p>',
      ].join('') }),
      extractRawText: async () => { rawCalled = true; return { value: '' }; },
    };
    document.head.appendChild = function (el) {
      if (el.src?.includes('mammoth.browser.min.js')) {
        queueMicrotask(() => el.onload?.());
        return el;
      }
      return originalAppend.call(this, el);
    };
    try {
      // Minimal ZIP central directory accepted by the DOCX preflight, with
      // Mammoth stubbed at the HTML-conversion boundary. No CDN or API call.
      const zip = new ArrayBuffer(68);
      const view = new DataView(zip);
      view.setUint32(0, 0x02014b50, true);
      view.setUint32(46, 0x06054b50, true);
      view.setUint16(54, 1, true);
      view.setUint16(56, 1, true);
      view.setUint32(58, 46, true);
      const src = await fileToSource(new File([zip], 'notes.docx'));
      return { kind: src.kind, text: src.text, rawCalled };
    } finally {
      document.head.appendChild = originalAppend;
      if (originalMammoth === undefined) delete window.mammoth;
      else window.mammoth = originalMammoth;
    }
  });
  ok(result.kind === 'text' && !result.rawCalled,
    'DOCX conversion uses structured HTML, not a raw-text fallback');
  ok(result.text.includes('## Динамика\nЗаконы') &&
     result.text.includes('Первый закон\nФормула F = ma'),
    'soft breaks survive in headings and paragraphs: ' + result.text);
  ok(result.text.includes('- Сила\nмасса') &&
     result.text.includes('Температура\n-5 °C | Изменение\n+2 °C'),
    'soft breaks survive in lists and table cells: ' + result.text);
  ok(result.text.includes('Коэффициент k равен 2'),
    'ordinary formatted inline runs are not separated unnecessarily');
};
