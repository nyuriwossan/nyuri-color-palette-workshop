// 画面の組み立てと操作。データの規則は各モジュールの純粋関数に任せ、ここは「状態→表示」と「操作→状態」だけを扱う。
import { APP_NAME, APP_VERSION, SCOPES, MAX_COLORS, NAME_MAX, MEMO_MAX, IMPORT_MAX_BYTES } from './config.js';
import { normalizeHex, hexToHsv, hsvToHex, textOn } from './color.js';
import { setRatio, maxRatio, addRatio, removeRatio, moveBoundary, equalize } from './ratio.js';
import { HARMONY_MODES, applyHarmony, VARIATIONS, applyVariation } from './harmony.js';
import { createPalette, createColor, clonePalette, duplicatePalette, parseImportText, serializePalette, checkInvariants, uid, DEFAULT_NAME } from './palette.js';
import { PRESETS } from './presets.js';
import { createStore } from './storage.js';
import { toText, drawPaletteCanvas, enabledScopes, safeFileName } from './exporter.js';
import { makeSlider, makeArea } from './picker.js';

/* ---------- 小道具 ---------- */

const $ = (id) => document.getElementById(id);

// 要素を作る。文字列は必ずテキストとして入れる（HTMLとして解釈させない）。
function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style') Object.assign(e.style, v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat()) {
    if (c == null || c === false) continue;
    e.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return e;
}

function safeStorage() {
  try {
    const s = window.localStorage;
    s.setItem('nyuri-cpw:probe', '1');
    s.removeItem('nyuri-cpw:probe');
    return { storage: s, persistent: true };
  } catch {
    const m = new Map();
    return { storage: { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }, persistent: false };
  }
}
const { storage, persistent } = safeStorage();
const store = createStore(storage);

const fmtDate = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/* ---------- 状態 ---------- */

const S = {
  palette: null,
  scope: 'overall',
  sel: {},
  dirty: false,
  undo: [],
  redo: [],
  pvMode: 'blocks',
  pvBg: 'paper',
};
const hsvCache = new Map();

const scopeData = (key = S.scope) => S.palette.scopes[key];
const colors = () => scopeData().colors;
const scopeDef = (key = S.scope) => SCOPES.find((s) => s.key === key);

function ensureSel() {
  for (const s of SCOPES) {
    const cs = S.palette.scopes[s.key].colors;
    if (!cs.some((c) => c.id === S.sel[s.key])) S.sel[s.key] = cs[0].id;
  }
}
function selIndex() {
  const i = colors().findIndex((c) => c.id === S.sel[S.scope]);
  return i < 0 ? 0 : i;
}
const selColor = () => colors()[selIndex()];
const fixedIdx = () => colors().map((c, i) => (c.lockRatio ? i : -1)).filter((i) => i >= 0);
const ratiosOf = () => colors().map((c) => c.ratio);
function assignRatios(rs) { colors().forEach((c, i) => { c.ratio = rs[i]; }); }

// HSVは色ごとに覚えておき、HEX⇔HSVの往復による色ずれと、無彩色での色相の迷子を防ぐ
function hsvOf(color) {
  const cached = hsvCache.get(color.id);
  if (cached && hsvToHex(cached) === color.hex) return cached;
  const n = hexToHsv(color.hex);
  if (cached) {
    if (n.s === 0 || n.v === 0) n.h = cached.h;
    if (n.v === 0) n.s = cached.s;
  }
  hsvCache.set(color.id, n);
  return n;
}

/* ---------- 履歴（元に戻す／やり直す） ---------- */

let lastKey = null, lastTime = 0;
const snapshot = () => JSON.stringify({ p: S.palette, scope: S.scope, sel: S.sel });

function checkpoint(key = null) {
  const now = Date.now();
  if (key && key === lastKey && now - lastTime < 1200) { lastTime = now; return; }
  const snap = snapshot();
  if (S.undo[S.undo.length - 1] !== snap) S.undo.push(snap);
  if (S.undo.length > 100) S.undo.shift();
  S.redo = [];
  lastKey = key; lastTime = now;
}
function restore(snap) {
  const d = JSON.parse(snap);
  S.palette = d.p; S.scope = d.scope; S.sel = d.sel;
  ensureSel();
}
function undo() {
  const cur = snapshot();
  while (S.undo.length && S.undo[S.undo.length - 1] === cur) S.undo.pop();
  if (!S.undo.length) { toast('これ以上戻せません'); render(); return; }
  S.redo.push(cur);
  restore(S.undo.pop());
  lastKey = null;
  markDirty(); render();
}
function redo() {
  if (!S.redo.length) { toast('やり直す操作がありません'); return; }
  S.undo.push(snapshot());
  restore(S.redo.pop());
  lastKey = null;
  markDirty(); render();
}

let draftTimer = 0;
function saveDraftNow() {
  store.saveDraft({ palette: S.palette, dirty: S.dirty, scope: S.scope });
}
function scheduleDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraftNow, 250);
}
function markDirty() {
  S.palette.updatedAt = new Date().toISOString();
  S.dirty = true;
  scheduleDraft();
}
/** 変更の定型：履歴に積む→変更→保存予約→再描画 */
function mutate(fn, key = null) {
  checkpoint(key);
  fn();
  if (!checkInvariants(S.palette)) { // 念のための安全弁。ここに来たら直前の状態へ戻す。
    restore(S.undo.pop());
    toast('その操作は適用できませんでした', 'warn');
    render();
    return;
  }
  markDirty();
  render();
}

/* ---------- トースト・シート・ダイアログ ---------- */

function toast(msg, type = 'ok', action = null) {
  const box = $('toasts');
  const t = h('div', { class: 'toast ' + type, role: type === 'warn' ? 'alert' : 'status' }, h('span', {}, msg));
  if (action) t.append(h('button', { type: 'button', class: 'toast-act', onclick: () => { action.fn(); t.remove(); } }, action.label));
  box.append(t);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => t.remove(), action ? 6000 : 2600);
}

const openStack = [];
function openOverlay(node, { center = false, onClose } = {}) {
  const prevFocus = document.activeElement;
  const ov = h('div', { class: 'ov' + (center ? ' center' : '') }, node);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    ov.remove();
    const i = openStack.indexOf(close);
    if (i >= 0) openStack.splice(i, 1);
    if (!openStack.length) document.body.classList.remove('lock');
    onClose && onClose();
    if (prevFocus && prevFocus.focus && document.contains(prevFocus)) prevFocus.focus({ preventScroll: true });
  };
  ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
  $('overlays').append(ov);
  openStack.push(close);
  document.body.classList.add('lock');
  node.tabIndex = -1;
  node.focus({ preventScroll: true });
  return close;
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openStack.length) openStack[openStack.length - 1]();
});

