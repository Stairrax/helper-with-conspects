// «Капля» при нажатии: от пальца по кнопке расходится волна, у главных кнопок — круги, как по воде.
// Рисуется поверх страницы и ничего не меняет в самих кнопках. Анимируются только transform и opacity —
// это делает видеокарта, голос и распознавание не тормозят.

const TARGETS = 'button, .seg label';
const DROP = '.icon-btn.play, .stop, .btn.filled.wide'; // у главных кнопок круги выходят за край
const TAP_DELAY = 90; // мс: касание пальцем могло быть началом прокрутки — ждём, прежде чем рисовать
const SLOP = 10;      // px: палец сдвинулся дальше — это прокрутка, а не нажатие

let enabled = true;
const reduced = matchMedia('(prefers-reduced-motion: reduce)');

export function setRipple(on) { enabled = !!on; }

function el(tag, cls, css) {
  const e = document.createElement(tag);
  e.className = cls;
  e.style.cssText = css;
  return e;
}

// Форма волны — видимая часть кнопки: «таблетка» вкладки, сегмент, а у прямоугольной кнопки
// внутри скруглённой карточки (строка темы в плане) — сама карточка
function shapeOf(btn) {
  let shape = btn.querySelector(':scope > .pill') || (btn.matches('.seg label') && btn.querySelector('span')) || btn;
  const parent = shape.parentElement;
  if (parseFloat(getComputedStyle(shape).borderTopLeftRadius) === 0 && parent && parseFloat(getComputedStyle(parent).borderTopLeftRadius) > 0) shape = parent;
  return shape;
}

function draw(btn, x, y) {
  const shape = shapeOf(btn);
  const r = shape.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  const cs = getComputedStyle(btn);
  const host = el('div', 'ripple', `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;border-radius:${getComputedStyle(shape).borderRadius}`);
  const d = 2 * Math.hypot(Math.max(x - r.left, r.right - x), Math.max(y - r.top, r.bottom - y));
  host.append(el('i', 'ripple-ink', `left:${x - r.left - d / 2}px;top:${y - r.top - d / 2}px;width:${d}px;height:${d}px;background:${cs.color}`));
  const parts = [host];
  if (btn.matches(DROP)) {
    const size = Math.min(240, Math.max(140, 1.6 * Math.min(r.width, r.height) + 60));
    const at = `left:${x - size / 2}px;top:${y - size / 2}px;width:${size}px;height:${size}px`;
    const c1 = cs.getPropertyValue('--ripple-ring').trim(), c2 = cs.getPropertyValue('--ripple-ring2').trim() || c1;
    parts.push(
      el('i', 'ripple-ring', `${at};border-color:${c1}`),
      el('i', 'ripple-ring second', `${at};border-color:${c2}`),
      el('i', 'ripple-dot', `left:${x - 7}px;top:${y - 7}px`),
    );
  }
  document.body.append(...parts);
  // Волна едет вместе с кнопкой (страница прокрутилась по инерции). Кнопку перерисовали (список тем
  // обновляется по касанию) — переходим на новую на том же месте; кнопка исчезла — волну убираем,
  // а круги «капли» расходятся от пальца, не от кнопки, — их доигрываем
  const until = performance.now() + 1000;
  let target = shape, bx = r.left, by = r.top, dx = 0, dy = 0;
  const tick = (t) => {
    if (t >= until) return parts.forEach((p) => p.remove());
    if (target && !target.isConnected) {
      const again = document.elementFromPoint(x + dx, y + dy)?.closest(TARGETS);
      target = again ? shapeOf(again) : null;
      if (target) { const n = target.getBoundingClientRect(); bx = n.left - dx; by = n.top - dy; }
    }
    if (!target || !target.getClientRects().length) { host.remove(); target = null; }
    else {
      const now = target.getBoundingClientRect();
      if (now.left - bx !== dx || now.top - by !== dy) {
        dx = now.left - bx; dy = now.top - by;
        for (const p of parts) p.style.translate = `${dx}px ${dy}px`;
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return parts;
}

let pending = null; // касание пальцем, которое ещё может оказаться прокруткой

document.addEventListener('pointerdown', (e) => {
  if (!enabled || reduced.matches || !e.isPrimary || e.button > 0) return;
  const btn = e.target.closest(TARGETS);
  if (!btn || btn.disabled || btn.closest('.switch')) return;
  if (e.pointerType === 'mouse') { draw(btn, e.clientX, e.clientY); return; }
  const p = { btn, x: e.clientX, y: e.clientY, id: e.pointerId, parts: null };
  p.timer = setTimeout(() => { p.timer = null; p.parts = draw(btn, p.x, p.y); }, TAP_DELAY);
  pending = p;
}, { passive: true, capture: true });

document.addEventListener('pointermove', (e) => {
  const p = pending;
  if (!p || e.pointerId !== p.id || p.parts) return;
  if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > SLOP) { clearTimeout(p.timer); pending = null; }
}, { passive: true, capture: true });

document.addEventListener('pointerup', (e) => {
  const p = pending;
  if (!p || e.pointerId !== p.id) return;
  pending = null;
  // быстрое касание — рисуем сразу, не дожидаясь задержки
  if (p.timer) { clearTimeout(p.timer); draw(p.btn, p.x, p.y); }
}, { passive: true, capture: true });

// браузер забрал жест под прокрутку — волны не будет, а начавшуюся убираем
document.addEventListener('pointercancel', (e) => {
  const p = pending;
  if (!p || e.pointerId !== p.id) return;
  pending = null;
  clearTimeout(p.timer);
  p.parts?.forEach((x) => x.remove());
}, { passive: true, capture: true });
