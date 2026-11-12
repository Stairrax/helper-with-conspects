// Regression: free-tier workload estimation, staggered reviews, output budgets and honest coverage.
import { reviewResult, reviewDayKey } from '../js/review-schedule.js';

export default async ({ ok, open, prepare, FINANCE }) => {
  const now = new Date(2026, 10, 12, 12).getTime();
  const early = reviewResult({}, 1, 'sure', now, () => 0);
  const late = reviewResult({}, 1, 'sure', now, () => 0.99);
  const guessed = reviewResult({}, 1, 'guessed', now, () => 0.99);
  ok(early.interval === 2 && late.interval > early.interval && late.interval < 3 &&
    guessed.due < early.due, 'new review intervals are staggered, with guesses shorter than confident results');
  const next = reviewResult(early, 1, 'sure', now, () => 0);
  ok(next.reps === 2 && next.interval > early.interval && next.due_at === next.due,
    'later reviews follow ease progression and keep durable due_at');
  ok(reviewResult(next, 0, 'unsure', now).reps === 0,
    'a lapse resets the first-success step without losing lifetime history');
  ok(reviewDayKey(new Date(2026, 10, 12, 2).getTime()) === reviewDayKey(new Date(2026, 10, 12, 22).getTime()) &&
    reviewDayKey(now) !== reviewDayKey(now + 86400000),
    'daily review budget follows the local calendar day');

  const { page } = await open();
  const result = await page.evaluate(async () => {
    const { estimateFreeRequests, generateTopicChunks } = await import('./js/analyze.js');
    const { generate } = await import('./js/gemini.js');
    const short = estimateFreeRequests([{kind:'text',text:'Планеты Солнечной системы. '.repeat(150)}]);
    const long = estimateFreeRequests([{kind:'text',text:'Планеты Солнечной системы. '.repeat(6500)}]);
    const noCheck = estimateFreeRequests([{kind:'text',text:'Планеты Солнечной системы. '.repeat(6500)}], false);
    const photos = estimateFreeRequests([{kind:'images',images:[{mime:'image/jpeg'}, {mime:'image/jpeg'}]}]);

    const originalFetch = window.fetch;
    let maxDefault = -1, maxExplicit = -1, calls = 0, coverage = null;
    try {
      window.fetch = async (_, init) => {
        const b = JSON.parse(init.body);
        if (maxDefault < 0) maxDefault = b.generationConfig?.maxOutputTokens;
        else maxExplicit = b.generationConfig?.maxOutputTokens;
        return Response.json({ candidates:[{content:{parts:[{text:'ok'}]},finishReason:'STOP'}] });
      };
      const opts = { apiKey:'test',model:'gemini-test',parts:[{text:'hello'}],retries:0,timeoutMs:4000 };
      await generate(opts);
      await generate({...opts,maxOutputTokens:12345});

      calls = 0;
      const answers = [
        {chunks:[{t:'Факт первый.',k:'content'}],points:[{p:'Первый факт',c:[0]}],recap:'',quiz:[],formulas:[]},
        {checks:[{i:0,c:[0]}],missing:['Второй факт']},
        {chunks:[{t:'Факт второй.',after:0,p:[0]}]},
      ];
      window.fetch = async () => {
        const answer = answers[calls++];
        return Response.json({choices:[{message:{content:JSON.stringify(answer)},finish_reason:'stop'}]});
      };
      const t = { title:'Тест',text:'Первый факт. Второй факт.' };
      const settings = {provider:'custom',apiKey:'test',baseUrl:'https://test.invalid/v1',
        model:'test-model',formulasApart:false,coverageCheck:true};
      await generateTopicChunks(t,settings,()=>{});
      coverage = t.coverage;
    } finally { window.fetch = originalFetch; }
    return {short,long,noCheck,photos,maxDefault,maxExplicit,calls,coverage,
      warning:document.querySelector('#storageWarning')?.textContent || ''};
  });
  ok(result.long.min > result.short.min && result.long.likelyHigh > result.long.min &&
    result.long.plan > result.short.plan && result.noCheck.min < result.long.min,
    'large notes estimate all preparation and verification calls, not only the plan');
  ok(result.photos.unknownPhotos === 2, 'photo OCR warns that preparation cost cannot yet be estimated');
  ok(result.maxDefault === 8192 && result.maxExplicit === 12345,
    'Gemini output is capped by default but respects explicit positive bounds');
  ok(result.calls === 3 && result.coverage.state === 'supplemented' &&
    !result.coverage.checked && result.coverage.covered === result.coverage.total,
    'supplemented coverage has its own state but never claims independent verification');
  ok(result.warning.includes('последние данные могут пропасть') &&
    result.warning.includes('Резервная копия может не содержать'),
    'storage warning explains irreversible risk to unsaved photo projects');

  // Exercise the actual review button with a backlog larger than the daily plan.
  await prepare(page, FINANCE, 'Повторения');
  await page.evaluate(async () => {
    const storage = await import('./js/storage.js');
    const subject = storage.loadSubjects().current;
    const p = await storage.idbGet('project:' + subject);
    const template = p.topics[0];
    p.topics = Array.from({length:22},(_,i)=>({...template,id:'due-topic-'+i,
      title:'Тема '+(i+1),status:'ready',origIndex:i}));
    p.plan.order = p.topics.map(t=>t.id);
    p.plan.skipped = {};
    await storage.idbSet('project:' + subject,p);
    const progress = storage.loadProgress(subject);
    progress.stats = Object.fromEntries(p.topics.map(t=>[t.id,
      {total:3,right:2,asked:0,studiedAt:Date.now()-86400000,due:Date.now()-1000,weak:false}]));
    storage.saveProgress(progress,subject);
  });
  await page.reload();
  await page.waitForTimeout(400);
  const initial = await page.locator('#reviewDueBtn').textContent();
  ok(initial.includes('15 из 22'), 'one tap offers at most 15 of 22 due topics, without hiding backlog');

  await page.evaluate(async () => {
    const storage = await import('./js/storage.js');
    const { reviewDayKey } = await import('./js/review-schedule.js');
    const subject = storage.loadSubjects().current;
    const p = storage.loadProgress(subject);
    p.reviewDaily = {day:reviewDayKey(),ids:Array.from({length:15},(_,i)=>'due-topic-'+i)};
    storage.saveProgress(p,subject);
  });
  await page.reload();
  await page.waitForTimeout(400);
  const exhausted = await page.locator('#reviewDueBtn').textContent();
  const disabled = await page.locator('#reviewDueBtn').isDisabled();
  const summary = await page.locator('#reviewSummary').textContent();
  ok(disabled && exhausted.includes('Сегодня достаточно') && summary.includes('7'),
    'daily review budget persists, leaving the remaining 7 topics visible for tomorrow');
};
