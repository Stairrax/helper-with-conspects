const RELEASE = __KD_RELEASE__;
const FILES = __KD_FILES__;
const CACHE = 'kd-release-' + RELEASE;
const ROOT = self.registration.scope;
const SHELL = 'releases/' + RELEASE + '/shell.html';
const CDN = /^https:\/\/(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com)\//;
const releasePath = /^releases\/(v\d+-[a-f0-9]{20})\/(.+)$/;

const absolute = path => new URL(path, ROOT).href;
const digest = async buffer => [...new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))]
  .map(x => x.toString(16).padStart(2, '0')).join('');

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    try {
      for (const [path, expected] of Object.entries(FILES)) {
        const url = absolute(path);
        const res = await fetch(url, { cache: 'reload' });
        if (!res.ok || await digest(await res.clone().arrayBuffer()) !== expected) {
          throw new Error('Invalid release asset: ' + path);
        }
        await cache.put(url, res);
      }
    } catch (error) {
      await caches.delete(CACHE);
      throw error;
    }
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

async function shared(req, name) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = req.mode === 'no-cors'
    ? await fetch(req.url, { mode: 'cors', credentials: 'omit' }).catch(() => fetch(req))
    : await fetch(req);
  if (res.ok) await cache.put(req, res.clone());
  return res;
}

async function navigation() {
  const cache = await caches.open(CACHE);
  const shell = await cache.match(absolute(SHELL));
  if (!shell) return new Response('Release shell unavailable. Reopen the app online.', { status: 503 });
  return new Response(await shell.arrayBuffer(), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

async function asset(req, id) {
  const cache = await caches.open('kd-release-' + id);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req, { cache: 'no-cache' });
  if (res.ok) await cache.put(req, res.clone());
  return res;
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (CDN.test(req.url)) {
    event.respondWith(shared(req, 'kd-cdn'));
    return;
  }
  if (!req.url.startsWith(ROOT)) return;
  const url = new URL(req.url);
  const path = url.pathname.slice(new URL(ROOT).pathname.length);
  if (req.mode === 'navigate' && (path === '' || path === 'index.html')) {
    event.respondWith(navigation());
    return;
  }
  const match = releasePath.exec(path);
  if (match) {
    event.respondWith(asset(req, match[1]));
    return;
  }
  if (path.startsWith('fonts/')) {
    event.respondWith(shared(req, 'kd-fonts'));
  }
});
