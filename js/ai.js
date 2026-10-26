// Выбор провайдера нейросети: Gemini (свой формат API) или любой OpenAI-совместимый (OpenRouter, DeepSeek, Mistral, свой адрес).

import * as gemini from './gemini.js';
import * as openai from './openai.js';
import * as anthropic from './anthropic.js';

export { GeminiError as AIError } from './gemini.js';

export const PROVIDERS = {
  openrouter: {
    name: 'OpenRouter (работает из России, есть бесплатные модели)',
    kind: 'openai',
    base: 'https://openrouter.ai/api/v1',
    model: 'google/gemini-2.5-flash',
    models: ['google/gemini-2.5-flash', 'anthropic/claude-sonnet-4.5', 'deepseek/deepseek-chat-v3.1', 'openai/gpt-4o-mini'],
    keyUrl: 'https://openrouter.ai/keys',
    keyHint: 'sk-or-…',
  },
  anthropic: {
    name: 'Claude (Anthropic API)',
    kind: 'anthropic',
    base: 'https://api.anthropic.com/v1',
    model: 'claude-opus-5-5',
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'],
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keyHint: 'sk-ant-…',
  },
  gemini: {
    name: 'Google Gemini',
    kind: 'gemini',
    base: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-2.5-flash',
    models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro', 'gemini-flash-latest'],
    keyUrl: 'https://aistudio.google.com/apikey',
    keyHint: 'AIza…',
  },
  deepseek: {
    name: 'DeepSeek (без распознавания фото)',
    kind: 'openai',
    base: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    keyUrl: 'https://platform.deepseek.com/api_keys',
    keyHint: 'sk-…',
  },
  mistral: {
    name: 'Mistral',
    kind: 'openai',
    base: 'https://api.mistral.ai/v1',
    model: 'mistral-small-latest',
    models: ['mistral-small-latest', 'mistral-medium-latest', 'mistral-large-latest'],
    keyUrl: 'https://console.mistral.ai/api-keys',
    keyHint: '',
  },
  custom: {
    name: 'Свой OpenAI-совместимый адрес',
    kind: 'openai',
    base: '',
    model: '',
    models: [],
    keyUrl: '',
    keyHint: '',
  },
};

/** Параметры подключения из настроек: передаются в generate/stream. */
export function conn(settings) {
  const p = PROVIDERS[settings.provider] || PROVIDERS.gemini;
  const base = (settings.baseUrl || '').trim();
  return {
    kind: p.kind,
    apiKey: settings.apiKey,
    model: settings.model || p.model,
    baseUrl: base || p.base,
    fallbacks: settings.provider === 'openrouter' ? settings.fallbackModels || [] : [],
    lang: settings.contentLang === 'en' ? 'en' : 'ru',
  };
}

export const providerName = (settings) => (PROVIDERS[settings.provider] || PROVIDERS.gemini).name.replace(/ \(.*\)$/, '');

const IMPL = { gemini, openai, anthropic };
const impl = (opts) => IMPL[opts.kind] || gemini;

// Конспект на английском: инструкции у нейросети русские, а всё, что она пишет для студента, — по-английски
const EN_NOTE = '\n\nВАЖНО: конспект и студент — на английском языке. Всё, что ты пишешь для студента (названия тем, куски диктовки, ' +
  'пояснения, примеры, выжимки, вопросы и ответы, исправленный текст), пиши на английском; правила произношения русских чисел и букв не применяй. ' +
  'Служебные поля JSON и их названия не меняй.';
const withLang = (opts) => (opts.lang === 'en' ? { ...opts, system: (opts.system || '') + EN_NOTE } : opts);

export const generate = (opts) => impl(opts).generate(withLang(opts));
export const stream = (opts) => impl(opts).stream(withLang(opts));
export const listModels = (c) => impl(c).listModels(c.apiKey, c.baseUrl);

/** Запрос, ожидающий JSON. При битом JSON — повтор. */
export async function generateJSON(opts) {
  let lastErr;
  for (let i = 0; i < 3; i++) {
    const text = await generate({ ...opts, json: true });
    try { return gemini.parseJSON(text); } catch (e) {
      lastErr = e;
      (opts.onStatus || (() => {}))('Ответ не разобран, повторяю запрос…');
    }
  }
  throw new gemini.GeminiError('Нейросеть вернула некорректный JSON', { code: 'BAD_JSON', cause: lastErr });
}