function openSheet(title, build, opts = {}) {
  const body = h('div', { class: 'sheet-body' });
  let close = () => {};
  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'sheet-head' }, h('h3', {}, title), h('button', { type: 'button', class: 'btn sm', onclick: () => close() }, '閉じる')),
    body);
  close = openOverlay(sheet, opts);
  build(body, close);
  return close;
}

function confirmDialog(message, { ok = 'OK', cancel = 'キャンセル', danger = false } = {}) {
  return new Promise((resolve) => {
    let result = false, close = () => {};
    const dlg = h('div', { class: 'dialog', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': '確認' },
      h('p', { class: 'dialog-msg' }, message),
      h('div', { class: 'dialog-btns' },
        h('button', { type: 'button', class: 'btn', onclick: () => close() }, cancel),
        h('button', { type: 'button', class: 'btn ' + (danger ? 'danger-fill' : 'primary'), 'data-ok': '1', onclick: () => { result = true; close(); } }, ok)));
    close = openOverlay(dlg, { center: true, onClose: () => resolve(result) });
  });
}

function promptDialog(title, value, { maxLength = NAME_MAX, ok = '決定' } = {}) {
  return new Promise((resolve) => {
    let result = null, close = () => {};
    const input = h('input', { type: 'text', class: 'text-input', maxlength: maxLength, value, 'aria-label': title, enterkeyhint: 'done' });
    const submit = () => { const v = input.value.trim(); if (!v) { input.focus(); return; } result = v.slice(0, maxLength); close(); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submit(); } });
    const dlg = h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('p', { class: 'dialog-title' }, title), input,
      h('div', { class: 'dialog-btns' },
        h('button', { type: 'button', class: 'btn', onclick: () => close() }, 'キャンセル'),
        h('button', { type: 'button', class: 'btn primary', 'data-ok': '1', onclick: submit }, ok)));
    close = openOverlay(dlg, { center: true, onClose: () => resolve(result) });
    setTimeout(() => { input.focus(); input.select(); }, 30);
  });
}

/* ---------- コピー・ダウンロード ---------- */

async function copyText(text, okMsg = 'コピーしました') {
  if (!text) { toast('コピーできる内容がありません。系統を「出力に含める」にしてください。', 'warn'); return false; }
  try {
    if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('no clipboard');
    await navigator.clipboard.writeText(text);
    toast(okMsg);
    return true;
  } catch {
    try {
      const ta = h('textarea', { readonly: true, class: 'offscreen' });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      const ok = document.execCommand('copy');
      ta.remove();
      if (ok) { toast(okMsg); return true; }
    } catch { /* 下の手動コピーへ */ }
    toast('自動コピーができませんでした。表示された文字を手動でコピーしてください。', 'warn');
    openSheet('手動でコピー', (body) => {
      const ta = h('textarea', { class: 'text-area mono', readonly: true, rows: Math.min(14, text.split('\n').length + 1) });
      ta.value = text;
      body.append(h('p', { class: 'note' }, '下の文字を長押し（または全選択）してコピーしてください。'), ta,
        h('button', { type: 'button', class: 'btn wide', onclick: () => { ta.focus(); ta.select(); ta.setSelectionRange(0, text.length); } }, 'すべて選択'));
    });
    return false;
  }
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename, class: 'offscreen' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/* ---------- 色・配色の操作 ---------- */

function selectColor(id) {
  if (S.sel[S.scope] === id) return;
  S.sel[S.scope] = id;
  scheduleDraft();
  render();
}

function setHexOf(color, hex, key) {
  if (color.hex === hex) return;
  mutate(() => { color.hex = hex; }, key);
}

function pickHsv(part) {
  const c = selColor();
  const cur = { ...hsvOf(c), ...part };
  hsvCache.set(c.id, cur);
  c.hex = hsvToHex(cur);
  markDirty();
  render();
}

function newHexFrom(color) {
  const b = hsvOf(color);
  if (b.s < 0.08) return hsvToHex({ h: b.h, s: b.s, v: b.v > 0.5 ? b.v - 0.22 : b.v + 0.22 });
  return hsvToHex({ h: b.h + 35, s: b.s, v: b.v });
}

function addColor(duplicate = false) {
  const cs = colors();
  if (cs.length >= MAX_COLORS) { toast(`色は最大${MAX_COLORS}色までです`, 'warn'); return; }
  const i = selIndex();
  const src = cs[i];
  mutate(() => {
    const rs = addRatio(ratiosOf(), i + 1, fixedIdx());
    const c = createColor(duplicate ? src.hex : newHexFrom(src), 1);
    cs.splice(i + 1, 0, c);
    assignRatios(rs);
    S.sel[S.scope] = c.id;
  });
}

function deleteColor() {
  const cs = colors();
  if (cs.length <= 1) { toast('最後の1色は削除できません', 'warn'); return; }
  const i = selIndex();
  mutate(() => {
    const rs = removeRatio(ratiosOf(), i, fixedIdx());
    cs.splice(i, 1);
    assignRatios(rs);
    S.sel[S.scope] = cs[Math.min(i, cs.length - 1)].id;
  });
  toast('色を削除しました', 'ok', { label: '元に戻す', fn: undo });
}

function moveColor(dir) {
  const cs = colors(), i = selIndex(), j = i + dir;
  if (j < 0 || j >= cs.length) return;
  mutate(() => { [cs[i], cs[j]] = [cs[j], cs[i]]; }, 'move');
}

function reverseColors() {
  if (colors().length < 2) return;
  mutate(() => { colors().reverse(); });
}

function shuffleColors() {
  const cs = colors();
  if (cs.length < 2) return;
  mutate(() => {
    const before = cs.map((c) => c.id).join();
    for (let tries = 0; tries < 8; tries++) {
      for (let i = cs.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [cs[i], cs[j]] = [cs[j], cs[i]];
      }
      if (cs.map((c) => c.id).join() !== before) break;
    }
  });
}

function equalizeRatios() {
  if (colors().length < 2) return;
  mutate(() => { assignRatios(equalize(colors().length)); });
  toast('比率を均等にしました');
}

function changeRatio(value, key = 'ratio') {
  const i = selIndex();
  if (colors()[i].lockRatio) { render(); return; }
  const rs = setRatio(ratiosOf(), i, value, fixedIdx());
  if (rs.join() === ratiosOf().join()) { render(); return; }
  mutate(() => assignRatios(rs), key);
}

function toggleScopeEnabled() {
  mutate(() => { scopeData().enabled = !scopeData().enabled; });
}

function setScope(key) {
  if (S.scope === key) return;
  S.scope = key;
  scheduleDraft();
  render();
}

/* ---------- 描画 ---------- */

function renderHeader() {
  $('palName').textContent = S.palette.name;
  $('dirtyDot').hidden = !S.dirty;
  document.title = `${S.palette.name}｜${APP_NAME}`;
}

function stripEl(cs, cls = 'strip') {
  return h('span', { class: cls, 'aria-hidden': 'true' }, cs.map((c) => h('i', { style: { background: c.hex, flexGrow: String(c.ratio) } })));
}

function renderTabs() {
  const wrap = $('tabs');
  wrap.replaceChildren(...SCOPES.map((s) => {
    const sc = S.palette.scopes[s.key];
    const on = S.scope === s.key;
    return h('button', {
      type: 'button', role: 'tab', class: 'tab' + (on ? ' on' : '') + (sc.enabled ? '' : ' off'),
      'aria-selected': on ? 'true' : 'false', 'data-scope': s.key,
      'aria-label': `${s.label}（${s.ja}）${sc.enabled ? '出力する' : '出力しない'}`,
      onclick: () => setScope(s.key),
    },
      h('span', { class: 'tab-name' }, s.label),
      h('span', { class: 'tab-top' }, stripEl(sc.colors, 'strip tab-strip'), h('span', { class: 'tab-badge' }, sc.enabled ? 'ON' : 'OFF')));
  }));
  const sc = scopeData(), def = scopeDef();
  $('scopeHint').textContent = `${def.ja}：${def.hint}`;
  const sw = $('scopeSwitch');
  sw.setAttribute('aria-checked', sc.enabled ? 'true' : 'false');
  sw.setAttribute('aria-label', `${def.label} を出力に含める`);
  $('scopeSwitchLabel').textContent = sc.enabled ? '出力に含める' : '出力しない';
}

let barSig = '';
let dragLockWarned = false;
function attachHandle(hd, i) {
  let startX = 0, start = null, width = 1;
  hd.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    const cs = colors();
    if (cs[i].lockRatio || cs[i + 1].lockRatio) {
      if (!dragLockWarned) { toast('比率を固定した色の境界は動かせません', 'warn'); dragLockWarned = true; setTimeout(() => { dragLockWarned = false; }, 2000); }
      return;
    }
    try { hd.setPointerCapture(e.pointerId); } catch {}
    startX = e.clientX; start = ratiosOf(); width = $('bar').getBoundingClientRect().width || 1;
    checkpoint(null);
    hd.classList.add('drag');
  });
  hd.addEventListener('pointermove', (e) => {
    if (!start) return;
    const rs = moveBoundary(start, i, ((e.clientX - startX) / width) * 100);
    if (rs.join() !== ratiosOf().join()) { assignRatios(rs); markDirty(); render(); }
  });
  const end = () => { start = null; hd.classList.remove('drag'); };
  hd.addEventListener('pointerup', end);
  hd.addEventListener('pointercancel', end);
  hd.addEventListener('lostpointercapture', end);
  hd.addEventListener('keydown', (e) => {
    const d = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
    if (!d) return;
    e.preventDefault();
    const cs = colors();
    if (cs[i].lockRatio || cs[i + 1].lockRatio) return;
    const rs = moveBoundary(ratiosOf(), i, d);
    mutate(() => assignRatios(rs), 'boundary-key');
  });
}

