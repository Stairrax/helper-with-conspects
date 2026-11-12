// Regression: estimates use the generator's section boundaries, while a split
// followed by supplement preserves citation offsets and every chunk index.
import { estimateFreeRequests, sectionSpans } from '../js/analyze.js';

export default async ({ok, open}) => {
  const paragraphs = Array.from({length:45}, (_, i) =>
    'Тема ' + i + ': Гравитация определяет движение планет, спутников и звёзд. ' +
    'Наблюдения подтверждают этот факт в Солнечной системе.').join('\n\n');
  const direct = sectionSpans(paragraphs).length;
  const estimate = estimateFreeRequests([{kind:'text',text:paragraphs}]);
  ok(direct >= 2 && estimate.sections === direct &&
    estimate.min === estimate.plan + direct * 2,
    'the estimated source section count uses the same splitter as note generation');

  const {page} = await open();
  const result = await page.evaluate(async () => {
    const {generateTopicChunks, sectionSpans} = await import('./js/analyze.js');
    const paragraph = 'Наблюдения подтверждают движение планет и спутников в гравитационном поле. ' +
      'Измерения орбит позволяют рассчитать массу небесного тела. ';
    const original = paragraph.repeat(125);
    const initialSections = sectionSpans(original).length;
    let generated = 0, verified = 0, supplemented = 0, truncated = 0;
    let afterEarlierCheck = false;
    const realFetch = window.fetch;
    try {
      window.fetch = async (_url, init) => {
        const request = JSON.parse(init.body);
        const prompt = request.messages.at(-1).content;
        let answer;
        if (prompt.startsWith('Проверь полноту диктовки.')) {
          verified++;
          // An originally covered point references chunk 1 (not chunk 0).
          // After supplementation inserts a new chunk after chunk 0,
          // the old index must shift to 2, and the new point must refer to 1.
          answer = {checks:[{i:0,c:[1]}, {i:1,c:[]}],missing:[]};
        } else if (prompt.includes('В диктовке пропущены или переданы не полностью')) {
          supplemented++;
          answer = {chunks:[{t:'Вставлен пропущенный пункт ' + supplemented,
            k:'content', after:0, p:[0]}]};
        } else {
          const match = prompt.match(/ИСХОДНЫЙ ТЕКСТ:\n<<<\n([\s\S]*?)\n>>>/);
          if (!match) throw new Error('generation prompt has no original section');
          const text = match[1];
          if (generated > 0 && text.length > 1900) {
            truncated++;
            if (verified > 0) afterEarlierCheck = true;
            return Response.json({choices:[{message:{content:''},finish_reason:'length'}]});
          }
          generated++;
          answer = {
            chunks:[
              {t:'Первый исходный кусок ' + generated, k:'content'},
              {t:'Второй исходный кусок ' + generated, k:'content'},
            ],
            points:[
              {p:'Проверенный исходный пункт ' + generated,c:[1],
                source_quote:text.slice(0,65).trim()},
              {p:'Восполненный исходный пункт ' + generated,c:[0],
                source_quote:text.slice(-65).trim()},
            ],
            recap:'',quiz:[],formulas:[],
          };
        }
        return Response.json({choices:[{message:{content:JSON.stringify(answer)},finish_reason:'stop'}]});
      };
      const topic = {title:'Разделение с дополнением',text:original};
      await generateTopicChunks(topic, {
        provider:'custom',apiKey:'test',baseUrl:'https://api-test.invalid/v1',
        model:'test-model',formulasApart:false,coverageCheck:true,
      }, () => {});
      const originalPoints = topic.points.filter(p=>p.p.startsWith('Проверенный'));
      const supplementedPoints = topic.points.filter(p=>p.p.startsWith('Восполненный'));
      const originalIndices = originalPoints.map(p=>p.c[0]);
      const supplementIndices = supplementedPoints.map(p=>p.c[0]);
      const citationsValid = topic.points.every(p=>
        p.citation && original.slice(p.citation.start,p.citation.end)===p.citation.quote);
      const refsValid = topic.points.every(p=>p.c.length===1 &&
        Number.isInteger(p.c[0]) && p.c[0]>=0 && p.c[0]<topic.chunks.length);
      return {initialSections,generated,verified,supplemented,truncated,afterEarlierCheck,
        coverage:topic.coverage,chunkCount:topic.chunks.length,pointCount:topic.points.length,
        originalIndices,supplementIndices,citationsValid,refsValid,
        firstChunks:topic.chunks.slice(0,3).map(c=>c.t),
      };
    } finally {window.fetch=realFetch;}
  });

  ok(result.initialSections >= 2 && result.truncated > 0 && result.afterEarlierCheck &&
    result.generated > result.initialSections,
    'MAX_TOKENS splits later sections after an earlier successful verification: ' + JSON.stringify(result));
  ok(result.generated === result.verified && result.verified === result.supplemented &&
    result.chunkCount === result.generated * 3 && result.pointCount === result.generated * 2,
    'every split section is verified and its supplement is inserted: ' + JSON.stringify(result));
  ok(result.originalIndices.every((i,n)=>i===n*3+2) &&
    result.supplementIndices.every((i,n)=>i===n*3+1) &&
    result.firstChunks[0].startsWith('Первый') &&
    result.firstChunks[1].startsWith('Вставлен') &&
    result.firstChunks[2].startsWith('Второй') && result.refsValid,
    'insertChunks remaps old and new point references across all split sections: ' + JSON.stringify(result));
  ok(result.citationsValid && result.coverage.state==='supplemented' &&
    result.coverage.checked===false && result.coverage.covered===result.coverage.total,
    'all source citations remain exact; supplemented content is never marked independently rechecked');
};
