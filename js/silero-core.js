// Голос Silero v5 (Бая, Ксения, Айдар…) прямо в браузере: подготовка текста, ударения, интонация
// и сборка звука. Нейросеть разбита на 5 моделей ONNX (их запускает neural-worker.js),
// здесь — всё, что между ними, повторяет логику оригинального пакета Silero.
// Модель: Silero TTS v5_6_ru, лицензия CC BY-NC-SA 4.0 (https://github.com/snakers4/silero-models).
/* eslint-disable no-bitwise */
(function (root) {
  'use strict';

  // ---------- Текст: числа, латиница, знаки ----------

  const UNITS = ['ноль', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять',
    'десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать', 'шестнадцать',
    'семнадцать', 'восемнадцать', 'девятнадцать'];
  const UNITS_F = { 1: 'одна', 2: 'две' };
  const TENS = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'];
  const HUNDREDS = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот'];
  const SCALES = [
    null,
    { f: true, forms: ['тысяча', 'тысячи', 'тысяч'] },
    { f: false, forms: ['миллион', 'миллиона', 'миллионов'] },
    { f: false, forms: ['миллиард', 'миллиарда', 'миллиардов'] },
  ];

  function plural(n, forms) {
    const a = n % 100, b = n % 10;
    if (a >= 11 && a <= 14) return forms[2];
    if (b === 1) return forms[0];
    if (b >= 2 && b <= 4) return forms[1];
    return forms[2];
  }

  function triple(n, fem) {
    const out = [];
    if (n >= 100) { out.push(HUNDREDS[Math.floor(n / 100)]); n %= 100; }
    if (n >= 20) { out.push(TENS[Math.floor(n / 10)]); n %= 10; }
    if (n > 0) out.push(fem && UNITS_F[n] ? UNITS_F[n] : UNITS[n]);
    return out;
  }

  /** Целое число словами (именительный падеж). */
  function numberWords(str, fem = false) {
    let s = String(str).replace(/^0+(?=\d)/, '');
    if (s.length > 12) return s.split('').map((d) => UNITS[+d]).join(' ');
    let n = Number(s);
    if (n === 0) return UNITS[0];
    const parts = [];
    for (let i = 0; n > 0; i++) {
      const t = n % 1000;
      n = Math.floor(n / 1000);
      if (!t) continue;
      const sc = SCALES[i];
      const words = i === 1 && t === 1 ? [] : triple(t, i === 0 ? fem : sc.f); // «тысяча», а не «одна тысяча»
      if (sc) words.push(plural(t, sc.forms));
      parts.unshift(words.join(' '));
    }
    return parts.join(' ');
  }

  const FRACTION = [null, ['десятая', 'десятых', 'десятых'], ['сотая', 'сотых', 'сотых'], ['тысячная', 'тысячных', 'тысячных']];

  function decimalWords(int, frac) {
    const fr = frac.slice(0, 3);
    const n = Number(int), f = Number(fr);
    const whole = `${numberWords(int, true)} ${plural(n, ['целая', 'целых', 'целых'])}`;
    return `${whole} ${numberWords(fr, true)} ${plural(f, FRACTION[fr.length])}`;
  }

  const LATIN = {
    a: 'а', b: 'бэ', c: 'цэ', d: 'дэ', e: 'е', f: 'эф', g: 'гэ', h: 'аш', i: 'и', j: 'йот', k: 'ка', l: 'эль', m: 'эм',
    n: 'эн', o: 'о', p: 'пэ', q: 'ку', r: 'эр', s: 'эс', t: 'тэ', u: 'у', v: 'вэ', w: 'дубль вэ', x: 'икс', y: 'игрек', z: 'зэт',
  };
  const GREEK = {
    α: 'альфа', β: 'бета', γ: 'гамма', δ: 'дельта', ε: 'эпсилон', ζ: 'дзета', η: 'эта', θ: 'тэта', λ: 'лямбда',
    μ: 'мю', ν: 'ню', ξ: 'кси', π: 'пи', ρ: 'ро', σ: 'сигма', τ: 'тау', φ: 'фи', χ: 'хи', ψ: 'пси', ω: 'омега',
    Δ: 'дельта', Σ: 'сигма', Ω: 'омега', Φ: 'фи', Π: 'пи', Λ: 'лямбда', Γ: 'гамма',
  };
  const TRANSLIT = [
    ['sch', 'щ'], ['sh', 'ш'], ['ch', 'ч'], ['zh', 'ж'], ['th', 'т'], ['ph', 'ф'], ['kh', 'х'], ['ts', 'ц'], ['ya', 'я'], ['yu', 'ю'],
    ['oo', 'у'], ['ee', 'и'], ['ck', 'к'], ['qu', 'кв'], ['x', 'кс'], ['w', 'в'], ['a', 'а'], ['b', 'б'], ['c', 'к'], ['d', 'д'], ['e', 'е'],
    ['f', 'ф'], ['g', 'г'], ['h', 'х'], ['i', 'и'], ['j', 'дж'], ['k', 'к'], ['l', 'л'], ['m', 'м'], ['n', 'н'], ['o', 'о'], ['p', 'п'],
    ['q', 'к'], ['r', 'р'], ['s', 'с'], ['t', 'т'], ['u', 'у'], ['v', 'в'], ['y', 'й'], ['z', 'з'],
  ];

  function translit(word) {
    let w = word.toLowerCase(), out = '';
    while (w) {
      const hit = TRANSLIT.find(([k]) => w.startsWith(k));
      if (hit) { out += hit[1]; w = w.slice(hit[0].length); } else { w = w.slice(1); }
    }
    return out;
  }

  // ---------- Порядковые числительные: «первый», «двадцать третьем», «девяностых» ----------

  // формы: m — какой, mg — какого, md — какому, mi — каким, mp — (о) каком, f — какая, fa — какую,
  // fo — какой (ж. р., косвенные), n — какое, pl — какие, plg — каких, pld — каким, pli — какими
  const ORD_END = { h: { m: 'ый', mg: 'ого', md: 'ому', mi: 'ым', mp: 'ом', f: 'ая', fa: 'ую', fo: 'ой', n: 'ое', pl: 'ые', plg: 'ых', pld: 'ым', pli: 'ыми' } };
  ORD_END.o = { ...ORD_END.h, m: 'ой' };
  ORD_END.s = { m: 'ий', mg: 'ьего', md: 'ьему', mi: 'ьим', mp: 'ьем', f: 'ья', fa: 'ью', fo: 'ьей', n: 'ье', pl: 'ьи', plg: 'ьих', pld: 'ьим', pli: 'ьими' };
  const ORD_UNITS = [null, 'перв', 'втор:o', 'трет:s', 'четвёрт', 'пят', 'шест:o', 'седьм:o', 'восьм:o', 'девят'];
  const ORD_TEENS = ['десят', 'одиннадцат', 'двенадцат', 'тринадцат', 'четырнадцат', 'пятнадцат', 'шестнадцат', 'семнадцат', 'восемнадцат', 'девятнадцат'];
  const ORD_TENS = [null, null, 'двадцат', 'тридцат', 'сороков:o', 'пятидесят', 'шестидесят', 'семидесят', 'восьмидесят', 'девяност'];
  const ORD_HUNDREDS = [null, 'сот', 'двухсот', 'трёхсот', 'четырёхсот', 'пятисот', 'шестисот', 'семисот', 'восьмисот', 'девятисот'];
  const GEN_PREFIX = [null, '', 'двух', 'трёх', 'четырёх', 'пяти', 'шести', 'семи', 'восьми', 'девяти', 'десяти'];

  function ordinalWords(num, form = 'm') {
    const n = Number(num);
    if (!Number.isInteger(n) || n <= 0 || n >= 1e9) return null;
    let stem, rest;
    if (n % 1000 === 0) {
      if (n / 1000 > 10) return null;
      stem = GEN_PREFIX[n / 1000] + 'тысячн'; rest = 0;
    } else if (n % 100 === 0) {
      stem = ORD_HUNDREDS[(n % 1000) / 100]; rest = n - (n % 1000);
    } else {
      const r = n % 100;
      if (r >= 10 && r < 20) { stem = ORD_TEENS[r - 10]; rest = n - r; }
      else if (r % 10 === 0) { stem = ORD_TENS[r / 10]; rest = n - r; }
      else { stem = ORD_UNITS[r % 10]; rest = n - (r % 10); }
    }
    const [base, type = 'h'] = stem.split(':');
    return (rest ? numberWords(String(rest)) + ' ' : '') + base + ORD_END[type][form];
  }

  // «2-х», «5-ти», «7-ми» — количественное числительное в родительном падеже
  const CARD_GEN = { 1: 'одного', 2: 'двух', 3: 'трёх', 4: 'четырёх', 5: 'пяти', 6: 'шести', 7: 'семи', 8: 'восьми', 9: 'девяти', 10: 'десяти',
    11: 'одиннадцати', 12: 'двенадцати', 15: 'пятнадцати', 20: 'двадцати', 30: 'тридцати', 40: 'сорока', 50: 'пятидесяти', 100: 'ста' };

  // окончание после дефиса («1990-х», «2-й», «5-ю») -> форма порядкового числительного
  const SUFFIX_FORM = { ых: 'plg', ым: 'pld', ыми: 'pli', й: 'm', ый: 'm', ий: 'm', ой: 'm', го: 'mg', ого: 'mg', его: 'mg',
    му: 'md', ому: 'md', ему: 'md', м: 'mp', ом: 'mp', ем: 'mp', я: 'f', ая: 'f', ья: 'f', ю: 'fa', ую: 'fa', ью: 'fa', ое: 'n', ье: 'n' };

  const ROMAN_RE = /^M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/;
  function romanToInt(r) {
    if (!r || !ROMAN_RE.test(r)) return 0;
    const v = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
    let n = 0;
    for (let i = 0; i < r.length; i++) n += v[r[i]] < (v[r[i + 1]] || 0) ? -v[r[i]] : v[r[i]];
    return n;
  }

  const MONTHS_GEN = 'января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря';

  /** Слово перед позицией (для выбора падежа: «в 1990 г.» -> «году», «к XX в.» -> «веку»). */
  function wordBefore(str, offset) {
    const m = /([а-яё]+)[\s ]*$/i.exec(str.slice(Math.max(0, offset - 20), offset));
    return m ? m[1].toLowerCase() : '';
  }
  const PREP_P = new Set(['в', 'во', 'о', 'об', 'при']);
  const PREP_D = new Set(['к', 'ко', 'по']);
  const caseByPrep = (w, p, d, g) => (PREP_P.has(w) ? p : PREP_D.has(w) ? d : g);

  /** Точка сокращения в конце предложения должна остаться точкой. */
  const endDot = (str, end) => (/^\s*$|^\s+[А-ЯЁA-Z]/.test(str.slice(end)) ? '.' : '');

  // ---------- Сокращения ----------

  const NL = '(?<![а-яёА-ЯЁa-zA-Z])'; // начало слова (\b не работает с кириллицей)
  const ABBREVIATIONS = [
    ['и т\\.\\s?д\\.', 'и так далее'], ['и т\\.\\s?п\\.', 'и тому подобное'], ['в т\\.\\s?ч\\.', 'в том числе'],
    ['т\\.\\s?е\\.', 'то есть'], ['т\\.\\s?к\\.', 'так как'], ['т\\.\\s?н\\.', 'так называемый'], ['т\\.\\s?о\\.', 'таким образом'],
    ['и др\\.', 'и другие'], ['до н\\.\\s?э\\.', 'до нашей эры'], ['н\\.\\s?э\\.', 'нашей эры'],
    ['напр\\.', 'например'], ['(?<!\\d\\s?)см\\.(?=\\s)', 'смотри'], ['ср\\.', 'сравните'], ['рис\\.', 'рисунок'], ['табл\\.', 'таблица'],
    ['стр\\.', 'страница'], ['гл\\.', 'глава'], ['ок\\.', 'около'], ['прим\\.', 'примечание'], ['англ\\.', 'английский'],
    ['лат\\.', 'латинский'], ['греч\\.', 'греческий'], ['букв\\.', 'буквально'], ['проф\\.', 'профессор'], ['акад\\.', 'академик'],
    ['им\\.', 'имени'], ['ул\\.', 'улица'], ['обл\\.', 'область'],
  ].map(([re, word]) => [new RegExp(NL + re, 'gi'), word]);
  ABBREVIATIONS.push([new RegExp(NL + '(?<!\\d\\s?)г\\.(?=\\s*[А-ЯЁ][а-яё])', 'g'), 'город']); // «г. Москва», но не «1703 г.»

  // ---------- Единицы измерения после числа: «60 км/ч» -> «шестьдесят километров в час» ----------

  const M = (one, few, many, fem = false, tail = '') => ({ forms: [one, few, many], fem, tail });
  const METR = M('метр', 'метра', 'метров');
  const UNITS_AFTER = [
    ['км/ч', M('километр', 'километра', 'километров', false, ' в час')],
    ['м/с²', M('метр', 'метра', 'метров', false, ' в секунду в квадрате')],
    ['км/с', M('километр', 'километра', 'километров', false, ' в секунду')],
    ['м/с', M('метр', 'метра', 'метров', false, ' в секунду')],
    ['°C|°С|℃', M('градус', 'градуса', 'градусов', false, ' Цельсия')],
    ['°', M('градус', 'градуса', 'градусов')],
    ['%', M('процент', 'процента', 'процентов')],
    ['‰', M('промилле', 'промилле', 'промилле')],
    ['км²', M('квадратный километр', 'квадратных километра', 'квадратных километров')],
    ['м²', M('квадратный метр', 'квадратных метра', 'квадратных метров')],
    ['см²', M('квадратный сантиметр', 'квадратных сантиметра', 'квадратных сантиметров')],
    ['м³', M('кубический метр', 'кубических метра', 'кубических метров')],
    ['см³', M('кубический сантиметр', 'кубических сантиметра', 'кубических сантиметров')],
    ['км', M('километр', 'километра', 'километров')], ['см', M('сантиметр', 'сантиметра', 'сантиметров')],
    ['мм', M('миллиметр', 'миллиметра', 'миллиметров')], ['нм', M('нанометр', 'нанометра', 'нанометров')], ['м', METR],
    ['кг', M('килограмм', 'килограмма', 'килограммов')], ['мг', M('миллиграмм', 'миллиграмма', 'миллиграммов')],
    ['г', M('грамм', 'грамма', 'граммов')], ['т', M('тонна', 'тонны', 'тонн', true)],
    ['мл', M('миллилитр', 'миллилитра', 'миллилитров')], ['л', M('литр', 'литра', 'литров')],
    ['ч', M('час', 'часа', 'часов')], ['мин\\.?', M('минута', 'минуты', 'минут', true)],
    ['мс', M('миллисекунда', 'миллисекунды', 'миллисекунд', true)],
    ['сек\\.?|с(?=\\s*(?:[.,;:)!?]|$))', M('секунда', 'секунды', 'секунд', true)],
    ['кВт', M('киловатт', 'киловатта', 'киловатт')], ['МВт', M('мегаватт', 'мегаватта', 'мегаватт')], ['Вт', M('ватт', 'ватта', 'ватт')],
    ['кВ', M('киловольт', 'киловольта', 'киловольт')], ['В', M('вольт', 'вольта', 'вольт')],
    ['мА', M('миллиампер', 'миллиампера', 'миллиампер')], ['А', M('ампер', 'ампера', 'ампер')], ['Ом', M('ом', 'ома', 'ом')],
    ['ГГц', M('гигагерц', 'гигагерца', 'гигагерц')], ['МГц', M('мегагерц', 'мегагерца', 'мегагерц')],
    ['кГц', M('килогерц', 'килогерца', 'килогерц')], ['Гц', M('герц', 'герца', 'герц')],
    ['кДж', M('килоджоуль', 'килоджоуля', 'килоджоулей')], ['Дж', M('джоуль', 'джоуля', 'джоулей')],
    ['кН', M('килоньютон', 'килоньютона', 'килоньютонов')], ['Н', M('ньютон', 'ньютона', 'ньютонов')],
    ['МПа', M('мегапаскаль', 'мегапаскаля', 'мегапаскалей')], ['кПа', M('килопаскаль', 'килопаскаля', 'килопаскалей')],
    ['Па', M('паскаль', 'паскаля', 'паскалей')], ['атм', M('атмосфера', 'атмосферы', 'атмосфер', true)],
    ['ТБ|Тб', M('терабайт', 'терабайта', 'терабайт')], ['ГБ|Гб', M('гигабайт', 'гигабайта', 'гигабайт')],
    ['МБ|Мб', M('мегабайт', 'мегабайта', 'мегабайт')], ['КБ|Кб', M('килобайт', 'килобайта', 'килобайт')],
    ['млрд', M('миллиард', 'миллиарда', 'миллиардов')], ['млн', M('миллион', 'миллиона', 'миллионов')],
    ['тыс\\.?', M('тысяча', 'тысячи', 'тысяч', true)],
    ['руб\\.?|р\\.|₽', M('рубль', 'рубля', 'рублей')], ['коп\\.?', M('копейка', 'копейки', 'копеек', true)],
    ['долл\\.?|\\$', M('доллар', 'доллара', 'долларов')], ['€', M('евро', 'евро', 'евро')],
    ['чел\\.?', M('человек', 'человека', 'человек')], ['шт\\.?', M('штука', 'штуки', 'штук', true)],
  ];
  const UNIT_RE = new RegExp(`(\\d+(?:[.,]\\d+)?)[\\s\\u00a0]?(${UNITS_AFTER.map(([u]) => u).join('|')})(?![а-яёА-ЯЁa-zA-Z0-9²³])`, 'g');
  const UNIT_LIST = UNITS_AFTER.map(([u, spec]) => [new RegExp(`^(?:${u})$`), spec]);
  const CURRENCY = { 'руб': 'рублей', 'р': 'рублей', '₽': 'рублей', 'долл': 'долларов', '$': 'долларов', '€': 'евро' };

  function amount(num, spec) {
    const m = /^(\d+)(?:[.,](\d+))?$/.exec(num);
    if (m[2]) return `${decimalWords(m[1], m[2])} ${spec.forms[1]}${spec.tail}`; // «две целых пять десятых процента»
    const n = Number(m[1].slice(-6));
    return `${numberWords(m[1], spec.fem)} ${plural(n, spec.forms)}${spec.tail}`;
  }

  // ---------- Аббревиатуры: «ВВП» -> «вэ вэ пэ», «USB» -> «ю эс би» ----------

  const RU_LETTER = { А: 'а', Б: 'бэ', В: 'вэ', Г: 'гэ', Д: 'дэ', Е: 'е', Ё: 'ё', Ж: 'жэ', З: 'зэ', И: 'и', Й: 'й', К: 'ка', Л: 'эль',
    М: 'эм', Н: 'эн', О: 'о', П: 'пэ', Р: 'эр', С: 'эс', Т: 'тэ', У: 'у', Ф: 'эф', Х: 'ха', Ц: 'цэ', Ч: 'чэ', Ш: 'ша', Щ: 'ща',
    Ъ: '', Ы: 'ы', Ь: '', Э: 'э', Ю: 'ю', Я: 'я' };
  const EN_LETTER = { A: 'эй', B: 'би', C: 'си', D: 'ди', E: 'и', F: 'эф', G: 'джи', H: 'эйч', I: 'ай', J: 'джей', K: 'кей', L: 'эл',
    M: 'эм', N: 'эн', O: 'оу', P: 'пи', Q: 'кью', R: 'ар', S: 'эс', T: 'ти', U: 'ю', V: 'ви', W: 'дабл ю', X: 'экс', Y: 'уай', Z: 'зед' };
  const ABBR_SAY = { МРОТ: 'мрот', ЕГЭ: 'е гэ э', ОГЭ: 'о гэ э', ООН: 'о о эн', ЕС: 'е эс', ООО: 'о о о', ИП: 'и пэ', ЗАГС: 'загс', ТАСС: 'тасс',
    OK: 'окей', JSON: 'джейсон', NASA: 'наса', NATO: 'нато', UNESCO: 'юнеско', LAN: 'лан', RAM: 'рам', ROM: 'ром' };
  const ONSET_RE = /^(?:с?т[рв]?|с[пкмнлвх]р?|[пбткгдфх][рл]|[зс]в|вз|вс|вр|вл|мн|шк|шт|шв|сл|зл|зн|зд|кн|гн|дв|тв|чт|гл|кл|пл|бл|фл|[бвгджзйклмнпрстфхцчшщ])$/;
  const GEOMETRY = /(отрез|прям|треугольн|четырёхугольн|многоугольн|угл|угол|точк|сторон|луч|вектор|плоскост|квадрат|ромб|трапец|параллелограмм|окружност|хорд|дуг|диагонал|медиан|биссектрис|высот|грань|ребр|пирамид|призм)[а-яё]*\s*$/i;

  /** Можно ли прочитать сокращение как слово (ВУЗ, ГОСТ, НАТО) — иначе по буквам (ВВП, МГУ). */
  function sayable(w, vowels) {
    const low = w.toLowerCase();
    const first = low.search(vowels);
    if (first < 0) return false;
    if (first > 0 && !ONSET_RE.test(low.slice(0, first))) return false;
    const tail = /[^аеёиоуыэюяaeiouy]+$/.exec(low);
    if (tail && tail[0].length > 1 && !/^(ст|нт|рт|нк|рк|нд|рд|ск|кс)$/.test(tail[0])) return false;
    return !/[^аеёиоуыэюяaeiouy]{3,}/.test(low.slice(first));
  }

  function readAbbr(w, before) {
    if (ABBR_SAY[w]) return ABBR_SAY[w];
    const latin = /[A-Z]/.test(w);
    // в геометрии латинские буквы читают по-русски: «отрезок AB» -> «а бэ»
    if (latin && GEOMETRY.test(before)) return [...w].map((c) => LATIN[c.toLowerCase()]).join(' ');
    if (latin ? w.length > 3 && sayable(w, /[aeiouy]/) : sayable(w, /[аеёиоуыэюя]/)) return latin ? translit(w) : w.toLowerCase();
    return [...w].map((c) => (latin ? EN_LETTER[c] : RU_LETTER[c])).join(' ');
  }

  // мужские имена правителей — по ним отличаем «Александра II» (кого?) от «Екатерина II» (кто?)
  const MALE_NAME = /^(п[её]тр|павл|павел|александр|никола|иван|иоанн|васили|ф[её]дор|михаил|алексе|борис|владимир|ярослав|святослав|всеволод|дмитри|юри|генрих|людовик|карл|фридрих|вильгельм|георг|эдуард|ричард|филипп|франциск|наполеон|григори|бенедикт|яков|густав|лев|льв|иосиф|сигизмунд|стефан|константин|олег|игор)/i;
  function nameCase(name) {
    const low = name.toLowerCase();
    if (/[бвгджзйклмнпрстфхцчшщь]$/.test(low)) return 'm';
    if (MALE_NAME.test(low)) return /[ая]$/.test(low) ? 'mg' : /[ую]$/.test(low) ? 'md' : /[оеё]м$/.test(low) ? 'mi' : /е$/.test(low) ? 'mp' : 'm';
    return /[ая]$/.test(low) ? 'f' : /[ую]$/.test(low) ? 'fa' : 'fo';
  }

  // математические сокращения: «sin x» -> «синус икс»
  const MATH_WORDS = { sin: 'синус', cos: 'косинус', tg: 'тангенс', tan: 'тангенс', ctg: 'котангенс', cot: 'котангенс',
    arcsin: 'арксинус', arccos: 'арккосинус', arctg: 'арктангенс', ln: 'натуральный логарифм', lg: 'десятичный логарифм',
    log: 'логарифм', lim: 'предел', max: 'максимум', min: 'минимум', exp: 'экспонента', sqrt: 'корень из', const: 'константа',
    sh: 'гиперболический синус', ch: 'гиперболический косинус', det: 'определитель', grad: 'градиент', div: 'дивергенция' };

  // ---------- Подготовка текста ----------

  const SUPERSCRIPT = { '⁰': 0, '¹': 1, '²': 2, '³': 3, '⁴': 4, '⁵': 5, '⁶': 6, '⁷': 7, '⁸': 8, '⁹': 9 };
  const power = (n) => (n === 2 ? ' в квадрате' : n === 3 ? ' в кубе' : ` в ${ordinalWords(n, 'fo') || numberWords(n)} степени`);

  /** Числа, даты, единицы, сокращения, формулы и латиница — словами: модель знает только русские буквы. */
  function normalize(text) {
    let t = String(text);
    t = t.replace(/[«»“”„"]/g, ' ').replace(/[‐‑]/g, '-').replace(/ | /g, ' ');
    // сокращения
    for (const [re, word] of ABBREVIATIONS) t = t.replace(re, (m, ...a) => word + endDot(a[a.length - 1], a[a.length - 2] + m.length));
    // «физ. лиц», «гос. бюджет» — точка сокращения перед строчной буквой не конец предложения
    t = t.replace(/(?<![А-Яа-яЁё])([А-Яа-яЁё]{2,5})\.\s+(?=[а-яё])/g, '$1 ');
    // «10 000» -> «10000»; «$5» -> «5 $»
    t = t.replace(/(?<![\d.,])(\d{1,3})((?: \d{3})+)(?![\d]|[.,]\d)/g, (m, a, b) => a + b.replace(/ /g, ''));
    t = t.replace(/([$€₽])\s?(\d+(?:[.,]\d+)?)/g, '$2 $1');
    // века: «XX в.», «в XIX–XX вв.», «XXI веке»
    t = t.replace(new RegExp(`(?<![A-Za-z])([IVXLC]+)(?:\\s*[–—-]\\s*([IVXLC]+))?\\s*(века|веке|веку|веком|веков|веках|векам|век|вв\\.|в\\.)(?![а-яё])`, 'g'),
      (m, r1, r2, noun, off, str) => {
        const a = romanToInt(r1), b = r2 ? romanToInt(r2) : 0;
        if (!a || (r2 && !b)) return m;
        const w = wordBefore(str, off);
        let form, word;
        if (noun === 'в.') [form, word] = caseByPrep(w, ['mp', 'веке'], ['md', 'веку'], ['mg', 'века']);
        else if (noun === 'вв.') [form, word] = caseByPrep(w, ['mp', 'веках'], ['md', 'векам'], ['mg', 'веков']);
        else { word = noun; form = { век: 'm', века: 'mg', веке: 'mp', веку: 'md', веком: 'mi', веков: 'mg', веках: 'mp', векам: 'md' }[noun]; }
        const dot = noun.endsWith('.') ? endDot(str, off + m.length) : '';
        return `${ordinalWords(a, form)}${b ? ' – ' + ordinalWords(b, form) : ''} ${word}${dot}`;
      });
    // «Пётр I», «Екатерина II», «при Николае II»
    t = t.replace(/(?<![а-яёА-ЯЁ])([А-ЯЁ][а-яё]{2,})\s+([IVX]{1,4})(?![A-Za-z\d])(?!\s*[=<>+*/^−-])/g, (m, name, r) => {
      const n = romanToInt(r);
      return n && n <= 30 ? `${name} ${ordinalWords(n, nameCase(name))}` : m;
    });
    // «глава II», «часть III» -> «глава два»
    t = t.replace(/(?<![а-яё])(глав[аеуыо]й?|част[ьиюе]й?|том[аеу]?|раздел[аеу]?|параграф[аеу]?|пункт[аеу]?|тип[аеу]?|групп[аеуы]|класс[аеу]?|квартал[аеу]?|этап[аеу]?|степен[ьи]|уров[ен][ьняею]+)\s+([IVXLC]+)(?![A-Za-z])/gi,
      (m, word, r) => { const n = romanToInt(r); return n ? `${word} ${numberWords(n)}` : m; });
    // годы: «в 2023 году», «1703 г.», «1941–1945 гг.»
    t = t.replace(/(\d{3,4})\s*[–—-]\s*(\d{3,4})\s*(гг\.|годах|годы|годов|годам)/g, (m, a, b, noun, off, str) => {
      const w = wordBefore(str, off);
      const [form, word] = noun === 'гг.' ? caseByPrep(w, ['mp', 'годах'], ['md', 'годам'], ['m', 'годы'])
        : [{ годах: 'mp', годы: 'm', годов: 'mg', годам: 'md' }[noun], noun];
      return `${ordinalWords(a, form)} – ${ordinalWords(b, form)} ${word}${noun === 'гг.' ? endDot(str, off + m.length) : ''}`;
    });
    t = t.replace(/(?<!\d)(\d{3,4})\s*(году|года|годом|год|г\.)(?![а-яё])/g, (m, y, noun, off, str) => {
      const w = wordBefore(str, off);
      // «200 г.» — граммы; год — четыре цифры или «в 988 г.»
      if (noun === 'г.' && !(+y >= 1000 && +y < 2200) && !PREP_P.has(w)) return m;
      let form, word = noun;
      if (noun === 'г.') [form, word] = caseByPrep(w, ['mp', 'году'], ['md', 'году'], ['mg', 'года']);
      else form = noun === 'году' ? (PREP_D.has(w) ? 'md' : 'mp') : { года: 'mg', годом: 'mi', год: 'm' }[noun];
      return `${ordinalWords(y, form) || y} ${word}${noun === 'г.' ? endDot(str, off + m.length) : ''}`;
    });
    // даты: «5 мая» -> «пятого мая»
    t = t.replace(new RegExp(`(?<!\\d)(\\d{1,2})\\s+(${MONTHS_GEN})(?![а-яё])`, 'g'), (m, d, month, off, str) => {
      const n = +d;
      if (n < 1 || n > 31) return m;
      const w = wordBefore(str, off);
      return `${ordinalWords(n, w === 'на' ? 'n' : PREP_D.has(w) ? 'md' : 'mg')} ${month}`;
    });
    // время «10:30»
    t = t.replace(/(?<!\d)(\d{1,2}):(\d{2})(?!\d)/g, (m, h, mm) => `${numberWords(h)} ${mm === '00' ? 'ноль ноль' : mm[0] === '0' ? 'ноль ' + numberWords(mm[1]) : numberWords(mm)}`);
    // «1990-х», «2-й», «5-ти»
    t = t.replace(/(\d+)\s?-\s?(ых|ые|ыми|ым|ый|ий|ой|ого|его|ому|ему|ом|ем|ая|ую|ое|ье|ья|ью|го|му|ми|ти|ух|ёх|ех|х|й|е|я|ю|м)(?![а-яё])/g, (m, d, suf) => {
      const n = Number(d);
      if (/^(ти|ми)$/.test(suf) || (/^(х|ух|ёх|ех)$/.test(suf) && n >= 2 && n <= 4)) return CARD_GEN[n] || numberWords(d);
      let form = SUFFIX_FORM[suf];
      if (/^(х|ух|ёх|ех)$/.test(suf)) form = 'plg';
      if (suf === 'ые' || (suf === 'е' && (n % 10 === 0 || n >= 1000))) form = 'pl'; // «90-е годы»
      else if (suf === 'е') form = 'n'; // «5-е издание»
      return ordinalWords(n, form) || numberWords(d);
    });
    // «−5» -> «минус пять», «3x - 1» -> «три икс минус один»
    t = t.replace(/(^|[\s(=:;,])[-−](?=\d)/g, '$1минус ');
    t = t.replace(/([\da-z])\s+-\s+(?=[\da-z(])/g, '$1 минус ');
    // «пункт 2.1» -> «пункт два точка один» (не дробь)
    t = t.replace(/(?<![а-яё])(пункт[аеу]?|п\.|раздел[аеу]?|глав[аеуы]|параграф[аеу]?|§|рис(?:\.|унок|унке|унка)|таблиц[аеуы]|табл\.|формул[аеуы]|стать[яеию])\s*(\d+(?:\.\d+)+)/gi,
      (m, w, num) => `${w} ${num.split('.').map((d) => numberWords(d)).join(' точка ')}`);
    // единицы после числа
    t = t.replace(UNIT_RE, (m, num, unit, off, str) => {
      const spec = UNIT_LIST.find(([re]) => re.test(unit))[1];
      return amount(num, spec) + (unit.endsWith('.') ? endDot(str, off + m.length) : '');
    });
    t = t.replace(/(миллион[а-я]*|миллиард[а-я]*|тысяч[а-я]*)\s+(руб\.?|р\.|₽|долл\.?|\$|€)(?![а-яё])/g, (m, a, c, off, str) => `${a} ${CURRENCY[c.replace('.', '')]}${c.endsWith('.') ? endDot(str, off + m.length) : ''}`);
    // степени и дроби: «x²», «x^3», «3/4»
    t = t.replace(/([^\s\d])\s?([⁰¹²³⁴⁵⁶⁷⁸⁹]+)/g, (m, a, sup) => a + power(Number([...sup].map((c) => SUPERSCRIPT[c]).join(''))));
    t = t.replace(/\^\s*\(?(\d+)\)?/g, (m, d) => power(Number(d)));
    t = t.replace(/(?<![\d/])(\d{1,3})\/(\d{1,3})(?![\d/])/g, (m, a, b) => {
      const n = Number(a), f = n % 10 === 1 && n % 100 !== 11 ? 'f' : 'plg';
      return `${numberWords(a, true)} ${ordinalWords(Number(b), f) || numberWords(b)}`;
    });
    t = t.replace(/(\d+)[.,](\d+)/g, (_, a, b) => decimalWords(a, b));
    t = t.replace(/(\d+)\s*-\s*(\d+)/g, '$1 – $2');
    t = t.replace(/\d+/g, (d) => ` ${numberWords(d)} `);
    // аббревиатуры (до перевода латиницы в русские буквы)
    t = t.replace(/(?<![А-Яа-яЁёA-Za-z])([А-ЯЁ]{2,5}|[A-Z]{2,6})(?![А-Яа-яЁёA-Za-z])/g, (m, w, off, str) => ` ${readAbbr(w, str.slice(Math.max(0, off - 30), off))} `);
    t = t.replace(/№\s*/g, ' номер ').replace(/§\s*/g, ' параграф ').replace(/\s*&\s*/g, ' и ').replace(/\s*±\s*/g, ' плюс-минус ')
      .replace(/\s*[⇒→]\s*/g, ', следовательно, ').replace(/\s*∈\s*/g, ' принадлежит ').replace(/∫\s*/g, ' интеграл ')
      .replace(/∑\s*/g, ' сумма ').replace(/\s*∀\s*/g, ' для любого ').replace(/\s*∃\s*/g, ' существует ');
    t = t.replace(/\s*=\s*/g, ' равно ').replace(/\s*≈\s*/g, ' примерно равно ').replace(/\s*≠\s*/g, ' не равно ')
      .replace(/\s*≤\s*/g, ' меньше или равно ').replace(/\s*≥\s*/g, ' больше или равно ')
      .replace(/\s+<\s+/g, ' меньше ').replace(/\s+>\s+/g, ' больше ')
      .replace(/\s*[×·*]\s*/g, ' умножить на ').replace(/\s*÷\s*/g, ' разделить на ')
      .replace(/\s+\/\s+/g, ' разделить на ').replace(/√\s*/g, ' корень из ')
      .replace(/\s*∞\s*/g, ' бесконечность ').replace(/\s+\+\s+/g, ' плюс ').replace(/\s+−\s+/g, ' минус ');
    t = t.replace(/[αβγδεζηθλμνξπρστφχψωΔΣΩΦΠΛΓ]/g, (c) => ` ${GREEK[c]} `);
    t = t.replace(/(?<![A-Za-z])([A-Za-z])\s?\(\s?([A-Za-z0-9 ,]+?)\s?\)/g, '$1 от $2'); // «f(x)» -> «эф от икс»
    t = t.replace(/[A-Za-z]+/g, (w) => {
      const low = w.toLowerCase();
      if (MATH_WORDS[low]) return ` ${MATH_WORDS[low]} `;
      // «mc», «dx» — буквы формулы, а не слово
      if (w.length === 1 || (w.length <= 3 && !/[aeiouy]/i.test(w))) return ` ${[...low].map((c) => LATIN[c]).join(' ')} `;
      return ` ${translit(w)} `;
    });
    t = t.replace(/\(\s*/g, ', ').replace(/\s*\)/g, ', ').replace(/\s*;\s*/g, '; ');
    t = t.replace(/(\S) -(?=[а-яё])/g, '$1-'); // «ай ти -сфера» -> «ай ти-сфера»
    return t.replace(/\s+([,.!?:;…])/g, '$1').replace(/,\s*,/g, ',').replace(/^[\s,]+/, '').replace(/\s+/g, ' ').trim();
  }

  // ---------- Тип предложения (повествование, вопрос, восклицание) ----------

  const TYPE2ID = { st: 0, wh_q: 1, general_q: 2, alternative_q: 3, tag_q: 4, exclam: 5 };
  const WH_FORMS = new Set(('кто кого кому кем ком что чего чему чем чём чё чо где куда откуда когда почему зачем как почём отчего ' +
    'насколько сколько скольких скольким сколькими какой какая какое какие какого каких какому каким какими каком какую ' +
    'чей чья чьё чье чьи чьего чьей чьих чьему чьим чьими чьём чьем чью который которая которое которые которого которой ' +
    'которых которому которым которыми котором которую каков какова каково каковы').split(' '));
  const LEADING_FILLERS = new Set('а ну и так вот слышь слушай скажите скажи пожалуйста вобще вообще типа короче'.split(' '));
  const TAG_RE = new RegExp(['[,\\s]+(правда|верно|да)\\s*\\?$', '[,\\s]+(не\\s+так\\s+ли|не\\s+правда\\s+ли|разве\\s+не\\s+так|ведь\\s+так)\\s*\\?$',
    '[,\\s]+ведь\\s*\\?$', '[,\\s]+а\\s*\\?$'].map((p) => `(?:${p})`).join('|'), 'i');
  const QUOTE_OPEN = new Set(['"', '«', '“', '„']);
  const QUOTE_CLOSE = new Set(['"', '»', '”', '’']);
  const SENT_SPLIT_RE = /(?<=[.!?])\s+/g;

  function stripQuotes(s) {
    s = s.trim();
    while (s && QUOTE_OPEN.has(s[0])) s = s.slice(1).trim();
    while (s && QUOTE_CLOSE.has(s[s.length - 1])) s = s.slice(0, -1).trim();
    return s;
  }

  function hasWhPrefix(text) {
    const words = (text.toLowerCase().match(/[а-яёa-z]+/g) || []).slice(0, 8);
    const content = [];
    for (const w of words) {
      if (LEADING_FILLERS.has(w)) continue;
      content.push(w);
      if (content.length >= 4) break;
    }
    return content.some((w) => WH_FORMS.has(w));
  }

  function classifySentence(s) {
    s = s.trim();
    if (!s) return 'st';
    const clean = stripQuotes(s);
    if (!clean) return 'st';
    let tail = clean;
    if (tail.endsWith('?!') || tail.endsWith('?..') || tail.endsWith('?...')) tail = tail.replace(/[.!]+$/, '');
    if (tail.endsWith('?')) {
      const q = stripQuotes(tail).replace(/\+/g, '').replace(/ё/g, 'е').replace(/Ё/g, 'Е').replace(/\s+/g, ' ').trim();
      if (TAG_RE.test(q)) return 'tag_q';
      if (hasWhPrefix(q)) return 'wh_q';
      if (/(^|[^\p{L}\p{N}_])или([^\p{L}\p{N}_]|$)/iu.test(q)) return 'alternative_q';
      return 'general_q';
    }
    if (clean.endsWith('!')) return 'exclam';
    return 'st';
  }

  function splitSentences(text) {
    return text.trim().split(SENT_SPLIT_RE).map((x) => x.trim()).filter(Boolean);
  }

  function classifyText(text) {
    if (!text || !text.trim()) return 'st';
    return splitSentences(text).map(classifySentence).join('|');
  }

  function charSentIds(text) {
    const ids = [];
    let pos = 0, sent = 0;
    SENT_SPLIT_RE.lastIndex = 0;
    for (const m of text.matchAll(SENT_SPLIT_RE)) {
      const end = m.index + m[0].length;
      for (let i = pos; i < end; i++) ids.push(sent);
      pos = end;
      sent++;
    }
    for (let i = pos; i < text.length; i++) ids.push(sent);
    return ids;
  }

  // ---------- Ударения и «ё» (AccentorNgram из Silero, без отдельной модели омографов) ----------

  const VOWELS = 'аоуыэиеяёю';
  const isVowel = (c) => VOWELS.includes(c);

  class Accentor {
    constructor(ngramsText, embInt8, meta) {
      this.index = new Map();
      ngramsText.split('\n').forEach((g, i) => this.index.set(g, i));
      this.emb = embInt8;
      this.dim = meta.emb.dim;
      this.scale = meta.emb.scale;
      this.zp = meta.emb.zero_point;
      this.stress = meta.stress;
      this.yo = meta.yo;
      this.exceptions = new Map(Object.entries(meta.exceptions));
      this.cache = new Map();
    }

    embed(word) {
      const ids = [];
      const s = `<${word}>`;
      for (let n = 1; n <= word.length + 3; n++) {
        for (let i = 0; i + n <= s.length; i++) {
          const id = this.index.get(s.slice(i, i + n));
          if (id !== undefined) ids.push(id);
        }
      }
      if (word.length < 1) { const id = this.index.get(word); if (id !== undefined) ids.push(id); }
      if (!ids.length) ids.push(this.index.get('UNK'));
      const v = new Float64Array(this.dim);
      for (const id of ids) {
        const off = id * this.dim;
        for (let k = 0; k < this.dim; k++) v[k] += this.scale * (this.emb[off + k] - this.zp);
      }
      for (let k = 0; k < this.dim; k++) v[k] /= ids.length;
      return v;
    }

    static mlp(x, layers) {
      let h = x;
      layers.forEach((L, li) => {
        const out = new Float64Array(L.b.length);
        for (let o = 0; o < out.length; o++) {
          let s = L.b[o];
          const w = L.w[o];
          for (let i = 0; i < h.length; i++) s += w[i] * h[i];
          out[o] = li < layers.length - 1 ? Math.max(0, s) : s;
        }
        h = out;
      });
      const mx = Math.max(...h);
      const e = Array.from(h, (z) => Math.exp(z - mx));
      const sum = e.reduce((a, b) => a + b, 0);
      const p = e.map((z) => z / sum);
      let arg = 0;
      for (let i = 1; i < p.length; i++) if (p[i] > p[arg]) arg = i;
      return { arg, prob: p[arg] };
    }

    predict(word) {
      let r = this.cache.get(word);
      if (!r) {
        const e = this.embed(word);
        r = { stress: Accentor.mlp(e, this.stress), yo: Accentor.mlp(e, this.yo) };
        if (this.cache.size > 5000) this.cache.clear();
        this.cache.set(word, r);
      }
      return r;
    }

    static tokenize(sentence) {
      const tokens = [], clean = [], mask = [];
      for (const word of sentence.split(/([\s.,!?;:<>=()/\\]+)/)) {
        const parts = word.split('-');
        let cur, curMask;
        if (parts.length === 1) { cur = parts; curMask = [true]; } else {
          cur = [...parts.slice(0, -1).map((p) => `${p}-`), parts[parts.length - 1]];
          curMask = [...parts.slice(0, -1).map(() => true), parts[parts.length - 1] !== 'то'];
        }
        cur.forEach((tok, i) => {
          const c = tok.toLowerCase().replace(/[^А-Яа-яёЁ]/g, '');
          tokens.push(tok);
          clean.push(c);
          mask.push(c.length > 0 && curMask[i]);
        });
      }
      return { tokens, clean, mask };
    }

    exception(clean, raw, haveStress) {
      const [excStress, excYo] = this.exceptions.get(clean);
      if (haveStress) {
        const userPos = [...raw].map((c, i) => (c === '+' ? i : -1)).filter((i) => i >= 0);
        let w = raw.replace(/\+/g, '');
        if (excYo !== -1 && userPos.includes(excYo + 1)) w = w.slice(0, excYo) + (w[excYo] === w[excYo].toLowerCase() ? 'ё' : 'Ё') + w.slice(excYo + 1);
        for (const p of userPos) w = `${w.slice(0, p)}+${w.slice(p)}`;
        return w;
      }
      if (excYo !== -1) raw = raw.slice(0, excYo) + (raw[excYo] === raw[excYo].toLowerCase() ? 'ё' : 'Ё') + raw.slice(excYo + 1);
      return `${raw.slice(0, excStress)}+${raw.slice(excStress)}`;
    }

    accentuate(sentence) {
      const { tokens, clean, mask } = Accentor.tokenize(sentence);
      const out = [];
      tokens.forEach((raw0, idx) => {
        let raw = raw0;
        const lower = raw.toLowerCase();
        const cw = clean[idx];
        if (!mask[idx]) { out.push(raw); return; }
        const haveStress = lower.includes('+');
        const haveYo = lower.includes('ё');
        if (haveStress && haveYo) { out.push(raw); return; }
        if (!haveStress && haveYo) {
          const pos = [...lower].map((c, i) => (c === 'ё' ? i : -1)).filter((i) => i >= 0);
          pos.forEach((p, i) => { raw = `${raw.slice(0, p + i)}+${raw.slice(p + i)}`; });
          out.push(raw);
          return;
        }
        if (this.exceptions.has(cw)) { out.push(this.exception(cw, raw, haveStress)); return; }
        const pred = this.predict(cw);
        let stressedIds = [pred.stress.arg];
        let setStress = pred.stress.prob > 0.5 && !haveStress;
        const yoIds = [pred.yo.arg];
        const setYo = pred.yo.prob > 0.5;
        if (haveStress) stressedIds = lower.split('+').map((part) => [...part].filter(isVowel).length);
        const vowelIds = [...lower].map((c, i) => (isVowel(c) ? i : -1)).filter((i) => i >= 0);
        const yeIds = [...lower].map((c, i) => (c === 'е' ? i : -1)).filter((i) => i >= 0);
        let stressPos = stressedIds.filter((k) => k < vowelIds.length && vowelIds.length > 0).map((k) => vowelIds[k]);
        const yoPos = yoIds.filter((k) => k > 0 && k - 1 < yeIds.length && yeIds.length > 0).map((k) => yeIds[k - 1]);
        if (!vowelIds.length) { out.push(raw); return; }
        for (const p of yoPos) {
          if (stressPos.includes(p) && setYo && lower[p] === 'е') raw = raw.slice(0, p) + (raw[p] === 'е' ? 'ё' : 'Ё') + raw.slice(p + 1);
        }
        if (vowelIds.length === 1) { stressPos = [vowelIds[0]]; setStress = true; }
        if (!haveStress && setStress) stressPos.forEach((p, i) => { raw = `${raw.slice(0, p + i)}+${raw.slice(p + i)}`; });
        out.push(raw);
      });
      return out.join('');
    }
  }

  // ---------- Омографы: «з+амок» или «зам+ок» — по смыслу фразы ----------
  // Порт HomoSolver из Silero: сначала готовые фразы-правила, иначе небольшая BERT-модель (homo.onnx)
  // смотрит на 150 символов слева и справа от слова и выбирает один из двух вариантов ударения.

  const HOMO_WINDOW = 300;
  const HOMO_WORD_RE = /(?=.*[а-яё])[а-яё+]+/gi;
  const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const isPunctChar = (c) => /[!-/:-@[-`{-~]/.test(c) || /\p{P}/u.test(c);

  /** Очистка контекста — как HomoSolver._clean_text. */
  function homoCleanText(text, isStart) {
    if (!text) return '';
    let t = text.replace(/[^a-zA-Zа-яА-ЯёЁ0-9\s.!?,-]/g, '');
    t = t.replace(/\s+/g, ' ').replace(/-{2,}/g, ' - ').replace(/([.!?])\1+/g, '$1').replace(/,{2,}/g, ',')
      .replace(/\s+([.,!?])/g, '$1').replace(/([.!?])\1+/g, '$1').replace(/,{2,}/g, ',')
      .replace(/([.,!?])(?=\S)/g, '$1 ').replace(/\s+/g, ' ').trim();
    if (isStart) {
      t = t.replace(/^[ .,!?-]+/, '');
      if (t) t = t[0].toUpperCase() + t.slice(1).toLowerCase();
    } else {
      if (t) t = t[0] + t.slice(1).toLowerCase();
      if (t && !'.!?'.includes(t[t.length - 1])) t += '.';
    }
    return t;
  }

  class HomoSolver {
    /**
     * meta — homo.json, vocabText — homo-vocab.txt, embInt8 — homo-emb.bin,
     * infer(emb Float32Array [T×dim], T, start, end) -> Promise<logit>.
     */
    constructor(meta, vocabText, embInt8, infer) {
      this.meta = meta;
      this.dict = meta.homodict;
      this.phrases = meta.phrases;
      this.vocab = new Map();
      vocabText.split('\n').forEach((t, i) => this.vocab.set(t, i));
      this.emb = embInt8;
      this.infer = infer;
      this.patterns = new Map();
      this.cache = new Map();
    }

    pattern(word) {
      let re = this.patterns.get(word);
      if (re === undefined) {
        const vs = this.phrases[word];
        re = vs ? new RegExp(vs.map(([, ps]) => `((?<![а-яА-ЯёЁ-])(?:${ps.map(escapeRe).join('|')})(?![а-яА-ЯёЁ-]))`).join('|'), 'i') : null;
        this.patterns.set(word, re);
      }
      return re;
    }

    /** Вариант по готовой фразе (например, «закрыть на замок»). */
    byPhrase(word, rawMark) {
      const re = this.pattern(word);
      const m = re && re.exec(rawMark);
      if (!m) return null;
      const g = m.findIndex((x, i) => i > 0 && x !== undefined);
      return this.phrases[word][g - 1][0];
    }

    /** Токены WordPiece — как SimpleBertTokenizer (без перевода в нижний регистр). */
    tokenize(text) {
      const { vocab } = this;
      const words = [];
      for (const w of text.replace(/\s+/g, ' ').trim().split(' ')) {
        if (!w) continue;
        if (w === '[HOMO]' || w === '[/HOMO]') { words.push(w); continue; }
        let cur = '';
        for (const c of w) {
          if (isPunctChar(c)) { if (cur) words.push(cur); words.push(c); cur = ''; } else cur += c;
        }
        if (cur) words.push(cur);
      }
      const ids = [this.meta.cls];
      for (const w of words) {
        const chars = [...w];
        if (chars.length > 100) { ids.push(this.meta.unk); continue; }
        const sub = [];
        let start = 0, bad = false;
        while (start < chars.length) {
          let end = chars.length, hit;
          while (start < end) {
            const piece = (start > 0 ? '##' : '') + chars.slice(start, end).join('');
            if (vocab.has(piece)) { hit = vocab.get(piece); break; }
            end--;
          }
          if (hit === undefined) { bad = true; break; }
          sub.push(hit);
          start = end;
        }
        if (bad) ids.push(this.meta.unk); else ids.push(...sub);
      }
      ids.push(this.meta.sep);
      return ids;
    }

    async byModel(word, rawMark) {
      const ids = this.tokenize(rawMark);
      const { dim, scale, zero_point: zp } = this.meta;
      const T = ids.length;
      const x = new Float32Array(T * dim);
      ids.forEach((id, t) => {
        const off = id * dim;
        for (let k = 0; k < dim; k++) x[t * dim + k] = scale * (this.emb[off + k] - zp);
      });
      const logit = await this.infer(x, T, ids.indexOf(this.meta.homo_start), ids.indexOf(this.meta.homo_end));
      return this.dict[word][logit > 0 ? 1 : 0]; // round(sigmoid(logit))
    }

    /** Ставит ударения (и «ё») в омографах фразы; остальные слова не трогает. */
    async solve(sentence) {
      const found = [];
      for (const m of sentence.matchAll(HOMO_WORD_RE)) {
        const word = m[0], lower = word.toLowerCase();
        if (!this.dict[lower] && !this.phrases[lower]) continue;
        const start = m.index, end = start + word.length;
        const left = homoCleanText(sentence.slice(0, start), true).slice(-HOMO_WINDOW / 2);
        const right = homoCleanText(sentence.slice(end), false).slice(0, HOMO_WINDOW / 2);
        const rawMark = `${left} [HOMO] ${lower} [/HOMO] ${right}`.trim();
        let variant = this.byPhrase(lower, rawMark);
        if (variant === null) {
          if (!this.dict[lower]) continue;
          variant = this.cache.get(rawMark);
          if (variant === undefined) {
            variant = await this.byModel(lower, rawMark);
            if (this.cache.size > 2000) this.cache.clear();
            this.cache.set(rawMark, variant);
          }
        }
        found.push({ start, end, word, variant });
      }
      let out = sentence, offset = 0;
      for (const { start, end, word, variant } of found) {
        const stress = variant.indexOf('+');
        const plain = variant.replace('+', '');
        let w = '';
        for (let i = 0; i < Math.min(word.length, plain.length); i++) {
          const c1 = word[i];
          w += c1 !== c1.toUpperCase() ? plain[i].toLowerCase() : plain[i].toUpperCase(); // регистр — как в исходном слове
        }
        w = `${w.slice(0, stress)}+${w.slice(stress)}`;
        out = out.slice(0, start + offset) + w + out.slice(end + offset);
        offset += w.length - (end - start);
      }
      return out;
    }
  }

  // ---------- Живая интонация ----------
  // Логическое ударение Silero: слово, обёрнутое в FOCUS_MARK, голос выделяет длительностью и тоном,
  // в EMPH_MARK — сильнее (всё предложение звучит с нажимом). В оригинале это *слово* и **слово**.

  const FOCUS_MARK = '', EMPH_MARK = '';
  const MARK_RE = /([])([^\s]+)\1/g;
  const MARKS_ANY = /[]/g;
  const FOCUS_SKIP = new Set('.,!?;:…–');
  const FOCUS_LEVEL = 3; // intensity по умолчанию в apply_tts
  const TYPE_EMPH = 6;   // тип предложения с эмфазой = обычный + 6
  const cleanWord = (w) => w.toLowerCase().replace(/[^а-яёa-z]/g, '');

  /** Что выделить голосом: термин перед «— это», слова в кавычках, «не X, а Y», «важно». */
  function markIntonation(text) {
    const F = (w) => FOCUS_MARK + w + FOCUS_MARK;
    const words = (t) => t.replace(/[А-Яа-яЁёA-Za-z0-9]+(?:-[А-Яа-яЁёA-Za-z0-9]+)*/g, F);
    let t = String(text);
    // «на руки» — короткая цитата целиком
    t = t.replace(/«([^«»]{1,40})»/g, (m, inner) => (inner.trim().split(/\s+/).length <= 4 ? `«${words(inner)}»` : m));
    // «Активные доходы — это …» — определяемый термин
    t = t.replace(/(^|[.!?…]\s+)([А-ЯЁ][а-яё]*(?:-[а-яё]+)?(?:\s+[а-яё]+(?:-[а-яё]+)?){0,2})(\s+[—–]\s+это\s)/g, (m, pre, term, rest) => pre + words(term) + rest);
    // «не физических, а юридических» — противопоставление
    t = t.replace(/(^|[^а-яёА-ЯЁ])([Нн]е)\s+([а-яё]+(?:-[а-яё]+)?)([^.!?,]{0,40}),\s+а\s+([а-яё]+(?:-[а-яё]+)?)/g,
      (m, pre, ne, x, mid, y) => `${pre}${ne} ${F(x)}${mid}, а ${F(y)}`);
    // «Это важно», «Запомните» — с нажимом
    t = t.replace(/(?<![а-яёА-ЯЁ])(важно|главное|обязательно|запомните)(?![а-яёА-ЯЁ])/gi, (w) => EMPH_MARK + w + EMPH_MARK);
    return t;
  }

  // Разговорные ударения на предлоге: «нá руки», «зá город», «пó полю», «нé был» — слово после предлога без ударения
  const PROCLITIC = {
    на: 'руки руку ноги ногу голову спину бок нос пол гору берег воду дом зиму лето день ночь год два три сто душу смех слово сторону плечи небо уши',
    за: 'руку руки ногу ноги голову спину город год день ночь зиму лето нос ухо уши волосы борт два три сто',
    по: 'полю лесу морю полу двое трое сто два три носу',
    под: 'гору ноги ногу руку руки нос вечер',
    из: 'дому лесу виду носу',
    без: 'вести толку',
    до: 'смерти дому ночи',
    от: 'роду',
    не: 'был было были',
  };
  const PROCLITIC_SET = Object.fromEntries(Object.entries(PROCLITIC).map(([k, v]) => [k, new Set(v.split(' '))]));
  /**
   * Предлог и слово сливаются в одно, как в живой речи: «н+а р+уки» -> «н+аруки» — модель тянет ударное «а»,
   * а «руки» звучит безударно. keep — какие символы исходной строки остались.
   */
  function shiftProclitics(accented) {
    const keep = new Array(accented.length).fill(true);
    const words = [...accented.matchAll(/[^ ]+/g)];
    for (let i = 0; i + 1 < words.length; i++) {
      const p = words[i][0], next = words[i + 1];
      if (!/^[а-яё]*\+[а-яё]*$/.test(p) || next.index !== words[i].index + p.length + 1) continue;
      const set = PROCLITIC_SET[p.replace('+', '')];
      if (!set || !set.has(next[0].replace(/[^а-яё]/g, ''))) continue;
      keep[next.index - 1] = false; // пробел
      [...next[0]].forEach((c, k) => { if (c === '+') keep[next.index + k] = false; });
    }
    return { text: [...accented].filter((_, i) => keep[i]).join(''), keep };
  }

  // ---------- Формулы — чуть медленнее ----------
  // В кусках диктовки формулы уже словами («E равно эм цэ квадрат», «дробь: a, делённое на b»), в вопросах и
  // своих текстах бывают и символами. Находим такие места и растягиваем их звуки на FORMULA_SLOW.

  const SLOW_OPEN = '', SLOW_CLOSE = '';
  const ALL_MARKS = /[-]/g;
  const FORMULA_SLOW = 1.15;
  const wordSet = (str) => new Set(str.split(' '));
  const F_STRONG = wordSet('плюс минус умножить умноженное умноженный умножено разделить делённое деленное делённый деленный поделить ' +
    'дробь квадрат квадрата квадрате куб куба кубе степени степень корень корня корнем интеграл интеграла индексом индекс индекса бесконечность стремится');
  const F_WEAK = wordSet('равно равна равен равны равняется примерно приблизительно больше меньше пропорционально');
  const F_VAR = wordSet('икс игрек зет зэт бэ вэ гэ дэ эф эм эн пэ эр эс тэ ка эль аш цэ кси ' +
    'альфа бета гамма дельта эпсилон дзета тэта каппа лямбда мю ню пи ро сигма тау фи хи пси омега');
  const F_FUNC = wordSet('синус синуса косинус косинуса тангенс тангенса котангенс котангенса логарифм логарифма экспонента экспоненты ' +
    'предел предела модуль модуля sin cos tg ctg tan cot ln lg log lim exp sqrt arcsin arccos arctg max min');
  const F_CONN = wordSet('от на в из под с по к скобка скобки скобках скобку открывается закрывается');
  const F_NUM = /^(\d+([.,]\d+)?|ноль|нуля|один|одна|одно|одного|одной|два|две|двух|двум|три|трёх|трех|трём|четыре|четырёх|пять|пяти|шесть|шести|семь|семи|восемь|восьми|девять|девяти|десять|десяти|одиннадцать|двенадцать|двадцать|тридцать|сорок|пятьдесят|сто|двести|триста|тысяча|тысячи|тысяч|половина|половины|треть|четверть|целых|целая|десятых|сотых|тысячных|нулю|нулём|единица|единицы|единице|единицу|единицей|двум|трём|трем)$/;
  const SUPERS = /[⁰¹²³⁴⁵⁶⁷⁸⁹]/;

  /** Вид слова в формуле: v — переменная, f — функция, n — число, s/w — сильный/слабый знак, c — связка, p — запятая, x — не формула. */
  function formulaKind(w) {
    if (/^\d/.test(w)) return SUPERS.test(w) ? 'v' : 'n';
    if (/^[A-Za-z]/.test(w) && !/[А-Яа-яЁё]/.test(w)) {
      const l = w.replace(SUPERS, '').toLowerCase();
      return F_FUNC.has(l) ? 'f' : l.length <= 3 ? 'v' : 'x';
    }
    if (/[А-Яа-яЁё]/.test(w)) {
      const l = w.toLowerCase();
      return F_STRONG.has(l) ? 's' : F_WEAK.has(l) ? 'w' : F_VAR.has(l) ? 'v' : F_FUNC.has(l) ? 'f' : F_CONN.has(l) ? 'c' : F_NUM.test(l) ? 'n' : 'x';
    }
    if ('=≈≠≤≥<>'.includes(w)) return 'w';
    if ('+−-×·*/^√∫∑'.includes(w)) return 's';
    if ('()→'.includes(w)) return 'c';
    if (',:'.includes(w)) return 'p';
    return 'x';
  }

  /** Оборачивает формулы текста в SLOW_OPEN … SLOW_CLOSE. */
  function markFormulas(text) {
    const toks = [];
    for (const m of String(text).matchAll(/[A-Za-zА-Яа-яЁё]+(?:-[A-Za-zА-Яа-яЁё]+)*[⁰¹²³⁴⁵⁶⁷⁸⁹]*|\d+(?:[.,]\d+)?[⁰¹²³⁴⁵⁶⁷⁸⁹]*|[^\s-]/g)) {
      toks.push({ s: m.index, e: m.index + m[0].length, k: formulaKind(m[0]), pow: SUPERS.test(m[0]) });
    }
    let out = '', last = 0;
    for (let i = 0; i < toks.length;) {
      if (toks[i].k === 'x') { i++; continue; }
      let j = i;
      while (j < toks.length && toks[j].k !== 'x') j++;
      let a = i, b = j - 1;
      while (a <= b && 'cp'.includes(toks[a].k)) a++;
      while (b >= a && 'cp'.includes(toks[b].k)) b--;
      const run = toks.slice(a, b + 1);
      const has = (k) => run.filter((t) => t.k === k).length;
      const strong = has('s') + run.filter((t) => t.pow).length;
      // переменная со знаком («икс плюс игрек», «E равно…») или арифметика из двух чисел («пять плюс три»)
      if (run.length >= 2 && ((has('v') + has('f') > 0 && strong + has('w') > 0) || (strong > 0 && has('n') >= 2))) {
        out += text.slice(last, toks[a].s) + SLOW_OPEN + text.slice(toks[a].s, toks[b].e) + SLOW_CLOSE;
        last = toks[b].e;
      }
      i = j;
    }
    return out + String(text).slice(last);
  }

  // ---------- Вход модели ----------

  /** Готовит фразу так же, как prepare_text_input в Silero. */
  function prepare(text, allowed) {
    let t = text.trim().replace(/\n/g, (m, off, s) => (off > 0 && ',;:.!?'.includes(s[off - 1]) ? ' ' : '. '));
    t = t.toLowerCase().replace(/—/g, '–').replace(/‑/g, '-');
    t = [...t].filter((c) => allowed.has(c)).join('');
    t = t.replace(/\^/g, ' ^').replace(/\s+/g, ' ').trim().replace(/\^ /g, '^').replace(/\^+/g, '^').trim();
    if (t.endsWith('^')) t = t.slice(0, -1).trim();
    return t;
  }

  function roundHalfEven(x) {
    const r = Math.round(x);
    return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
  }

  class Frontend {
    constructor(tts, accentor, homo = null) {
      this.tts = tts;
      this.acc = accentor;
      this.homo = homo;
      this.allowed = new Set([...tts.symbols.slice(3), '^']);
    }

    /**
     * Текст фразы -> { ids, types, dtypes, focus, spans, … } или null, если букв нет.
     * expressive — живая интонация: выделяет главное (markIntonation) и ставит разговорные ударения на предлогах.
     * Слова между FOCUS_MARK (логическое ударение) или EMPH_MARK (эмфаза) выделяются голосом.
     */
    async encode(rawText, { expressive = false } = {}) {
      let src = markFormulas(rawText);
      if (expressive) src = markIntonation(src);
      // формулы: номера слов [с, по) в подготовленном тексте
      const countWords = (t) => prepare(normalize(t.replace(ALL_MARKS, '')), this.allowed).split(' ').filter(Boolean).length;
      const slowWords = [];
      {
        let head = '', last = 0;
        for (const m of src.matchAll(/\uE003([^\uE004]*)\uE004/g)) {
          head += src.slice(last, m.index);
          const from = countWords(head);
          head += m[1];
          slowWords.push([from, countWords(head)]);
          last = m.index + m[0].length;
        }
        src = head + src.slice(last);
      }
      // выделенные слова: номер слова в подготовленном тексте и само слово
      const marks = [];
      let plain = '', last = 0;
      for (const m of src.matchAll(MARK_RE)) {
        plain += src.slice(last, m.index);
        const before = plain.replace(MARKS_ANY, '');
        const at = prepare(normalize(before), this.allowed).split(' ').filter(Boolean).length;
        normalize(m[2]).split(/\s+/).forEach((part, j) => {
          const word = cleanWord(part);
          if (word) marks.push({ at: at + j, word, emph: m[1] === EMPH_MARK });
        });
        plain += m[2];
        last = m.index + m[0].length;
      }
      plain = (plain + src.slice(last)).replace(MARKS_ANY, '');
      const original = normalize(plain);
      const sentence = prepare(original, this.allowed);
      if (!sentence.replace(/[^а-яё]/g, '')) return null;
      // как SileroStress: сначала омографы, затем остальные слова
      let accented = this.acc.accentuate(this.homo ? await this.homo.solve(sentence) : sentence);
      const words = [...accented.matchAll(/\S+/g)];
      // формулы: растягиваем все символы от первого до последнего слова
      let charSlow = new Array(accented.length).fill(0);
      for (const [from, to] of slowWords) {
        const w0 = words[from], w1 = words[to - 1];
        if (!w0 || !w1 || to <= from) continue;
        for (let i = w0.index; i < w1.index + w1[0].length; i++) charSlow[i] = 1;
      }
      // логическое ударение: уровень на символах выделенных слов (без знаков препинания)
      let charFocus = new Array(accented.length).fill(0);
      let emphAt = [];
      if (marks.length) {
        const used = new Set();
        for (const mk of marks) {
          let hit = -1;
          for (const d of [0, 1, -1, 2, -2]) {
            const w = words[mk.at + d];
            if (w && !used.has(mk.at + d) && cleanWord(w[0]) === mk.word) { hit = mk.at + d; break; }
          }
          if (hit < 0) continue;
          used.add(hit);
          const w = words[hit];
          [...w[0]].forEach((c, i) => { if (!FOCUS_SKIP.has(c)) charFocus[w.index + i] = FOCUS_LEVEL; });
          if (mk.emph) emphAt.push(w.index);
        }
      }
      if (expressive) {
        const sh = shiftProclitics(accented);
        const map = [];
        let j = 0;
        sh.keep.forEach((k, i) => { map[i] = j; if (k) j++; });
        accented = sh.text;
        charFocus = charFocus.filter((_, i) => sh.keep[i]);
        charSlow = charSlow.filter((_, i) => sh.keep[i]);
        emphAt = emphAt.map((i) => map[i]);
      }
      const toks = [this.tts.sos, ...accented, this.tts.eos];
      const ids = toks.map((c) => this.tts.symbol_to_id[c]).filter((v) => v !== undefined);
      // предложения на токенах: [начало, конец) без пробелов в конце
      const sentIds = charSentIds(toks.slice(1, -1).join(''));
      const nSent = sentIds.length ? sentIds[sentIds.length - 1] + 1 : 0;
      const spans = [];
      for (let k = 0; k < nSent; k++) {
        const idx = sentIds.map((s, i) => (s === k ? i + 1 : -1)).filter((i) => i >= 0);
        let a = idx[0], b = idx[idx.length - 1] + 1;
        while (b > a && toks[b - 1] === ' ') b--;
        spans.push([a, b]);
      }
      // тип каждого предложения — для интонации вопроса и восклицания
      let types = classifyText(original).split('|');
      if (types.length !== nSent) types = spans.map(([a, b]) => classifySentence(toks.slice(a, b).join('').replace(/\+/g, '')));
      const tids = types.map((t) => TYPE2ID[t] || 0);
      // как place_tokens: начало фразы — как первый символ, конец — 0
      const focus = [charFocus[0] || 0, ...charFocus, 0];
      const emphSpans = new Set(emphAt.map((c) => sentIds[c]).filter((k) => k !== undefined));
      const place = (shift) => {
        const values = sentIds.map((s) => tids[Math.min(s, tids.length - 1)] + (shift && emphSpans.has(s) ? TYPE_EMPH : 0));
        const out = new Array(toks.length).fill(0);
        values.forEach((v, i) => { if (i + 1 < toks.length - 1) out[i + 1] = v; });
        if (values.length) { out[0] = values[0]; out[toks.length - 1] = values[values.length - 1]; }
        return out;
      };
      return {
        ids, types: place(false), dtypes: place(true), focus, spans, spanTypes: spans.map((_, k) => tids[Math.min(k, tids.length - 1)]),
        emphSpans, hasFocus: focus.some((v) => v > 0), hasEmph: emphSpans.size > 0, accented, slow: [0, ...charSlow, 0],
      };
    }
  }

  const expm1 = (logDur) => Float64Array.from(logDur, (v) => Math.exp(v) - 1);

  /**
   * Длительности символов (в кадрах) из выхода модели — как cap_sos и fx_durs в оригинале:
   * обрезка начала и концовки фразы; во фразе с эмфазой начало длиннее.
   */
  function durations(lin, rate = 1, emph = false) {
    const n = lin.length;
    const sosCap = emph ? 20 : 5;
    const d = new Float64Array(n);
    for (let i = 0; i < n; i++) d[i] = roundHalfEven(Math.max(0, lin[i]));
    d[0] = Math.min(d[0], sosCap);
    if (rate !== 1) for (let i = 0; i < n; i++) d[i] = roundHalfEven(d[i] / rate);
    d[0] = Math.min(d[0], sosCap);
    if (emph) for (let i = 1; i < Math.min(5, n - 1); i++) d[i] = Math.max(d[i], 5);
    if (n >= 1) d[n - 1] = Math.min(d[n - 1], 7);
    if (n >= 2) d[n - 2] = 13;
    if (n >= 3) d[n - 3] = Math.min(d[n - 3], 13);
    return d;
  }

  /** Растягивает выход кодировщика по длительностям: [T, C] -> [F, C]. */
  function lengthRegulate(enc, T, C, durs) {
    let F = 0;
    const reps = new Int32Array(T);
    for (let i = 0; i < T; i++) { reps[i] = Math.floor(durs[i] + 0.5); F += reps[i]; }
    const out = new Float32Array(F * C);
    let o = 0;
    for (let i = 0; i < T; i++) {
      const row = enc.subarray(i * C, (i + 1) * C);
      for (let r = 0; r < reps[i]; r++) { out.set(row, o); o += C; }
    }
    return { x: out, F };
  }

  // ---------- Обратное преобразование Фурье (вокодер Vocos, окно 2400, шаг 600) ----------

  /**
   * Обратное комплексное БПФ длины n = 2^a·3^b·5^c (алгоритм Стокхема, смешанное основание).
   * Возвращает функцию (re, im) -> [re, im]; результат во внутренних буферах, без деления на n.
   */
  function makeIFFT(n) {
    const radices = [];
    let m = n;
    for (const r of [4, 2, 3, 5]) while (m % r === 0) { radices.push(r); m /= r; }
    if (m !== 1) throw new Error('n_fft');
    // для каждого этапа — повороты exp(+2πi·sj/(lp))
    const stages = [];
    let l = n, span = 1;
    for (const p of radices) {
      l /= p;
      const twR = new Float64Array(l * p), twI = new Float64Array(l * p);
      for (let j = 0; j < l; j++) {
        for (let s = 0; s < p; s++) {
          const a = (2 * Math.PI * s * j) / (l * p);
          twR[j * p + s] = Math.cos(a); twI[j * p + s] = Math.sin(a);
        }
      }
      stages.push({ p, l, span, twR, twI });
      span *= p;
    }
    const bufs = [new Float64Array(n), new Float64Array(n), new Float64Array(n), new Float64Array(n)];
    return (re, im) => {
      let xR = bufs[0], xI = bufs[1], yR = bufs[2], yI = bufs[3];
      xR.set(re); xI.set(im);
      for (const st of stages) {
        BUTTERFLY[st.p](st.l, st.span, xR, xI, yR, yI, st.twR, st.twI);
        [xR, yR] = [yR, xR];
        [xI, yI] = [yI, xI];
      }
      return [xR, xI];
    };
  }

  // Этап БПФ основания p: y[k + (jp+s)·span] = tw(s,j) · Σ_q x[k + j·span + q·l·span] · exp(+2πi·qs/p)
  const C3 = Math.sqrt(3) / 2;
  const C51 = Math.cos((2 * Math.PI) / 5), C52 = Math.cos((4 * Math.PI) / 5);
  const S51 = Math.sin((2 * Math.PI) / 5), S52 = Math.sin((4 * Math.PI) / 5);
  function put(yR, yI, o, r, i, wr, wi) { yR[o] = r * wr - i * wi; yI[o] = r * wi + i * wr; }
  const BUTTERFLY = {
    2(l, span, xR, xI, yR, yI, twR, twI) {
      const lm = l * span;
      for (let j = 0; j < l; j++) {
        const w = j * 2;
        for (let k = 0; k < span; k++) {
          const i0 = k + j * span, o = k + w * span;
          const ar = xR[i0], ai = xI[i0], br = xR[i0 + lm], bi = xI[i0 + lm];
          yR[o] = ar + br; yI[o] = ai + bi;
          put(yR, yI, o + span, ar - br, ai - bi, twR[w + 1], twI[w + 1]);
        }
      }
    },
    3(l, span, xR, xI, yR, yI, twR, twI) {
      const lm = l * span;
      for (let j = 0; j < l; j++) {
        const w = j * 3;
        for (let k = 0; k < span; k++) {
          const i0 = k + j * span, o = k + w * span;
          const r0 = xR[i0], i0v = xI[i0], r1 = xR[i0 + lm], i1 = xI[i0 + lm], r2 = xR[i0 + 2 * lm], i2 = xI[i0 + 2 * lm];
          const sr = r1 + r2, si = i1 + i2;
          const mr = r0 - sr / 2, mi = i0v - si / 2;
          const dr = (r1 - r2) * C3, di = (i1 - i2) * C3;
          yR[o] = r0 + sr; yI[o] = i0v + si;
          put(yR, yI, o + span, mr - di, mi + dr, twR[w + 1], twI[w + 1]);
          put(yR, yI, o + 2 * span, mr + di, mi - dr, twR[w + 2], twI[w + 2]);
        }
      }
    },
    4(l, span, xR, xI, yR, yI, twR, twI) {
      const lm = l * span;
      for (let j = 0; j < l; j++) {
        const w = j * 4;
        for (let k = 0; k < span; k++) {
          const i0 = k + j * span, o = k + w * span;
          const r0 = xR[i0], q0 = xI[i0], r1 = xR[i0 + lm], q1 = xI[i0 + lm];
          const r2 = xR[i0 + 2 * lm], q2 = xI[i0 + 2 * lm], r3 = xR[i0 + 3 * lm], q3 = xI[i0 + 3 * lm];
          const t0r = r0 + r2, t0i = q0 + q2, t1r = r0 - r2, t1i = q0 - q2;
          const t2r = r1 + r3, t2i = q1 + q3, t3r = r1 - r3, t3i = q1 - q3;
          yR[o] = t0r + t2r; yI[o] = t0i + t2i;
          put(yR, yI, o + span, t1r - t3i, t1i + t3r, twR[w + 1], twI[w + 1]);
          put(yR, yI, o + 2 * span, t0r - t2r, t0i - t2i, twR[w + 2], twI[w + 2]);
          put(yR, yI, o + 3 * span, t1r + t3i, t1i - t3r, twR[w + 3], twI[w + 3]);
        }
      }
    },
    5(l, span, xR, xI, yR, yI, twR, twI) {
      const lm = l * span;
      for (let j = 0; j < l; j++) {
        const w = j * 5;
        for (let k = 0; k < span; k++) {
          const i0 = k + j * span, o = k + w * span;
          const r0 = xR[i0], q0 = xI[i0];
          const r1 = xR[i0 + lm], q1 = xI[i0 + lm], r2 = xR[i0 + 2 * lm], q2 = xI[i0 + 2 * lm];
          const r3 = xR[i0 + 3 * lm], q3 = xI[i0 + 3 * lm], r4 = xR[i0 + 4 * lm], q4 = xI[i0 + 4 * lm];
          const a1r = r1 + r4, a1i = q1 + q4, b1r = r1 - r4, b1i = q1 - q4;
          const a2r = r2 + r3, a2i = q2 + q3, b2r = r2 - r3, b2i = q2 - q3;
          const m1r = r0 + C51 * a1r + C52 * a2r, m1i = q0 + C51 * a1i + C52 * a2i;
          const m2r = r0 + C52 * a1r + C51 * a2r, m2i = q0 + C52 * a1i + C51 * a2i;
          const n1r = S51 * b1r + S52 * b2r, n1i = S51 * b1i + S52 * b2i; // Y1,4 = m1 ± i·n1
          const n2r = S52 * b1r - S51 * b2r, n2i = S52 * b1i - S51 * b2i; // Y2,3 = m2 ± i·n2
          yR[o] = r0 + a1r + a2r; yI[o] = q0 + a1i + a2i;
          put(yR, yI, o + span, m1r - n1i, m1i + n1r, twR[w + 1], twI[w + 1]);
          put(yR, yI, o + 2 * span, m2r - n2i, m2i + n2r, twR[w + 2], twI[w + 2]);
          put(yR, yI, o + 3 * span, m2r + n2i, m2i - n2r, twR[w + 3], twI[w + 3]);
          put(yR, yI, o + 4 * span, m1r + n1i, m1i - n1r, twR[w + 4], twI[w + 4]);
        }
      }
    },
  };

  /** Спектр [bins, frames] (вещественная и мнимая части) -> звук. */
  function istft(re, im, bins, frames, window, nFft, hop) {
    const ifft = makeIFFT(nFft);
    const L = (frames - 1) * hop + nFft;
    const y = new Float64Array(L), env = new Float64Array(L);
    const zr = new Float64Array(nFft), zi = new Float64Array(nFft);
    const w2 = Float64Array.from(window, (w) => w * w);
    // сигнал вещественный, поэтому два кадра считаются одним БПФ: z = A + i·B -> ifft(z) = a + i·b
    for (let t = 0; t < frames; t += 2) {
      const u = t + 1 < frames ? t + 1 : -1;
      for (let k = 0; k < bins; k++) {
        const ar = re[k * frames + t], ai = k === 0 || k === bins - 1 ? 0 : im[k * frames + t];
        const br = u < 0 ? 0 : re[k * frames + u], bi = u < 0 || k === 0 || k === bins - 1 ? 0 : im[k * frames + u];
        zr[k] = ar - bi; zi[k] = ai + br;
        if (k > 0 && k < nFft - k) { zr[nFft - k] = ar + bi; zi[nFft - k] = br - ai; } // сопряжённая половина спектра
      }
      const [xr, xi] = ifft(zr, zi);
      for (const [frame, x] of [[t, xr], [u, xi]]) {
        if (frame < 0) continue;
        const off = frame * hop;
        for (let i = 0; i < nFft; i++) { y[off + i] += (x[i] / nFft) * window[i]; env[off + i] += w2[i]; }
      }
    }
    const pad = (nFft - hop) / 2;
    const out = new Float32Array(L - 2 * pad);
    for (let i = 0; i < out.length; i++) out[i] = y[i + pad] / env[i + pad];
    return out;
  }

  // модель озвучивает не больше 5000 кадров (≈ минута речи) за раз — длинный текст делим по предложениям
  const MAX_CHUNK = 300;

  /** Делит длинный текст на куски до max символов: по предложениям, затем по запятым, затем по словам. */
  function splitLong(text, max = MAX_CHUNK) {
    if (text.length <= max) return [text];
    const pieces = [];
    const cut = (t, re) => t.split(re).map((x) => x.trim()).filter(Boolean);
    for (const sent of cut(text, /(?<=[.!?…])\s+/)) {
      if (sent.length <= max) { pieces.push(sent); continue; }
      for (const part of cut(sent, /(?<=[,;:—–])\s+/)) {
        if (part.length <= max) { pieces.push(part); continue; }
        let cur = '';
        for (const w of part.split(/\s+/)) {
          if (cur && cur.length + 1 + w.length > max) { pieces.push(cur); cur = ''; }
          cur = cur ? cur + ' ' + w : w;
        }
        if (cur) pieces.push(cur);
      }
    }
    // соседние короткие куски склеиваем обратно, чтобы интонация не дробилась
    const out = [];
    for (const p of pieces) {
      if (out.length && out[out.length - 1].length + 1 + p.length <= max) out[out.length - 1] += ' ' + p;
      else out.push(p);
    }
    return out;
  }

  /**
   * Полный синтез текста. run(name, feeds) запускает модель ONNX и возвращает её выходы;
   * tensor(type, data, dims) создаёт тензор (ort.Tensor в браузере).
   */
  async function synthesize(frontend, run, tensor, text, opts = {}) {
    const parts = [];
    for (const piece of splitLong(text)) parts.push(await synthesizeOne(frontend, run, tensor, piece, opts));
    if (parts.length === 1) return parts[0];
    const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  async function synthesizeOne(frontend, run, tensor, text, { speaker = 'baya', rate = 1, pitch: pitchCoef = 1, expressive = false } = {}) {
    const enc = await frontend.encode(text, { expressive });
    if (!enc) return new Float32Array(0);
    const tts = frontend.tts;
    const { ids } = enc;
    const T = ids.length;
    const i64 = (arr, dims) => tensor('int64', BigInt64Array.from(arr, (v) => BigInt(v)), dims);
    const seq = i64(ids, [1, T]);
    const spkId = tts.speakers[speaker] ?? 1;
    const spk = i64([spkId], [1]);
    // модель длительностей и тона: dtypes — типы для длительностей (эмфаза +6), ptypes — для тона
    const prosody = (s, dt, pt, fo) => {
      const n = s.length;
      return run('prosody', { seq: i64(s, [1, n]), spk, dtypes: i64(dt, [1, n]), ptypes: i64(pt.map((v) => v % TYPE_EMPH), [1, n]), focus: i64(fo, [1, n]) });
    };
    const zeros = new Array(T).fill(0);
    let lin, pitch, givenPitch = false;
    if (!enc.hasFocus) {
      const p = await prosody(ids, enc.types, enc.types, zeros);
      lin = expm1(p.log_dur.data); pitch = Float32Array.from(p.pitch.data);
    } else if (enc.spans.length <= 1) {
      const p = await prosody(ids, enc.dtypes, enc.types, enc.focus);
      lin = expm1(p.log_dur.data); pitch = Float32Array.from(p.pitch.data);
      givenPitch = enc.hasEmph; // при эмфазе тон считается отдельно и идёт в модель как есть
    } else {
      // несколько предложений: тон выделенного предложения — по нему одному,
      // длительности — вместе с соседними предложениями, остальное — без выделения
      const base = await prosody(ids, enc.types, enc.types, zeros);
      lin = expm1(base.log_dur.data); pitch = Float32Array.from(base.pitch.data);
      givenPitch = true;
      const fm = enc.focus, sp = enc.spans;
      for (let k = 0; k < sp.length; k++) {
        const [a, b] = sp[k];
        if (!fm.slice(a, b).some((v) => v > 0)) continue;
        const tidPitch = enc.spanTypes[k];
        const tid = tidPitch + (enc.emphSpans.has(k) ? TYPE_EMPH : 0);
        const sSeq = [ids[0], ...ids.slice(a, b), ids[T - 1]];
        const sType = new Array(sSeq.length).fill(tidPitch);
        const sp1 = await prosody(sSeq, sType, sType, [fm[a], ...fm.slice(a, b), 0]);
        pitch.set(sp1.pitch.data.subarray(1, 1 + (b - a)), a);
        const lo = k > 0 ? sp[k - 1][0] : a;
        const hi = k + 1 < sp.length ? sp[k + 1][1] : b;
        const endK = k + 1 < sp.length ? sp[k + 1][0] : b;
        const focK = zeros.slice();
        for (let i = a; i < b; i++) focK[i] = fm[i];
        const typeK = enc.types.slice();
        for (let i = a; i < endK; i++) typeK[i] = tid;
        const wType = [typeK[lo], ...typeK.slice(lo, hi), typeK[hi - 1]];
        const wp = await prosody([ids[0], ...ids.slice(lo, hi), ids[T - 1]], wType, wType, [focK[lo], ...focK.slice(lo, hi), 0]);
        const wd = expm1(wp.log_dur.data);
        const a0 = enc.emphSpans.has(k) ? a + 1 : a;
        for (let i = a0; i < b; i++) lin[i] = wd[a0 - lo + 1 + (i - a0)];
      }
    }
    // формулы — чуть медленнее остального текста
    enc.slow.forEach((v, i) => { if (v) lin[i] *= FORMULA_SLOW; });
    const durs = durations(lin, rate, enc.dtypes[0] >= TYPE_EMPH);
    if (!givenPitch) {
      const shift = (pitchCoef - 1) * (tts.mean_std_coef?.[String(spkId)] || 0);
      for (let i = 0; i < pitch.length; i++) {
        if (Math.abs(pitch[i]) < 0.001) pitch[i] = 0;
        else if (pitchCoef !== 1) pitch[i] = pitch[i] * pitchCoef + shift;
      }
    }
    const e = await run('encoder', { seq, spk, pitch: tensor('float32', pitch, [1, 1, T]) });
    const C = e.enc.dims[2];
    const { x, F } = lengthRegulate(e.enc.data, T, C, durs);
    const h = await run('dec_pre', { x: tensor('float32', x, [1, F, C]) });
    const F3 = F + ((3 - (F % 3)) % 3);
    const hp = new Float32Array(F3 * C);
    hp.set(h.h.data);
    const mel = await run('dec_post', { h: tensor('float32', hp, [1, F3, C]), n: tensor('int64', BigInt64Array.from([BigInt(F)]), []) });
    const v = await run('vocoder', { mel: mel.mel });
    const bins = v.re.dims[1], frames = v.re.dims[2];
    return istft(v.re.data, v.im.data, bins, frames, tts.window, tts.n_fft, tts.hop);
  }

  root.SileroCore = { FOCUS_MARK, EMPH_MARK, markIntonation, markFormulas, shiftProclitics, normalize, numberWords, ordinalWords, classifyText, classifySentence, charSentIds, Accentor, HomoSolver, homoCleanText, Frontend, durations, istft, splitLong, synthesize, prepare };
})(typeof self !== 'undefined' ? self : globalThis);
