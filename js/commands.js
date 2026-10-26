// Голосовые и текстовые команды приложения: темы, формулы, экраны, настройки, справка.
// Короткие команды диктовки («стоп», «дальше», «повтори») распознаёт speech.js; здесь — всё остальное.
// Просьбу своими словами («сделай паузы подольше») может разобрать нейросеть: она выбирает команду из списка.

import { norm } from './speech.js';
import { generateJSON, conn } from './ai.js';

const ORD = [['перв', 1], ['втор', 2], ['трет', 3], ['четверт', 4], ['пят', 5], ['шест', 6], ['седьм', 7], ['восьм', 8], ['девят', 9], ['десят', 10],
  ['одиннадцат', 11], ['двенадцат', 12], ['тринадцат', 13], ['четырнадцат', 14], ['пятнадцат', 15], ['шестнадцат', 16], ['семнадцат', 17],
  ['восемнадцат', 18], ['девятнадцат', 19], ['двадцат', 20], ['последн', -1]];
const CARD = { один: 1, одна: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7, восемь: 8, девять: 9, десять: 10,
  одиннадцать: 11, двенадцать: 12, тринадцать: 13, четырнадцать: 14, пятнадцать: 15, шестнадцать: 16, семнадцать: 17,
  восемнадцать: 18, девятнадцать: 19, двадцать: 20 };

/** «третья», «3», «номер три», «последняя» -> номер темы (с единицы; -1 — последняя) или 0. */
export function topicNumber(words) {
  for (const w of words) {
    if (/^\d{1,3}$/.test(w)) return +w;
    if (CARD[w]) return CARD[w];
    if (EN_NUM[w]) return EN_NUM[w];
    const o = ORD_LONG.find(([st]) => w.startsWith(st));
    if (o) return o[1];
  }
  return 0;
}
const ORD_LONG = [...ORD].sort((a, b) => b[0].length - a[0].length); // «пятнадцатая» раньше «пятой»
const EN_NUM = Object.fromEntries([
  ['one', 'first'], ['two', 'second'], ['three', 'third'], ['four', 'fourth'], ['five', 'fifth'], ['six', 'sixth'], ['seven', 'seventh'],
  ['eight', 'eighth'], ['nine', 'ninth'], ['ten', 'tenth'], ['eleven', 'eleventh'], ['twelve', 'twelfth'], ['thirteen', 'thirteenth'],
  ['fourteen', 'fourteenth'], ['fifteen', 'fifteenth'], ['sixteen', 'sixteenth'], ['seventeen', 'seventeenth'], ['eighteen', 'eighteenth'],
  ['nineteen', 'nineteenth'], ['twenty', 'twentieth'],
].flatMap(([c, o], i) => [[c, i + 1], [o, i + 1]]).concat([['last', -1], ['final', -1]]));

const on = (t) => !/(?:^|\s)(выключ|отключ|убер|не )/.test(t);
const TOPIC = 'тем[аеуыой]{0,2}';
const STATE = [];
/** Правило: регулярное выражение по нормализованному тексту -> команда (или функция, возвращающая команду). */
const R = (re, f) => STATE.push([re, f]);

