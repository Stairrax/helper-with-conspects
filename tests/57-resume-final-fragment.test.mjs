export default async ({ open, prepare, FINANCE, ok }) => {
  const { page } = await open({ settings: { selfCheck: false, retellAfter: false, mode: 'one', formulasApart: false } });
  await prepare(page, FINANCE);
  await page.waitForFunction(async () => {
    const { loadSubjects, idbGet } = await import('./js/storage.js');
    const project = await idbGet('project:' + loadSubjects().current);
    return project?.topics?.length > 0 && project.topics.every(t => t.status === 'ready' && t.chunks?.length);
  });
  const seed = await page.evaluate(async () => {
    const { loadSubjects, idbGet } = await import('./js/storage.js');
    const { activeSeq } = await import('./js/analyze.js');
    const subject = loadSubjects().current;
    const project = await idbGet('project:' + subject);
    const topic = activeSeq(project)[0];
    return { key: 'kd.progress:' + subject, projectId: project.id, topicId: topic.id, n: topic.chunks.length };
  });
  ok(seed.n > 1, 'fixture has multiple fragments');
  await page.addInitScript(({ key, projectId, topicId }) => {
    const raw = sessionStorage.getItem('resume-test-position');
    if (raw === null) return;
    sessionStorage.removeItem('resume-test-position');
    localStorage.setItem(key, JSON.stringify({
      projectId, topicId, chunk: Number(raw), done: {}, stats: {},
      elapsedMs: 0, spoken: 1, qa: [],
    }));
  }, seed);
  const restore = async (at) => {
    await page.evaluate(at => sessionStorage.setItem('resume-test-position', String(at)), at);
    await page.reload();
    await page.waitForFunction(() => window.__kdReady);
    await page.click('[data-tab=load]');
    return page.locator('#resumeText').textContent();
  };
  const normal = await restore(seed.n - 1);
  ok(normal.includes('кусок ' + seed.n + ' из ' + seed.n), 'last unread fragment has its actual number');
  const end = await restore(seed.n);
  ok(end.includes('все фрагменты прочитаны') && end.includes('пройдено тем 0 из 2'),
    'end position displays all fragments read, without prematurely marking the topic complete');
  const overflow = await restore(seed.n + 1);
  ok(overflow.includes('все фрагменты прочитаны') && !overflow.includes('кусок '),
    'an out-of-range saved position never shows an impossible fragment number');
  await restore(seed.n);
  await page.click('#resumeCard');
  await page.waitForFunction(({ key, topicId }) => JSON.parse(localStorage.getItem(key) || '{}').done?.[topicId], seed);
  ok(true, 'resume at the end still completes the topic through the dictation engine');
  const translated = await page.evaluate(async () => {
    const { translate } = await import('./js/i18n.js');
    return translate('«Экономика», все фрагменты прочитаны · пройдено тем 0 из 2');
  });
  ok(translated === '“Экономика”, all pieces read · topics done 0 of 2', 'end label is translated without changing the topic title');
};
