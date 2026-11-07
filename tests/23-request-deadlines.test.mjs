// Deadlines cover headers, bodies, SSE, offline waits and retry backoff.
export default async ({ open, ok }) => {
  const { page } = await open();
  const result = await page.evaluate(async () => {
    const { generate, stream, listModels } = await import('./js/openai.js');
    const fetchReal = window.fetch;
    const opts = { apiKey: 'test', baseUrl: 'https://deadline.test', model: 'test', parts: [{ text: 'hello' }], retries: 0, timeoutMs: 60 };
    const outcome = async (work) => {
      const started = performance.now();
      try { await work(); return { code: 'success', ms: performance.now() - started }; }
      catch (err) { return { code: err.name === 'AbortError' ? err.name : err.code || err.name, ms: performance.now() - started }; }
    };
    try {
      window.fetch = () => new Promise(() => {}); // Even an uncooperative fetch must time out.
      const headers = await outcome(() => generate(opts));
      const models = await outcome(() => listModels('test', opts.baseUrl, { timeoutMs: 60 }));
      window.fetch = async () => ({ ok: true, json: () => new Promise(() => {}) });
      const body = await outcome(() => generate(opts));

      let cancelled = false, text = '';
      window.fetch = async () => new Response(new ReadableStream({
        start(c) { c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n')); },
        cancel() { cancelled = true; },
      }), { headers: { 'Content-Type': 'text/event-stream' } });
      const stalled = await outcome(() => stream({ ...opts, onText: (t) => { text += t; } }));

      let doneCancelled = false, doneText = '';
      window.fetch = async () => new Response(new ReadableStream({
        start(c) { c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"done"}}]}\n\ndata: [DONE]\n\n')); },
        cancel() { doneCancelled = true; },
      }));
      const done = await outcome(() => stream({ ...opts, onText: (t) => { doneText += t; } }));

      let calls = 0;
      window.fetch = async () => { calls++; return new Response('{}', { status: 429 }); };
      const controller = new AbortController();
      const waiting = outcome(() => generate({ ...opts, signal: controller.signal, retries: 5, timeoutMs: 2000 }));
      setTimeout(() => controller.abort(), 50);
      const backoff = await waiting;
      const backoffCalls = calls;

      controller.abort(); calls = 0;
      const preAborted = await outcome(() => generate({ ...opts, signal: controller.signal }));
      const preAbortedCalls = calls;

      Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
      let onlineAdded = 0, onlineRemoved = 0;
      const add = window.addEventListener, remove = window.removeEventListener;
      window.addEventListener = function(type, ...args) { if (type === 'online') onlineAdded++; return add.call(this, type, ...args); };
      window.removeEventListener = function(type, ...args) { if (type === 'online') onlineRemoved++; return remove.call(this, type, ...args); };
      let offline;
      try { offline = await outcome(() => generate(opts)); }
      finally { delete navigator.onLine; window.addEventListener = add; window.removeEventListener = remove; }

      calls = 0;
      window.fetch = async () => { calls++; return new Response('{}', { status: 500 }); };
      const total = await outcome(() => generate({ ...opts, retries: 5, timeoutMs: 100 }));
      const totalCalls = calls;
      const { setUiLang, T } = await import('./js/i18n.js');
      setUiLang('en');
      const translated = T('Нейросеть слишком долго не отвечает. Попробуйте снова.');
      return { headers, models, body, stalled, cancelled, text, done, doneCancelled, doneText,
        backoff, backoffCalls, preAborted, preAbortedCalls, offline, onlineAdded, onlineRemoved, total, totalCalls, translated };
    } finally { window.fetch = fetchReal; }
  });
  ok(result.headers.code === 'REQUEST_TIMEOUT' && result.headers.ms < 5000, 'зависший fetch завершается тайм-аутом: ' + JSON.stringify(result.headers));
  ok(result.models.code === 'REQUEST_TIMEOUT' && result.body.code === 'REQUEST_TIMEOUT', 'список моделей и зависшее тело JSON ограничены по времени');
  ok(result.stalled.code === 'REQUEST_TIMEOUT' && result.cancelled && result.text === 'hello', 'зависший SSE после первых токенов сообщает тайм-аут и освобождает reader');
  ok(result.done.code === 'success' && result.doneText === 'done' && result.doneCancelled, '[DONE] завершает SSE, даже если сервер не закрыл соединение');
  ok(result.backoff.code === 'AbortError' && result.backoff.ms < 5000 && result.backoffCalls === 1, 'отмена прерывает ожидание повторного запроса без новой попытки');
  ok(result.preAborted.code === 'AbortError' && result.preAbortedCalls === 0, 'заранее отменённый запрос не отправляется');
  ok(result.offline.code === 'REQUEST_TIMEOUT' && result.onlineAdded === result.onlineRemoved, 'ожидание интернета ограничено по времени, слушатель online удаляется');
  ok(result.total.code === 'REQUEST_TIMEOUT' && result.totalCalls === 1 && result.total.ms < 5000, 'общий дедлайн включает паузы между повторами');
  ok(result.translated === 'The AI is taking too long to respond. Please try again.', 'сообщение тайм-аута переведено на английский');
};
