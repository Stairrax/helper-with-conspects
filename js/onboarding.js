// Мастер первого запуска: ключ OpenRouter → автоматический подбор бесплатной модели → проверка звука и микрофона.

import { IOS } from './platform.js';
import { speak, stopSpeaking, loadVoices, getVoices, ttsSupported, srSupported, checkAudioDevices } from './speech.js';

const OR_BASE = 'https://openrouter.ai/api/v1';
const DONE_KEY = 'kd.onboarded';

const $ = (id) => document.getElementById(id);

export const onboardingDone = () => { try { return localStorage.getItem(DONE_KEY) === '1'; } catch { return false; } };
const markDone = () => { try { localStorage.setItem(DONE_KEY, '1'); } catch { /* ignore */ } };

// ---------- OpenRouter ----------

/** Проверяет ключ. -> { ok, free } или бросает ошибку с понятным текстом. */
async function checkKey(key) {
  for (const path of ['/key', '/auth/key']) {
    let res;
    try {
      res = await fetch(OR_BASE + path, { headers: { Authorization: 'Bearer ' + key } });
    } catch {
      throw new Error('Нет связи с OpenRouter. Проверьте интернет.');
    }
    if (res.status === 401 || res.status === 403) throw new Error('Ключ не подошёл. Скопируйте его ещё раз целиком — он начинается с «sk-or-».');
    if (res.ok) {
      const data = (await res.json().catch(() => ({}))).data || {};
      return { ok: true, free: data.is_free_tier !== false };
    }
  }
  return { ok: true, free: true }; // эндпоинт проверки недоступен — ключ проверится первым запросом
}