function renderBar() {
  const cs = colors(), bar = $('bar');
  const sig = S.scope + ':' + cs.map((c) => c.id).join(',');
  if (sig !== barSig) {
    barSig = sig;
    bar.replaceChildren();
    cs.forEach((c) => bar.append(h('button', { type: 'button', class: 'seg', 'data-id': c.id, onclick: () => selectColor(c.id) }, h('span', { class: 'seg-label' }))));
    for (let i = 0; i < cs.length - 1; i++) {
      const hd = h('div', { class: 'handle', role: 'slider', tabindex: '0', 'aria-label': `色${i + 1}と色${i + 2}の境界。ドラッグで比率を調整` });
      attachHandle(hd, i);
      bar.append(hd);
    }
  }
  const segs = bar.querySelectorAll('.seg'), hds = bar.querySelectorAll('.handle');
  let acc = 0;
  cs.forEach((c, i) => {
    const s = segs[i];
    s.style.left = acc + '%';
    s.style.width = c.ratio + '%';
    s.style.background = c.hex;
    s.style.color = textOn(c.hex);
    s.classList.toggle('on', c.id === S.sel[S.scope]);
    s.setAttribute('aria-label', `色${i + 1} ${c.hex} ${c.ratio}%`);
    s.firstChild.textContent = c.ratio >= 9 ? c.ratio + '%' : '';
    acc += c.ratio;
    if (hds[i]) { hds[i].style.left = acc + '%'; hds[i].setAttribute('aria-valuenow', String(c.ratio)); hds[i].classList.toggle('locked', !!(c.lockRatio || (cs[i + 1] && cs[i + 1].lockRatio))); }
  });
  $('previewWrap').classList.toggle('off', !scopeData().enabled);
}

function renderChips() {
  const cs = colors(), wrap = $('chips');
  const nodes = cs.map((c, i) => {
    const on = c.id === S.sel[S.scope];
    return h('button', {
      type: 'button', class: 'chip' + (on ? ' on' : ''), style: { background: c.hex, color: textOn(c.hex) },
      'aria-pressed': on ? 'true' : 'false', 'aria-label': `色${i + 1} ${c.hex} ${c.ratio}%${on ? '（選択中）' : ''}`,
      'data-id': c.id, onclick: () => selectColor(c.id),
    },
      h('span', { class: 'chip-no' }, i + 1),
      (c.lockColor || c.lockRatio) && h('span', { class: 'chip-lock', title: '固定中' }, '固定'),
      h('span', { class: 'chip-ratio' }, c.ratio + '%'),
      h('span', { class: 'chip-hex' }, c.hex));
  });
  if (cs.length < MAX_COLORS) nodes.push(h('button', { type: 'button', class: 'chip add', 'aria-label': '色を追加', onclick: () => addColor() }, h('span', { class: 'chip-plus' }, '＋'), h('span', { class: 'chip-hex' }, '追加')));
  wrap.replaceChildren(...nodes);
}

