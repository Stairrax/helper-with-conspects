// Preflight cost calculation is advisory, but note generation must fail safely
// when the model repeatedly produces truncated responses.
import {
  tryEstimateFreeRequests, estimateFreeRequests, estimateTopicPreparation, sectionSpans,
} from '../js/analyze.js';

export default async ({ok, open, prepare, FINANCE}) => {
  const bad = tryEstimateFreeRequests([{kind:'text',text:'Valid text.'}], true,
    () => { throw new Error('Source span mapping failed'); });
  ok(bad === null, 'a throwing preflight estimator degrades to an unknown estimate, not an unhandled error');
  const valid = tryEstimateFreeRequests([{kind:'text',text:'Valid text.'}], true);
  ok(valid?.sections === 1, 'normal cost estimation still works');

  const topics = Array.from({length:16}, (_,i)=>({
    id:'t'+i, text:'Тема '+i+': '+('Гравитация меняет орбиты. '.repeat(11)),status:'pending',
  }));
  const input = topics.map(t=>t.text).join(' ');
  const preliminary = estimateFreeRequests([{kind:'text',text:input}], true);
  const project = {topics,plan:{skipped:{}}};
  const revised = estimateTopicPreparation(project, true);
  ok(preliminary.sections < revised.sections && revised.sections === topics.length &&
    revised.min === revised.sections * 2 && revised.likelyHigh >= revised.min,
    'post-plan estimate corrects systematic undercount from unknown AI topic boundaries');
  project.plan.skipped[topics[0].id] = true;
  ok(estimateTopicPreparation(project,true).sections===topics.length-1,
    'post-plan estimate excludes skipped topics');

  const {page} = await open();
  const failures = await page.evaluate(async () => {
    const {generateTopicChunks, sectionSpans} = await import('./js/analyze.js');
    const oldFetch = window.fetch;
    const settings = {
      provider:'custom',apiKey:'test',baseUrl:'https://mock.test/v1',
      model:'test-model',formulasApart:false,coverageCheck:false,
    };
    const results = {};
    try {
      const short = {title:'Short',text:'Очень короткая секция длиной меньше двухсот символов.'};
      let shortCalls=0;
      window.fetch = async () => {
        shortCalls++;
        return Response.json({choices:[{message:{content:''},finish_reason:'length'}]});
      };
      try {await generateTopicChunks(short,settings,()=>{}); results.shortCode='none';}
      catch(e){results.shortCode=e.code;}
      results.shortCalls=shortCalls;
      results.shortHasChunks=Array.isArray(short.chunks);

      const longText=('Наблюдения описывают гравитацию и движение небесных тел. '+
        'Измерения подтверждают параметры орбит планет и спутников. ').repeat(1100);
      const long = {title:'Repeated truncation',text:longText};
      results.originalSections=sectionSpans(longText).length;
      let truncated=0, generated=0;
      window.fetch = async (_url, init) => {
        const req=JSON.parse(init.body);
        const prompt=req.messages.at(-1).content;
        const m=prompt.match(/ИСХОДНЫЙ ТЕКСТ:\n<<<\n([\s\S]*?)\n>>>/);
        if (!m) throw new Error('Missing source section in mock request');
        if (m[1].length > 3200) {
          truncated++;
          return Response.json({choices:[{message:{content:''},finish_reason:'length'}]});
        }
        generated++;
        return Response.json({choices:[{message:{content:JSON.stringify({
          chunks:[{t:'Секция обработана.',k:'content'}],
          points:[{p:'Проверенный факт',c:[0]}],
          recap:'',quiz:[],formulas:[],
        })},finish_reason:'stop'}]});
      };
      try {await generateTopicChunks(long,settings,()=>{});results.longCode='none';}
      catch(e){results.longCode=e.code;}
      results.truncated=truncated;
      results.generated=generated;
      results.longHasChunks=Array.isArray(long.chunks);
    } finally {window.fetch=oldFetch;}
    return results;
  });
  ok(failures.shortCode==='MAX_TOKENS' && failures.shortCalls===1 &&
    !failures.shortHasChunks,
    'a truncated section under 200 characters stops after one attempt and leaves no false prepared result');
  ok(failures.originalSections > 16 && failures.longCode==='MAX_TOKENS' &&
    failures.truncated===17 && failures.generated>=16 && !failures.longHasChunks,
    'the seventeenth MAX_TOKENS split stops explicitly, even after earlier sections succeeded: ' +
    JSON.stringify(failures));

  const free = await open({
    settings:{provider:'free',apiKey:'',coverageCheck:false},
    freeProxy:'https://free-proxy.test',
  });
  await prepare(free.page,FINANCE,'Plan forecast');
  const view = await free.page.evaluate(async () => {
    const storage=await import('./js/storage.js');
    const {estimateTopicPreparation}=await import('./js/analyze.js');
    const sub=storage.loadSubjects().current;
    const p=await storage.idbGet('project:'+sub);
    const own=estimateTopicPreparation(p,false);
    const message=document.querySelector('[data-cost-forecast]')?.textContent||'';
    return {stored:p.prepRequestEstimate,own,message,topics:p.topics.length};
  });
  ok(view.topics>0 && view.stored?.sections===view.own.sections &&
    view.stored?.min===view.own.min && view.message.includes('После разделения на темы'),
    'post-plan recalculation persists with the project and is visible on the plan screen: ' +
    JSON.stringify(view));

  const en=await free.page.evaluate(async () => {
    const {translate}=await import('./js/i18n.js');
    return {
      cost:translate('После разделения на темы: подготовка всех тем потребует ориентировочно 20–40 запросов (без уже потраченных на план и OCR). Темы готовятся постепенно; дневной лимит общий.'),
      failed:translate('Не удалось оценить расход бесплатных запросов. Подготовка может потребовать много запросов, лимит может закончиться. Продолжить составление плана?'),
    };
  });
  ok(en.cost.includes('20–40 requests') && en.failed.startsWith('Could not estimate'),
    'new cost messages are translated for English users');
};
