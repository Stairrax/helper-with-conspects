// Язык интерфейса. Интерфейс написан по-русски; для английского текст на экране переводится по словарю
// (i18n-en.js) прямо в странице — при запуске и всякий раз, когда приложение что-то меняет (MutationObserver).
// Конспект, ответы нейросети, названия тем и предметов не трогаем: всё внутри [data-no-i18n] остаётся как есть.

import { EXACT, PATTERNS, WORDS } from './i18n-en.js';

const CYR = /[а-яё]/i;
const ATTRS = ['placeholder', 'title', 'aria-label', 'label'];
const SKIP = 'script,style,svg,[data-no-i18n]';

let lang = 'ru';
const exact = new Map(Object.entries(EXACT).map(([k, v]) => [norm(k), v]));
const done = new WeakMap(); // текстовый узел → то, что мы в него записали

function norm(s) {
  return s.replace(/[\s ]+/g, ' ').trim();
}

export const uiLang = () => lang;

/** Перевод строки интерфейса (для английского; по-русски — как есть). */
export function T(s) {
  if (lang !== 'en' || s == null) return s;
  return translate(String(s));
}

export function translate(s) {
  if (!CYR.test(s)) return s;
  const lead = s.match(/^[\s ]*/)[0];
  const trail = s.slice(lead.length).match(/[\s ]*$/)[0];
  const core = norm(s);
  return lead + translateCore(core) + trail;
}

function translateCore(core) {
  const hit = exact.get(core);
  if (hit !== undefined) return hit;
  for (const [re, to] of PATTERNS) {
    const m = core.match(re);
    if (m) return typeof to === 'function' ? to(m, translateCore) : core.replace(re, to);
  }
  // составные строки («Тема 2 из 5 · 3 формулы»): части через « · » переводим по отдельности
  if (core.includes(' · ')) return core.split(' · ').map(translateCore).join(' · ');
  // несколько предложений: самые длинные известные куски подряд, остальное — по одному предложению
  const parts = core.split(/(?<=[.!?…])\s+(?=[«(А-ЯЁA-Z✓✗])/);
  if (parts.length > 1) {
    const out = [];
    for (let i = 0; i < parts.length;) {
      let j = parts.length;
      for (; j > i + 1; j--) if (known(parts.slice(i, j).join(' '))) break;
      out.push(translateCore(parts.slice(i, j).join(' ')));
      i = j;
    }
    return out.join(' ');
  }
  let out = core;
  for (const [re, to] of WORDS) out = out.replace(re, to);
  return out;
}

function known(s) {
  return exact.has(s) || PATTERNS.some(([re]) => re.test(s));
}

function textNode(n) {
  if (done.get(n) === n.data) return;
  if (!CYR.test(n.data)) return;
  const p = n.parentElement;
  if (!p || p.closest(SKIP)) return;
  const en = translate(n.data);
  done.set(n, en);
  if (en !== n.data) n.data = en;
}

function attrs(el) {
  if (el.closest(SKIP)) return;
  for (const a of ATTRS) {
    const v = el.getAttribute(a);
    if (v && CYR.test(v)) el.setAttribute(a, translate(v));
  }
}

function walk(root) {
  if (root.nodeType === 3) return textNode(root);
  if (root.nodeType !== 1) return;
  if (root.matches(SKIP)) return;
  attrs(root);
  const it = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: (n) => (n.nodeType === 1 && n.matches(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = it.nextNode(); n; n = it.nextNode()) {
    if (n.nodeType === 3) textNode(n); else attrs(n);
  }
}

/** Включает язык интерфейса. Вызывается один раз при запуске; смена языка — с перезагрузкой страницы. */
export function setUiLang(l) {
  lang = l === 'en' ? 'en' : 'ru';
  document.documentElement.lang = lang;
  if (lang === 'en') {
    walk(document.documentElement);
    new MutationObserver((list) => {
      for (const m of list) {
        if (m.type === 'characterData') textNode(m.target);
        else if (m.type === 'attributes') attrs(m.target);
        else for (const n of m.addedNodes) walk(n);
      }
    }).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    for (const f of ['alert', 'confirm']) {
      const orig = window[f].bind(window);
      window[f] = (msg) => orig(T(msg));
    }
    const prompt = window.prompt.bind(window);
    window.prompt = (msg, def) => prompt(T(msg), def == null ? def : T(def));
  }
  document.documentElement.classList.remove('i18n-wait');
}
