// Бесплатный режим: нейросеть через сервер автора (server/worker.js), своего ключа пользователю не нужно.
// Сюда — адреса сервера после установки (см. server/README.md), например 'https://konspekt-free.имя.workers.dev'.
// Адресов может быть несколько: приложение берёт первый, который отвечает, и запоминает его. Это нужно там,
// где часть доменов закрыта — например, в России недоступен workers.dev, и спасает свой домен.
// Пустой список — режима нет, и приложение, как раньше, просит ключ OpenRouter.
const FREE_PROXY_URLS = [
  'https://konspekt-free.dimonperetyatko228.workers.dev',
];

function read(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key, value) {
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}

const clean = (u) => String(u || '').trim().replace(/\/+$/, '');

// kd.freeProxy в localStorage — чтобы проверить свой сервер, не меняя код (и для автотестов):
// один адрес или несколько через запятую; 'off' — выключить режим
const own = read('kd.freeProxy');
/** Все известные адреса сервера бесплатного режима, в порядке предпочтения. */
export const FREE_PROXY_LIST = (own === 'off' ? [] : own ? own.split(/[\s,]+/) : FREE_PROXY_URLS).map(clean).filter(Boolean);

const saved = clean(read('kd.freeProxyOk'));
/** Текущий адрес сервера. Меняется, если он не отвечает, а в списке есть другой. */
export let FREE_PROXY = (FREE_PROXY_LIST.includes(saved) ? saved : FREE_PROXY_LIST[0]) || '';

/** Этот адрес из нашего списка? */
export const isFreeProxy = (url) => !!url && FREE_PROXY_LIST.includes(clean(url));

/** Запомнить адрес, который ответил: с него приложение начнёт в следующий раз. */
export function useFreeProxy(url) {
  const u = clean(url);
  if (!u || !FREE_PROXY_LIST.includes(u)) return FREE_PROXY;
  FREE_PROXY = u;
  write('kd.freeProxyOk', u);
  return u;
}

/** Адрес не отвечает: взять следующий из списка. Пусто — других нет. */
export function freeProxyFailed(url) {
  const i = FREE_PROXY_LIST.indexOf(clean(url));
  if (i < 0 || FREE_PROXY_LIST.length < 2) return '';
  return useFreeProxy(FREE_PROXY_LIST[(i + 1) % FREE_PROXY_LIST.length]);
}

/** Случайный номер устройства: по нему сервер считает дневной лимит. Ничего личного в нём нет. */
export function deviceId() {
  let id = read('kd.device');
  if (!id) {
    id = 'kd-' + Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
    try { localStorage.setItem('kd.device', id); } catch { /* ignore */ }
  }
  return id;
}
