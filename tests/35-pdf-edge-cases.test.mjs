// PDF edge cases in real Chromium with a deterministic PDF.js stand-in.
// No AI, CDN or student data. Real parser integration remains a separate optional test.
export default async ({ open, ok }) => {
  const { page } = await open();
  const results = await page.evaluate(async () => {
    const append = document.head.appendChild;
    let active = null;
    window.pdfjsLib = undefined;
    document.head.appendChild = function(el) {
      if (el.src?.includes('pdf.min.js')) {
        window.pdfjsLib = {
          GlobalWorkerOptions: {},
          getDocument() {
            const state = active;
            return { promise: Promise.resolve({
              numPages: state.count ?? state.pages.length,
              async destroy() { state.destroyed++; },
              async getPage(pageNumber) {
                state.visited.push(pageNumber);
                if (state.failRead === pageNumber) throw Error('PDF page read failed');
                return {
                  async getTextContent() {
                    const text = state.pages[pageNumber - 1] || '';
                    return { items: text ? [{ str: text }] : [] };
                  },
                  getViewport({ scale }) { return { width: 90 * scale, height: 70 * scale }; },
                  render() {
                    state.rendered.push(pageNumber);
                    return { promise: state.failRender === pageNumber
                      ? Promise.reject(Error('PDF render failed')) : Promise.resolve() };
                  },
                };
              },
            }) };
          },
        };
        queueMicrotask(() => el.onload());
        return el;
      }
      return append.call(this, el);
    };

    const full = n => ('Page ' + n + ': correct text. ').repeat(5);
    const run = async (pages, more = {}) => {
      const state = { pages, count: more.count, failRead: more.failRead, failRender: more.failRender,
        visited: [], rendered: [], destroyed: 0 };
      active = state;
      let source, error = '';
      try {
        const { fileToSource } = await import('./js/extract.js');
        source = await fileToSource(new File(['test'], 'notes.pdf', { type: 'application/pdf' }));
      } catch(e) { error = String(e.message || e); }
      return {
        error,
        kind: source?.kind,
        text: source?.text || '',
        pages: source?.pages,
        imageCount: source?.images?.length || 0,
        imagePages: source?.images?.map(x => x.page),
        imagesValid: source?.images?.every(x => x.mime === 'image/jpeg' && Boolean(x.data)),
        rendered: state.rendered, visited: state.visited, destroyed: state.destroyed,
      };
    };

    try {
      return {
        digital: await run([full(1), full(2), full(3)]),
        mixed: await run([full(1), '', full(3), '']),
        threshold: await run(['a'.repeat(39), 'b'.repeat(40)]),
        scanned: await run(['', '']),
        limit20: await run(Array(20).fill('')),
        limit21: await run(Array(21).fill('')),
        limit201: await run(Array(201).fill(full(1))),
        badRead: await run([full(1), full(2)], { failRead: 2 }),
        badRender: await run([''], { failRender: 1 }),
      };
    } finally {
      document.head.appendChild = append;
    }
  });

  const p = results;
  ok(p.digital.kind === 'text' && p.digital.text.indexOf('Page 1') < p.digital.text.indexOf('Page 3') &&
    p.digital.rendered.length === 0 && p.digital.destroyed === 1,
    'all-digital PDF preserves page order without sending pages to OCR');
  ok(p.mixed.kind === 'images' && p.mixed.imagePages.join() === '2,4' &&
    p.mixed.rendered.join() === '2,4' && p.mixed.pages.length === 4 &&
    p.mixed.pages[0].includes('Page 1') && p.mixed.pages[1] === null &&
    p.mixed.pages[2].includes('Page 3') && p.mixed.pages[3] === null && p.mixed.destroyed === 1,
    'mixed PDF routes only scanned pages 2 and 4 to OCR, retains positions of digital pages');
  ok(p.threshold.kind === 'images' && p.threshold.imagePages.join() === '1' &&
    p.threshold.pages[1] === 'b'.repeat(40),
    'boundary: 39 nonspace characters trigger OCR, 40 keep the text layer');
  ok(p.scanned.kind === 'images' && p.scanned.imagePages.join() === '1,2' &&
    p.scanned.imagesValid && p.scanned.destroyed === 1,
    'fully scanned PDF retains all pages with page numbers and image MIME types');
  ok(p.limit20.kind === 'images' && p.limit20.imageCount === 20 &&
    p.limit20.rendered.length === 20 && p.limit20.destroyed === 1,
    'up to 20 scanned pages are accepted');
  ok(p.limit21.error.includes('20 страниц') && p.limit21.rendered.length === 0 &&
    p.limit21.destroyed === 1,
    '21 scanned pages are rejected before rendering and resources are released');
  ok(p.limit201.error.includes('200 страниц') && p.limit201.visited.length === 0 &&
    p.limit201.destroyed === 1,
    '201 pages are rejected before reading and resources are released');
  ok(p.badRead.error.includes('PDF page read failed') && p.badRead.destroyed === 1,
    'PDF read error does not leak the document');
  ok(p.badRender.error.includes('PDF render failed') && p.badRender.destroyed === 1,
    'PDF render error does not leak the document');
};
