// Хранилище: настройки и прогресс — localStorage, тяжёлые данные проекта — IndexedDB.

import { FREE_PROXY } from './config.js';

const LS_SETTINGS = 'kd.settings';
const LS_PROGRESS = 'kd.progress';

// Keep failures visible without putting keys or user data into error messages.
export const storageFailures = new Set();
function storageResult(key, ok) {
  if (ok) storageFailures.delete(key); else storageFailures.add(key);
  window.dispatchEvent(new CustomEvent('kd-storage-state', { detail: { failed: storageFailures.size > 0 } }));
  return ok;
}
function writeLocal(key, value) {
  if (restoring) return storageResult(key, false);
  try { localStorage.setItem(key, JSON.stringify(value)); return storageResult(key, true); }
  catch { return storageResult(key, false); }
}

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
  abbreviate: false,      // диктовать сокращениями: «физ. лиц», «НДФЛ»
  formulasApart: true,    // 3+ формулы в теме — в отдельный блок, голос объясняет словами
  fxPause: false,         // пауза в диктовке, пока открыт блок формул
  remind: false,          // уведомление «пора повторить» (Periodic Background Sync)
  listenOnly: false,      // «Только слушаю»: текст подряд, без пауз на запись (в транспорте)
  voiceStyle: 'none',     // 'none' | 'jarvis' — стиль ИИ-ассистента
  address: '',            // обращение: '' | 'сэр' | 'мэм'
  pauseMode: 'time',      // 'time' — пауза по времени, 'wait' — ждать «дальше»
  adaptivePause: true,    // подстраивать паузы под скорость письма
  highlightWord: false,   // подсвечивать в тексте отрывка слово, которое сейчас звучит
  examCount: 10,          // экзамен: сколько вопросов
  examMinutes: 0,         // экзамен: ограничение по времени, минут (0 — без него)
  testCount: 10,          // тест с вариантами ответа: сколько вопросов
  writePace: 1,           // во сколько раз паузы длиннее (>1) или короче (<1) обычных — учится сам
  selfCheck: true,        // самопроверка после каждой темы
  retellAfter: false,     // после темы — пересказать её своими словами (нейросеть скажет, что упущено)
  breakEvery: 40,         // напоминать о перерыве каждые N минут (0 — не напоминать)
  headsetButtons: false,  // управление кнопками наушников
  contentLang: 'ru',      // 'ru' | 'en' — язык конспекта: распознавание, голос, команды и тексты нейросети
  uiLang: 'ru',           // 'ru' | 'en' — язык интерфейса (при первом запуске — язык браузера)
  theme: 'auto',          // 'auto' (как в системе: тёмная — «Аврора», светлая — «Чернила») | 'aurora' | 'ink' | 'android' | 'ios' | 'classic' | 'neon' | 'light'
  themePicked: false,     // оформление выбрано вручную (иначе — «как в системе»)
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
  const out = { ...DEFAULT_SETTINGS, profiles: {}, ...first, ...saved };
  if (!out.themePicked) out.theme = 'auto';
  // своего ключа нет — бесплатный режим через сервер автора (если он настроен)
  if (FREE_PROXY && !out.apiKey && out.provider === 'openrouter') out.provider = 'free';
  return out;
}

export function saveSettings(s) {
  return writeLocal(LS_SETTINGS, s);
}

// Прогресс хранится отдельно для каждого предмета: kd.progress:<id> (без id — старый общий ключ).
const progressKey = (id) => (id ? `${LS_PROGRESS}:${id}` : LS_PROGRESS);

export function loadProgress(id) {
  try { return JSON.parse(localStorage.getItem(progressKey(id)) || 'null'); } catch { return null; }
}

export function saveProgress(p, id) {
  return writeLocal(progressKey(id), p);
}

export function clearProgress(id) {
  if (restoring) return false;
  try { localStorage.removeItem(progressKey(id)); } catch { /* ignore */ }
}

// ---------- Предметы ----------

export function loadSubjects() {
  try { return JSON.parse(localStorage.getItem('kd.subjects') || 'null'); } catch { return null; }
}

export function saveSubjects(s) {
  return writeLocal('kd.subjects', s);
}

// --- IndexedDB (key-value) с запасным вариантом на localStorage ---

let dbPromise = null;
const RESTORE_JOURNAL = '__kd_restore_journal_v1__';
let restoring = false;
export const storageLocked = () => restoring;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('no idb'));
      const req = indexedDB.open('konspekt-diktor', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => {
        const d = req.result;
        d.onversionchange = () => { d.close(); dbPromise = null; };
        d.onclose = () => { dbPromise = null; };
        recoverRestore(d).then(() => resolve(d), (err) => { d.close(); reject(err); });
      };
      req.onerror = () => reject(req.error);
    }).catch((err) => { dbPromise = null; throw err; });
  }
  return dbPromise;
}

function transaction(d, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = d.transaction('kv', mode);
    const store = t.objectStore('kv');
    let req;
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new DOMException('Transaction aborted', 'AbortError'));
    try { req = fn(store); }
    catch (err) { t.abort(); reject(err); }
  });
}
function tx(mode, fn) {
  return db().then((d) => transaction(d, mode, fn));
}
function replaceLocal(values) {
  for (const k of Object.keys(localStorage)) {
    if (k.startsWith('kd.') && k !== 'kd.backupAt') localStorage.removeItem(k);
  }
  for (const [k, v] of Object.entries(values)) localStorage.setItem(k, v);
}
function replaceIDB(d, values, journal) {
  return transaction(d, 'readwrite', (s) => {
    s.clear();
    for (const [k, v] of Object.entries(values)) s.put(v, k);
    if (journal) s.put(journal, RESTORE_JOURNAL);
  });
}
// A crash can occur between IDB and localStorage commits. Never discard the old snapshot
// until both stores have been written. Recovery finishes before normal reads are allowed.
async function recoverRestore(d) {
  const journal = await transaction(d, 'readonly', (s) => s.get(RESTORE_JOURNAL));
  if (!journal) return;
  replaceLocal(journal.localStorage);
  await replaceIDB(d, journal.idb);
}

