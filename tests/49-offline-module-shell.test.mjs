// Offline regression: new JS dependencies must be included in the service
// worker's install-time SHELL. Dynamic network-first caching is not enough
// for the first offline launch of an installed PWA.
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Parse the literal SHELL array without letting a comment containing '];'
 * or a nested bracket terminate the scan. Reject non-string array elements.
 */
function shellEntries(code) {
  const match = /\bconst\s+SHELL\s*=\s*\[/.exec(code);
  if (!match) throw new Error('SHELL declaration not found');
  const start = match.index + match[0].lastIndexOf('[');
  let depth = 0, quote = null, comment = null, escaped = false;
  for (let i = start; i < code.length; i++) {
    const ch = code[i], next = code[i + 1];
    if (comment === 'line') {
      if (ch === '\n') comment = null;
      continue;
    }
    if (comment === 'block') {
      if (ch === '*' && next === '/') { comment = null; i++; }
      continue;
    }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && next === '/') { comment = 'line'; i++; continue; }
    if (ch === '/' && next === '*') { comment = 'block'; i++; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '[') depth++;
    if (ch === ']' && --depth === 0) {
      // The source is our own service-worker manifest, not outside input.
      const values = vm.runInNewContext(code.slice(start, i + 1), {}, {timeout:1000});
      if (!Array.isArray(values) || !values.every((v) => typeof v === 'string')) {
        throw new Error('SHELL must be a flat list of literal path strings');
      }
      return [...values];
    }
  }
  throw new Error('Unterminated SHELL array');
}

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

function reachableESModules(modules, start = 'js/app.js') {
  const reachable = new Set(), queue = [start];
  while (queue.length) {
    const from = queue.shift();
    if (reachable.has(from)) continue;
    reachable.add(from);
    for (const spec of moduleRefs(modules.get(from) || '')) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(from),
        spec.split(/[?#]/, 1)[0]));
      if (modules.has(target)) queue.push(target);
    }
  }
  return reachable;
}

/** Inspect entire dynamic import expressions. Just checking the initial quote
 * misses concatenated paths such as import('./' + name + '.js').
 */
function dynamicImportArgs(code) {
  const args = [], re = /\bimport\s*\(/g;
  for (const m of code.matchAll(re)) {
    const start = m.index + m[0].length;
    let depth = 1, quote = null, escaped = false, comment = null, end = -1;
    for (let i = start; i < code.length; i++) {
      const ch = code[i], next = code[i + 1];
      if (comment === 'line') {
        if (ch === '\n') comment = null;
        continue;
      }
      if (comment === 'block') {
        if (ch === '*' && next === '/') { comment = null; i++; }
        continue;
      }
      if (quote) {
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '/' && next === '/') { comment = 'line'; i++; continue; }
      if (ch === '/' && next === '*') { comment = 'block'; i++; continue; }
      if (ch === "'" || ch === '"' || ch.charCodeAt(0) === 96) { quote = ch; continue; }
      if (ch === '(') { depth++; continue; }
      if (ch === ')' && --depth === 0) { end = i; break; }
    }
    args.push(end < 0 ? code.slice(start) : code.slice(start, end));
  }
  return args;
}
const PLAIN_IMPORT_SPECIFIER = /^\s*(['"])(?:\\.|(?!\1)[^\\])*\1\s*$/s;
const nonLiteralDynamicImports = (code) =>
  dynamicImportArgs(code).filter((arg) => !PLAIN_IMPORT_SPECIFIER.test(arg));

function compareMapped(reachable, mappedPaths) {
  return {
    notMapped: [...reachable].filter((p) => !mappedPaths.has(p)),
    staleMapped: [...mappedPaths].filter((p) => !reachable.has(p)),
  };
}

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
  const shellList = shellEntries(sw);
  const shell = new Set(shellList);
  ok(shellList.length === shell.size && shell.has('index.html') && shell.has('js/app.js'),
    'service worker has an unambiguous, duplicate-free offline SHELL');
  const withMisleadingComment = sw.replace("'./',", "'./',\n  /* ]; nested [ignored] */");
  ok(shellEntries(withMisleadingComment).length === shellList.length,
    'SHELL parser ignores brackets and closing delimiters inside comments');

  const jsDir = path.join(ROOT, 'js');
  const names = (await fs.readdir(jsDir)).filter((name) => name.endsWith('.js'));
  const modules = new Map(await Promise.all(names.map(async (name) =>
    ['js/' + name, await fs.readFile(path.join(jsDir, name), 'utf8')])));
  const totalRefs = [...modules.values()].reduce((n, code) => n + moduleRefs(code).length, 0);
  ok(totalRefs > 20, 'graph guard actually parses imports: ' + totalRefs);
  const sample = [
    "import {x} from './static.js';",
    "export {x} from '../re-export.js';",
    "import './side-effect.js';",
    "await import('./dynamic.js');",
  ].map((code) => moduleRefs(code)[0]);
  ok(JSON.stringify(sample) === JSON.stringify([
    './static.js', '../re-export.js', './side-effect.js', './dynamic.js',
  ]), 'import parser recognizes imports, re-exports and literal dynamic imports');
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
  const reachable = reachableESModules(modules);
  ok(reachable.size > 20 && reachable.has('js/request.js') &&
    !reachable.has('js/neural-worker.js') && shell.has('js/neural-worker.js'),
    'ES module graph is traversed from app.js; worker scripts are still precached');

  const nonliteral = [...modules].filter(([, code]) =>
    nonLiteralDynamicImports(code).length > 0);
  ok(nonliteral.length === 0,
    'no non-literal dynamic imports can evade the static precache graph: ' +
    nonliteral.map(([p]) => p).join(', '));
  const templateExample = 'await import(' + String.fromCharCode(96) +
    './$' + '{name}.js' + String.fromCharCode(96) + ')';
  ok(nonLiteralDynamicImports("await import('./' + name + '.js')").length === 1 &&
    nonLiteralDynamicImports(templateExample).length === 1 &&
    nonLiteralDynamicImports("await import('./literal.js')").length === 0,
    'dynamic import guard rejects concatenation and templates, but accepts literals');

  const entries = Object.entries(importMap);
  const mappedPaths = new Set(entries.map(([, url]) => url.replace(/^\.\//, '').split('?')[0]));
  const {notMapped, staleMapped} = compareMapped(reachable, mappedPaths);
  const malformed = entries.filter(([key, url]) => {
    const relative = key.replace(/^\.\//, '');
    return !key.startsWith('./js/') ||
      url !== './' + relative + '?v=' + version?.[1] ||
      !modules.has(relative) || !shell.has(relative);
  });
  ok(notMapped.length === 0 && staleMapped.length === 0 &&
    mappedPaths.size === entries.length && malformed.length === 0,
    'import map exactly matches reachable ES modules: missing ' + notMapped.join(', ') +
      '; stale ' + staleMapped.join(', ') + '; malformed ' + malformed.map((p) => p[0]).join(', '));
  ok(Boolean(version) && version[1] === entry?.[1],
    'service worker cache and entry-module versions are synchronized');

  const simulatedMissing = new Set(mappedPaths);
  simulatedMissing.delete('js/request.js');
  const simulatedStale = new Set(mappedPaths);
  simulatedStale.add('js/orphan.js');
  ok(compareMapped(reachable, simulatedMissing).notMapped.includes('js/request.js') &&
    compareMapped(reachable, simulatedStale).staleMapped.includes('js/orphan.js'),
    'import-map guard detects both a missing dependency and a stale orphan entry');

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