let area, slH, slS, slV, slR;
function renderEditor() {
  const cs = colors(), i = selIndex(), c = cs[i], n = cs.length;
  const hsv = hsvOf(c);
  $('edSwatch').style.background = c.hex;
  $('edNo').textContent = `色 ${i + 1}／${n}`;
  $('btnCopyHex').textContent = `${c.hex}　コピー`;
  const pure = hsvToHex({ h: hsv.h, s: 1, v: 1 });
  $('sv').style.background = `linear-gradient(to top,#000,rgba(0,0,0,0)),linear-gradient(to right,#fff,${pure})`;
  $('svThumb').style.background = c.hex;
  area.set(hsv.s, hsv.v);
  slH.set(Math.round(hsv.h) % 360);
  slS.set(Math.round(hsv.s * 100));
  slV.set(Math.round(hsv.v * 100));
  slH.el.style.setProperty('--thumb', pure);
  slS.el.style.background = `linear-gradient(to right,${hsvToHex({ h: hsv.h, s: 0, v: hsv.v })},${hsvToHex({ h: hsv.h, s: 1, v: hsv.v })})`;
  slV.el.style.background = `linear-gradient(to right,#000,${hsvToHex({ h: hsv.h, s: hsv.s, v: 1 })})`;
  slS.el.style.setProperty('--thumb', c.hex);
  slV.el.style.setProperty('--thumb', c.hex);
  $('valH').textContent = `${Math.round(hsv.h) % 360}°`;
  $('valS').textContent = `${Math.round(hsv.s * 100)}%`;
  $('valV').textContent = `${Math.round(hsv.v * 100)}%`;
  if (document.activeElement !== $('hexInput')) $('hexInput').value = c.hex;
  $('nativeColor').value = c.hex.toLowerCase();

  const mx = maxRatio(ratiosOf(), i, fixedIdx());
  const canRatio = n > 1 && !c.lockRatio && mx > 1;
  const rMax = canRatio ? mx : 100;
  slR.setRange(1, rMax);
  slR.set(c.ratio);
  slR.el.classList.toggle('disabled', !canRatio);
  slR.el.style.setProperty('--fill', c.hex);
  slR.el.style.setProperty('--pct', `${((c.ratio - 1) / (rMax - 1)) * 100}%`);
  if (document.activeElement !== $('ratioInput')) $('ratioInput').value = String(c.ratio);
  $('ratioInput').disabled = !canRatio;
  $('btnRminus').disabled = !canRatio || c.ratio <= 1;
  $('btnRplus').disabled = !canRatio || c.ratio >= mx;
  $('valRmax').textContent = n === 1 ? '1色のときは100%固定' : c.lockRatio ? `${c.ratio}%（固定中）` : `${c.ratio}%（最大${mx}%）`;
  $('btnLockRatio').setAttribute('aria-pressed', c.lockRatio ? 'true' : 'false');
  $('btnLockRatio').textContent = c.lockRatio ? '比率を固定中' : '比率を固定';
  $('btnLockColor').setAttribute('aria-pressed', c.lockColor ? 'true' : 'false');
  $('btnLockColor').textContent = c.lockColor ? '色を固定中' : '色を固定';
  $('btnLeft').disabled = i === 0;
  $('btnRight').disabled = i === n - 1;
  $('btnDel').disabled = n <= 1;
  $('btnDup').disabled = n >= MAX_COLORS;
  $('btnAdd').disabled = n >= MAX_COLORS;
  $('btnAdd').textContent = n >= MAX_COLORS ? `上限${MAX_COLORS}色` : '＋ 色を追加';
  $('btnReverse').disabled = $('btnShuffle').disabled = $('btnEqual').disabled = n < 2;
  $('btnUndo').disabled = !S.undo.length;
  $('btnRedo').disabled = !S.redo.length;
}

const PV_MODES = [
  { key: 'blocks', label: 'ブロック' },
  { key: 'gradient', label: 'グラデ' },
  { key: 'poster', label: 'ポスター' },
  { key: 'pair', label: '人物×背景' },
  { key: 'three', label: '3系統' },
];
const PV_BGS = [{ key: 'paper', label: '紙' }, { key: 'white', label: '白' }, { key: 'gray', label: '灰' }, { key: 'black', label: '黒' }];

function hardStops(cs, dir) {
  let acc = 0;
  const parts = cs.map((c) => { const a = acc; acc += c.ratio; return `${c.hex} ${a}% ${acc}%`; });
  return `linear-gradient(${dir},${parts.join(',')})`;
}

