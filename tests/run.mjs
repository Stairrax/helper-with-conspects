// Запуск тестов: node tests/run.mjs [часть имени файла…]
// Каждый tests/*.test.mjs — export default async (t) => { … t.ok(условие, 'что проверяем') … }.
// Ошибки JavaScript на странице тоже считаются провалом.

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServer, makeOpen, prepare, FINANCE, ROOT } from './lib.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const only = process.argv.slice(2);
const dir = path.join(ROOT, 'tests');
const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.test.mjs') && (!only.length || only.some((o) => f.includes(o)))).sort();

const { server, base } = await startServer();
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
let failed = 0, passed = 0;

for (const file of files) {
  const opened = [];
  const openRaw = await makeOpen(browser, base);
  const open = async (o) => { const x = await openRaw(o); opened.push(x); return x; };
  const fails = [];
  const t = {
    base, browser, open, prepare, FINANCE,
    ok(cond, msg) { if (cond) passed++; else { failed++; fails.push(msg); } console.log(`  ${cond ? '✓' : '✗'} ${msg}`); },
  };
  console.log(file);
  const started = Date.now();
  try {
    const mod = await import(pathToFileURL(path.join(dir, file)).href);
    await Promise.race([
      mod.default(t),
      new Promise((_, rej) => setTimeout(() => rej(new Error('тест не уложился в 3 минуты')), 180000)),
    ]);
  } catch (e) {
    t.ok(false, 'упал: ' + (e.message || e).split('\n')[0]);
  }
  for (const x of opened) {
    for (const err of x.errors) t.ok(false, 'ошибка на странице: ' + err);
    await x.ctx.close().catch(() => {});
  }
  console.log(`  — ${((Date.now() - started) / 1000).toFixed(1)} с${fails.length ? `, провалов: ${fails.length}` : ''}`);
}

await browser.close();
server.close();
console.log(`\nПроверок: ${passed + failed}, провалено: ${failed}`);
process.exit(failed ? 1 : 0);
