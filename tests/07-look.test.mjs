// Оформление: «Неон», «как в системе» («Чернила» / «Аврора»), круглый «СТОП»; шрифты — только по необходимости; «капля».
export default async ({ open, prepare, FINANCE, ok }) => {
  const { page } = await open({ settings: { theme: 'classic', themePicked: true } });
  const fonts = [];
  page.on('request', (r) => { if (r.url().includes('/fonts/')) fonts.push(r.url()); });
  await page.reload(); await page.waitForTimeout(400);
  ok(fonts.length === 0, 'в «Классике» шрифты не скачиваются');
  const theme = (v) => page.evaluate((v) => { const r = document.querySelector(`input[name=theme][value=${v}]`); r.checked = true; r.dispatchEvent(new Event('change')); }, v);
  await theme('neon');
  await page.evaluate(() => document.fonts.ready);
  ok(await page.evaluate(() => document.documentElement.dataset.theme === 'neon' && document.querySelector('meta[name=theme-color]').content === '#000000'), '«Неон»');
  ok(fonts.some((u) => u.includes('unbounded')), 'шрифты «Неона» скачались');
  await page.emulateMedia({ colorScheme: 'light' });
  await theme('auto');
  await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(200);
  ok(await page.evaluate(() => document.documentElement.dataset.theme) === 'ink' && fonts.some((u) => u.includes('literata')), '«как в системе» при светлой системе — «Чернила»');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(100);
  ok(await page.evaluate(() => document.documentElement.dataset.theme === 'aurora' && document.querySelector('meta[name=theme-color]').content === '#070818'), '…переключилась система — «Аврора»');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.addInitScript(() => document.addEventListener('readystatechange', () => { if (document.readyState === 'interactive') window.__early = document.documentElement.dataset.theme || ''; }));
  await page.reload(); await page.waitForTimeout(300);
  ok(await page.evaluate(() => window.__early) === 'ink', 'тема ставится до загрузки приложения — экран не мигает');

  await prepare(page, FINANCE, 'Финансы');
  await page.waitForTimeout(1100); // волны от прошлых нажатий успели исчезнуть
  const b = await page.locator('#startBtn').boundingBox();
  await page.mouse.move(b.x + 40, b.y + b.height / 2); await page.mouse.down();
  ok(await page.evaluate(() => document.querySelectorAll('.ripple-ring').length === 2 && document.querySelectorAll('.ripple').length === 1), '«капля» на главной кнопке: волна и два круга');
  await page.mouse.move(b.x + 40, b.y - 300); await page.mouse.up();
  await page.waitForTimeout(1100);
  ok(await page.evaluate(() => document.querySelectorAll('.ripple, .ripple-ring, .ripple-dot').length === 0), 'после анимации ничего не остаётся');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.mouse.move(b.x + 40, b.y + b.height / 2); await page.mouse.down();
  ok(await page.evaluate(() => document.querySelectorAll('.ripple').length === 0), '«убрать анимацию» в системе — капли нет');
  await page.mouse.move(b.x + 40, b.y - 300); await page.mouse.up();
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  // пальцем: касание — волна по карточке темы; прокрутка — никакой волны
  await page.click('[data-tab=plan]');
  await page.waitForTimeout(1100);
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  await page.evaluate(() => { document.querySelectorAll('#planList li')[1].scrollIntoView({ block: 'center' }); });
  await page.waitForTimeout(100);
  const li = await page.locator('#planList li').nth(1).locator('.phead').boundingBox();
  const x = li.x + 120, y = li.y + li.height / 2;
  await touch('touchStart', x, y); await touch('touchEnd'); await page.waitForTimeout(30);
  ok(await page.evaluate(() => { const r = document.querySelector('.ripple')?.style.borderRadius; return !!r && r === getComputedStyle(document.querySelectorAll('#planList li')[1]).borderRadius; }), 'касание — волна в форме карточки темы');
  await page.waitForTimeout(1100);
  await page.click('[data-tab=load]'); await page.click('[data-tab=plan]'); await page.waitForTimeout(1100);
  const li2 = await page.locator('#planList li').nth(0).locator('.phead').boundingBox();
  await touch('touchStart', li2.x + 120, li2.y + 20);
  for (let i = 1; i <= 6; i++) { await touch('touchMove', li2.x + 120, li2.y + 20 - i * 12); }
  await touch('touchEnd');
  await page.waitForTimeout(200);
  ok(await page.evaluate(() => document.querySelectorAll('.ripple').length === 0), 'прокрутка пальцем — волны нет');
};
