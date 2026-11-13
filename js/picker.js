// タッチで使えるスライダーと2次元エリア（Pointer Events）。
// ドラッグする部品だけ touch-action:none にして、ページのスクロールは妨げない。

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const PAD = 14; // つまみ半径ぶんの余白

/**
 * 横スライダー。root は空の要素。
 * opts: { min, max, step, label, format(v), onStart(), onInput(v), onEnd() }
 */
export function makeSlider(root, opts) {
  let { min, max } = opts;
  const step = opts.step || 1;
  let value = min;
  let dragging = false;
  const thumb = document.createElement('div');
  thumb.className = 'sl-thumb';
  root.append(thumb);
  root.tabIndex = 0;
  root.setAttribute('role', 'slider');
  root.setAttribute('aria-label', opts.label);

  function paint() {
    const t = max > min ? (value - min) / (max - min) : 0;
    thumb.style.left = `calc(${PAD}px + (100% - ${PAD * 2}px) * ${clamp01(t)})`;
    root.setAttribute('aria-valuemin', String(min));
    root.setAttribute('aria-valuemax', String(max));
    root.setAttribute('aria-valuenow', String(value));
    if (opts.format) root.setAttribute('aria-valuetext', opts.format(value));
    root.classList.toggle('disabled', max <= min);
  }
  function emit(v) {
    v = Math.min(max, Math.max(min, Math.round(v / step) * step));
    if (v !== value) { value = v; paint(); opts.onInput(v); }
  }
  function fromEvent(e) {
    const r = root.getBoundingClientRect();
    const w = r.width - PAD * 2;
    emit(min + clamp01(w > 0 ? (e.clientX - r.left - PAD) / w : 0) * (max - min));
  }
  root.addEventListener('pointerdown', (e) => {
    if (max <= min || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    dragging = true;
    try { root.setPointerCapture(e.pointerId); } catch {}
    root.focus({ preventScroll: true });
    opts.onStart && opts.onStart();
    fromEvent(e);
  });
  root.addEventListener('pointermove', (e) => { if (dragging) fromEvent(e); });
  const end = () => { if (dragging) { dragging = false; opts.onEnd && opts.onEnd(); } };
  root.addEventListener('pointerup', end);
  root.addEventListener('pointercancel', end);
  root.addEventListener('lostpointercapture', end);
  root.addEventListener('keydown', (e) => {
    const big = Math.max(step, Math.round((max - min) / 10));
    const d = { ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step, PageDown: -big, PageUp: big }[e.key];
    if (d === undefined) return;
    e.preventDefault();
    opts.onStart && opts.onStart();
    emit(value + d);
  });
  paint();
  return {
    el: root,
    set(v) { value = Math.min(max, Math.max(min, v)); paint(); },
    setRange(mn, mx) { min = mn; max = mx; value = Math.min(max, Math.max(min, value)); paint(); },
    get dragging() { return dragging; },
  };
}

/**
 * 彩度×明度の2次元エリア。x=彩度(0–1)、y=明度(上が1)。
 * opts: { onStart(), onInput(s, v) }
 */
export function makeArea(root, thumb, opts) {
  let s = 0, v = 0, dragging = false;
  root.tabIndex = 0;
  function paint() {
    thumb.style.left = `calc(${PAD}px + (100% - ${PAD * 2}px) * ${s})`;
    thumb.style.top = `calc(${PAD}px + (100% - ${PAD * 2}px) * ${1 - v})`;
  }
  function fromEvent(e) {
    const r = root.getBoundingClientRect();
    const ns = clamp01((e.clientX - r.left - PAD) / (r.width - PAD * 2));
    const nv = 1 - clamp01((e.clientY - r.top - PAD) / (r.height - PAD * 2));
    if (ns !== s || nv !== v) { s = ns; v = nv; paint(); opts.onInput(s, v); }
  }
  root.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    dragging = true;
    try { root.setPointerCapture(e.pointerId); } catch {}
    root.focus({ preventScroll: true });
    opts.onStart && opts.onStart();
    fromEvent(e);
  });
  root.addEventListener('pointermove', (e) => { if (dragging) fromEvent(e); });
  const end = () => { dragging = false; };
  root.addEventListener('pointerup', end);
  root.addEventListener('pointercancel', end);
  root.addEventListener('lostpointercapture', end);
  root.addEventListener('keydown', (e) => {
    const d = { ArrowLeft: [-0.02, 0], ArrowRight: [0.02, 0], ArrowUp: [0, 0.02], ArrowDown: [0, -0.02] }[e.key];
    if (!d) return;
    e.preventDefault();
    opts.onStart && opts.onStart();
    s = clamp01(s + d[0]); v = clamp01(v + d[1]);
    paint();
    opts.onInput(s, v);
  });
  return {
    set(ns, nv) { s = clamp01(ns); v = clamp01(nv); paint(); },
    get dragging() { return dragging; },
  };
}
