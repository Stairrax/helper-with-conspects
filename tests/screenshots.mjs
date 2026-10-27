// Снимки экрана и анимация для README: node tests/screenshots.mjs (для GIF нужен ffmpeg).
// Телефон Android, оформление «как в системе»: тёмная система — «Аврора», светлая — «Чернила».
// Нейросеть и голос — заглушки из tests/lib.mjs, как в тестах.

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer, fakeSpeech, mockAI, prepare, DEFAULT_SETTINGS, ROOT } from './lib.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const OUT = path.join(ROOT, 'screenshots');
const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const PHONE = { width: 412, height: 915 };
const CAPTION = 150; // полоса с подписями «Помощник» / «Вы» над экраном в GIF
const SUBJECT = 'Финансовая грамотность, лекция 2';
const TITLES = ['Доходы и расходы', 'Сложный процент'];
const LECTURE = `Активные доходы — это зарплата, премии и подработки. Их планируют, считая «на руки», то есть после удержания налога на доходы физических лиц. Пассивные доходы — это проценты по вкладам, купоны облигаций и дивиденды. Вместе они и составляют доходную часть бюджета.

Сложный процент — это начисление процентов не только на вклад, но и на уже начисленные проценты. Каждый год проценты прибавляются к вкладу. Поэтому сумма растёт не по прямой, а всё быстрее. За двадцать лет вклад может вырасти в несколько раз.`;
const QUESTION = 'что значит на руки';
const ANSWER = ['«На руки» — это зарплата после налога: из неё сразу удерживают 13 % НДФЛ. ', 'Например, из 50 000 рублей на руки придёт 43 500.'];
const SETTINGS = { voiceCommands: true, listenWhileSpeaking: true, formulasApart: false, pause: 2 };

const { server, base } = await startServer();
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

/** Телефон: отдельный контекст, как open() в тестах, но с тёмной темой системы и без лишних всплывающих подсказок. */
async function phone({ settings = SETTINGS, fresh = false, freeProxy = 'off', storageState, video, viewport = PHONE, url = base, scheme = 'dark' } = {}) {
  const ctx = await browser.newContext({
    viewport, isMobile: true, hasTouch: true, userAgent: UA, locale: 'ru-RU', colorScheme: scheme, deviceScaleFactor: 1,
    ...(storageState ? { storageState } : {}), ...(video ? { recordVideo: { dir: video, size: viewport } } : {}),
  });
  const page = await ctx.newPage();
  const started = Date.now();
  await page.addInitScript(fakeSpeech);
  await page.addInitScript((u) => {
    localStorage.setItem('kd.freeProxy', u);
    document.addEventListener('DOMContentLoaded', () => {
      const s = document.createElement('style');
      s.textContent = '.toast{display:none!important}';
      document.head.append(s);
    });
  }, freeProxy);
  await mockAI(page, { prompts: [], titles: TITLES, segment: 0, plan: 0, generate: 0, answer: 0, command: 0, tidy: 0, extract: 0 });
  // ответ нейросети на вопрос — свой, под вопрос из снимков
  await page.route(/openrouter\.ai\/api|free-proxy\.test/, async (route) => {
    if (!JSON.parse(route.request().postData() || '{}').stream) return route.fallback();
    const sse = ANSWER.map((t) => 'data: ' + JSON.stringify({ choices: [{ delta: { content: t } }] }) + '\n\n').join('') + 'data: [DONE]\n\n';
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse });
  });
  await page.goto(url);
  if (!storageState) {
    await page.evaluate(() => navigator.serviceWorker?.ready);
    if (!fresh) {
      await page.evaluate((s) => {
        localStorage.setItem('kd.settings', JSON.stringify(s));
        localStorage.setItem('kd.tipHidden', '1');
        localStorage.setItem('kd.onboarded', '1');
      }, { ...DEFAULT_SETTINGS, ...settings });
    }
    await page.reload();
  }
  await page.waitForTimeout(500);
  return { ctx, page, started };
}

