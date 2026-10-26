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
  // микрофон и во время речи (мгновенный «стоп» голосом). На Android распознавание забирает звук:
  // голос обрывается и глохнет, поэтому там по умолчанию слушаем только в паузах
  listenWhileSpeaking: typeof navigator === 'undefined' || !/Android/i.test(navigator.userAgent),
  bargeIn: false,       // прерывать при любой речи (только с наушниками)
  btStopOnly: true,     // с Bluetooth-наушниками микрофон только после «СТОП» — иначе звук «как по телефону»
  scalePause: true,     // пауза зависит от сложности темы и длины куска
  coverageCheck: true,
  showText: true,
  voiceEngine: 'system',  // 'system' — голос Android, 'neural' — нейросетевой голос на телефоне
  neuralVoice: 'silero-baya',
  intonation: true,       // живая интонация голосов Silero: логические ударения, «нá руки»
  abbreviate: false,      // диктовать сокращениями: «физ. лиц», «НДФЛ»
  formulasApart: true,    // 3+ формулы в теме — в отдельный блок, голос объясняет словами
  fxPause: false,         // пауза в диктовке, пока открыт блок формул
  remind: false,          // уведомление «пора повторить» (Periodic Background Sync)
  listenOnly: false,      // «Только слушаю»: текст подряд, без пауз на запись (в транспорте)
  voiceStyle: 'none',     // 'none' | 'jarvis' — стиль ИИ-ассистента
  address: '',            // обращение: '' | 'сэр' | 'мэм'
  pauseMode: 'time',      // 'time' — пауза по времени, 'wait' — ждать «дальше»
  adaptivePause: true,    // удлинять паузу, если часто просят повторить
  selfCheck: true,        // самопроверка после каждой темы
  breakEvery: 40,         // напоминать о перерыве каждые N минут (0 — не напоминать)
  headsetButtons: false,  // управление кнопками наушников
  contentLang: 'ru',      // 'ru' | 'en' — язык конспекта: распознавание, голос, команды и тексты нейросети
  uiLang: 'ru',           // 'ru' | 'en' — язык интерфейса (при первом запуске — язык браузера)
  theme: 'classic',       // 'classic' | 'neon' | 'light' | 'auto' (как в системе) — оформление
  ripple: true,           // «капля» при нажатии на кнопки
};

export function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}'); } catch { /* ignore */ }
  // настройки до появления выбора провайдера относились к Gemini
  if (saved.apiKey !== undefined && !saved.provider) {
    saved.provider = 'gemini';
    if (!saved.model) saved.model = 'gemini-2.5-flash';
  }
  // облачного голоса больше нет: в наушниках он звучал «как по телефону» — переходим на живой голос на телефоне
  const cloudKeys = ['cloudProvider', 'cloudVoice', 'cloudKey', 'yandexUrl', 'voiceClarity', 'yandexFormat'];
  if (saved.voiceEngine === 'cloud' || cloudKeys.some((k) => k in saved)) {
    if (saved.voiceEngine === 'cloud') {
      saved.voiceEngine = 'neural';
      saved.neuralVoice = 'silero-baya';
    }
    for (const k of cloudKeys) delete saved[k]; // ключи облачных сервисов больше не храним
    saveSettings(saved);
  }
  // первый запуск — язык интерфейса и конспекта по языку браузера
  const first = {};
  if (!Object.keys(saved).length && typeof navigator !== 'undefined' && !/^(ru|uk|be|kk)/i.test(navigator.language || 'ru')) {
    first.uiLang = 'en';
    first.contentLang = 'en';
    first.neuralVoice = 'en-lessac';
  }
  return { ...DEFAULT_SETTINGS, profiles: {}, ...first, ...saved };
}

export function saveSettings(s) {
  try { localStorage.setItem(LS_SETTINGS, JSON.stringify(s)); } catch { /* приватный режим */ }
}

// Прогресс хранится отдельно для каждого предмета: kd.progress:<id> (без id — старый общий ключ).
const progressKey = (id) => (id ? `${LS_PROGRESS}:${id}` : LS_PROGRESS);

export function loadProgress(id) {
  try { return JSON.parse(localStorage.getItem(progressKey(id)) || 'null'); } catch { return null; }
}

export function saveProgress(p, id) {
  try { localStorage.setItem(progressKey(id), JSON.stringify(p)); } catch { /* ignore */ }
}

export function clearProgress(id) {
  try { localStorage.removeItem(progressKey(id)); } catch { /* ignore */ }
}

// ---------- Предметы ----------

export function loadSubjects() {
  try { return JSON.parse(localStorage.getItem('kd.subjects') || 'null'); } catch { return null; }
}

export function saveSubjects(s) {
  try { localStorage.setItem('kd.subjects', JSON.stringify(s)); } catch { /* ignore */ }
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

/** Все записи IndexedDB (для резервной копии). */
async function idbEntries() {
  try {
    const d = await db();
    return await new Promise((resolve, reject) => {
      const out = {};
      const t = d.transaction('kv', 'readonly');
      const req = t.objectStore('kv').openCursor();
      req.onsuccess = () => { const c = req.result; if (c) { out[c.key] = c.value; c.continue(); } };
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
    });
  } catch { return {}; }
}

// ---------- Резервная копия ----------

const BACKUP_APP = 'konspekt-diktor';

/** Все данные одним объектом: настройки и ключи, предметы, конспекты, прогресс. */
export async function makeBackup() {
  const ls = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith('kd.') && k !== 'kd.backupAt') ls[k] = localStorage.getItem(k);
  }
  return { app: BACKUP_APP, version: 1, at: Date.now(), localStorage: ls, idb: await idbEntries() };
}

/** Заменяет все данные приложения содержимым копии. */
export async function restoreBackup(data) {
  if (data?.app !== BACKUP_APP || !data.localStorage || typeof data.localStorage !== 'object') {
    throw new Error('Это не резервная копия Диктора конспектов');
  }
  try { await tx('readwrite', (s) => s.clear()); } catch { /* ignore */ }
  for (const k of Object.keys(localStorage)) if (k.startsWith('kd.') && k !== 'kd.backupAt') localStorage.removeItem(k);
  for (const [k, v] of Object.entries(data.localStorage)) localStorage.setItem(k, String(v));
  for (const [k, v] of Object.entries(data.idb || {})) await idbSet(k, v);
}

export async function idbDel(key) {
  try { await tx('readwrite', (s) => s.delete(key)); } catch { /* ignore */ }
  try { localStorage.removeItem('kd.idb.' + key); } catch { /* ignore */ }
}
