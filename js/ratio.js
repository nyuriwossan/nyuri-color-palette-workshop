// 比率計算。すべて整数％・合計100・複数色なら各1％以上を保証する純粋関数。
import { MIN_RATIO as MIN, TOTAL_RATIO as TOTAL, MAX_COLORS } from './config.js';

const sum = (a) => a.reduce((x, y) => x + y, 0);

/**
 * total を weights に比例して整数配分する（最大剰余法）。各要素は min 以上。
 * weights が全部0以下なら均等配分。
 */
export function distribute(total, weights, min = MIN) {
  const n = weights.length;
  if (n === 0) return [];
  const rem = total - n * min;
  if (rem < 0) throw new RangeError('配分できません');
  let w = weights.map((x) => (Number.isFinite(x) && x > 0 ? x : 0));
  let W = sum(w);
  if (W <= 0) { w = w.map(() => 1); W = n; }
  const exact = w.map((x) => (rem * x) / W);
  const base = exact.map(Math.floor);
  let left = rem - sum(base);
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x), w: w[i] }))
    .sort((a, b) => b.frac - a.frac || b.w - a.w || a.i - b.i);
  for (let k = 0; left > 0; k = (k + 1) % n, left--) base[order[k].i]++;
  return base.map((x) => x + min);
}

/** 有効な比率配列か */
export function isValidRatios(ratios) {
  if (!Array.isArray(ratios) || ratios.length < 1 || ratios.length > MAX_COLORS) return false;
  if (!ratios.every((r) => Number.isInteger(r) && r >= MIN && r <= TOTAL)) return false;
  return sum(ratios) === TOTAL;
}

/** n色の均等配分 */
export function equalize(n) {
  return distribute(TOTAL, new Array(n).fill(1));
}

/** どんな数値配列でも有効な比率に直す（元の大小関係はできるだけ保つ） */
export function sanitize(values) {
  const n = values.length;
  if (n === 0) return [];
  if (n === 1) return [TOTAL];
  const w = values.map((v) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : 0; });
  return distribute(TOTAL, w);
}

function freeOthers(ratios, idx, fixed) {
  const fx = new Set((fixed || []).filter((i) => i !== idx && i >= 0 && i < ratios.length));
  const free = [];
  for (let i = 0; i < ratios.length; i++) if (i !== idx && !fx.has(i)) free.push(i);
  const fixedSum = sum([...fx].map((i) => ratios[i]));
  return { free, fixedSum };
}

/** idx の色に設定できる最大値（動かせる相手がいなければ現在値） */
export function maxRatio(ratios, idx, fixed = []) {
  if (ratios.length === 1) return TOTAL;
  const { free, fixedSum } = freeOthers(ratios, idx, fixed);
  if (free.length === 0) return ratios[idx];
  return TOTAL - fixedSum - free.length * MIN;
}

/**
 * idx の比率を value にし、残りを「固定されていない他の色」に元の比率に応じて再配分。
 * fixed: 比率を固定している色のインデックス配列。
 */
export function setRatio(ratios, idx, value, fixed = []) {
  const n = ratios.length;
  if (n === 1) return [TOTAL];
  let v = Math.round(Number(value));
  if (!Number.isFinite(v)) return ratios.slice();
  const { free, fixedSum } = freeOthers(ratios, idx, fixed);
  if (free.length === 0) return ratios.slice();
  v = Math.min(TOTAL - fixedSum - free.length * MIN, Math.max(MIN, v));
  const alloc = distribute(TOTAL - fixedSum - v, free.map((i) => ratios[i] - MIN));
  const out = ratios.slice();
  out[idx] = v;
  free.forEach((i, k) => { out[i] = alloc[k]; });
  return out;
}

/** 色を1つ追加したときの比率（新しい色は at の位置に入る）。上限なら null。 */
export function addRatio(ratios, at = ratios.length, fixed = []) {
  const n = ratios.length;
  if (n >= MAX_COLORS) return null;
  if (n === 0) return [TOTAL];
  const target = Math.max(MIN, Math.round(TOTAL / (n + 1)));
  let { free } = freeOthers(ratios, -1, fixed);
  let avail = sum(free.map((i) => ratios[i])) - free.length * MIN;
  if (avail < MIN) { free = ratios.map((_, i) => i); avail = TOTAL - n * MIN; }
  const take = Math.min(target, avail);
  const alloc = distribute(sum(free.map((i) => ratios[i])) - take, free.map((i) => ratios[i] - MIN));
  const out = ratios.slice();
  free.forEach((i, k) => { out[i] = alloc[k]; });
  const pos = Math.min(Math.max(0, at), n);
  out.splice(pos, 0, take);
  return out;
}

/** idx の色を消したときの比率。最後の1色は消せないので null。 */
export function removeRatio(ratios, idx, fixed = []) {
  const n = ratios.length;
  if (n <= 1) return null;
  const rest = [];
  for (let i = 0; i < n; i++) if (i !== idx) rest.push(i);
  if (rest.length === 1) return [TOTAL];
  const fx = new Set(fixed);
  let free = rest.filter((i) => !fx.has(i));
  if (free.length === 0) free = rest;
  const alloc = distribute(sum(free.map((i) => ratios[i])) + ratios[idx], free.map((i) => ratios[i] - MIN));
  const tmp = ratios.slice();
  free.forEach((i, k) => { tmp[i] = alloc[k]; });
  tmp.splice(idx, 1);
  return tmp;
}

/** i と i+1 の境界を delta％ 動かす（2色の合計は不変、各1％以上） */
export function moveBoundary(ratios, i, delta) {
  if (i < 0 || i >= ratios.length - 1) return ratios.slice();
  let d = Math.round(Number(delta));
  if (!Number.isFinite(d)) return ratios.slice();
  const a = ratios[i], b = ratios[i + 1];
  d = Math.min(b - MIN, Math.max(-(a - MIN), d));
  const out = ratios.slice();
  out[i] = a + d;
  out[i + 1] = b - d;
  return out;
}