const isFree = (m) => m.id.endsWith(':free') ||
  (Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0 && !/^openrouter\//.test(m.id));
const hasVision = (m) => (m.architecture?.input_modalities || []).includes('image') || /->/.test(m.architecture?.modality || '') && /image/.test((m.architecture?.modality || '').split('->')[0]);

/** Оценка пригодности модели для конспектов на русском. */
function score(m) {
  let s = 0;
  if (hasVision(m)) s += 100;                         // нужна для фото страниц
  s += Math.min(60, (m.context_length || 0) / 4000);  // большие конспекты
  const id = m.id.toLowerCase();
  const family = [[/gemini/, 60], [/deepseek/, 45], [/qwen/, 40], [/llama-4|llama4/, 35], [/mistral|mixtral/, 30], [/gemma/, 25], [/llama/, 15]];
  for (const [re, b] of family) if (re.test(id)) { s += b; break; }
  if (/r1|reason|think|coder|math|guard|embed|tts|audio|vision-preview/.test(id)) s -= 50; // медленные или узкие модели
  const size = parseFloat((id.match(/(\d+(?:\.\d+)?)b\b/) || [])[1]);                     // число параметров, млрд
  if (size && size < 12) s -= 80; else if (size && size < 30) s -= 20;                    // маленькие модели хуже пишут
  if (/mini|nano|tiny/.test(id)) s -= 40;
  return s;
}

/** Бесплатные модели OpenRouter, лучшие первыми. */
async function freeModels() {
  const res = await fetch(OR_BASE + '/models');
  const data = await res.json();
  return (data.data || [])
    .filter((m) => isFree(m) && (m.architecture?.output_modalities || ['text']).includes('text'))
    .map((m) => ({ id: m.id, vision: hasVision(m), score: score(m) }))
    .sort((a, b) => b.score - a.score);
}

// ---------- Мастер ----------

/**
 * hooks: getSettings(), save(), liveVoice(statusEl) -> Promise<boolean>, onFinish(goSettings), importFile(),
 *   free — есть бесплатный режим: ключ не нужен, мастер сразу переходит к звуку
 */
export function initOnboarding(hooks) {
  const root = $('onboard');
  const steps = [...root.querySelectorAll('.ob-step')];
  const show = (i) => steps.forEach((s, j) => s.classList.toggle('hidden', i !== j));
  const open = (step = 0) => { root.classList.remove('hidden'); show(step); };
  const close = (goSettings = false) => {
    stopSpeaking();
    root.classList.add('hidden');
    markDone();
    hooks.onFinish(goSettings);
  };

  if (hooks.free) {
    $('obNeedKey').textContent = 'Ничего настраивать не нужно: нейросеть уже подключена.';
    $('obStart').textContent = 'Начать';
    $('obOwnKey').classList.remove('hidden');
  }
  $('obStart').addEventListener('click', () => {
    if (!hooks.free) { $('obStep2').textContent = 'Шаг 2 из 2'; show(1); return; }
    const s = hooks.getSettings();
    // у бесплатного режима мало запросов в день — проверка полноты кусков удвоила бы их число
    if (!s.apiKey) { s.provider = 'free'; s.coverageCheck = false; hooks.save(); }
    $('obStep2').textContent = 'Последний шаг';
    show(2);
  });
  $('obOwnKey').addEventListener('click', () => { $('obStep2').textContent = 'Шаг 2 из 2'; show(1); });
  // присланный готовый конспект диктуется без ключа — мастер можно пройти потом (Настройки → Настроить заново)
  $('obImport').addEventListener('click', () => { close(false); hooks.importFile?.(); });
  $('obOther').addEventListener('click', () => close(true));
  $('obOpenKeys').addEventListener('click', () => window.open('https://openrouter.ai/keys', '_blank', 'noopener'));
  $('obPaste').addEventListener('click', async () => {
    try {
      const t = (await navigator.clipboard.readText()).trim();
      if (t) $('obKey').value = t;
      else $('obStatus').textContent = 'Буфер обмена пуст — скопируйте ключ на сайте OpenRouter.';
    } catch {
      $('obStatus').textContent = 'Не удалось вставить автоматически — нажмите на поле и вставьте ключ вручную.';
    }
  });

  $('obCheck').addEventListener('click', async () => {
    const key = $('obKey').value.trim().replace(/\s+/g, '');
    const st = $('obStatus');
    st.className = 'ob-status';
    if (!key) { st.textContent = 'Сначала вставьте ключ.'; return; }
    const btn = $('obCheck');
    btn.disabled = true;
    try {
      st.textContent = 'Проверяю ключ…';
      await checkKey(key);
      st.textContent = 'Ключ подходит. Подбираю бесплатную модель…';
      const models = await freeModels();
      if (!models.length) throw new Error('Не нашёл бесплатных моделей на OpenRouter. Попробуйте позже или выберите модель в настройках.');
      const s = hooks.getSettings();
      s.profiles = s.profiles || {};
      if (s.provider !== 'openrouter') s.profiles[s.provider] = { apiKey: s.apiKey, model: s.model, baseUrl: s.baseUrl };
      s.provider = 'openrouter';
      s.apiKey = key;
      s.baseUrl = '';
      s.model = models[0].id;
      s.fallbackModels = models.slice(1, 3).map((m) => m.id); // запасные — следующие по качеству
      s.coverageCheck = false; // у бесплатных моделей мало запросов в день
      hooks.save();
      st.className = 'ob-status ok';
      st.textContent = `Готово: ${models[0].id}${models[0].vision ? ' (умеет читать фото)' : ''}.`;
      setTimeout(() => show(2), 900);
    } catch (e) {
      st.className = 'ob-status err';
      st.textContent = e.message || String(e);
    } finally {
      btn.disabled = false;
    }
  });

  $('obVoice').addEventListener('click', async () => {
    const st = $('obVoiceStatus');
    if (!ttsSupported) { st.textContent = 'Этот браузер не умеет озвучивать текст — откройте приложение в Chrome.'; return; }
    await loadVoices();
    const en = hooks.getSettings().contentLang === 'en';
    const ru = getVoices().some((v) => (en ? /^en/i : /^ru/i).test(v.lang));
    stopSpeaking();
    const r = await speak(en
      ? 'Hi! I will dictate your notes. If something is unclear, say “stop” and ask a question.'
      : 'Привет! Я буду диктовать ваш конспект. Если что-то непонятно — скажите «стоп» и задайте вопрос.', { rate: hooks.getSettings().rate });
    st.textContent = r === 'error'
      ? (IOS ? 'Голос не воспроизвёлся. Проверьте громкость и что переключатель «Без звука» сбоку iPhone выключен.' : 'Голос не воспроизвёлся. Проверьте громкость и что в Android установлен «Синтезатор речи Google».')
      : ru ? 'Если голос слышно — всё в порядке.'
        : en ? (IOS ? 'Английского голоса нет: Настройки → Универсальный доступ → Устный контент → Голоса → Английский.'
          : 'Английского голоса нет: установите английский язык в Настройки Android → Синтез речи → Google.')
          : IOS ? 'Русского голоса нет: Настройки → Универсальный доступ → Устный контент → Голоса → Русский.'
            : 'Русского голоса нет: установите русский язык в Настройки Android → Синтез речи → Google.';
  });

  $('obLive').addEventListener('click', async () => {
    const btn = $('obLive');
    btn.disabled = true;
    const st = $('obLiveStatus');
    st.className = 'ob-status';
    const ok = await hooks.liveVoice(st);
    btn.disabled = false;
    if (!ok) { st.className = 'ob-status err'; return; }
    st.className = 'ob-status ok';
    stopSpeaking();
    speak(hooks.getSettings().contentLang === 'en'
      ? 'Hi! This is the voice that will dictate your notes. If something is unclear, say “stop” and ask a question.'
      : 'Привет! Меня зовут Бая. Я буду диктовать ваш конспект — если что-то непонятно, скажите «стоп» и задайте вопрос.', { rate: hooks.getSettings().rate });
  });

  $('obMic').addEventListener('click', async () => {
    const st = $('obMicStatus');
    if (!srSupported) { st.textContent = 'Распознавание речи недоступно в этом браузере — откройте приложение в Chrome. Кнопка «СТОП» будет работать и так.'; return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      checkAudioDevices(); // после разрешения видны названия устройств — узнаём о Bluetooth-наушниках
      st.textContent = '✓ Микрофон разрешён.';
    } catch {
      st.textContent = 'Доступ не дан. Нажмите на значок замка в адресной строке → Разрешения → Микрофон → Разрешить.';
    }
  });

  $('obFinish').addEventListener('click', () => close(false));

  return { open };
}
