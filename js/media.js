// Кнопки наушников и шторки уведомлений (Media Session).
// Chrome передаёт нажатия кнопок гарнитуры только странице, которая сама что-то воспроизводит,
// поэтому во время занятия тихо проигрывается беззвучный звук.

import { T } from './i18n.js';

let audio = null;
let handlers = null;

/** Секунда тишины в формате WAV (8 кГц, 8 бит). */
function silentWav() {
  const n = 8000;
  const buf = new ArrayBuffer(44 + n);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + n, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  str(36, 'data'); v.setUint32(40, n, true);
  for (let i = 0; i < n; i++) v.setUint8(44 + i, 128);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

export const mediaSupported = 'mediaSession' in navigator;

/**
 * Включает управление с наушников. Вызывать из обработчика нажатия (нужен жест пользователя).
 * h: { toggle(), next(), previous() }
 */
export function enableMedia(h) {
  if (!mediaSupported) return;
  handlers = h;
  if (!audio) {
    audio = new Audio(silentWav());
    audio.loop = true;
  }
  audio.play().catch(() => {});
  const ms = navigator.mediaSession;
  const set = (action, fn) => { try { ms.setActionHandler(action, fn); } catch { /* не поддерживается */ } };
  set('play', () => { audio.play().catch(() => {}); handlers?.toggle(); });
  set('pause', () => { audio.play().catch(() => {}); handlers?.toggle(); });
  set('stop', () => handlers?.toggle());
  set('nexttrack', () => handlers?.next());
  set('previoustrack', () => handlers?.previous());
}

export function disableMedia() {
  if (!mediaSupported) return;
  handlers = null;
  audio?.pause();
  for (const a of ['play', 'pause', 'stop', 'nexttrack', 'previoustrack']) {
    try { navigator.mediaSession.setActionHandler(a, null); } catch { /* ignore */ }
  }
}

/** Подпись в шторке уведомлений и состояние «играет / пауза». */
export function updateMedia(title, playing) {
  if (!mediaSupported || !handlers) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: title || T('Помощник по учёбе'),
      artist: T('Помощник по учёбе'),
      artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
    });
    navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  } catch { /* ignore */ }
}
