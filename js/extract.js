// Извлечение текста из файлов: txt/md, pdf (pdf.js), docx (mammoth), фото (для Gemini).

const PDFJS = [
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js',
];
const PDFJS_WORKER = {
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js':
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js':
    'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js',
};
const MAMMOTH = [
  'https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js',
  'https://unpkg.com/mammoth@1.8.0/mammoth.browser.min.js',
];

const loaded = {};
function loadScript(url) {
  if (!loaded[url]) {
    loaded[url] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = url;
      s.async = true;
      s.onload = () => resolve(url);
      s.onerror = () => { delete loaded[url]; s.remove(); reject(new Error('Не удалось загрузить ' + url)); };
      document.head.appendChild(s);
    });
  }
  return loaded[url];
}

async function loadFirst(urls, check) {
  let err;
  for (const u of urls) {
    try { await loadScript(u); if (check()) return u; } catch (e) { err = e; }
  }
  throw err || new Error('Библиотека не загрузилась (нужен интернет)');
}

let pdfReady;
async function getPdfJs() {
  if (!pdfReady) {
    pdfReady = loadFirst(PDFJS, () => !!window.pdfjsLib).then((u) => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER[u];
      return window.pdfjsLib;
    }).catch((e) => { pdfReady = null; throw e; });
  }
  return pdfReady;
}

async function getMammoth() {
  await loadFirst(MAMMOTH, () => !!window.mammoth);
  return window.mammoth;
}

/** Сжимает изображение до maxSide и возвращает {mime, data(base64)}. */
export async function imageToBase64(blob, maxSide = 2000) {
  const bmp = await createImageBitmap(blob).catch(() => null);
  let w, h, src;
  if (bmp) { w = bmp.width; h = bmp.height; src = bmp; } else {
    const url = URL.createObjectURL(blob);
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    w = img.naturalWidth; h = img.naturalHeight; src = img;
  }
  const k = Math.min(1, maxSide / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * k); c.height = Math.round(h * k);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return canvasToB64(c);
}

function canvasToB64(c) {
  const url = c.toDataURL('image/jpeg', 0.85);
  return { mime: 'image/jpeg', data: url.slice(url.indexOf(',') + 1) };
}

async function pdfExtract(file, onStatus) {
  const pdfjs = await getPdfJs();
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    onStatus?.(`PDF: страница ${i} из ${doc.numPages}`);
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    let s = '';
    for (const it of tc.items) s += (it.str || '') + (it.hasEOL ? '\n' : ' ');
    pages.push(s.replace(/[ \t]+\n/g, '\n').trim());
  }
  const chars = pages.join('').replace(/\s/g, '').length;
  if (chars / doc.numPages >= 40) return { kind: 'text', text: pages.join('\n\n') };
  // Скан без текстового слоя — рендерим страницы в картинки для Gemini.
  const images = [];
  for (let i = 1; i <= doc.numPages; i++) {
    onStatus?.(`PDF без текста (скан): рендер страницы ${i} из ${doc.numPages}`);
    const page = await doc.getPage(i);
    const vp0 = page.getViewport({ scale: 1 });
    const scale = Math.min(2.2, 1800 / Math.max(vp0.width, vp0.height));
    const vp = page.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    images.push(canvasToB64(c));
  }
  return { kind: 'images', images };
}

function htmlToText(html) {
  const root = new DOMParser().parseFromString(html, 'text/html').body;
  const out = [];
  const walk = (el) => {
    for (const n of el.children) {
      const tag = n.tagName;
      if (/^H[1-6]$/.test(tag)) out.push('#'.repeat(+tag[1]) + ' ' + n.textContent.trim());
      else if (tag === 'P') { const t = n.textContent.trim(); if (t) out.push(t); }
      else if (tag === 'UL' || tag === 'OL') {
        out.push([...n.querySelectorAll(':scope > li')].map((li, i) => (tag === 'OL' ? `${i + 1}. ` : '- ') + li.textContent.trim()).join('\n'));
      } else if (tag === 'TABLE') {
        out.push([...n.querySelectorAll('tr')].map((tr) => [...tr.children].map((td) => td.textContent.trim()).join(' | ')).join('\n'));
      } else walk(n);
    }
  };
  walk(root);
  return out.join('\n\n');
}

async function docxExtract(file) {
  const mammoth = await getMammoth();
  const ab = await file.arrayBuffer();
  try {
    const { value } = await mammoth.convertToHtml({ arrayBuffer: ab });
    const t = htmlToText(value);
    if (t.trim()) return t;
  } catch { /* упадём на raw */ }
  const { value } = await mammoth.extractRawText({ arrayBuffer: ab });
  return value;
}

/**
 * Превращает файл в источник: {name, kind:'text', text} или {name, kind:'images', images:[{mime,data}]}.
 */
export async function fileToSource(file, onStatus) {
  const name = file.name || 'Файл';
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (file.type.startsWith('image/') || ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'].includes(ext)) {
    onStatus?.(`Фото: ${name}`);
    return { name, kind: 'images', images: [await imageToBase64(file)] };
  }
  if (ext === 'pdf' || file.type === 'application/pdf') {
    return { name, ...(await pdfExtract(file, onStatus)) };
  }
  if (ext === 'docx') {
    onStatus?.(`DOCX: ${name}`);
    return { name, kind: 'text', text: await docxExtract(file) };
  }
  if (ext === 'doc') throw new Error(`«${name}»: старый формат .doc не поддерживается, сохраните как .docx`);
  return { name, kind: 'text', text: await file.text() };
}
