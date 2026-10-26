// Готовый конспект: файл без личного, открытие у другого человека без ключа и без запросов.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export default async ({ open, prepare, FINANCE, ok }) => {
  const { page, say } = await open({ settings: { apiKey: 'MY-SECRET-KEY', voiceCommands: true, listenWhileSpeaking: true } });
  await prepare(page, FINANCE, 'Финансы');
  await page.click('#startBtn');
  await page.waitForFunction(() => window.__spoken.length >= 1, null, { timeout: 10000 });
  await say('стоп');
  await page.fill('#questionInput', 'МОЙ-ЛИЧНЫЙ-ВОПРОС почему так');
  await page.click('#askBtn');
  await page.waitForTimeout(1200);
  await page.click('[data-tab=plan]');
  const shared = await page.evaluate(async () => {
    let out = null; navigator.canShare = () => true;
    navigator.share = async ({ files }) => { out = { name: files[0].name, text: await files[0].text() }; };
    document.getElementById('shareBtn').click();
    await new Promise((r) => setTimeout(r, 400));
    return out;
  });
  ok(shared?.name === 'Финансы.konspekt.json', 'файл ' + shared?.name);
  ok(!shared.text.includes('MY-SECRET-KEY') && !shared.text.includes('МОЙ-ЛИЧНЫЙ-ВОПРОС'), 'в файле нет ключа и личных вопросов');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kd-')), 'shared.konspekt.json'); // латиница: так надёжнее для выбора файла
  fs.writeFileSync(file, shared.text);

  const other = await open({ settings: null });
  const before = other.ai.prompts.length;
  const [chooser] = await Promise.all([other.page.waitForEvent('filechooser'), other.page.click('#obImport')]);
  await chooser.setFiles(file);
  await other.page.waitForFunction(() => document.querySelectorAll('#planList .pstate.ok').length === 2, null, { timeout: 10000 });
  ok((await other.page.textContent('#subjectName')) === 'Финансы', 'у получателя — новый предмет «Финансы»');
  ok((await other.page.$$('#planList .badge.fx')).length === 1, 'формулы на месте');
  await other.page.click('#startBtn');
  await other.page.waitForFunction(() => window.__spoken.length >= 2, null, { timeout: 10000 });
  ok(other.ai.prompts.length === before, 'диктовка без ключа и без единого запроса к нейросети');
};
