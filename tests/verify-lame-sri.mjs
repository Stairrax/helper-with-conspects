// Check the SRI digest against the actual npm package installed by npm ci.
// Optional --cdn additionally verifies live bytes from both external mirrors.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(resolve(root, 'js/audiobook.js'), 'utf8');
const sri = source.match(/const LAME_SRI = '(sha256-[A-Za-z0-9+/=]+)'/);
assert.ok(sri, 'LAME_SRI missing');
const urls = [...source.matchAll(/\{ url: '(https:\/\/[^']+)', integrity: LAME_SRI \}/g)].map(m => m[1]);
assert.deepEqual(urls, [
  'https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js',
  'https://unpkg.com/lamejs@1.2.1/lame.min.js',
], 'Both pinned CDN URLs must use the SRI digest');
assert.ok(source.includes("s.integrity = integrity;") && source.includes("s.crossOrigin = 'anonymous';"),
  'Dynamic script must set integrity and crossOrigin before appending');

const integrity = bytes => 'sha256-' + createHash('sha256').update(bytes).digest('base64');
const installed = await readFile(resolve(root, 'node_modules/lamejs/lame.min.js'));
assert.equal(sri[1], integrity(installed), 'SRI does not match installed lamejs@1.2.1 npm artifact');
console.log('PASS npm lamejs@1.2.1: ' + sri[1]);

if (process.argv.includes('--cdn')) {
  for (const url of urls) {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    assert.ok(response.ok, `Failed to fetch ${url}: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(integrity(bytes), sri[1], `CDN delivered different bytes: ${url}`);
    console.log('PASS CDN ' + url);
  }
}