const shot = async (page, name) => {
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, name) });
  console.log('✓', name);
};
const say = (frame, text) => frame.evaluate((t) => window.__say(t, true), text);

// ---------- материал, план, диктовка, ответ, «только слушаю» ----------
// тёмное — «Аврора», светлое — «Чернила»; в README — по три снимка каждого
const prepared = {};
for (const [scheme, look, mine] of [['dark', 'aurora', ['dictate', 'answer']], ['light', 'ink', ['plan', 'listen']]]) {
  const main = await phone({ scheme });
  const { page } = main;
  await prepare(page, LECTURE, 'Лекция 2');
  page.once('dialog', (d) => d.accept(SUBJECT));
  await page.click('#subjectBtn');
  await page.click('#subjectRename');
  await page.waitForFunction((s) => document.getElementById('subjectName').textContent === s, SUBJECT);
  prepared[scheme] = await main.ctx.storageState({ indexedDB: true });
  const want = (name) => mine.includes(name);

  await page.click('[data-tab=plan]');
  await page.evaluate(() => scrollTo(0, 0));
  if (want('plan')) await shot(page, `plan-${look}.png`);

  await page.evaluate(() => { window.__hold = 'Их планируют'; });
  await page.click('#startBtn');
  await page.waitForFunction(() => document.getElementById('chunkText').textContent.includes('Их планируют') && window.speechSynthesis.speaking, null, { timeout: 20000 });
  await page.evaluate(() => scrollTo(0, 0));
  await page.waitForTimeout(2500);
  if (want('dictate')) await shot(page, `dictate-${look}.png`);

  await page.dispatchEvent('#stopBtn', 'pointerdown');
  await page.waitForTimeout(300);
  await say(page, QUESTION);
  await page.waitForFunction(() => /Продолжаем/.test(document.getElementById('dictState').textContent), null, { timeout: 20000 });
  await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
  if (want('answer')) await shot(page, `answer-${look}.png`);

  await say(page, 'да');
  await page.waitForTimeout(800);
  await page.evaluate(() => { window.__hold = 'Пассивные доходы'; });
  await page.click('#listenSeg label:nth-child(2)');
  await page.click('#nextBtn');
  await page.waitForFunction(() => document.getElementById('chunkText').textContent.includes('Пассивные доходы') && window.speechSynthesis.speaking, null, { timeout: 20000 });
  await page.evaluate(() => scrollTo(0, 0));
  await page.waitForTimeout(2500);
  if (want('listen')) await shot(page, `listen-${look}.png`);
  await main.ctx.close();
}

// ---------- живой голос в настройках ----------
const voice = await phone({ scheme: 'light' });
await voice.page.click('[data-tab=settings]');
await voice.page.click('input[name=voiceEngine][value=neural] + span');
await voice.page.waitForFunction(() => /^[✓✗]/.test(document.getElementById('neuralStatus').textContent), null, { timeout: 180000 }).catch(() => {});
console.log('  голос:', await voice.page.textContent('#neuralStatus'));
await voice.page.evaluate(() => {
  const title = document.querySelector('input[name=voiceEngine]').closest('.seg').previousElementSibling; // «Голос»
  scrollTo(0, title.getBoundingClientRect().top + scrollY - 96);
});
await shot(voice.page, 'voice-ink.png');
await voice.ctx.close();

// ---------- первый запуск: последний шаг мастера ----------
const welcome = await phone({ fresh: true, freeProxy: 'https://free-proxy.test' });
await welcome.page.click('#obStart');
await welcome.page.waitForSelector('#obFinish', { state: 'visible' });
await shot(welcome.page, 'welcome-aurora.png');
await welcome.ctx.close();

