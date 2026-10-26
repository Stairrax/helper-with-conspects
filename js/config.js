// Бесплатный режим: нейросеть через сервер автора (server/worker.js), своего ключа пользователю не нужно.
// Сюда — адрес сервера после установки (см. server/README.md), например 'https://konspekt-free.имя.workers.dev'.
// Пусто — режима нет, и приложение, как раньше, просит ключ OpenRouter.
const FREE_PROXY_URL = 'https://konspekt-free.dimonperetyatko228.workers.dev';

function read(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

// kd.freeProxy в localStorage — чтобы проверить свой сервер, не меняя код (и для автотестов); 'off' — выключить режим
const own = read('kd.freeProxy');
export const FREE_PROXY = own === 'off' ? '' : (own || FREE_PROXY_URL).trim().replace(/\/+$/, '');

/** Случайный номер устройства: по нему сервер считает дневной лимит. Ничего личного в нём нет. */
export function deviceId() {
  let id = read('kd.device');
  if (!id) {
    id = 'kd-' + Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
    try { localStorage.setItem('kd.device', id); } catch { /* ignore */ }
  }
  return id;
}
