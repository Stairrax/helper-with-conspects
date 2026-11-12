// Извлечение текста из файлов: txt/md, pdf (pdf.js), docx (mammoth), фото (для Gemini).

import { T } from './i18n.js';

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_PDF_PAGES = 200;
const MAX_SCANNED_PAGES = 20;
const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_DOCX_UNPACKED = 80 * 1024 * 1024;

// DOCX is a ZIP archive. Check the declared unpacked size before handing it to Mammoth.
// Archive metadata is not trusted as a complete defence against malformed ZIP files.
function checkDocxSize(buffer) {
  const d = new DataView(buffer);
  let end = -1;
  for (let i = d.byteLength - 22, min = Math.max(0, d.byteLength - 65557); i >= min; i--) {
    if (d.getUint32(i, true) === 0x06054b50 && i + 22 + d.getUint16(i + 20, true) === d.byteLength) { end = i; break; }
  }
  const invalid = () => { throw new Error(T('Не удалось прочитать DOCX. Проверьте файл или сохраните его заново.')); };
  if (end < 0) return invalid();
  const count = d.getUint16(end + 10, true), size = d.getUint32(end + 12, true), offset = d.getUint32(end + 16, true);
  if (d.getUint16(end + 4, true) || d.getUint16(end + 6, true) || count === 0xffff || size === 0xffffffff || offset === 0xffffffff || offset + size > end || count > 10000) return invalid();
  let pos = offset, total = 0;
  for (let i = 0; i < count; i++) {
    if (pos + 46 > end || d.getUint32(pos, true) !== 0x02014b50) return invalid();
    const n = d.getUint32(pos + 24, true);
    if (n === 0xffffffff) return invalid();
    total += n;
    if (total > MAX_DOCX_UNPACKED) throw new Error(T('DOCX слишком большой после распаковки. Разделите файл на части.'));
    pos += 46 + d.getUint16(pos + 28, true) + d.getUint16(pos + 30, true) + d.getUint16(pos + 32, true);
    if (pos > offset + size) return invalid();
  }
  if (pos !== offset + size) return invalid();
}

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

const SCRIPT_INTEGRITY = {
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js": "sha384-/1qUCSGwTur9vjf/z9lmu/eCUYbpOTgSjmpbMQZ1/CtX2v/WcAIKqRv+U1DUCG6e",
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js": "sha384-/1qUCSGwTur9vjf/z9lmu/eCUYbpOTgSjmpbMQZ1/CtX2v/WcAIKqRv+U1DUCG6e",
  "https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js": "sha384-/cXAMbzovUIKbBERjPmR3SnPTh8siWr5lsvFYj1Uq4XP0yaJUZJmsh0YXyGv5P0y",
  "https://unpkg.com/mammoth@1.8.0/mammoth.browser.min.js": "sha384-/cXAMbzovUIKbBERjPmR3SnPTh8siWr5lsvFYj1Uq4XP0yaJUZJmsh0YXyGv5P0y"
};

const loaded = {};
function loadScript(url) {
  if (!loaded[url]) {
    loaded[url] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = url;
      s.integrity = SCRIPT_INTEGRITY[url];
      s.crossOrigin = 'anonymous';
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
  if (blob.size > MAX_FILE_BYTES) throw new Error(T('Файл слишком большой. Максимальный размер — 25 МБ.'));
  const bmp = await createImageBitmap(blob).catch(() => null);
  let w, h, src, url = '';
  if (bmp) { w = bmp.width; h = bmp.height; src = bmp; } else {
    url = URL.createObjectURL(blob);
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; })
      .catch((e) => { URL.revokeObjectURL(url); throw e; });
    w = img.naturalWidth; h = img.naturalHeight; src = img;
  }
  try {
    if (w * h > MAX_IMAGE_PIXELS) throw new Error(T('Изображение слишком большое. Уменьшите его разрешение и попробуйте снова.'));
    const k = Math.min(1, maxSide / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.round(w * k); c.height = Math.round(h * k);
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    return canvasToB64(c);
  } finally {
    // без этого каждое фото оставляло бы за собой копию в памяти — на iPhone это заметно
    bmp?.close?.();
    if (url) URL.revokeObjectURL(url);
  }
}