// оформление — раньше тем: «светлая тема» — это не тема конспекта
R(/(?:^|\s)(?:андроид|android)\S*(?: тем| оформлен| стил)|(?:тем|оформлен|стил)\S* (?:андроид|android|как на андроиде)/, () => ({ cmd: 'theme', arg: 'android' }));
R(/(?:^|\s)(?:айфон|ios|ай ос|эппл|apple)\S*(?: тем| оформлен| стил)|(?:тем|оформлен|стил)\S* (?:айфон|ios|ай ос|как на айфоне)/, () => ({ cmd: 'theme', arg: 'ios' }));
R(/(?:^|\s)(?:неонов|неон)/, (t) => (/(?:тем|включ|сделай|поставь|оформлен)/.test(t) ? { cmd: 'theme', arg: 'neon' } : null));
R(/(?:^|\s)(?:светл|белая тема|дневная тема)/, (t) => (/(?:тем|включ|сделай|поставь|оформлен|режим)/.test(t) ? { cmd: 'theme', arg: 'light' } : null));
R(/(?:^|\s)(?:темн|черн|ночн|классическ)\S* (?:тем|оформлен|режим)|(?:тем|оформлен)\S* (?:темн|классическ)/, () => ({ cmd: 'theme', arg: 'classic' }));
// темы
R(new RegExp(`(?:^|\\s)(?:предыдущ|прошл|прежн)\\S* ${TOPIC}|(?:^|\\s)(?:назад|вернись|верни) (?:к |на )?(?:предыдущ|прошл)\\S* ${TOPIC}|${TOPIC} назад`), () => ({ cmd: 'prevTopic' }));
R(/(?:^|\s)(?:какая|какую|где мы|на какой|что за) (?:сейчас )?тем|(?:^|\s)сколько (?:еще |ещё )?(?:осталось|тем)|(?:^|\s)где мы$|(?:^|\s)на чем мы/, () => ({ cmd: 'where' }));
R(new RegExp(`(?:^|\\s)(?:перейди|перейдем|перейти|переходи|открой|включи|давай|начни|начинай|диктуй|вернись|верни|хочу|давай)\\S*(?: (?:к|на|в))? ${TOPIC}(?:\\s|$)|(?:^|\\s)(?:к|на) ${TOPIC} (?:номер )?\\S+|^${TOPIC} (?:номер )?\\S+$|(?:^|\\s)\\S+ ${TOPIC}$`), (t) => {
  const rest = t.replace(/^(?:.*?\s)?тем[аеуыой]{0,2}(?:\s+|$)/, '').replace(/^(?:номер|про|о|об|по|под названием|называется)\s+/, '').trim();
  const before = t.replace(/(?:^|\s)тем[аеуыой]{0,2}(?:\s.*)?$/, '').split(' ');
  const n = topicNumber([...rest.split(' ').slice(0, 2), ...before.slice(-1)]);
  if (n) return { cmd: 'gotoTopic', arg: { n } };
  if (rest.split(' ').filter((x) => x.length > 2).length) return { cmd: 'gotoTopic', arg: { q: rest } };
  return null;
});
// формулы
R(/(?:^|\s)(?:закрой|скрой|убери|спрячь) (?:блок )?формул|(?:^|\s)закрой(?: окно)?$/, () => ({ cmd: 'fxClose' }));
R(/(?:^|\s)формул\S*(?: (?:следующ|дальш)\S*)|(?:^|\s)следующ\S* формул/, () => ({ cmd: 'fx', arg: 'next' }));
R(/(?:^|\s)формул\S* (?:предыдущ|прошл)\S*|(?:^|\s)(?:предыдущ|прошл)\S* формул/, () => ({ cmd: 'fx', arg: 'prev' }));
R(/(?:^|\s)(?:покажи|открой|где|дай|выведи|посмотреть|показать) (?:\S+ )?формул|^формулы?(?: темы)?$|^блок формул/, () => ({ cmd: 'fx', arg: 'cur' }));
// экраны
R(/(?:^|\s)(?:открой|покажи|перейди (?:в|на)|вернись (?:в|на)|на) (?:вкладку |экран )?план/, () => ({ cmd: 'tab', arg: 'plan' }));
R(/(?:^|\s)(?:открой|покажи|перейди (?:в|на)) (?:вкладку |экран )?настройк/, () => ({ cmd: 'tab', arg: 'settings' }));
R(/(?:^|\s)(?:открой|покажи|перейди (?:в|на)) (?:вкладку |экран )?материал/, () => ({ cmd: 'tab', arg: 'load' }));
R(/(?:^|\s)(?:открой|покажи|перейди (?:в|на)|вернись (?:в|на|к)) (?:вкладку |экран )?диктовк/, () => ({ cmd: 'tab', arg: 'dictate' }));
// режимы и настройки
R(/(?:^|\s)только слуша|(?:^|\s)режим (?:прослушивания|слушания)|(?:^|\s)(?:без пауз|не записываю|я (?:в транспорте|еду))/, () => ({ cmd: 'listenOnly', arg: true }));
R(/(?:^|\s)(?:режим записи|записываю$|буду записывать|с паузами)/, () => ({ cmd: 'listenOnly', arg: false }));
R(/(?:^|\s)(?:пауз\S* (?:подольше|длиннее|больше|побольше)|(?:подольше|длиннее|побольше) пауз|увелич\S* пауз)/, () => ({ cmd: 'pauseLen', arg: +1 }));
R(/(?:^|\s)(?:пауз\S* (?:покороче|короче|меньше|поменьше)|(?:покороче|короче|поменьше) пауз|уменьш\S* пауз)/, () => ({ cmd: 'pauseLen', arg: -1 }));
R(/сокращени/, (t) => (/(?:включ|выключ|отключ|убер|без|не |давай|диктуй|сокращай)/.test(t) ? { cmd: 'abbreviate', arg: on(t) && !/без сокращ/.test(t) } : null));
R(/интонац/, (t) => (/(?:включ|выключ|отключ|убер|без|верни)/.test(t) ? { cmd: 'intonation', arg: on(t) && !/без интонац/.test(t) } : null));
R(/самопроверк/, (t) => (/(?:включ|выключ|отключ|убер|без|не )/.test(t) ? { cmd: 'selfCheck', arg: on(t) && !/без самопровер/.test(t) } : null));
R(/(?:^|\s)(?:скрой|спрячь|убери) текст/, () => ({ cmd: 'showText', arg: false }));
R(/(?:^|\s)(?:покажи|верни|открой) текст/, () => ({ cmd: 'showText', arg: true }));
R(/(?:^|\s)(?:сохрани|экспорт|выгрузи|отправь|скачай) (?:\S+ )?(?:конспект|файл|вопрос)/, () => ({ cmd: 'export' }));
R(/(?:^|\s)(?:что ты умеешь|какие (?:есть )?команды|список команд|помощь|справка|что можно (?:сказать|говорить))/, () => ({ cmd: 'help' }));

