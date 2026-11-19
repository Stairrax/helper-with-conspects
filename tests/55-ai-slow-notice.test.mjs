// Long AI generation should show a truthful progress hint and clean timers
// after success, timeout or manual cancellation.
export default async ({ open, ok }) => {
  const { page } = await open();
  const result = await page.evaluate(async () => {
    const { generate } = await import('./js/openai.js');
    const originalFetch = window.fetch;
    const originalSetTimeout = window.setTimeout;
    // Shorten ONLY the progress-hint timer, never the request deadline.
    window.setTimeout = (fn, ms, ...args) =>
      originalSetTimeout(fn, ms === 45000 ? 20 : ms, ...args);
    const wait = (ms) => new Promise((r) => originalSetTimeout(r, ms));
    const statuses = [];
    const opts = {
      apiKey: 'test', baseUrl: 'https://notice.test', model: 'test',
      purpose: 'notes', retries: 0, timeoutMs: 110,
      parts: [{ text: 'Please divide these study notes into topics' }],
      onStatus: (message) => statuses.push(message),
    };
    try {
      window.fetch = () => new Promise(() => {});
      let timeout = '';
      try { await generate(opts); }
      catch (e) { timeout = e.code || e.name; }
      const slow = [...statuses];
      statuses.length = 0;

      window.fetch = async () => new Response(JSON.stringify({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      const fast = await generate(opts);
      await wait(50);
      const afterSuccess = [...statuses];
      statuses.length = 0;

      window.fetch = () => new Promise(() => {});
      const controller = new AbortController();
      originalSetTimeout(() => controller.abort(), 5);
      let cancelled = '';
      try { await generate({ ...opts, signal: controller.signal }); }
      catch (e) { cancelled = e.name; }
      await wait(50);
      const afterCancel = [...statuses];
      return { timeout, slow, fast, afterSuccess, cancelled, afterCancel };
    } finally {
      window.fetch = originalFetch;
      window.setTimeout = originalSetTimeout;
    }
  });
  ok(result.timeout === 'REQUEST_TIMEOUT', 'stalled notes generation remains bounded by its original deadline');
  ok(result.slow.length === 1 && result.slow[0].includes('медленнее обычного'),
    'a long silent notes request shows one clear waiting message');
  ok(result.fast === 'ok' && result.afterSuccess.length === 0,
    'fast successful response clears progress timer');
  ok(result.cancelled === 'AbortError' && result.afterCancel.length === 0,
    'user cancellation clears progress timer without a misleading late message');
};
