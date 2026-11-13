// 色彩調和（色相角ベース）と、パレット全体のバリエーション生成。
import { hexToHsv, hsvToHex, hexToRgb, rgbToHsl, hslToRgb, rgbToHex, mixHex } from './color.js';

export const HARMONY_MODES = [
  { key: 'mono', label: 'モノクロマティック', desc: '同じ色相の濃淡', offsets: [0] },
  { key: 'analogous', label: 'アナロガス', desc: '隣り合う類似色', offsets: [0, 30, -30, 60, -60] },
  { key: 'complementary', label: 'コンプリメンタリー', desc: '補色（反対の色）', offsets: [0, 180] },
  { key: 'split', label: 'スプリット', desc: '補色の両隣', offsets: [0, 150, 210] },
  { key: 'triadic', label: 'トライアド', desc: '色相環を三等分', offsets: [0, 120, 240] },
  { key: 'tetradic', label: 'テトラード', desc: '2組の補色（長方形）', offsets: [0, 60, 180, 240] },
];

const clamp01 = (x) => Math.min(1, Math.max(0, x));

// 色相が一巡したあとの「濃淡ずらし」
function tone(s, v, cycle) {
  switch (cycle % 4) {
    case 0: return { s, v };
    case 1: return { s: s * 0.5, v: v + (1 - v) * 0.6 };
    case 2: return { s: clamp01(s * 0.95 + 0.05), v: v * 0.55 };
    default: return { s: s * 0.28, v: v + (1 - v) * 0.85 };
  }
}

/** 基準色から count 色を作る。先頭は必ず基準色そのもの。 */
export function generateHarmony(baseHex, modeKey, count) {
  const mode = HARMONY_MODES.find((m) => m.key === modeKey);
  if (!mode) throw new Error('未知の配色モード: ' + modeKey);
  const b = hexToHsv(baseHex);
  const out = [hsvToHex(b)];
  if (mode.key === 'mono') {
    const steps = Math.max(1, Math.ceil((count - 1) / 2));
    for (let i = 1; i < count; i++) {
      const t = Math.ceil(i / 2) / steps;
      if (i % 2 === 1) out.push(hsvToHex({ h: b.h, s: b.s * (1 - 0.62 * t), v: b.v + (1 - b.v) * 0.75 * t }));
      else out.push(hsvToHex({ h: b.h, s: clamp01(b.s + (1 - b.s) * 0.15 * t), v: b.v * (1 - 0.6 * t) }));
    }
    return out;
  }
  // 無彩色が基準だと色相を回しても変化しないので、生成色には最低限の彩度を持たせる
  const s0 = Math.max(b.s, 0.3), v0 = Math.max(b.v, 0.25);
  const offs = mode.offsets;
  for (let i = 1; i < count; i++) {
    const k = i % offs.length, cycle = Math.floor(i / offs.length);
    const t = tone(s0, v0, cycle);
    out.push(hsvToHex({ h: b.h + offs[k], s: t.s, v: t.v }));
  }
  return out;
}

/**
 * 現在の色配列に調和配色を当てはめる。
 * baseIndex の色と locked[i]===true の色は変えない。
 */
export function applyHarmony(hexes, baseIndex, locked, modeKey) {
  const n = hexes.length;
  const gen = generateHarmony(hexes[baseIndex], modeKey, n);
  const out = hexes.slice();
  let g = 1;
  for (let i = 0; i < n; i++) {
    if (i === baseIndex || (locked && locked[i])) continue;
    out[i] = gen[g++];
  }
  return out;
}

export const VARIATIONS = [
  { key: 'lighter', label: '明るめ' },
  { key: 'darker', label: '暗め' },
  { key: 'vivid', label: '高彩度' },
  { key: 'muted', label: '低彩度' },
  { key: 'warm', label: '暖色寄り' },
  { key: 'cool', label: '寒色寄り' },
];

export function varyHex(hex, key) {
  const hsl = rgbToHsl(hexToRgb(hex));
  switch (key) {
    case 'lighter': return rgbToHex(hslToRgb({ ...hsl, l: hsl.l + (1 - hsl.l) * 0.28 }));
    case 'darker': return rgbToHex(hslToRgb({ ...hsl, l: hsl.l * 0.76 }));
    case 'vivid': return rgbToHex(hslToRgb({ ...hsl, s: hsl.s + (1 - hsl.s) * 0.35 }));
    case 'muted': return rgbToHex(hslToRgb({ ...hsl, s: hsl.s * 0.55 }));
    case 'warm': return mixHex(hex, '#FF8A3D', 0.14);
    case 'cool': return mixHex(hex, '#3D8BFF', 0.14);
    default: throw new Error('未知のバリエーション: ' + key);
  }
}

/** locked の色は変えずにパレット全体を変化させる */
export function applyVariation(hexes, locked, key) {
  return hexes.map((hx, i) => (locked && locked[i] ? hx : varyHex(hx, key)));
}
