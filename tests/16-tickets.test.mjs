// Билеты к экзамену, пересказ темы, подготовка к дате экзамена, быстрые действия на значке.
const dayPlus = (n) => { const d = new Date(Date.now() + n * 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const state = (page) => page.textContent('#dictState');
const spoken = (page, start) => page.waitForFunction((s) => window.__spoken.some((t) => t.startsWith(s)), start, { timeout: 10000 });

export default async ({ open, prepare, FINANCE, ok, base }) => {
  const { page, say, ai } = await open({ settings: { selfCheck: false, voiceCommands: true, listenWhileSpeaking: true } });

  // ---- разбор списка и окончание длинного ответа
  const unit = await page.evaluate(async () => {
    const t = await import('./js/tickets.js');
    const c = await import('./js/commands.js');
    return {
      parsed: t.parseTickets('Вопросы к экзамену:\n1. Понятие бюджета\n2) Сложный процент и\nего формула\nБилет 3. Налоговый вычет\n\n— Реальная ставка'),
      end: [t.endOfAnswer('Бюджет — это план доходов. Всё'), t.endOfAnswer('у меня всё'), t.endOfAnswer('бюджет включает доходы, расходы и всё'), t.endOfAnswer('доходы и расходы, я закончил'), t.endOfAnswer('That’s all')],
      cmds: ['тяни билет', 'билет номер 2', 'третий билет', 'давай ещё билет', 'перескажу тему', 'дай перескажу вторую тему', 'перескажи тему', 'draw a ticket', 'let me retell the topic'].map((x) => c.matchAppCommand(x)),
    };
  });
  ok(JSON.stringify(unit.parsed) === JSON.stringify(['Понятие бюджета', 'Сложный процент и его формула', 'Налоговый вычет', 'Реальная ставка']),
    'билеты: номера, заголовок и переносы строк — ' + unit.parsed.join(' | '));
  ok(unit.end[0] === 'Бюджет — это план доходов.' && unit.end[1] === '' && unit.end[2] === null && unit.end[3] === 'доходы и расходы' && unit.end[4] === '',
    '«всё», «я закончил» — конец ответа; «…и всё» внутри фразы — нет ' + JSON.stringify(unit.end));
  const [c1, c2, c3, c4, c5, c6, c7, c8, c9] = unit.cmds;
  ok(c1?.cmd === 'ticket' && !c1.arg && c2?.arg?.n === 2 && c3?.arg?.n === 3 && c4?.cmd === 'ticket', 'голосом: «тяни билет», «билет номер 2», «третий билет»');
  ok(c5?.cmd === 'retell' && c6?.cmd === 'retell' && c6.arg?.n === 2 && c7?.cmd !== 'retell', '«перескажу тему» — пересказ, «перескажи тему» — нет ' + JSON.stringify([c5, c6, c7]));
  ok(c8?.cmd === 'ticket' && c9?.cmd === 'retell', 'по-английски: «draw a ticket», «let me retell the topic»');

  await prepare(page, FINANCE, 'Финансы');

  // ---- билеты: список -> ответы по конспекту
  await page.click('[data-tab=plan]');
  await page.click('#ticketBtn');
  ok(await page.isVisible('#ticketText'), 'билеты: сначала — поле для списка вопросов');
  await page.fill('#ticketText', 'Вопросы к экзамену:\n1. Понятие бюджета\n2) Сложный процент и\nего формула\nБилет 3. Налоговый вычет');
  await page.click('#ticketSave');
  await page.waitForFunction(() => /ответы готовы: 3 из 3/.test(document.getElementById('ticketSummary').textContent), null, { timeout: 10000 });
  ok(true, 'билеты: ответы на все три подготовлены');
  ok(await page.evaluate(() => document.querySelectorAll('#ticketList li').length === 3), 'билеты: три в списке');
  await page.click('#ticketList li:nth-child(1) [data-act=open]');
  ok(/Ответ: Понятие бюджета/.test(await page.textContent('#ticketList .tans')), 'билеты: готовый ответ виден в списке');

  // ---- ответить на билет 1
  await page.click('#ticketList [data-act=answer]');
  await spoken(page, 'Билет номер 1. Понятие бюджета');
  await page.waitForFunction(() => /Слушаю ответ/.test(document.getElementById('dictState').textContent), null, { timeout: 10000 });
  ok(/^Билет 1 из 3/.test(await page.textContent('#chunkKind')) && /Понятие бюджета/.test(await page.textContent('#chunkText')), 'билет на экране: номер и вопрос');
  ok(await page.isVisible('#longDone'), 'кнопка «Готово» для длинного ответа');
  await say('бюджет это план доходов и расходов государства', true, 400);
  await say('на определённый период', true, 400);
  ok(/план доходов.*период/.test(await page.textContent('#heard')), 'ответ копится, пока говорят: ' + await page.textContent('#heard'));
  ok(/Слушаю ответ/.test(await state(page)), 'пауза в речи — ответ не обрывается');
  await say('всё', true, 200);
  await spoken(page, 'Хорошо');
  await page.waitForFunction(() => /Ещё билет/.test(document.getElementById('dictState').textContent), null, { timeout: 10000 });
  const ans = (ai.prompts.find((p) => p.includes('Билет:') && p.includes('Ответ студента')) || '');
  ok(/Ответ студента: бюджет это план доходов и расходов государства на определённый период$/.test(ans.trim()), 'на проверку ушёл весь ответ, без «всё»');
  ok(/Образцовый ответ/.test(ans), 'проверка опирается на подготовленный ответ');
  const res = await page.evaluate(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).find((k) => k.startsWith('kd.progress')))).tickets);
  ok(Object.values(res || {})[0]?.grade === 4, 'оценка за билет сохранена: 4');
  ok(/Хорошо/.test(await page.textContent('#answer')), 'отзыв экзаменатора виден на экране');
  ok(/Ещё билет/.test(await page.textContent('#continueBtn')), 'кнопка «Ещё билет»');

  // ---- ещё билет: тянется тот, на который не отвечали
  await say('да', true, 300);
  await page.waitForFunction(() => /Слушаю ответ/.test(document.getElementById('dictState').textContent), null, { timeout: 10000 });
  ok(/^Билет [23] из 3/.test(await page.textContent('#chunkKind')), 'следующий билет — из тех, на которые ещё не отвечали');
  await page.click('#longDone');
  await spoken(page, 'Билет пропущен');
  await say('хватит', true, 300);
  ok(/Пауза/.test(await state(page)), '«хватит» — билеты закончили');

  // ---- пересказ темы
  await page.click('[data-tab=plan]');
  await page.click('#planList li:nth-child(1) .phead');
  await page.click('#planList [data-act=retell]');
  await spoken(page, 'Перескажите тему');
  await page.waitForFunction(() => /Слушаю ответ/.test(document.getElementById('dictState').textContent), null, { timeout: 10000 });
  ok(await page.textContent('#chunkKind') === 'Пересказ темы', 'пересказ: подпись на экране');
  const before = await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem(Object.keys(localStorage).find((k) => k.startsWith('kd.progress')))).stats || {}).reduce((n, s) => n + s.total, 0));
  await say('сложный процент начисляется на накопленную сумму, я закончил', true, 200);
  await spoken(page, 'Отлично');
  await page.waitForFunction(() => /Пауза/.test(document.getElementById('dictState').textContent), null, { timeout: 10000 });
  const rp = (ai.prompts.find((p) => p.includes('Пересказ студента')) || '');
  ok(/Ключевые пункты темы/.test(rp) && /Пересказ студента: сложный процент начисляется на накопленную сумму$/.test(rp.trim()), 'пересказ сверяется с пунктами темы');
  const after = await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem(Object.keys(localStorage).find((k) => k.startsWith('kd.progress')))).stats || {}).reduce((n, s) => n + s.total, 0));
  ok(after === before + 1, 'пересказ засчитан в статистику темы');
  ok(/Отлично/.test(await page.textContent('#answer')), 'отзыв на пересказ виден на экране');

  // ---- подготовка к дате экзамена
  await page.click('[data-tab=plan]');
  ok(/Укажите дату экзамена/.test(await page.textContent('#prepBody')), 'подготовка: без даты — подсказка');
  const setDate = (d) => page.evaluate((v) => { const e = document.getElementById('examDate'); e.value = v; e.dispatchEvent(new Event('change')); }, d);
  await setDate(dayPlus(3));
  const p3 = await page.textContent('#prepBody');
  ok(/До экзамена 3 дня/.test(p3) && /Новые темы: 0 из 1/.test(p3), 'за 3 дня до экзамена: по одной новой теме в день — ' + p3);
  ok(/Билеты: \d из \d/.test(p3), 'в плане на сегодня — и билеты');
  await setDate(dayPlus(1));
  const p1 = await page.textContent('#prepBody');
  ok(/Экзамен завтра/.test(p1) && /Новые темы: 0 из 2/.test(p1) && /Осталось непройденных тем: 2/.test(p1), 'накануне — все оставшиеся темы и предупреждение');
  await page.waitForTimeout(1700); // сроки для напоминаний сохраняются чуть позже
  ok(await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('kd.exams') || '{}'))[0]?.left === 2), 'для напоминаний сохранены дата и сколько тем осталось ' + await page.evaluate(() => localStorage.getItem('kd.exams')));
  await page.click('#prepStart');
  await page.waitForFunction(() => window.__spoken.some((t) => t.startsWith('Тема: ')), null, { timeout: 10000 });
  ok(await page.evaluate(() => document.body.dataset.tab) === 'dictate', '«Начать сегодняшнее» — диктовка первой темы из плана на сегодня');
  await page.click('#playBtn');

  // ---- быстрые действия на значке
  const manifest = await page.evaluate(async () => (await (await fetch('manifest.webmanifest')).json()).shortcuts.map((s) => s.url));
  ok(manifest.join() === './?go=dictate,./?go=today,./?go=ticket,./?go=exam', 'на значке: продолжить, на сегодня, билет, экзамен');
  await page.goto(base + '?go=ticket');
  await page.waitForFunction(() => window.__kdReady, null, { timeout: 10000 });
  ok(await page.isVisible('#ticketDraw'), '?go=ticket — открываются билеты');
  await page.goto(base + '?go=exam');
  await page.waitForFunction(() => window.__kdReady, null, { timeout: 10000 });
  ok(await page.isVisible('#examStart'), '?go=exam — открывается экзамен');

  // ---- «Пересказ после темы» в настройках: после темы — пересказ, потом «Есть вопросы?»
  {
    const { page, say } = await open({ settings: { selfCheck: false, retellAfter: true, pause: 1, mode: 'topic', voiceCommands: true, listenWhileSpeaking: true } });
    await prepare(page, FINANCE, 'Финансы');
    await page.click('#startBtn');
    await spoken(page, 'Перескажите тему');
    await page.waitForFunction(() => /Слушаю ответ/.test(document.getElementById('dictState').textContent), null, { timeout: 10000 });
    await say('проценты начисляются на проценты. Всё', true, 200);
    await spoken(page, 'Отлично');
    await page.waitForFunction(() => window.__spoken.some((t) => /Есть вопросы\?$/.test(t)), null, { timeout: 10000 });
    ok(true, 'пересказ после темы — по настройке, затем «Есть вопросы?»');
  }
};