// English — для конспектов на английском
R(/(?:^|\s)(?:light|white|day) (?:theme|mode)/, () => ({ cmd: 'theme', arg: 'light' }));
R(/(?:^|\s)(?:dark|night|classic) (?:theme|mode)/, () => ({ cmd: 'theme', arg: 'classic' }));
R(/(?:^|\s)(?:ios|iphone|apple) (?:theme|style|look|mode)/, () => ({ cmd: 'theme', arg: 'ios' }));
R(/(?:^|\s)(?:android|material) (?:theme|style|look|mode)/, () => ({ cmd: 'theme', arg: 'android' }));
R(/(?:^|\s)neon(?: theme| mode)?$/, () => ({ cmd: 'theme', arg: 'neon' }));
R(/(?:^|\s)previous topic|(?:^|\s)go back (?:a|one) topic|(?:^|\s)topic before/, () => ({ cmd: 'prevTopic' }));
R(/(?:^|\s)(?:what|which) topic|(?:^|\s)where are we|(?:^|\s)how much (?:is )?left/, () => ({ cmd: 'where' }));
R(/(?:^|\s)(?:go|jump|skip|switch|move) (?:back )?to (?:the )?(?:\S+ )?topic|(?:^|\s)(?:open|start) (?:the )?(?:\S+ )?topic|^topic (?:number )?\S+$|^(?:the )?\S+ topic$/, (t) => {
  if (/(?:^|\s)next topic$/.test(t)) return null; // «next topic» — команда диктовки
  const rest = t.replace(/^.*?(?:^|\s)topic(?:\s+|$)/, '').replace(/^(?:number|about|on|called)\s+/, '').trim();
  const before = t.replace(/(?:^|\s)topic(?:\s.*)?$/, '').split(' ');
  const n = topicNumber([...rest.split(' ').slice(0, 2), ...before.slice(-1)]);
  if (n) return { cmd: 'gotoTopic', arg: { n } };
  if (rest.split(' ').filter((x) => x.length > 2).length) return { cmd: 'gotoTopic', arg: { q: rest } };
  return null;
});
R(/(?:^|\s)close (?:the )?formulas|^close$/, () => ({ cmd: 'fxClose' }));
R(/(?:^|\s)formulas (?:for|of) (?:the )?next|(?:^|\s)next formulas/, () => ({ cmd: 'fx', arg: 'next' }));
R(/(?:^|\s)formulas (?:for|of) (?:the )?previous|(?:^|\s)previous formulas/, () => ({ cmd: 'fx', arg: 'prev' }));
R(/(?:^|\s)(?:show|open)(?: me)? (?:the )?formulas|^formulas$/, () => ({ cmd: 'fx', arg: 'cur' }));
R(/(?:^|\s)(?:open|show|go to)(?: the)? plan/, () => ({ cmd: 'tab', arg: 'plan' }));
R(/(?:^|\s)(?:open|show|go to)(?: the)? settings/, () => ({ cmd: 'tab', arg: 'settings' }));
R(/(?:^|\s)(?:open|show|go to)(?: the)? material/, () => ({ cmd: 'tab', arg: 'load' }));
R(/(?:^|\s)listen(?:ing)? only|(?:^|\s)just listening|(?:^|\s)no pauses/, () => ({ cmd: 'listenOnly', arg: true }));
R(/(?:^|\s)(?:writing|note taking) mode|(?:^|\s)with pauses|(?:^|\s)i m writing/, () => ({ cmd: 'listenOnly', arg: false }));
R(/(?:^|\s)(?:longer|more|bigger) pauses?|(?:^|\s)pauses? longer/, () => ({ cmd: 'pauseLen', arg: +1 }));
R(/(?:^|\s)(?:shorter|smaller) pauses?|(?:^|\s)pauses? shorter/, () => ({ cmd: 'pauseLen', arg: -1 }));
R(/(?:^|\s)hide (?:the )?text/, () => ({ cmd: 'showText', arg: false }));
R(/(?:^|\s)show (?:the )?text/, () => ({ cmd: 'showText', arg: true }));
R(/(?:^|\s)(?:save|export|download) (?:the )?(?:\S+ )?(?:conspect|notes|file)/, () => ({ cmd: 'export' }));
R(/(?:^|\s)(?:what can you do|what commands|list (?:of )?commands|^help$)/, () => ({ cmd: 'help' }));

