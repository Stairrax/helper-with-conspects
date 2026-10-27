// Service worker: оболочка приложения работает офлайн, библиотеки с CDN кэшируются при первом использовании.
// Запросы к API нейросетей никогда не кэшируются.

// При выпуске новой версии поднимайте VERSION и ?v= в index.html (importmap и app.js) — одно и то же число.
const VERSION = 'kd-v59';
const SHELL = [
  './',
  'index.html',
  'css/styles.css',
  'css/neon.css',
  'css/light.css',
  'css/ios.css',
  'css/android.css',
  'css/aurora.css',
  'css/ink.css',
  'js/app.js',
  'js/abbr.js',
  'js/commands.js',
  'js/lecture.js',
  'js/config.js',
  'js/stats.js',
  'js/cheatsheet.js',
  'js/audiobook.js',
  'js/tickets.js',
  'js/i18n.js',
  'js/i18n-en.js',
  'js/platform.js',
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
  'icons/apple-touch-icon.png',
];
const CDN = /^https:\/\/(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com)\//;

self.addEventListener('install', (e) => {
  // cache: 'reload' — мимо кэша браузера, иначе в новую версию могут попасть старые файлы
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== 'kd-cdn' && k !== 'kd-voices' && k !== 'kd-fonts' && k !== 'kd-meta').map((k) => caches.delete(k)))) // скачанный голос не удаляем
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

// ---------- Напоминания о повторении ----------
// Страница кладёт сроки в kd-meta/due.json; Chrome будит service worker примерно раз в день (periodicsync).

const META = (name) => new URL(name, self.registration.scope).href;
const DAY = 24 * 3600 * 1000;

async function remindDue() {
  const c = await caches.open('kd-meta');
  const r = await c.match(META('due.json'));
  if (!r) return;
  const { on, lang, items, exams } = await r.json();
  const now = Date.now();
  const due = (items || []).filter((x) => x.due <= now).sort((a, b) => a.due - b.due);
  // ближайший экзамен, до которого ещё есть непройденные темы
  const day0 = new Date(now); day0.setHours(12, 0, 0, 0);
  const daysTo = (d) => { const [y, m, dd] = d.split('-').map(Number); return Math.round((new Date(y, m - 1, dd, 12) - day0) / DAY); };
  const exam = (exams || []).map((x) => ({ ...x, days: daysTo(x.date) })).filter((x) => x.days > 0).sort((a, b) => a.days - b.days)[0];
  if (!on || (!due.length && !exam)) return;
  const last = await c.match(META('reminded.json'));
  if (last && now - (await last.json()).at < 0.8 * DAY) return; // не чаще раза в сутки
  const en = lang === 'en';
  if (exam) {
    const per = exam.left ? Math.ceil(exam.left / Math.max(1, exam.days - 1)) : 0;
    const when = en ? (exam.days === 1 ? 'tomorrow' : `in ${exam.days} days`) : exam.days === 1 ? 'завтра' : `через ${exam.days} ${exam.days % 10 === 1 && exam.days % 100 !== 11 ? 'день' : [2, 3, 4].includes(exam.days % 10) && ![12, 13, 14].includes(exam.days % 100) ? 'дня' : 'дней'}`;
    const plan = per ? (en ? `today: ${per} new ${per === 1 ? 'topic' : 'topics'}` : `сегодня по плану новых тем: ${per}`) : (en ? 'today: review and tickets' : 'сегодня — повторение и билеты');
    await self.registration.showNotification(en ? `Exam ${when}` : `Экзамен ${when}`, {
      body: `${exam.s ? `${exam.s}: ` : ''}${plan}${due.length ? (en ? `, ${due.length} to review` : `, повторить: ${due.length}`) : ''}`,
      icon: 'icons/icon-192.png', tag: 'kd-review', data: { url: './?go=today' },
    });
  } else {
    await self.registration.showNotification(en ? 'Time to review' : 'Пора повторить', {
      body: due.length === 1 ? `«${due[0].t}»` : en ? `“${due[0].t}” and ${due.length - 1} more` : `«${due[0].t}» и ещё ${due.length - 1}`,
      icon: 'icons/icon-192.png', tag: 'kd-review', data: { url: './?go=review' },
    });
  }
  await c.put(META('reminded.json'), new Response(JSON.stringify({ at: now })));
}

self.addEventListener('periodicsync', (e) => { if (e.tag === 'kd-review') e.waitUntil(remindDue()); });

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    const w = wins[0];
    if (w) { w.postMessage({ type: 'review' }); return w.focus(); }
    return self.clients.openWindow(e.notification.data?.url || './');
  }));
});
