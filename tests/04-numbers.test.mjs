// Числа: на экране цифрами, голосу — словами в нужном падеже.
export default async ({ open, prepare, FINANCE, ok }) => {
  const { page, ai } = await open();
  await prepare(page, FINANCE, 'Финансы');
  ok(ai.prompts.some((p) => p.includes('"s":"…"')), 'нейросеть просят дать вариант для голоса');
  await page.evaluate(() => { window.__hold = 'вычет'; });
  await page.click('#planList li:nth-child(2) .phead');
  await page.click('#planList [data-act=from]');
  await page.waitForFunction(() => window.__spoken.some((t) => t.includes('вычет')), null, { timeout: 10000 });
  await page.waitForTimeout(200);
  const shown = await page.textContent('#chunkText');
  const said = await page.evaluate(() => window.__spoken.find((t) => t.includes('вычет')));
  ok(shown.includes('150 000'), 'на экране: ' + shown);
  ok(said.includes('ста пятидесяти тысяч') && !/\d/.test(said), 'голос: ' + said);
};
