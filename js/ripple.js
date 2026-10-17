// «Капля» при нажатии: от пальца по кнопке расходится волна, у главных кнопок — круги, как по воде.
// Рисуется поверх страницы и ничего не меняет в самих кнопках. Анимируются только transform и opacity —
// это делает видеокарта, голос и распознавание не тормозят.

const TARGETS = 'button, .seg label';
const DROP = '.icon-btn.play, .stop, .btn.filled.wide'; // у главных кнопок круги выходят за край

let enabled = true;
const reduced = matchMedia('(prefers-reduced-motion: reduce)');

export function setRipple(on) { enabled = !!on; }

function el(tag, cls, css) {
  const e = document.createElement(tag);
  e.className = cls;
  e.style.cssText = css;
  return e;
}

document.addEventListener('pointerdown', (e) => {
  if (!enabled || reduced.matches || !e.isPrimary || e.button > 0) return;
  const btn = e.target.closest(TARGETS);
  if (!btn || btn.disabled || btn.closest('.switch')) return;
  // у вкладок и сегментов волна идёт по видимой «таблетке», а не по всей кнопке
  const shape = btn.querySelector(':scope > .pill') || (btn.matches('.seg label') && btn.querySelector('span')) || btn;
  const r = shape.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const x = e.clientX, y = e.clientY;
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
  // кнопка исчезла (закрылось окно, сменился экран) — волна не должна висеть на пустом месте;
  // круги «капли» расходятся от пальца, а не от кнопки, — их доигрываем
  const until = performance.now() + 1000;
  const tick = (t) => {
    if (t >= until) return parts.forEach((p) => p.remove());
    if (!btn.isConnected || !btn.getClientRects().length) host.remove();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}, { passive: true, capture: true });
