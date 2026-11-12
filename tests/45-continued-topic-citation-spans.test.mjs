// Citations must point into the actual saved topic, even across continued
// segmentation passes, irregular whitespace and MAX_TOKENS section splits.
import { sectionSpans, toBlocks, generateTopicChunks } from '../js/analyze.js';

export default async ({ ok, open }) => {
  // A quote and following punctuation inside a long (>1200-char) paragraph
  // must not discard the rest of the material while splitting into blocks.
  const longText = 'Важный вывод: он сказал «система устойчива.»' +
    'Дальше объясняется взаимодействие планет и спутников. '.repeat(27) +
    '«...»!?…» Доказательство продолжается. ' +
    'Это заключительный вывод без завершающего знака';
  const hostile = 'Вводная часть!?…»...' +
    '«..»…!? Сложная последовательность знаков, цитат и кавычек. '.repeat(32) +
    'Итоговая мысль без точки';
  const noPunctuation = 'Длинная непрерывная формулировка '.repeat(55);
  for (const [name, original] of [
    ['quoted long paragraph', longText],
    ['punctuation cluster', hostile],
    ['long sentence without punctuation', noPunctuation],
  ]) {
    const compact = (s) => s.replace(/\\s/g, '');
    const blocks = toBlocks(original);
    ok(original.length > 1200 && compact(blocks.join('')) === compact(original),
      name + ': plan segmentation preserves every non-whitespace character');
    for (const max of [90, 5000]) {
      const spans = sectionSpans(original, max);
      const exact = spans.every((part) => original.slice(part.start, part.start + part.text.length) === part.text);
      const covered = compact(spans.map((part) => part.text).join('')) === compact(original);
      ok(exact && covered, name + ': section spans are exact and cover the entire paragraph (max ' + max + ')');
    }
  }
  const unusual = '  Введение\r\n  Гравитация сохраняет орбиты.\r\n\r\nГлава 2\r\nПланеты\u00a0вращаются вокруг звезды.\n\n' +
    'Планеты\u00a0вращаются вокруг звезды. '.repeat(48);
  for (const size of [90, 5000]) {
    const sections = sectionSpans(unusual, size);
    ok(sections.length > 0 && sections.every((s) =>
      unusual.slice(s.start, s.start + s.text.length) === s.text),
      'sections map exactly to original text with CRLF, NBSP and repeated phrases (size ' + size + ')');
  }

  // Emulate r.continues: one topic consists of blocks from two plan passes.
  const sentence = 'Открытая орбита меняется под действием тяготения и движения окружающих тел. ';
  const blocks = Array.from({length:22}, (_, i) =>
    'Достоверный пункт номер ' + String(i).padStart(3,'0') +
    ' описывает движение спутников под действием гравитации. ' + sentence.repeat(6));
  const partA = blocks.slice(0,7).join('\n\n');
  const partB = blocks.slice(7).join('\n\n');
  const text = partA + '\n\n' + partB;
  const boundary = partA.length + 2;
  const originalSections = sectionSpans(text);
  ok(originalSections.length > 1 && originalSections.some((s) =>
    s.start < boundary && s.start + s.text.length > boundary),
    'a generated section can cross the join of two separate plan passes');

  const { page } = await open();
  const outcome = await page.evaluate(async ({ text, boundary }) => {
    const { sectionSpans, generateTopicChunks } = await import('./js/analyze.js');
    const settings = {provider:'custom',apiKey:'key',baseUrl:'https://mock-study.test/v1',
      model:'model',coverageCheck:false,formulasApart:false};
    const origFetch = window.fetch;
    const trial = async (split) => {
      let calls = 0, rejected = 0;
      try {
        window.fetch = async (_, init) => {
          calls++;
          const body = JSON.parse(init.body);
          const prompt = body.messages.at(-1).content;
          const section = prompt.match(/ИСХОДНЫЙ ТЕКСТ:\n<<<\n([\s\S]*?)\n>>>/)[1];
          if (split && section.length > 2300) {
            rejected++;
            return Response.json({choices:[{message:{content:''},finish_reason:'length'}]});
          }
          const quote = section.slice(0,100).trim();
          const points = [{p:'Пункт из исходного текста',c:[0],source_quote:quote}];
          const joinedQuote = text.slice(boundary - 38,boundary + 50);
          if (section.includes(joinedQuote)) points.push({
            p:'Цитата через стык частей плана',c:[0],source_quote:joinedQuote,
          });
          const answer = {points,
            chunks:[{t:'Орбиты зависят от гравитации.',k:'content'}],
            recap:'',quiz:[],formulas:[]};
          return Response.json({choices:[{message:{content:JSON.stringify(answer)},finish_reason:'stop'}]});
        };
        const topic = {title:'Объединённая тема',text,difficulty:2};
        await generateTopicChunks(topic,settings,()=>{});
        const citations = topic.points.map((p) => p.citation);
        return {calls,rejected,total:citations.length,
          matched:citations.filter((c) => c &&
            text.slice(c.start,c.end) === c.quote).length,
          afterJoin:citations.some((c) => c && c.start >= boundary),
          crossed:citations.some((c) => c && c.start < boundary && c.end > boundary),
          starts:citations.map(c=>c?.start)};
      } finally { window.fetch = origFetch; }
    };
    return {ordinary:await trial(false),split:await trial(true),
      spans:sectionSpans(text).length};
  }, {text,boundary});

  ok(outcome.ordinary.total >= 2 && outcome.ordinary.matched === outcome.ordinary.total &&
    outcome.ordinary.afterJoin && outcome.ordinary.crossed,
    'ordinary sections retain verified citations before and after a continued-topic boundary: ' +
      JSON.stringify(outcome.ordinary));
  ok(outcome.split.rejected > 0 && outcome.split.total > outcome.ordinary.total &&
    outcome.split.matched === outcome.split.total && outcome.split.afterJoin &&
    outcome.split.starts.every(Number.isFinite),
    'MAX_TOKENS retries retain exact source offsets in both halves: ' + JSON.stringify(outcome.split));
};