// ---------- GIF: диктовка, «стоп», вопрос, ответ, «да» — и дальше с того же места ----------
// подписи над экраном — в цветах оформления
const CAP = {
  aurora: { bg: '#070818', text: '#eef0ff', line: '#26284a', who: '#b7abff', me: '#7ef0ee' },
  ink: { bg: '#f3f0e8', text: '#1b1a17', line: '#d6cfbf', who: '#7b766b', me: '#2f7d5b' },
};
for (const [scheme, look] of [['dark', 'aurora'], ['light', 'ink']]) {
const c = CAP[look];
const FRAME = path.join(ROOT, 'tests', '.demo-frame.html');
await fs.writeFile(FRAME, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=${PHONE.width}">
<style>
  html, body { margin: 0; background: ${c.bg}; color: ${c.text}; font: 19px/1.35 Roboto, system-ui, sans-serif; }
  #cap { height: ${CAPTION}px; box-sizing: border-box; padding: 12px 18px; overflow: hidden; border-bottom: 1px solid ${c.line}; }
  #cap b { display: block; font-size: 15px; font-weight: 500; color: ${c.who}; }
  #me b { color: ${c.me}; margin-top: 6px; }
  iframe { display: block; border: 0; width: ${PHONE.width}px; height: ${PHONE.height}px; }
</style>
<div id="cap"><div id="tts"></div><div id="me"></div></div>
<iframe id="app" src="../index.html"></iframe>
<script>
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  window.me = '';
  setInterval(() => {
    const w = document.getElementById('app').contentWindow;
    const s = w.speechSynthesis && w.speechSynthesis.speaking && (w.__spoken || []).at(-1);
    document.getElementById('tts').innerHTML = s && !/^Тема:/.test(s) ? '<b>Помощник</b>' + esc(s) : '';
    document.getElementById('me').innerHTML = window.me ? '<b>Вы</b>«' + esc(window.me) + '»' : '';
  }, 100);
</script>`);
const video = path.join(ROOT, 'tests', '.video');
const demo = await phone({ scheme, storageState: prepared[scheme], video, viewport: { width: PHONE.width, height: PHONE.height + CAPTION }, url: base + 'tests/.demo-frame.html' });
const app = () => demo.page.frames().find((f) => f.url().includes('index.html'));
await app().evaluate(() => navigator.serviceWorker?.ready);
await demo.page.waitForTimeout(2500); // приложение один раз перезагружается под service worker
await app().waitForSelector('[data-tab=plan]');
await app().click('[data-tab=plan]');
await app().evaluate(() => { scrollTo(0, 0); window.__dur = 3200; });
await demo.page.waitForTimeout(600);
const from = (Date.now() - demo.started) / 1000;
const caption = async (text, ms) => { await demo.page.evaluate((t) => { window.me = t; }, text); await say(app(), text); await demo.page.waitForTimeout(ms); await demo.page.evaluate(() => { window.me = ''; }); };

await demo.page.waitForTimeout(1200);
await app().click('#startBtn');
await app().waitForFunction(() => document.getElementById('chunkText').textContent.includes('Их планируют') && window.speechSynthesis.speaking, null, { timeout: 20000 });
await demo.page.waitForTimeout(1800);
await caption('Стоп', 1500);
await caption('Что значит «на руки»?', 1200);
await app().waitForFunction(() => /Продолжаем/.test(document.getElementById('dictState').textContent), null, { timeout: 30000 });
await demo.page.waitForTimeout(1500);
await caption('Да', 1200);
await demo.page.waitForTimeout(3500);
const to = (Date.now() - demo.started) / 1000;
const rec = demo.page.video();
await demo.ctx.close();
const webm = await rec.path();
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', from.toFixed(2), '-to', to.toFixed(2), '-i', webm,
  '-vf', 'fps=12,scale=340:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle',
  '-loop', '0', path.join(OUT, `demo-${look}.gif`)]);
console.log(`✓ demo-${look}.gif (${(to - from).toFixed(1)} с)`);
await fs.rm(FRAME, { force: true });
await fs.rm(video, { recursive: true, force: true });
}

await browser.close();
server.close();
