// Учёба: паузы под скорость письма, экзамен, подсветка слова, статистика, шпаргалка, аудиоконспект (iPhone).
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const pace = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('kd.settings')).writePace);

export default async ({ open, prepare, FINANCE, ok }) => {
  // ---- паузы под скорость письма
  {
    const { page } = await open({ settings: { pause: 3, adaptivePause: true, highlightWord: true } });
    await prepare(page, FINANCE, 'Финансы');
    await page.click('#startBtn');
    // подсветка: пока звучит отрывок, одно его слово выделено
    await page.evaluate(() => { window.__hold = 'Сложный процент начисляется'; });
    await page.waitForFunction(() => window.__spoken.some((t) => t.startsWith('Сложный процент начисляется')), null, { timeout: 10000 });
    await page.waitForTimeout(400);
    ok(await page.evaluate(() => document.querySelectorAll('#chunkText .w').length > 3 && document.querySelectorAll('#chunkText .w.hl').length === 1),
      'подсветка: читаемое слово выделено');
    // отрывок дозвучал — пауза на запись
    await page.evaluate(() => { window.__hold = ''; window.speechSynthesis.cancel(); });
    await page.waitForFunction(() => document.getElementById('dictState').textContent.includes('Записывайте'), null, { timeout: 10000 });
    await page.waitForTimeout(1000);
    await page.click('#nextBtn'); // «записал» через секунду при паузе в 3 с
    await page.waitForTimeout(200);
    const p1 = await pace(page);
    ok(p1 < 0.9, 'записали раньше конца паузы — паузы короче: ×' + p1);
    await page.click('#repeatBtn');
    await page.waitForTimeout(200);
    ok(await pace(page) > p1, 'попросили повторить — паузы снова длиннее');
    await page.click('[data-tab=settings]');
    ok(/Сейчас паузы короче обычных/.test(await page.textContent('#paceHint')), 'в настройках видно, что паузы подстроены, и есть «Сбросить»');
    await page.click('#paceReset');
    ok(await pace(page) === 1, '«Сбросить» — обычные паузы');

    // ---- статистика: время занятий сегодня
    const today = await page.evaluate(async () => (await import('./js/stats.js')).statsSummary().today);
    ok(today > 0, 'статистика: время занятий сегодня — ' + today + ' с');
    await page.click('[data-tab=plan]');
    ok(await page.evaluate(() => document.querySelectorAll('#statBars .bar').length === 14 && document.querySelector('#statBars .bar.today')),
      'статистика: график за две недели');
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'вкладка «План» не шире экрана');

    // ---- шпаргалка
    await page.click('#cheatBtn');
    const cheat = await page.evaluate(() => ({
      title: document.querySelector('#cheatBody h1')?.textContent,
      topics: document.querySelectorAll('#cheatBody section').length,
      term: [...document.querySelectorAll('#cheatBody dt')].map((x) => x.textContent),
      fx: document.querySelectorAll('#cheatBody .cs-fx li').length,
    }));
    ok(cheat.title === 'Финансы' && cheat.topics === 2, 'шпаргалка: предмет и все темы');
    ok(cheat.term.includes('Бюджет'), 'шпаргалка: термины из «… — это …»: ' + cheat.term.join(', '));
    ok(cheat.fx >= 3, 'шпаргалка: формулы');
    await page.evaluate(() => { window.print = () => { window.__printed = document.getElementById('printArea').innerHTML.length; }; });
    await page.click('#cheatPrint');
    ok(await page.evaluate(() => window.__printed > 100), '«Печать / PDF» — печатается шпаргалка');
    await page.click('#cheatSheet [data-close].btn');

    // ---- экзамен
    await page.click('#examBtn');
    ok(await page.isVisible('#examSheet .exam-body'), 'экзамен: окно с настройками');
    ok(/Всего вопросов в конспекте: 2/.test(await page.textContent('#examPoolHint')), 'экзамен: сколько всего вопросов');
    await page.evaluate(() => { const r = document.querySelector('input[name=examTime][value="10"]'); r.checked = true; r.dispatchEvent(new Event('change')); });
    await page.click('#examStart');
    await page.waitForFunction(() => window.__spoken.some((t) => t.startsWith('Экзамен по всему предмету: 2 вопроса, на 10 минут')), null, { timeout: 10000 });
    await page.waitForFunction(() => document.getElementById('dictState').textContent.includes('Ваш ответ'), null, { timeout: 10000 });
    ok(/^Экзамен · вопрос 1 из 2 · осталось 9:5\d$/.test(await page.textContent('#chunkKind')), 'экзамен: номер вопроса и обратный отсчёт — ' + await page.textContent('#chunkKind'));
    await page.evaluate(() => window.__say('проценты начисляются на накопленную сумму'));
    await page.waitForFunction(() => window.__spoken.some((t) => t.startsWith('Верно')), null, { timeout: 10000 });
    await page.waitForFunction(() => window.__spoken.some((t) => t.startsWith('Вопрос 2')) && document.getElementById('dictState').textContent.includes('Ваш ответ'), null, { timeout: 10000 });
    await page.evaluate(() => window.__say('не знаю'));
    await page.waitForFunction(() => window.__spoken.some((t) => t.startsWith('Результат экзамена')), null, { timeout: 10000 });
    const res = await page.evaluate(() => window.__spoken.find((t) => t.startsWith('Результат экзамена')));
    ok(/1 из 2, это 50 процентов\. Стоит повторить:/.test(res), 'экзамен: результат и слабые темы — ' + res);
    await page.click('[data-tab=plan]');
    ok(/Последний экзамен: 1 из 2 \(50%\)/.test(await page.textContent('#statMore')), 'статистика: последний экзамен');
    ok(!(await page.isVisible('#audioBtn')), 'аудиоконспект — не на Android');
  }

  // ---- голосом: «начни экзамен»
  {
    const { page, say } = await open({ settings: { voiceCommands: true, listenWhileSpeaking: true } });
    await prepare(page, FINANCE, 'Финансы');
    await page.click('#startBtn');
    await page.waitForTimeout(500);
    await say('начни экзамен', true, 1500);
    ok(await page.evaluate(() => window.__spoken.some((t) => t.startsWith('Экзамен по всему предмету'))), '«начни экзамен» — экзамен голосом');
  }

  // ---- аудиоконспект на iPhone
  {
    const { page } = await open({ userAgent: UA });
    await prepare(page, FINANCE, 'Финансы');
    await page.click('[data-tab=plan]');
    ok(await page.isVisible('#audioBtn'), 'аудиоконспект: кнопка на iPhone');
    await page.click('#audioBtn');
    const ui = await page.evaluate(() => ({
      what: [...document.querySelectorAll('#audioWhat option')].map((o) => o.textContent),
      voices: document.querySelectorAll('#audioVoice option').length,
    }));
    ok(ui.what[0] === 'Весь конспект' && ui.what.length === 3, 'аудиоконспект: весь конспект или одна тема');
    ok(ui.voices === 9, 'аудиоконспект: русские нейроголоса');
    await page.waitForFunction(() => /звука/.test(document.getElementById('audioInfo').textContent), null, { timeout: 5000 });
    ok(/^≈\d+ (с|мин)/.test(await page.textContent('#audioInfo')), 'аудиоконспект: сколько будет звука — ' + await page.textContent('#audioInfo'));
    // MP3 из озвученных отрывков (голос подменён синусом — настоящий нейроголос в автотестах не скачивается)
    const mp3 = await page.evaluate(async () => {
      const m = await import('./js/audiobook.js');
      const ac = new OfflineAudioContext(1, 48000, 48000);
      const said = [];
      const synth = async (text) => {
        said.push(text);
        const b = ac.createBuffer(1, 9600, 48000);
        const d = b.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.sin(i / 8) * 0.3;
        return b;
      };
      const topics = [{ status: 'ready', title: 'Бюджет', chunks: [{ t: 'Первый отрывок.', s: 'Первый отрывок словами.' }, { t: 'Второй.' }] }];
      const pieces = m.audioPieces(topics, { spoken: (c) => c.s || c.t, gap: () => 0.5 });
      const r = await m.renderMp3(pieces, { synth });
      const head = new Uint8Array(await r.blob.slice(0, 2).arrayBuffer());
      return { said, size: r.blob.size, type: r.blob.type, sync: head[0] === 0xff && (head[1] & 0xe0) === 0xe0, seconds: r.seconds };
    });
    ok(mp3.said.join('|') === 'Тема: Бюджет.|Первый отрывок словами.|Второй.', 'аудиоконспект: «Тема: …», затем отрывки — текстом для голоса');
    ok(mp3.type === 'audio/mpeg' && mp3.sync && mp3.size > 1000, `аудиоконспект: настоящий MP3 (${mp3.size} байт)`);
    ok(Math.abs(mp3.seconds - (0.2 * 3 + 0.8 + 0.5 + 2)) < 0.01, // три фразы по 0,2 с и паузы после них
      'аудиоконспект: длительность с паузами');
  }
};