export async function idbGet(key) {
  if (restoring) throw new Error('Restore in progress; reload required');
  await writes.get(key);
  // A fallback was written after a failed IDB write and is newer than IDB.
  try {
    const fallback = localStorage.getItem('kd.idb.' + key);
    if (fallback !== null) return JSON.parse(fallback);
  } catch { storageResult('idb:' + key, false); }
  try { return await tx('readonly', (s) => s.get(key)); } catch (err) {
    // A read failure is not evidence that a subject is empty.
    storageResult('idb:' + key, false);
    throw err;
  }
}

const writes = new Map();
export function idbSet(key, value) {
  if (restoring || key === RESTORE_JOURNAL) return Promise.resolve(storageResult('idb:' + key, false));
  let snapshot;
  try { snapshot = structuredClone(value); }
  catch { return Promise.resolve(storageResult('idb:' + key, false)); }
  const write = (writes.get(key) || Promise.resolve()).then(() => writeIDB(key, snapshot));
  writes.set(key, write);
  write.finally(() => { if (writes.get(key) === write) writes.delete(key); });
  return write;
}

async function writeIDB(key, value) {
  try {
    await tx('readwrite', (s) => s.put(value, key));
    localStorage.removeItem('kd.idb.' + key);
    return storageResult('idb:' + key, true);
  } catch {
    try {
      const json = JSON.stringify(value);
      if (json === undefined) throw new Error('Not JSON');
      localStorage.setItem('kd.idb.' + key, json);
      return storageResult('idb:' + key, true);
    } catch { return storageResult('idb:' + key, false); }
  }
}

/** Все записи IndexedDB (для резервной копии). */
async function idbEntries() {
  try {
    const d = await db();
    return await new Promise((resolve, reject) => {
      const out = Object.create(null);
      const t = d.transaction('kv', 'readonly');
      const req = t.objectStore('kv').openCursor();
      req.onsuccess = () => { const c = req.result; if (c) { if (c.key !== RESTORE_JOURNAL) out[c.key] = c.value; c.continue(); } };
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('Transaction aborted'));
    });
  } catch (err) {
    storageResult('backup', false);
    throw err;
  }
}

// ---------- Резервная копия ----------

const BACKUP_APP = 'konspekt-diktor';

/** Все данные одним объектом: настройки и ключи, предметы, конспекты, прогресс. */
export async function makeBackup() {
  if (restoring) throw new Error('Restore in progress; reload required');
  return captureBackup();
}
async function captureBackup() {
  await Promise.all([...writes.values()]);
  const ls = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith('kd.') && k !== 'kd.backupAt') ls[k] = localStorage.getItem(k);
  }
  const idb = await idbEntries();
  // Include fallback records even when IDB is available but still holds old data.
  for (const [key, value] of Object.entries(ls)) {
    if (key.startsWith('kd.idb.')) idb[key.slice('kd.idb.'.length)] = JSON.parse(value);
  }
  storageResult('backup', true);
  return { app: BACKUP_APP, version: 1, at: Date.now(), localStorage: ls, idb };
}

/** Заменяет все данные приложения содержимым копии. */
export async function restoreBackup(data) {
  const record = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if (data?.app !== BACKUP_APP || data.version !== 1 || !record(data.localStorage) || !record(data.idb) ||
      Object.entries(data.localStorage).some(([k, v]) => !k.startsWith('kd.') || typeof v !== 'string') ||
      Object.hasOwn(data.idb, RESTORE_JOURNAL)) {
    throw new Error('Это не резервная копия Помощника по учёбе');
  }
  if (restoring) throw new Error('Restore in progress; reload required');
  const incoming = structuredClone(data);
  // Legacy backups may contain fallback records newer than their IDB counterparts.
  for (const [key, value] of Object.entries(incoming.localStorage)) {
    if (key.startsWith('kd.idb.')) {
      Object.defineProperty(incoming.idb, key.slice('kd.idb.'.length), {
        value: JSON.parse(value), enumerable: true, configurable: true, writable: true,
      });
      delete incoming.localStorage[key];
    }
  }
  if (Object.hasOwn(incoming.idb, RESTORE_JOURNAL)) throw new Error('Invalid backup');
  restoring = true;
  let d;
  try {
    const previous = await captureBackup();
    d = await db();
    // clear + all puts + old snapshot form one atomic transaction.
    await replaceIDB(d, incoming.idb, previous);
    replaceLocal(incoming.localStorage);
    await transaction(d, 'readwrite', (s) => s.delete(RESTORE_JOURNAL));
    storageResult('restore', true);
    // Keep old-page background writes blocked until the UI reloads.
  } catch (err) {
    try { if (d) await recoverRestore(d); restoring = false; }
    catch { /* Journal remains durable; retry recovery on the next open. */ }
    storageResult('restore', false);
    throw err;
  }
}

export async function idbDel(key) {
  if (restoring || key === RESTORE_JOURNAL) return false;
  try { await tx('readwrite', (s) => s.delete(key)); } catch { /* ignore */ }
  try { localStorage.removeItem('kd.idb.' + key); } catch { /* ignore */ }
}