function svg(tag, attrs) {
  const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

function renderPreview() {
  $('pvModes').replaceChildren(...PV_MODES.map((m) => h('button', { type: 'button', role: 'tab', class: S.pvMode === m.key ? 'on' : '', 'aria-selected': S.pvMode === m.key ? 'true' : 'false', onclick: () => { S.pvMode = m.key; renderPreview(); } }, m.label)));
  $('pvBgs').replaceChildren(h('span', { class: 'seg-cap' }, '下地'), ...PV_BGS.map((m) => h('button', { type: 'button', class: S.pvBg === m.key ? 'on' : '', 'aria-pressed': S.pvBg === m.key ? 'true' : 'false', onclick: () => { S.pvBg = m.key; renderPreview(); } }, m.label)));
  const stage = $('pvStage');
  stage.className = 'pv-stage bg-' + S.pvBg;
  const cs = colors();
  let node, cap = '';
  if (S.pvMode === 'blocks') {
    node = h('div', { class: 'pv-blocks' }, cs.map((c, i) => h('div', { style: { background: c.hex, color: textOn(c.hex) } }, i + 1)));
    cap = `${scopeDef().label} の各色を同じ大きさで並べています（比率は反映しません）。`;
  } else if (S.pvMode === 'gradient') {
    let acc = 0;
    const stops = cs.map((c) => { const mid = acc + c.ratio / 2; acc += c.ratio; return `${c.hex} ${mid}%`; });
    node = h('div', { class: 'pv-grad', style: { background: cs.length === 1 ? cs[0].hex : `linear-gradient(90deg,${stops.join(',')})` } });
    cap = `${scopeDef().label} の色を、比率に応じた位置でなめらかにつないでいます。`;
  } else if (S.pvMode === 'poster') {
    const o = cs.slice().sort((a, b) => b.ratio - a.ratio);
    node = svg('svg', { viewBox: '0 0 320 190', class: 'pv-svg', role: 'img', 'aria-label': '抽象的なポスター風の配色見本' });
    node.append(svg('rect', { x: 0, y: 0, width: 320, height: 190, fill: o[0].hex }));
    if (o[1]) node.append(svg('circle', { cx: 212, cy: 88, r: 66, fill: o[1].hex }));
    if (o[2]) node.append(svg('rect', { x: 0, y: 132, width: 320, height: 58, fill: o[2].hex }));
    if (o[3]) node.append(svg('rect', { x: 38, y: 34, width: 66, height: 112, fill: o[3].hex }));
    if (o[4]) node.append(svg('circle', { cx: 71, cy: 62, r: 17, fill: o[4].hex }));
    o.slice(5).forEach((c, k) => node.append(svg('rect', { x: 150 + k * 30, y: 150, width: 22, height: 22, fill: c.hex })));
    cap = `${scopeDef().label} の色を、比率の大きい順に「地・主役・帯・小物」へ割り当てた抽象図形です。`;
  } else if (S.pvMode === 'pair') {
    const bg = S.palette.scopes.background.colors, ch = S.palette.scopes.character.colors;
    node = h('div', { class: 'pv-pair', style: { background: hardStops(bg, '180deg') } },
      h('div', { class: 'pv-figure', style: { background: hardStops(ch, '180deg') } }));
    cap = '地＝Background、中央の形＝Character の配色です（出力しない設定の系統も表示します）。';
  } else {
    node = h('div', { class: 'pv-three' }, SCOPES.map((s) => {
      const sc = S.palette.scopes[s.key];
      return h('div', { class: 'pv-three-row' + (sc.enabled ? '' : ' off') },
        h('div', { class: 'pv-three-label' }, s.label, h('span', {}, sc.enabled ? 'ON' : 'OFF')),
        h('div', { class: 'pv-three-bar', style: { background: hardStops(sc.colors, '90deg') } }));
    }));
    cap = '3系統を比率どおりに並べ、色調のつながりを見比べます。';
  }
  stage.replaceChildren(node, h('p', { class: 'pv-cap' }, cap));
}

function render() {
  ensureSel();
  renderHeader();
  renderTabs();
  renderBar();
  renderChips();
  renderEditor();
  renderPreview();
}

/* ---------- 保存・ライブラリ ---------- */

async function savePalette() {
  if (S.palette.name === DEFAULT_NAME) {
    const name = await promptDialog('パレットに名前を付けて保存', S.palette.name, { ok: '保存' });
    if (name === null) return;
    S.palette.name = name;
  }
  S.palette.updatedAt = new Date().toISOString();
  if (!store.upsert(clonePalette(S.palette))) {
    toast('保存できませんでした。ブラウザの保存領域を確認してください。', 'warn');
    render();
    return;
  }
  S.dirty = false;
  saveDraftNow();
  render();
  toast(persistent ? `「${S.palette.name}」を保存しました` : 'このブラウザでは保存領域が使えないため、ページを閉じると消えます。JSONで保存してください。', persistent ? 'ok' : 'warn');
}

async function confirmDiscard(what) {
  if (!S.dirty) return true;
  return confirmDialog(`編集中の内容はまだ保存されていません。${what}`, { ok: '続ける' });
}

function loadPalette(p) {
  checkpoint(null);
  S.palette = clonePalette(p);
  S.scope = 'overall';
  S.sel = {};
  ensureSel();
  S.dirty = false;
  saveDraftNow();
  render();
  window.scrollTo({ top: 0 });
}

function openLibrary() {
  openSheet('保存済みパレット', (body, close) => {
    const draw = () => {
      const list = store.loadLibrary();
      body.replaceChildren();
      if (!list.length) {
        body.append(h('p', { class: 'empty' }, 'まだ保存したパレットはありません。画面上部の「保存」で、いまの配色をこの端末に保存できます。'));
        return;
      }
      body.append(h('p', { class: 'note' }, `${list.length}件。この端末のブラウザ内に保存されています。`));
      for (const p of list) {
        const isCur = p.id === S.palette.id;
        body.append(h('div', { class: 'lib-card' },
          h('div', { class: 'lib-head' }, h('div', { class: 'lib-name' }, p.name, isCur && h('span', { class: 'lib-cur' }, '編集中')), h('div', { class: 'lib-date' }, '更新 ' + fmtDate(p.updatedAt))),
          h('div', { class: 'lib-strips' }, SCOPES.map((s) => h('div', { class: 'lib-strip-row' + (p.scopes[s.key].enabled ? '' : ' off') }, h('span', { class: 'lib-strip-label' }, s.label.slice(0, 1)), stripEl(p.scopes[s.key].colors)))),
          p.memo && h('p', { class: 'lib-memo' }, p.memo.length > 80 ? p.memo.slice(0, 80) + '…' : p.memo),
          h('div', { class: 'lib-btns' },
            h('button', { type: 'button', class: 'btn sm primary', onclick: async () => { if (await confirmDiscard('このパレットを読み込みますか？')) { loadPalette(p); close(); toast(`「${p.name}」を読み込みました`); } } }, '読込'),
            h('button', { type: 'button', class: 'btn sm', onclick: async () => {
              const name = await promptDialog('名前を変更', p.name);
              if (name === null) return;
              p.name = name; p.updatedAt = new Date().toISOString();
              store.upsert(p);
              if (isCur) { S.palette.name = name; scheduleDraft(); render(); }
              draw();
            } }, '名前変更'),
            h('button', { type: 'button', class: 'btn sm', onclick: () => { store.upsert(duplicatePalette(p)); draw(); toast('複製しました'); } }, '複製'),
            h('button', { type: 'button', class: 'btn sm', onclick: () => openJsonOut(p) }, 'JSON'),
            h('button', { type: 'button', class: 'btn sm danger', onclick: async () => {
              if (!(await confirmDialog(`「${p.name}」を削除しますか？\nこの操作は元に戻せません。`, { ok: '削除する', danger: true }))) return;
              store.remove(p.id);
              if (isCur) { S.dirty = true; scheduleDraft(); render(); }
              draw();
              toast('削除しました');
            } }, '削除'))));
      }
    };
    draw();
  });
}

function openPresets() {
  openSheet('プリセット', (body, close) => {
    body.append(h('p', { class: 'note' }, `このアプリ独自の配色です（PixAI公式のプリセットではありません）。選ぶと、いま開いている「${scopeDef().label}」の配色に入ります。`));
    for (const p of PRESETS) {
      const cs = p.colors.map(([hex, ratio]) => ({ hex, ratio }));
      body.append(h('button', {
        type: 'button', class: 'preset',
        onclick: async () => {
          if (!(await confirmDialog(`「${scopeDef().label}」の配色を「${p.name}」で置き換えますか？\n（あとで「元に戻す」で戻せます）`, { ok: '置き換える' }))) return;
          mutate(() => {
            scopeData().colors = p.colors.map(([hex, ratio]) => createColor(hex, ratio));
            S.sel[S.scope] = scopeData().colors[0].id;
            if (S.palette.name === DEFAULT_NAME) S.palette.name = p.name;
          });
          close();
          toast(`「${p.name}」を ${scopeDef().label} に入れました`);
          window.scrollTo({ top: 0 });
        },
      }, stripEl(cs, 'strip preset-strip'), h('span', { class: 'preset-name' }, p.name), h('span', { class: 'preset-desc' }, p.desc)));
    }
  });
}

async function newPalette() {
  if (!(await confirmDiscard('新しいパレットを作りますか？'))) return;
  loadPalette(createPalette());
  S.dirty = false;
  toast('新しいパレットを作りました');
}

function openInfo() {
  openSheet('パレット名とメモ', (body, close) => {
    const name = h('input', { type: 'text', class: 'text-input', maxlength: NAME_MAX, value: S.palette.name, id: 'infoName', enterkeyhint: 'done' });
    const memo = h('textarea', { class: 'text-area', maxlength: MEMO_MAX, rows: 5, id: 'infoMemo', placeholder: '例：使ったモデル、プロンプトの方針、試した結果など' });
    memo.value = S.palette.memo;
    name.addEventListener('input', () => { checkpoint('meta'); S.palette.name = name.value.trim().slice(0, NAME_MAX) || DEFAULT_NAME; markDirty(); renderHeader(); });
    memo.addEventListener('input', () => { checkpoint('meta'); S.palette.memo = memo.value.slice(0, MEMO_MAX); markDirty(); renderHeader(); });
    body.append(
      h('label', { class: 'field', for: 'infoName' }, h('span', { class: 'field-label' }, 'パレット名')), name,
      h('label', { class: 'field', for: 'infoMemo' }, h('span', { class: 'field-label' }, 'メモ')), memo,
      h('p', { class: 'note' }, `作成 ${fmtDate(S.palette.createdAt)}　更新 ${fmtDate(S.palette.updatedAt)}`),
      h('button', { type: 'button', class: 'btn wide primary', onclick: () => close() }, '完了'));
  });
}

/* ---------- 出力 ---------- */

function openTransfer() {
  const scopes = enabledScopes(S.palette);
  if (!scopes.length) { toast('出力する系統がありません。「出力に含める」をオンにしてください。', 'warn'); return; }
  openSheet('PixAIへ転記', (body) => {
    const done = new Set();
    body.append(h('p', { class: 'note' }, '色をタップするとHEXコードをコピーします。PixAIのカラーパレット画面に貼り付け、比率を入力したら次の色へ。コピー済みの色には印が付きます。'));
    for (const s of scopes) {
      body.append(h('h4', { class: 'tr-scope' }, s.label, h('span', {}, ` ${s.ja}`)));
      S.palette.scopes[s.key].colors.forEach((c, i) => {
        const row = h('button', { type: 'button', class: 'tr-row', 'aria-label': `${s.label} 色${i + 1} ${c.hex} 比率${c.ratio}% をコピー` },
          h('span', { class: 'tr-sw', style: { background: c.hex, color: textOn(c.hex) } }, i + 1),
          h('span', { class: 'tr-hex' }, c.hex),
          h('span', { class: 'tr-ratio' }, c.ratio + '%'),
          h('span', { class: 'tr-state' }, 'コピー'));
        row.addEventListener('click', async () => {
          if (await copyText(c.hex, `${c.hex} をコピー（比率は ${c.ratio}%）`)) {
            done.add(c.id);
            row.classList.add('done');
            row.lastChild.textContent = '済';
          }
        });
        body.append(row);
      });
    }
    body.append(h('button', { type: 'button', class: 'btn wide', onclick: () => copyText(toText(S.palette), 'HEXと比率をまとめてコピーしました') }, 'まとめてコピー（HEXと比率）'));
  });
}

function openPng() {
  const cv = drawPaletteCanvas(S.palette);
  if (!cv) { toast('出力する系統がありません。「出力に含める」をオンにしてください。', 'warn'); return; }
  cv.toBlob((blob) => {
    if (!blob) { toast('画像を作れませんでした', 'warn'); return; }
    const name = safeFileName(S.palette.name) + '.png';
    const url = URL.createObjectURL(blob);
    openSheet('パレット画像（PNG）', (body) => {
      const file = (typeof File === 'function') ? new File([blob], name, { type: 'image/png' }) : null;
      const canShare = !!(file && navigator.canShare && navigator.canShare({ files: [file] }));
      body.append(
        h('img', { class: 'png-img', src: url, alt: `${S.palette.name} の配色画像`, id: 'pngImg' }),
        h('div', { class: 'grid2' },
          canShare && h('button', { type: 'button', class: 'btn primary', onclick: () => navigator.share({ files: [file], title: S.palette.name }).catch(() => {}) }, '共有・写真に保存'),
          h('button', { type: 'button', class: 'btn' + (canShare ? '' : ' primary'), id: 'btnPngDl', onclick: () => { download(blob, name); toast('画像を書き出しました'); } }, 'ダウンロード')),
        h('p', { class: 'note' }, 'iPhoneでは、画像を長押しして「“写真”に保存」も使えます。出力に含める系統だけが画像に入ります。'));
    }, { onClose: () => URL.revokeObjectURL(url) });
  }, 'image/png');
}

function openJsonOut(p = S.palette) {
  const text = serializePalette(p);
  const name = safeFileName(p.name) + '.json';
  openSheet('JSONで保存（バックアップ）', (body) => {
    const ta = h('textarea', { class: 'text-area mono', readonly: true, rows: 6, 'aria-label': 'JSONの内容' });
    ta.value = text;
    body.append(
      h('p', { class: 'note' }, `「${p.name}」の全データ（3系統・比率・メモ）を保存します。機種変更やブラウザのデータ削除に備えたバックアップ用で、このアプリの「JSONを読み込む」で元に戻せます。PixAIには読み込めません。`),
      h('div', { class: 'grid2' },
        h('button', { type: 'button', class: 'btn primary', id: 'btnJsonDl', onclick: () => { download(new Blob([text], { type: 'application/json' }), name); toast('JSONを書き出しました'); } }, 'ファイルで保存'),
        h('button', { type: 'button', class: 'btn', onclick: () => copyText(text, 'JSONをコピーしました') }, 'テキストをコピー')),
      ta);
  });
}

function openJsonIn() {
  openSheet('JSONを読み込む', (body, close) => {
    const err = h('p', { class: 'hex-err', role: 'alert', hidden: true });
    const showErr = (m) => { err.textContent = m; err.hidden = false; };
    const apply = async (text) => {
      const r = parseImportText(text);
      if (!r.ok) { showErr('読み込めませんでした：' + r.error); return; }
      if (!(await confirmDiscard('読み込んだパレットに切り替えますか？'))) return;
      const p = r.palette;
      const exists = store.loadLibrary().some((x) => x.id === p.id);
      if (exists) p.id = uid('p'); // 保存済みの同じIDを黙って上書きしないよう、別のパレットとして扱う
      loadPalette(p);
      S.dirty = true;
      saveDraftNow();
      render();
      close();
      toast(`「${p.name}」を読み込みました。残すには「保存」を押してください。`);
    };
    const file = h('input', { type: 'file', accept: '.json,application/json', class: 'file-input', id: 'jsonFile', 'aria-label': 'JSONファイルを選ぶ' });
    file.addEventListener('change', () => {
      const f = file.files && file.files[0];
      if (!f) return;
      err.hidden = true;
      if (f.size > IMPORT_MAX_BYTES) { showErr(`ファイルが大きすぎます（上限 ${Math.round(IMPORT_MAX_BYTES / 1024)}KB）。`); file.value = ''; return; }
      if (!/\.json$/i.test(f.name) && f.type !== 'application/json') { showErr('JSONファイル（.json）を選んでください。'); file.value = ''; return; }
      const fr = new FileReader();
      fr.onload = () => { apply(String(fr.result)); file.value = ''; };
      fr.onerror = () => showErr('ファイルを読み取れませんでした。');
      fr.readAsText(f);
    });
    const ta = h('textarea', { class: 'text-area mono', rows: 5, placeholder: 'ここにJSONを貼り付けてもOK', id: 'jsonPaste', 'aria-label': 'JSONを貼り付け', spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off' });
    body.append(
      h('p', { class: 'note' }, 'このアプリで保存したJSONを読み込みます。いま編集中の配色は、読み込んだ内容に置き換わります。'),
      h('label', { class: 'btn wide primary file-btn' }, 'ファイルを選ぶ', file),
      h('div', { class: 'or' }, 'または'),
      ta,
      h('button', { type: 'button', class: 'btn wide', id: 'btnPasteLoad', onclick: () => {
        err.hidden = true;
        if (ta.value.length > IMPORT_MAX_BYTES) { showErr('貼り付けた内容が大きすぎます。'); return; }
        apply(ta.value);
      } }, '貼り付けた内容を読み込む'),
      err);
  });
}

/* ---------- 配色の提案 ---------- */

function openSuggest() {
  openSheet('配色の提案', (body) => {
    const draw = () => {
      const cs = colors(), i = selIndex(), base = cs[i];
      const locked = cs.map((c) => c.lockColor);
      const hexes = cs.map((c) => c.hex);
      const lockedCount = locked.filter(Boolean).length;
      const cand = (label, desc, out) => h('button', {
        type: 'button', class: 'cand', 'aria-label': `${label} を採用`,
        onclick: () => {
          if (out.join() === hexes.join()) { toast('変化する色がありません（固定を確認してください）', 'warn'); return; }
          mutate(() => { cs.forEach((c, k) => { c.hex = out[k]; }); });
          toast(`「${label}」を採用しました`, 'ok', { label: '元に戻す', fn: () => { undo(); draw(); } });
          draw();
        },
      },
        h('span', { class: 'cand-head' }, h('b', {}, label), desc && h('span', {}, desc)),
        stripEl(out.map((hex, k) => ({ hex, ratio: cs[k].ratio })), 'strip cand-strip'));
      body.replaceChildren(
        h('div', { class: 'cand-now' }, h('span', { class: 'cand-head' }, h('b', {}, 'いまの配色'), h('span', {}, `${scopeDef().label}・${cs.length}色${lockedCount ? `・固定${lockedCount}色` : ''}`)), stripEl(cs, 'strip cand-strip')),
        h('h4', {}, '調和から作る'),
        h('p', { class: 'note' }, h('span', { class: 'dot', style: { background: base.hex } }), `選択中の色（色${i + 1} ${base.hex}）を基準に、他の色を作り直します。基準色と「色を固定」した色は変わりません。${cs.length < 2 ? '色が1色だけなので、色を追加すると候補が出ます。' : ''}`),
        ...(cs.length < 2 ? [] : HARMONY_MODES.map((m) => cand(m.label, m.desc, applyHarmony(hexes, i, locked, m.key)))),
        h('h4', {}, 'いまの配色を変化させる'),
        h('p', { class: 'note' }, '全体の印象を少しずつ動かします。何度でも重ねられます。「色を固定」した色は変わりません。'),
        ...VARIATIONS.map((v) => cand(v.label, '', applyVariation(hexes, locked, v.key))),
        h('p', { class: 'note' }, '候補は色彩理論に基づく機械的な提案です。仕上がりの良し悪しを保証するものではないので、目で見て選んでください。比率は変わりません。'));
    };
    draw();
  });
}

/* ---------- メニュー ---------- */

function openMenu() {
  openSheet('メニュー', (body, close) => {
    const item = (label, sub, fn) => h('button', { type: 'button', class: 'menu-item', onclick: () => { close(); fn(); } }, h('b', {}, label), h('span', {}, sub));
    body.append(
      item('保存済みパレット', '読込・名前変更・複製・削除・JSON出力', openLibrary),
      item('プリセット', 'オリジナルの配色12種から始める', openPresets),
      item('新規作成', '初期状態の新しいパレット', newPalette),
      item('パレット名とメモ', '名前・メモの編集', openInfo),
      item('JSONを読み込む', 'バックアップから復元', openJsonIn),
      item('このアプリについて', '使い方と注意', openAbout));
  });
}

function openAbout() {
  openSheet('このアプリについて', (body) => {
    const p = (t) => h('p', { class: 'about' }, t);
    body.append(
      h('h4', {}, '使い方'),
      p('① 色のチップを選び、色エリアやスライダーで色を探します。② 比率はスライダー・数値・プレビューの境界ドラッグで調整できます。③「転記チェックリスト」でHEXを1色ずつコピーし、PixAIのカラーパレット画面へ入力します。'),
      h('h4', {}, 'PixAIとの関係'),
      p('PixAI の非公式補助ツールです。PixAIへの自動入力・アカウント連携・画像生成は行いません。色数の上限（10色）や3系統の区分は、作成時点で把握している Tsubaki.3 のカラーパレット仕様に合わせています。'),
      p('比率は生成画像の面積を厳密に指定する値ではなく、色の存在感を誘導する目安です。同じパレットでも、プロンプトやseedで結果は変わります。'),
      h('h4', {}, 'データについて'),
      p('すべての処理はこの端末のブラウザ内で完結し、外部へ送信しません。保存したパレットはブラウザのデータを消したり端末を変えたりすると失われます。大事なものはJSONで保存してください。'),
      p(`${APP_NAME} v${APP_VERSION}`));
  });
}

/* ---------- 初期化 ---------- */

function initPickers() {
  const start = () => checkpoint('pick:' + selColor().id);
  area = makeArea($('sv'), $('svThumb'), { onStart: start, onInput: (s, v) => pickHsv({ s, v }) });
  slH = makeSlider($('slH'), { min: 0, max: 359, label: '色相', format: (v) => v + '度', onStart: start, onInput: (v) => pickHsv({ h: v }) });
  slS = makeSlider($('slS'), { min: 0, max: 100, label: '彩度', format: (v) => v + '%', onStart: start, onInput: (v) => pickHsv({ s: v / 100 }) });
  slV = makeSlider($('slV'), { min: 0, max: 100, label: '明るさ', format: (v) => v + '%', onStart: start, onInput: (v) => pickHsv({ v: v / 100 }) });
  slR = makeSlider($('slR'), { min: 1, max: 100, label: '比率', format: (v) => v + '%', onInput: (v) => changeRatio(v, 'ratio:' + selColor().id) });
}

function initEvents() {
  $('btnName').addEventListener('click', openInfo);
  $('btnSave').addEventListener('click', savePalette);
  $('btnMenu').addEventListener('click', openMenu);
  $('scopeSwitch').addEventListener('click', toggleScopeEnabled);

  $('btnCopyHex').addEventListener('click', () => copyText(selColor().hex, `${selColor().hex} をコピーしました`));
  $('btnLeft').addEventListener('click', () => moveColor(-1));
  $('btnRight').addEventListener('click', () => moveColor(1));
  $('btnDup').addEventListener('click', () => addColor(true));
  $('btnDel').addEventListener('click', deleteColor);

  // HEX入力：6桁そろったら即反映。3桁や確定は change で。無効なら警告して元の色を保つ。
  const hexInput = $('hexInput'), hexErr = $('hexErr');
  const showHexErr = (on) => { hexErr.hidden = !on; hexErr.textContent = on ? '色コードとして読めません。#RRGGBB（例：#F3E7E0）の形で入力してください。元の色のままにしています。' : ''; hexInput.classList.toggle('bad', on); };
  hexInput.addEventListener('input', () => {
    const raw = hexInput.value.trim().replace(/^[#＃]/, '');
    const hex = normalizeHex(hexInput.value);
    if (hex && raw.length === 6) { showHexErr(false); setHexOf(selColor(), hex, 'hex:' + selColor().id); }
  });
  const commitHex = () => {
    const hex = normalizeHex(hexInput.value);
    if (hex) { showHexErr(false); setHexOf(selColor(), hex, 'hex:' + selColor().id); hexInput.value = selColor().hex; }
    else if (hexInput.value.trim() === '') { showHexErr(false); hexInput.value = selColor().hex; }
    else showHexErr(true);
  };
  hexInput.addEventListener('change', commitHex);
  hexInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); commitHex(); hexInput.blur(); } });
  hexInput.addEventListener('blur', () => { if (!normalizeHex(hexInput.value)) { const bad = hexInput.value.trim() !== ''; hexInput.value = selColor().hex; if (bad) { showHexErr(true); hexInput.classList.remove('bad'); setTimeout(() => showHexErr(false), 4000); } } });
  hexInput.addEventListener('focus', () => hexInput.select());

  $('nativeColor').addEventListener('input', (e) => {
    const hex = normalizeHex(e.target.value);
    if (hex) setHexOf(selColor(), hex, 'native:' + selColor().id);
  });

  const ratioInput = $('ratioInput');
  const commitRatio = () => {
    const raw = ratioInput.value.trim().replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
    if (!/^\d{1,3}$/.test(raw)) {
      if (raw !== '') toast('比率は1以上の整数で入力してください', 'warn');
      ratioInput.value = String(selColor().ratio);
      return;
    }
    const want = parseInt(raw, 10);
    changeRatio(want, null);
    const got = selColor().ratio;
    ratioInput.value = String(got);
    if (got !== want) toast(`この色に設定できるのは 1〜${maxRatio(ratiosOf(), selIndex(), fixedIdx())}% です`, 'warn');
  };
  ratioInput.addEventListener('change', commitRatio);
  ratioInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ratioInput.blur(); } });
  ratioInput.addEventListener('focus', () => ratioInput.select());
  $('btnRminus').addEventListener('click', () => changeRatio(selColor().ratio - 1, 'ratio-step'));
  $('btnRplus').addEventListener('click', () => changeRatio(selColor().ratio + 1, 'ratio-step'));
  $('btnLockRatio').addEventListener('click', () => mutate(() => { const c = selColor(); c.lockRatio = !c.lockRatio; }));
  $('btnLockColor').addEventListener('click', () => mutate(() => { const c = selColor(); c.lockColor = !c.lockColor; }));

  $('btnAdd').addEventListener('click', () => addColor());
  $('btnReverse').addEventListener('click', reverseColors);
  $('btnShuffle').addEventListener('click', shuffleColors);
  $('btnEqual').addEventListener('click', equalizeRatios);
  $('btnUndo').addEventListener('click', undo);
  $('btnRedo').addEventListener('click', redo);
  $('btnSuggest').addEventListener('click', openSuggest);

  $('btnTransfer').addEventListener('click', openTransfer);
  $('btnCopyAll').addEventListener('click', () => copyText(toText(S.palette), 'HEXと比率をコピーしました'));
  $('btnCopyHexes').addEventListener('click', () => copyText(toText(S.palette, { hexOnly: true }), 'HEXコードをコピーしました'));
  $('btnPng').addEventListener('click', openPng);
  $('btnJsonOut').addEventListener('click', () => openJsonOut());
  $('btnJsonIn').addEventListener('click', openJsonIn);
  $('btnLibrary').addEventListener('click', openLibrary);
  $('btnPresets').addEventListener('click', openPresets);
  $('btnNew').addEventListener('click', newPalette);

  document.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    e.preventDefault();
    if (e.shiftKey) redo(); else undo();
  });

  // キーボードが出ても入力欄が隠れないようにする
  const vv = window.visualViewport;
  const setVv = () => {
    const hgt = vv ? vv.height : window.innerHeight;
    document.documentElement.style.setProperty('--vvh', hgt + 'px');
    document.documentElement.style.setProperty('--kb', Math.max(0, window.innerHeight - hgt - (vv ? vv.offsetTop : 0)) + 'px');
  };
  setVv();
  if (vv) { vv.addEventListener('resize', setVv); vv.addEventListener('scroll', setVv); }
  window.addEventListener('resize', setVv);
  document.addEventListener('focusin', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && t.type !== 'color' && t.type !== 'file') {
      setTimeout(() => { if (document.activeElement === t) t.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, 320);
    }
  });

  // ページを離れる直前にも下書きを確実に書く
  window.addEventListener('pagehide', saveDraftNow);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveDraftNow(); });
}

function init() {
  const draft = store.loadDraft();
  S.palette = draft ? draft.palette : createPalette();
  S.dirty = draft ? draft.dirty : false;
  if (draft && SCOPES.some((s) => s.key === draft.scope)) S.scope = draft.scope;
  ensureSel();
  initPickers();
  initEvents();
  render();
  if (!persistent) toast('このブラウザでは端末内保存が使えません。JSONでの保存をご利用ください。', 'warn');
}

init();
