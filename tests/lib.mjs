// Общее для браузерных тестов: статический сервер, имитация синтеза и распознавания речи, заглушка нейросети.
// Нейросеть отвечает по шаблонам — по тексту запроса понятно, какой это шаг (темы, план, куски, ответ…).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.gif': 'image/gif', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
  '.onnx': 'application/octet-stream', '.bin': 'application/octet-stream', '.md': 'text/markdown; charset=utf-8',
};

/** Раздаёт папку репозитория, как GitHub Pages. */
export function startServer(port = 0) {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = path.join(ROOT, url);
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}/` })));
}

/** Имитация speechSynthesis и SpeechRecognition: window.__spoken — что сказано, window.__say(текст) — «сказал человек». */
function fakeSpeech() {
  window.__spoken = [];
  window.__dur = 0;   // 0 — фраза длится по длине текста; иначе — столько мс (кроме «Тема: …»)
  window.__hold = ''; // фраза с этим текстом звучит «бесконечно» — чтобы тест застал её на экране
  const fake = {
    speaking: false, pending: false, _u: null, _t: null,
    getVoices: () => [{ name: 'Fake RU', lang: 'ru-RU', voiceURI: 'fake-ru' }],
    addEventListener() {}, onvoiceschanged: null,
    speak(u) {
      this._u = u; this.speaking = true; window.__spoken.push(u.text); window.__ttsLang = u.lang;
      setTimeout(() => u.onstart && u.onstart(), 10);
      // __dur растягивает куски, но не объявления «Тема: …» — чтобы тест успел дойти до куска
      const hold = (window.__hold && u.text.includes(window.__hold)) || (window.__dur && !/^(Тема|Продолжаем тему)/.test(u.text));
      const ms = hold ? (window.__dur || 600000) : Math.min(1500, 150 + u.text.length * 8);
      this._t = setTimeout(() => { this.speaking = false; this._u = null; u.onend && u.onend(); }, ms);
    },
    cancel() {
      clearTimeout(this._t); const u = this._u; this._u = null; this.speaking = false;
      if (u) setTimeout(() => u.onerror && u.onerror({ error: 'interrupted' }), 5);
    },
  };
  Object.defineProperty(window, 'speechSynthesis', { value: fake });
  class FakeSR {
    start() { window.__sr = this; window.__srLang = this.lang; this.i = 0; setTimeout(() => this.onstart && this.onstart(), 5); }
    abort() { setTimeout(() => this.onend && this.onend(), 5); }
    stop() { this.abort(); }
  }
  window.SpeechRecognition = FakeSR;
  window.__say = (text, final = true) => {
    const sr = window.__sr; if (!sr) return 'no sr';
    const idx = sr.i; if (final) sr.i++;
    const res = [{ transcript: text }]; res.isFinal = final;
    const results = []; results[idx] = res;
    sr.onresult({ resultIndex: idx, results: Object.assign(results, { length: idx + 1 }) });
    return 'ok';
  };
}

const sentences = (s) => s.split(/(?<=[.!?])\s+/).filter(Boolean);
const between = (text) => text.split('<<<')[1].split('>>>')[0].trim();

/** Заглушка нейросети (OpenRouter, Gemini, Anthropic). ai — счётчики и запросы, чтобы тест мог их проверить. */
async function mockAI(page, ai) {
  await page.route(/generativelanguage\.googleapis|openrouter\.ai\/api|api\.anthropic\.com/, async (route) => {
    const url = route.request().url();
    const body = JSON.parse(route.request().postData() || '{}');
    const isA = url.includes('anthropic'), isO = url.includes('openrouter'), isStream = url.includes('streamGenerateContent') || body.stream;
    let text;
    if (isA) text = (body.messages[0].content || []).map((c) => c.text || '').join('');
    else if (isO) { const c = body.messages.at(-1).content; text = typeof c === 'string' ? c : c.map((x) => x.text || '').join(''); }
    else text = body.contents?.[0]?.parts?.map((p) => p.text || '').join('') || '';
    ai.prompts.push(text);
    const reply = (obj) => {
      const t = typeof obj === 'string' ? obj : JSON.stringify(obj);
      const json = isA ? { content: [{ type: 'text', text: t }], stop_reason: 'end_turn' }
        : isO ? { choices: [{ message: { content: t }, finish_reason: 'stop' }] }
          : { candidates: [{ content: { parts: [{ text: t }] }, finishReason: 'STOP' }] };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(json) });
    };
    if (isStream) {
      ai.answer++;
      const parts = ['Потому что проценты начисляются и на уже начисленные проценты. ', 'Поэтому сумма растёт всё быстрее.'];
      const sse = isA ? 'event: message_start\ndata: {"type":"message_start","message":{}}\n\n' + parts.map((t) => 'event: content_block_delta\ndata: ' + JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } }) + '\n\n').join('') + 'event: message_stop\ndata: {"type":"message_stop"}\n\n'
        : isO ? parts.map((t) => 'data: ' + JSON.stringify({ choices: [{ delta: { content: t } }] }) + '\n\n').join('') + 'data: [DONE]\n\n'
          : parts.map((t) => 'data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: t }] } }] }) + '\n\n').join('');
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse });
    }
    if (text.includes('пронумерованные блоки')) {
      ai.segment++;
      const n = +text.match(/блоки \[1\]…\[(\d+)\]/)[1];
      const titles = ai.titles;
      const per = Math.ceil(n / titles.length);
      return reply({ topics: titles.map((title, i) => ({ title, from: i * per + 1, to: Math.min(n, (i + 1) * per) })).filter((t) => t.from <= n) });
    }
    if (text.includes('Для каждой темы определи')) {
      ai.plan++;
      const ids = [...text.matchAll(/"id":"(t[a-z0-9]+)"/g)].map((m) => m[1]);
      return reply({ topics: ids.map((id, i) => ({ id, difficulty: 2 + i, prerequisites: [], summary: 'О чём тема.' })) });
    }
    if (text.includes('Проверь полноту')) {
      const n = (text.match(/^\(\d+\)/gm) || []).length;
      return reply({ checks: Array.from({ length: n }, (_, i) => ({ i, c: [0] })), missing: [] });
    }
    if (text.includes('Пользователь приложения для диктовки конспектов сказал')) {
      ai.command++;
      return reply(/короче/.test(text) ? { cmd: 'pauseLen', arg: -1 } : { cmd: 'none' });
    }
    if (text.includes('автоматической расшифровки лекции')) {
      ai.tidy++;
      const src = between(text);
      return reply(src.charAt(0).toUpperCase() + src.slice(1) + '.');
    }
    const formulasOf = (src) => sentences(src).filter((x) => x.includes('='))
      .map((f, i) => ({ n: 'Формула ' + (i + 1), f: f.replace(/^[^:]*:\s*/, '').replace(/\.$/, ''), d: 'S — сумма; P — вклад' }));
    if (text.includes('Ответ JSON: {"formulas"')) {
      ai.extract++;
      return reply({ formulas: formulasOf(between(text)) });
    }
    if (text.includes('ИСХОДНЫЙ ТЕКСТ')) {
      ai.generate++;
      const src = between(text);
      const all = sentences(src);
      const fs = all.filter((x) => x.includes('='));
      const m = text.match(/Если в этом тексте формул (\d+) или больше/);
      const apart = text.includes('ФОРМУЛЫ ОТДЕЛЬНО') && (!m || fs.length >= +m[1]);
      const theory = apart ? all.filter((x) => !x.includes('=')).concat(['Итоговая сумма зависит от вклада, ставки и числа периодов.']) : all;
      // числа: на экране цифрами, для голоса — словами
      const spoken = (t) => (/\d/.test(t) ? { s: t.replace('19 500', 'девятнадцати тысяч пятисот').replace('150 000', 'ста пятидесяти тысяч') } : {});
      return reply({
        points: theory.map((p, i) => ({ p, c: [i] })),
        chunks: theory.map((t) => ({ t, k: 'content', ...spoken(t) })),
        recap: 'Главное по теме.',
        quiz: [{ q: 'Вопрос: ' + all[0].slice(0, 30), a: 'Ответ.' }],
        formulas: formulasOf(src), apart,
      });
    }
    return reply({});
  });
}

export const DEFAULT_SETTINGS = {
  provider: 'openrouter', apiKey: 'TEST-KEY', model: 'google/gemini-2.5-flash', pause: 3, scalePause: false,
  selfCheck: false, coverageCheck: false, showText: true,
};

/**
 * Новый «телефон»: отдельный контекст браузера с имитацией речи и заглушкой нейросети.
 * settings — поверх DEFAULT_SETTINGS (null — чистый первый запуск с мастером).
 */
export async function makeOpen(browser, base) {
  return async function open({ settings = {}, desktop = false, permissions = [], userAgent, titles = ['Доходы и расходы', 'Сложный процент'], locale = 'ru-RU' } = {}) {
    const ctx = await browser.newContext(desktop
      ? { viewport: { width: 1280, height: 800 }, permissions, locale }
      : { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, permissions, locale, ...(userAgent ? { userAgent } : {}) });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
    await page.addInitScript(fakeSpeech);
    const ai = { prompts: [], titles, segment: 0, plan: 0, generate: 0, answer: 0, command: 0, tidy: 0, extract: 0 };
    await mockAI(page, ai);
    await page.goto(base);
    // первый запуск ставит service worker, и приложение один раз перезагружается под ним — дожидаемся этого
    await page.evaluate(() => navigator.serviceWorker?.ready);
    if (settings === null) { await page.reload(); await page.waitForTimeout(300); }
    if (settings !== null) {
      await page.evaluate((s) => {
        localStorage.setItem('kd.settings', JSON.stringify(s));
        localStorage.setItem('kd.tipHidden', '1');
        localStorage.setItem('kd.onboarded', '1');
      }, { ...DEFAULT_SETTINGS, ...settings });
      await page.reload();
    }
    await page.waitForTimeout(300);
    await page.addStyleTag({ content: '.toast{display:none!important}' });
    const say = async (text, final = true, wait = 600) => { await page.evaluate(([t, f]) => window.__say(t, f), [text, final]); await page.waitForTimeout(wait); };
    return { ctx, page, errors, ai, say };
  };
}

/** Вставляет текст конспекта, составляет план и ждёт, пока все темы подготовятся. */
export async function prepare(page, text, title = 'Конспект') {
  await page.click('[data-tab=load]');
  await page.click('#addTextBtn');
  await page.fill('#pasteText', text);
  await page.fill('#pasteTitle', title);
  await page.click('#pasteAdd');
  await page.click('#analyzeBtn');
  await page.waitForFunction(() => {
    const li = document.querySelectorAll('#planList li');
    return li.length > 0 && document.querySelectorAll('#planList .pstate.ok').length === li.length;
  }, null, { timeout: 20000 });
}

export const FINANCE = `Сложный процент начисляется на накопленную сумму. Итоговая сумма: S = P(1 + r)^n. Доход: D = S - P. Реальная ставка: R = r - i.

Бюджет — это план доходов и расходов. Социальный вычет — до 150 000 рублей в год. Возврат — до 19 500 рублей.`;
