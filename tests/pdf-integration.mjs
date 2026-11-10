import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { startServer } from './lib.mjs';
const browser = await chromium.launch();
const { server, base } = await startServer();
try {
 const p = await browser.newPage();
 await p.goto(base);
 const data = await fs.readFile(new URL('./fixtures/mixed-study.pdf.base64', import.meta.url), 'utf8');
 const result = await p.evaluate(async(data) => {
  const {fileToSource} = await import('./js/extract.js');
  const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
  const s = await fileToSource(new File([bytes], 'mixed.pdf', {type:'application/pdf'}));
  return { kind:s.kind, images:s.images?.length, page:s.images?.[0]?.page, pages:s.pages };
 }, data);
 if(result.kind !== 'images' || result.images !== 1 || result.page !== 2 || !result.pages[0]?.includes('Newton') || !result.pages[2]?.includes('Savings')) throw Error('Mixed PDF lost a page');
 console.log('Real PDF.js: digital pages 1/3 retained, page 2 rendered for OCR.');
} finally { server.close(); await browser.close(); }
