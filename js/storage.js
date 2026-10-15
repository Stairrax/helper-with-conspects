// Хранилище: настройки и прогресс — localStorage, тяжёлые данные проекта — IndexedDB.

const LS_SETTINGS = 'kd.settings';
const LS_PROGRESS = 'kd.progress';

export const DEFAULT_SETTINGS = {
  provider: 'openrouter', // см. PROVIDERS в ai.js
  apiKey: '',             // ключ, модель и адрес текущего провайдера
  model: 'google/gemini-2.5-flash',
  baseUrl: '',            // пусто — адрес провайдера по умолчанию
  profiles: {},           // сохранённые ключ/модель/адрес остальных провайдеров
  fallbackModels: [],     // запасные модели OpenRouter (подбирает мастер настройки)
  rate: 1,
  pause: 3,
  voiceURI: '',
  mode: 'all',          // 'all' — всё подряд, 'topic' — по теме с вопросами после каждой
  voiceCommands: true,
  bargeIn: false,       // прерывать при любой речи (только с наушниками)
  scalePause: true,     // пауза зависит от сложности темы и длины куска
  coverageCheck: true,
  showText: true,
};

export function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}'); } catch { /* ignore */ }
  // настройки до появления выбора провайдера относились к Gemini
  if (saved.apiKey !== undefined && !saved.provider) {
    saved.provider = 'gemini';
    if (!saved.model) saved.model = 'gemini-2.5-flash';
  }
  return { ...DEFAULT_SETTINGS, profiles: {}, ...saved };
}

export function saveSettings(s) {
  try { localStorage.setItem(LS_SETTINGS, JSON.stringify(s)); } catch { /* приватный режим */ }
}

export function loadProgress() {
  try { return JSON.parse(localStorage.getItem(LS_PROGRESS) || 'null'); } catch { return null; }
}

export function saveProgress(p) {
  try { localStorage.setItem(LS_PROGRESS, JSON.stringify(p)); } catch { /* ignore */ }
}

export function clearProgress() {
  try { localStorage.removeItem(LS_PROGRESS); } catch { /* ignore */ }
}

// --- IndexedDB (key-value) с запасным вариантом на localStorage ---

let dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('no idb'));
      const req = indexedDB.open('konspekt-diktor', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx(mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction('kv', mode);
    const store = t.objectStore('kv');
    const req = fn(store);
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export async function idbGet(key) {
  try { return await tx('readonly', (s) => s.get(key)); } catch {
    try { return JSON.parse(localStorage.getItem('kd.idb.' + key) || 'null'); } catch { return null; }
  }
}

export async function idbSet(key, value) {
  try { await tx('readwrite', (s) => s.put(value, key)); } catch {
    localStorage.setItem('kd.idb.' + key, JSON.stringify(value));
  }
}

export async function idbDel(key) {
  try { await tx('readwrite', (s) => s.delete(key)); } catch { /* ignore */ }
  try { localStorage.removeItem('kd.idb.' + key); } catch { /* ignore */ }
}
