// Service worker: оболочка приложения работает офлайн, библиотеки с CDN кэшируются при первом использовании.
// Запросы к API нейросетей никогда не кэшируются.

// При выпуске новой версии поднимайте VERSION и ?v= в index.html (importmap и app.js) — одно и то же число.
const VERSION = 'kd-v36';
const SHELL = [
  './',
  'index.html',
  'css/styles.css',
  'css/neon.css',
  'js/app.js',
  'js/abbr.js',
  'js/ai.js',
  'js/analyze.js',
  'js/anthropic.js',
  'js/dictation.js',
  'js/extract.js',
  'js/gemini.js',
  'js/media.js',
  'js/neural.js',
  'js/neural-worker.js',
  'js/silero-core.js',
  'js/onboarding.js',
  'js/openai.js',
  'js/ripple.js',
  'js/speech.js',
  'js/storage.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-512.png',
];
const CDN = /^https:\/\/(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com)\//;

self.addEventListener('install', (e) => {
  // cache: 'reload' — мимо кэша браузера, иначе в новую версию могут попасть старые файлы
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== 'kd-cdn' && k !== 'kd-voices' && k !== 'kd-fonts').map((k) => caches.delete(k)))) // скачанный голос не удаляем
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (CDN.test(req.url)) {
    e.respondWith(caches.open('kd-cdn').then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      // importScripts в голосовом модуле запрашивает скрипт без CORS — такой ответ «непрозрачный»,
      // его нельзя проверить и он не сохранялся. CDN отдаёт CORS, поэтому просим явно.
      const res = req.mode === 'no-cors'
        ? await fetch(req.url, { mode: 'cors', credentials: 'omit' }).catch(() => fetch(req))
        : await fetch(req);
      if (res.ok) c.put(req, res.clone());
      return res;
    }));
    return;
  }

  if (url.origin !== self.location.origin) return;
  // шрифты темы «Неон» не меняются — храним отдельно, чтобы не скачивать заново с каждой версией
  if (url.pathname.includes('/fonts/')) {
    e.respondWith(caches.open('kd-fonts').then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone());
      return res;
    }));
    return;
  }
  // файлы голоса (≈90 МБ) кэширует сам голосовой модуль (kd-voices) — второй копии не нужно
  if (url.pathname.includes('/voices/')) return;

  // Свои файлы: сначала сеть (чтобы обновления приходили сразу), при офлайне — кэш.
  // cache: 'no-cache' — всегда сверяемся с сервером: файлы разных версий не перемешаются.
  const fresh = req.mode === 'navigate' ? fetch(req.url, { cache: 'no-cache' }) : fetch(req, { cache: 'no-cache' });
  e.respondWith(
    fresh
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
        // на переход по ссылке нельзя отвечать ответом после редиректа — отдаём его как обычный
        if (req.mode === 'navigate' && res.redirected) return new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers });
        return res;
      })
      .catch(async () => (await caches.match(req, { ignoreSearch: true })) ||
        (req.mode === 'navigate' ? caches.match('index.html') : Response.error())),
  );
});