/** Распознаёт команду приложения во фразе (или null). Длинные фразы — скорее вопрос, а не команда. */
export function matchAppCommand(text) {
  const t = norm(text);
  if (!t || t.split(' ').length > 9) return null;
  for (const [re, f] of STATE) {
    if (re.test(t)) {
      const c = f(t);
      if (c) return c;
    }
  }
  return null;
}

/** Ищет тему по номеру (в порядке плана) или по словам из названия. */
export function findTopic(seq, arg) {
  if (!seq.length || !arg) return null;
  if (arg.n) return arg.n === -1 ? seq[seq.length - 1] : seq[arg.n - 1] || null;
  const stem = (w) => w.slice(0, Math.max(4, Math.ceil(w.length * 0.7)));
  const q = norm(arg.q).split(' ').filter((w) => w.length > 2).map(stem);
  if (!q.length) return null;
  let best = null, score = 0;
  for (const t of seq) {
    const words = norm(t.title).split(' ').filter((w) => w.length > 2);
    const hit = q.filter((s) => words.some((w) => w.startsWith(s) || s.startsWith(stem(w)))).length / q.length;
    if (hit > score) { score = hit; best = t; }
  }
  return score >= 0.5 ? best : null;
}

/** Похоже на просьбу что-то сделать с приложением, а не на вопрос по конспекту? */
export const looksLikeRequest = (text) =>
  /^(?:пожалуйста |можешь |можно |давай |а )?(?:включи|выключи|отключи|открой|закрой|покажи|скрой|перейди|переключи|сделай|поставь|убери|верни|увеличь|уменьши|измени|смени|поменяй|начни|запусти|вернись|прочитай|диктуй|хочу|не надо)/.test(norm(text)) ||
  /^(?:please |can you |could you |let s )?(?:turn on|turn off|switch|open|close|show|hide|go to|make|set|change|start|enable|disable|i want)/.test(norm(text));