function canvasToB64(c) {
  const url = c.toDataURL('image/jpeg', 0.85);
  return { mime: 'image/jpeg', data: url.slice(url.indexOf(',') + 1) };
}

async function pdfExtract(file, onStatus) {
  const pdfjs = await getPdfJs();
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  try {
  if (!doc.numPages || doc.numPages > MAX_PDF_PAGES) throw new Error(T('В PDF слишком много страниц. Разделите файл на части до 200 страниц.'));
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    onStatus?.(`PDF: страница ${i} из ${doc.numPages}`);
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    let s = '';
    for (const it of tc.items) s += (it.str || '') + (it.hasEOL ? '\n' : ' ');
    pages.push(s.replace(/[ \t]+\n/g, '\n').trim());
  }
  const scans = pages.map((text, i) => text.replace(/\s/g, '').length < 40 ? i : -1).filter(i => i >= 0);
  if (!scans.length) return { kind: 'text', text: pages.join('\n\n') };
  if (scans.length > MAX_SCANNED_PAGES) throw new Error(T('В отсканированном PDF слишком много страниц. Разделите его на части до 20 страниц.'));
  // Скан без текстового слоя — рендерим страницы в картинки для Gemini.
  const images = [];
  for (const index of scans) {
    const i = index + 1;
    onStatus?.(`PDF без текста (скан): рендер страницы ${i} из ${doc.numPages}`);
    const page = await doc.getPage(i);
    const vp0 = page.getViewport({ scale: 1 });
    const scale = Math.min(2.2, 1800 / Math.max(vp0.width, vp0.height));
    const vp = page.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    images.push({ ...canvasToB64(c), page: i });
    c.width = c.height = 0;
  }
  return { kind: 'images', images, pages: pages.map((text, i) => scans.includes(i) ? null : text) };
  } finally { await doc.destroy(); }
}

// DOM textContent drops soft line breaks (<br>) and silently merges DOCX lines.
// Preserve them before the AI sees the source material.
function textWithLineBreaks(root) {
  const parts = [];
  const visit = (node) => {
    if (node.nodeType === 3) {
      parts.push(node.nodeValue || '');
    } else if (node.nodeType === 1) {
      if (node.tagName === 'BR') parts.push('\n');
      else for (const child of node.childNodes) visit(child);
    }
  };
  visit(root);
  return parts.join('').replace(/[ \t]+\n/g, '\n').trim();
}

function htmlToText(html) {
  const root = new DOMParser().parseFromString(html, 'text/html').body;
  const out = [];
  const walk = (el) => {
    for (const n of el.children) {
      const tag = n.tagName;
      if (/^H[1-6]$/.test(tag)) out.push('#'.repeat(+tag[1]) + ' ' + textWithLineBreaks(n));
      else if (tag === 'P') { const t = textWithLineBreaks(n); if (t) out.push(t); }
      else if (tag === 'UL' || tag === 'OL') {
        out.push([...n.querySelectorAll(':scope > li')].map((li, i) => (tag === 'OL' ? `${i + 1}. ` : '- ') + textWithLineBreaks(li)).join('\n'));
      } else if (tag === 'TABLE') {
        out.push([...n.querySelectorAll('tr')].map((tr) => [...tr.children].map((td) => textWithLineBreaks(td)).join(' | ')).join('\n'));
      } else walk(n);
    }
  };
  walk(root);
  return out.join('\n\n');
}

async function docxExtract(file) {
  const ab = await file.arrayBuffer();
  checkDocxSize(ab);
  const mammoth = await getMammoth();
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
  if (file.size > MAX_FILE_BYTES) throw new Error(T('Файл слишком большой. Максимальный размер — 25 МБ.'));
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
