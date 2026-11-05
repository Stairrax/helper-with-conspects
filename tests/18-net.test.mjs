// «Проверить связь»: что открывается из этой сети — сервер бесплатного режима и нейросеть.
const HEALTH = { keyOnServer: true, models: ['a:free', 'b:free'], keyCheck: { status: 200, freeTier: true }, fallback: { binding: true }, where: { colo: 'ARN', country: 'EE' } };

export default async ({ open, ok }) => {
  const run = async (serverUp, openrouterUp) => {
    const { page } = await open({ settings: { provider: 'free', apiKey: '' }, freeProxy: 'https://free-proxy.test' });
    await page.route(/free-proxy\.test\/health/, (r) => (serverUp ? r.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(HEALTH) }) : r.abort()));
    await page.route('https://openrouter.ai/', (r) => (openrouterUp ? r.fulfill({ status: 200, contentType: 'text/html', body: 'ok' }) : r.abort()));
    await page.click('[data-tab=settings]');
    await page.click('#netCheckBtn');
    await page.waitForFunction(() => !/Проверяю/.test(document.getElementById('netCheckOut').textContent) && document.getElementById('netCheckOut').textContent.length > 0, null, { timeout: 15000 });
    return { text: await page.textContent('#netCheckOut'), page };
  };

  let r = await run(true, true);
  ok(/Сервер бесплатного режима отвечает/.test(r.text) && /ключ принят/.test(r.text) && /моделей: 2/.test(r.text) && /запасной ИИ/.test(r.text) && /ARN \(EE\)/.test(r.text) && /Связь в порядке/.test(r.text),
    'всё открывается: сервер, ключ, модели, запасной ИИ, путь через дата-центр — ' + r.text.slice(0, 120));

  r = await run(false, true);
  ok(/не отвечает/.test(r.text) && /OpenRouter открывается/.test(r.text) && /подключите свой ключ/.test(r.text), 'сервер закрыт, OpenRouter открывается — совет: свой ключ');

  r = await run(false, false);
  ok(/Включите VPN/.test(r.text) && /без интернета/.test(r.text) && !r.text.includes('Связь в порядке'), 'ничего не открывается — совет: VPN или другая сеть, готовые конспекты работают без интернета');

  // сообщение об ошибке, когда сервер бесплатного режима недостижим (повторы отключены, чтобы не ждать)
  const { page } = await open({ settings: { provider: 'free', apiKey: '' }, freeProxy: 'https://free-proxy.test' });
  await page.route(/free-proxy\.test/, (rt) => rt.abort());
  const msg = await page.evaluate(async () => {
    const { generate } = await import('./js/openai.js');
    try { await generate({ apiKey: 'kd-x', baseUrl: 'https://free-proxy.test', model: 'auto', parts: [{ text: 'привет' }], retries: 0 }); return 'нет ошибки'; } catch (e) { return e.message; }
  });
  ok(/Нет связи с сервером бесплатного режима[\s\S]*Если вы в России и без VPN[\s\S]*Проверить связь/.test(msg), 'сервер недостижим: понятное сообщение про VPN и «Проверить связь»: ' + msg.slice(0, 80));
  const other = await page.evaluate(async () => {
    const { generate } = await import('./js/openai.js');
    try { await generate({ apiKey: 'k', baseUrl: 'https://other.test/v1', model: 'm', parts: [{ text: 'привет' }], retries: 0 }); return 'нет ошибки'; } catch (e) { return e.message; }
  });
  ok(/^Нет связи с API/.test(other), 'у своего ключа сообщение прежнее: ' + other.slice(0, 40));
};
