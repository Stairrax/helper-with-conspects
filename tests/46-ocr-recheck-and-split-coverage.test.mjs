// Re-OCR budget clarity and completeness checks across MAX_TOKENS splits.
import { estimateFreeRequests, sectionSpans } from '../js/analyze.js';

export default async ({ ok, open }) => {
  const images = [{mime:'image/jpeg'}, {mime:'image/jpeg'}, {mime:'image/jpeg'}];
  const fresh = estimateFreeRequests([{kind:'images',images}]);
  const rerun = estimateFreeRequests([{kind:'images',images,ocrRevision:1}]);
  const recognised = estimateFreeRequests([{kind:'images',images,
    text:'Распознанный текст из фотографий. '.repeat(240),ocrRevision:1}]);
  ok(fresh.unknownPhotos === 3 && fresh.reocrPhotos === 0,
    'new photographs have an unknown preparation cost, not a re-OCR label');
  ok(rerun.unknownPhotos === 3 && rerun.reocrPhotos === 3 &&
    rerun.plan === fresh.plan,
    'an OCR revision counts three re-recognitions already included in plan calls');
  ok(recognised.unknownPhotos === 0 && recognised.reocrPhotos === 0 &&
    recognised.sections > 0,
    'photos with reusable OCR text are estimated by their recognised sections');

  const { page } = await open();
  const outcome = await page.evaluate(async () => {
    const { generateTopicChunks, sectionSpans } = await import('./js/analyze.js');
    const input = ('Тяготение удерживает планеты на орбитах и определяет движение спутников. ' +
      'Это подтверждают наблюдения различных небесных тел. ').repeat(130);
    const before = sectionSpans(input).length;
    const oldFetch = window.fetch;
    let generated = 0, checked = 0, split = 0, splitAfterCheck = false;
    try {
      window.fetch = async (_url, init) => {
        const req = JSON.parse(init.body);
        const prompt = req.messages.at(-1).content;
        let answer;
        if (prompt.startsWith('Проверь полноту диктовки.')) {
          checked++;
          answer = {checks:[{i:0,c:[0]}],missing:[]};
        } else if (prompt.includes('В диктовке пропущены')) {
          throw new Error('unexpected supplement: verified sections must be complete');
        } else {
          const m = prompt.match(/ИСХОДНЫЙ ТЕКСТ:\n<<<\n([\s\S]*?)\n>>>/);
          if (!m) throw new Error('missing source text in generation prompt');
          const section = m[1];
          // The first large section succeeds and gets checked. Only later
          // sections force MAX_TOKENS and splice the remaining sections.
          if (generated > 0 && section.length > 1900) {
            split++;
            if (checked > 0) splitAfterCheck = true;
            return Response.json({choices:[{message:{content:''},finish_reason:'length'}]});
          }
          generated++;
          answer = {chunks:[{t:'Гравитация влияет на орбиты.',k:'content'}],
            points:[{p:'Гравитация влияет на орбиты',c:[0]}],recap:'',quiz:[],formulas:[]};
        }
        return Response.json({choices:[{message:{content:JSON.stringify(answer)},finish_reason:'stop'}]});
      };
      const topic = {title:'Проверка после сплита',text:input};
      const settings = {provider:'custom',apiKey:'test',baseUrl:'https://test.invalid/v1',
        model:'test-model',formulasApart:false,coverageCheck:true};
      await generateTopicChunks(topic,settings,()=>{});
      return {before,generated,checked,split,splitAfterCheck,coverage:topic.coverage};
    } finally { window.fetch = oldFetch; }
  });
  ok(outcome.before >= 2 && outcome.split > 0 && outcome.splitAfterCheck,
    'a MAX_TOKENS split occurs after an earlier section was successfully checked: ' +
    JSON.stringify(outcome));
  ok(outcome.checked === outcome.generated && outcome.coverage.checked === true &&
    outcome.coverage.state === 'passed' && outcome.coverage.covered === outcome.coverage.total,
    'mutating sections with splice does not produce a false unchecked/partial status: ' +
    JSON.stringify(outcome));

  const labels = await page.evaluate(async () => {
    const { translate } = await import('./js/i18n.js');
    return [
      translate('3 фото будут распознаны заново'),
      translate('Пропуски дополнены, повторная проверка не проводилась'),
    ];
  });
  ok(labels[0].includes('3 photos') && labels[1].includes('supplemented'),
    'OCR re-recognition and supplemented status labels have English translations');
};
