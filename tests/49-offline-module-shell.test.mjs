// Offline regression: new JS dependencies must be included in the service
// worker's install-time SHELL. Dynamic network-first caching is not enough
// for the first offline launch of an installed PWA.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const moduleRefs = (code) => {
  const refs = new Set();
  // Static ES import/re-export, side-effect imports and literal dynamic imports.
  // We intentionally only accept literal relative specifiers: nonliteral
  // imports cannot be guaranteed cached by a static manifest.
  const patterns = [
    /\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]/g,
    /\bimport\s*['"](\.{1,2}\/[^'"]+)['"]/g,
    /\bimport\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) for (const m of code.matchAll(re)) refs.add(m[1]);
  return [...refs];
};

function missingFromShell(modules, shell) {
  const missing = [];
  for (const [from, code] of modules) {
    for (const spec of moduleRefs(code)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(from),
        spec.split(/[?#]/, 1)[0]));
      if (!modules.has(target)) missing.push(from + ' -> ' + target + ' (module missing)');
      else if (!shell.has(target)) missing.push(from + ' -> ' + target + ' (not in SHELL)');
    }
  }
  return missing;
}

export default async ({ ok, open }) => {
  const sw = await fs.readFile(path.join(ROOT, 'sw.js'), 'utf8');
  const html = await fs.readFile(path.join(ROOT, 'index.html'), 'utf8');
  const shellSection = sw.match(/\bconst\s+SHELL\s*=\s*\[([\s\S]*?)\];/);
  const shell = new Set([...((shellSection?.[1] || '').matchAll(/['"]([^'"]+)['"]/g))]
    .map((m) => m[1]));
  ok(Boolean(shellSection) && shell.has('index.html') && shell.has('js/app.js'),
    'service worker has an install-time SHELL with the offline HTML and entry module');

  const jsDir = path.join(ROOT, 'js');
  const names = (await fs.readdir(jsDir)).filter((name) => name.endsWith('.js'));
  const modules = new Map(await Promise.all(names.map(async (name) =>
    ['js/' + name, await fs.readFile(path.join(jsDir, name), 'utf8')])));
  const missing = missingFromShell(modules, shell);
  ok(missing.length === 0 && names.every((n) => shell.has('js/' + n)),
    'all relative JS imports and all app JS modules are pre-cached: ' + missing.join('; '));

  const simulated = new Map(modules);
  for (const name of ['js/config.js', 'js/storage.js']) {
    simulated.set(name, simulated.get(name) +
      '\nimport { storageResult } from "./storage-state.js";');
  }
  const detected = missingFromShell(simulated, shell);
  ok(detected.some((m) => m.includes('js/config.js -> js/storage-state.js')) &&
    detected.some((m) => m.includes('js/storage.js -> js/storage-state.js')),
    'graph guard detects precisely the missing storage-state.js imports in the reported scenario');

  const importMapMatch = html.match(/<script\s+type="importmap"\s*>([\s\S]*?)<\/script>/);
  const importMap = importMapMatch ? JSON.parse(importMapMatch[1]).imports : {};
  const version = sw.match(/const VERSION\s*=\s*['"]kd-v(\d+)['"]/);
  const entry = html.match(/<script\s+type="module"\s+src="js\/app\.js\?v=(\d+)"/);
  const mapped = Object.values(importMap);
  ok(Boolean(version) && version[1] === entry?.[1] &&
    mapped.length >= 20 && mapped.every((url) =>
      url.endsWith('?v=' + version[1]) && shell.has(url.slice(2).split('?')[0])),
  'import map, entry module and service worker cache version stay synchronized');

  // Structural checks alone do not establish actual offline bootability.
  // Prove that a first install while online can start with the network disabled
  // on the very next navigation, without relying on runtime network-first warmup.
  const {ctx, page} = await open();
  const installed = await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    const cache = await caches.open('kd-v' +
      document.querySelector('script[type=module][src*="app.js"]')
        .src.match(/[?&]v=(\d+)/)[1]);
    const keyFiles = ['js/app.js','js/config.js','js/storage.js','js/analyze.js'];
    const missing = [];
    for (const file of keyFiles) if (!await cache.match(file)) missing.push(file);
    return {controller: Boolean(navigator.serviceWorker.controller),missing};
  });
  ok(installed.controller && !installed.missing.length,
    'installed service worker controls the page with required modules already cached: ' +
    JSON.stringify(installed));

  let offline;
  try {
    await ctx.setOffline(true);
    await page.reload({waitUntil:'domcontentloaded',timeout:20000});
    await page.waitForFunction(() => window.__kdReady === true, null, {timeout:15000});
    offline = await page.evaluate(() => ({
      ready: window.__kdReady === true,
      hasApp: !!document.querySelector('#analyzeBtn'),
      blocked: !!document.querySelector('.boot-fail'),
    }));
  } catch (err) {
    offline = {error: String(err)};
  } finally {
    await ctx.setOffline(false);
  }
  ok(offline.ready && offline.hasApp && !offline.blocked,
    'PWA starts with no network immediately after the first online installation: ' +
    JSON.stringify(offline));
};
