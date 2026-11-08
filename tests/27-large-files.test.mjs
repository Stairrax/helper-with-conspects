export default async ({ open, ok }) => {
  const { page } = await open();
  const results = await page.evaluate(async () => {
    const { fileToSource, imageToBase64 } = await import('./js/extract.js');
    const append = document.head.appendChild;
    document.head.appendChild = function(el) {
      if (el.src?.includes('pdf.min.js')) {
        window.pdfjsLib = { GlobalWorkerOptions: {}, getDocument() { return { promise: Promise.resolve({ numPages: window.testPdfPages, getPage: async () => ({ getTextContent: async () => ({ items: [] }) }), destroy: async () => { window.pdfDestroyed = true; } }) }; } };
        queueMicrotask(() => el.onload());
        return el;
      }
      return append.call(this, el);
    };
    const result = {};
    const huge = { name: 'huge.pdf', type: 'application/pdf', size: 26 * 1024 * 1024, arrayBuffer() { throw Error('read'); } };
    try { await fileToSource(huge); } catch (e) { result.file = e.message; }
    const zip = new ArrayBuffer(68), view = new DataView(zip);
    view.setUint32(0, 0x02014b50, true);
    view.setUint32(24, 81 * 1024 * 1024, true);
    view.setUint32(46, 0x06054b50, true);
    view.setUint16(54, 1, true); view.setUint16(56, 1, true);
    view.setUint32(58, 46, true);
    try { await fileToSource(new File([zip], 'huge.docx')); } catch (e) { result.docx = e.message; }
    window.testPdfPages = 201;
    const pdf = new File(['test'], 'test.pdf', { type: 'application/pdf' });
    try { await fileToSource(pdf); } catch (e) { result.pdf = e.message; }
    result.destroyed = window.pdfDestroyed;
    window.pdfDestroyed = false;
    window.testPdfPages = 21;
    try { await fileToSource(pdf); } catch (e) { result.scan = e.message; }
    result.scanDestroyed = window.pdfDestroyed;
    document.head.appendChild = append;
    const original = window.createImageBitmap;
    let closed = false;
    window.createImageBitmap = async () => ({ width: 10000, height: 5000, close() { closed = true; } });
    try { await imageToBase64(new Blob(['test'])); } catch (e) { result.image = e.message; }
    window.createImageBitmap = original;
    result.closed = closed;
    const text = await fileToSource(new File(['hello'], 'normal.txt', { type: 'text/plain' }));
    result.normal = text.text;
    return result;
  });
  ok(results.file?.includes('25 МБ'), 'крупный файл отклоняется до чтения в память');
  ok(results.docx?.includes('распаковки'), 'слишком большой распакованный DOCX отклоняется до загрузки библиотеки');
  ok(results.pdf?.includes('200 страниц') && results.destroyed, 'большой PDF отклоняется и освобождается: ' + results.pdf);
  ok(results.scan?.includes('20 страниц') && results.scanDestroyed, 'длинный скан отклоняется до рендеринга и освобождается: ' + results.scan);
  ok(results.image?.includes('разрешение') && results.closed, 'слишком большое изображение отклоняется и освобождается');
  ok(results.normal === 'hello', 'обычный текстовый файл читается');
};
