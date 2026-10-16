// Service worker: оболочка приложения работает офлайн, библиотеки с CDN кэшируются при первом использовании.
// Запросы к API нейросетей никогда не кэшируются.

const VERSION = 'kd-v16';
const SHELL = [
  './',
  'index.html',
  'css/styles.css',
  'js/app.js',
  'js/cloud.js',
  'js/ai.js',
  'js/analyze.js',
  'js/anthropic.js',
  'js/dictation.js',
  'js/extract.js',
  'js/gemini.js',
  'js/media.js',
  'js/neural.js',
  'js/neural-worker.js',
  'js/onboarding.js',
  'js/openai.js',
  'js/speech.js',
  'js/storage.js',
  'manifest.webmanifest',
  'yandex-function/index.js',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-512.png',
];
const CDN = /^https:\/\/(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com)\//;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== 'kd-cdn' && k !== 'kd-voices' && k !== 'kd-tts').map((k) => caches.delete(k)))) // скачанный голос не удаляем
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
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone());
      return res;
    }));
    return;
  }

  if (url.origin !== self.location.origin) return;

  // Свои файлы: сначала сеть (чтобы обновления приходили сразу), при офлайне — кэш.
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
        return res;
      })
      .catch(async () => (await caches.match(req, { ignoreSearch: true })) ||
        (req.mode === 'navigate' ? caches.match('index.html') : Response.error())),
  );
});