/** Что можно попросить — для справки и для нейросети. */
export const COMMAND_LIST = [
  ['gotoTopic', 'перейти к теме: arg — {"n": номер} или {"q": "слова из названия"}'],
  ['prevTopic', 'вернуться к предыдущей теме'],
  ['skipTopic', 'следующая тема'],
  ['repeatTopic', 'тема с начала'],
  ['where', 'сказать, какая сейчас тема и сколько осталось'],
  ['fx', 'показать формулы: arg — "cur" | "next" | "prev"'],
  ['fxClose', 'закрыть формулы'],
  ['tab', 'открыть экран: arg — "load" | "plan" | "dictate" | "settings"'],
  ['listenOnly', 'режим «Только слушаю» (true) или «Записываю» (false)'],
  ['pauseLen', 'длина паузы между кусками: arg — +1 (длиннее) или -1 (короче)'],
  ['rate', 'скорость речи: arg — +1 (быстрее) или -1 (медленнее)'],
  ['abbreviate', 'диктовать сокращениями: arg — true | false'],
  ['intonation', 'живая интонация: arg — true | false'],
  ['selfCheck', 'самопроверка после темы: arg — true | false'],
  ['showText', 'показывать текст куска: arg — true | false'],
  ['theme', 'оформление: arg — "android" | "ios" | "classic" | "neon" | "light" | "auto"'],
  ['export', 'сохранить конспект и вопросы в файл'],
  ['help', 'рассказать, какие есть команды'],
];

/** Просьба своими словами -> команда из списка (один короткий запрос к нейросети) или null. */
export async function aiCommand(text, settings) {
  const prompt = `Пользователь приложения для диктовки конспектов сказал: «${text}».
Если это просьба что-то сделать с приложением, выбери одну команду из списка и её аргумент; если это вопрос по учебному материалу или ничего не подходит — "none".
Команды:
${COMMAND_LIST.map(([c, d]) => `- ${c}: ${d}`).join('\n')}
Ответ JSON: {"cmd":"…","arg":…}`;
  try {
    const res = await generateJSON({ ...conn(settings), system: 'Ты разбираешь команды пользователя. Отвечай строго JSON.', parts: [{ text: prompt }], temperature: 0 });
    const cmd = String(res.cmd || 'none');
    if (!COMMAND_LIST.some(([c]) => c === cmd)) return null;
    return { cmd, arg: res.arg };
  } catch {
    return null;
  }
}

export const HELP_TEXT = 'Можно сказать: «перейди к третьей теме» или «к теме налоги», «предыдущая тема», «следующая тема», «тему сначала», ' +
  '«какая сейчас тема», «покажи формулы», «формулы следующей темы», «закрой формулы», «открой план», «только слушаю», «режим записи», ' +
  '«паузы подольше», «быстрее», «медленнее», «включи сокращения», «светлая тема», «скрой текст», «сохрани конспект». ' +
  'А если сказать своими словами — я постараюсь понять.';

export const HELP_TEXT_EN = 'You can say: “go to topic three” or “go to the topic taxes”, “previous topic”, “next topic”, “repeat topic”, ' +
  '“what topic is this”, “show formulas”, “formulas for the next topic”, “close formulas”, “open the plan”, “listen only”, “writing mode”, ' +
  '“longer pauses”, “faster”, “slower”, “light theme”, “hide text”, “save the notes”. You can also just say what you want — I’ll try to understand.';
