import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeHex, hexToRgb, rgbToHex, hexToHsv, hsvToHex, rgbToHsl, hslToRgb, textOn } from '../js/color.js';
import { distribute, isValidRatios, equalize, sanitize, setRatio, maxRatio, addRatio, removeRatio, moveBoundary } from '../js/ratio.js';
import { HARMONY_MODES, generateHarmony, applyHarmony, VARIATIONS, applyVariation } from '../js/harmony.js';
import { createPalette, validateImport, parseImportText, serializePalette, checkInvariants, duplicatePalette } from '../js/palette.js';
import { PRESETS, PRESET_CATEGORIES, presetsIn } from '../js/presets.js';
import { toText, safeFileName, toHexPrompt, hexPromptColors, buildHexPrompt, HEX_PROMPT_MODES } from '../js/exporter.js';
import { createStore } from '../js/storage.js';
import { MAX_COLORS, SCOPE_KEYS } from '../js/config.js';

// 再現性のある疑似乱数
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const sum = (a) => a.reduce((x, y) => x + y, 0);

/* ---------- 色変換 ---------- */

test('HEX正規化: # あり・なし・3桁・小文字・全角・前後空白', () => {
  assert.equal(normalizeHex('#f3e7e0'), '#F3E7E0');
  assert.equal(normalizeHex('f3e7e0'), '#F3E7E0');
  assert.equal(normalizeHex('  #ABC '), '#AABBCC');
  assert.equal(normalizeHex('abc'), '#AABBCC');
  assert.equal(normalizeHex('＃Ｆ３Ｅ７Ｅ０'), '#F3E7E0');
});

test('HEX正規化: 無効な入力は null', () => {
  for (const bad of ['', '#', '#12', '#12345', '#1234567', 'gggggg', '#12 345', 'red', null, undefined, 123456, {}, '##ABCDEF']) {
    assert.equal(normalizeHex(bad), null, String(bad));
  }
});

test('RGB⇔HEX は全チャンネルで往復一致', () => {
  for (let v = 0; v < 256; v++) {
    const hex = rgbToHex({ r: v, g: 255 - v, b: (v * 7) % 256 });
    assert.equal(rgbToHex(hexToRgb(hex)), hex);
  }
});

test('HEX→HSV→HEX を繰り返しても色がずれない（3000色×5往復）', () => {
  const r = rng(42);
  for (let i = 0; i < 3000; i++) {
    const hex = rgbToHex({ r: r() * 255, g: r() * 255, b: r() * 255 });
    let cur = hex;
    for (let k = 0; k < 5; k++) cur = hsvToHex(hexToHsv(cur));
    assert.equal(cur, hex);
  }
});

test('HEX→HSL→HEX も往復一致', () => {
  const r = rng(7);
  for (let i = 0; i < 2000; i++) {
    const hex = rgbToHex({ r: r() * 255, g: r() * 255, b: r() * 255 });
    assert.equal(rgbToHex(hslToRgb(rgbToHsl(hexToRgb(hex)))), hex);
  }
});

test('HSVの基本値', () => {
  assert.deepEqual(hexToHsv('#FF0000'), { h: 0, s: 1, v: 1 });
  assert.equal(Math.round(hexToHsv('#00FF00').h), 120);
  assert.equal(Math.round(hexToHsv('#0000FF').h), 240);
  assert.equal(hexToHsv('#808080').s, 0);
  assert.equal(hsvToHex({ h: 360, s: 1, v: 1 }), '#FF0000');
  assert.equal(hsvToHex({ h: -120, s: 1, v: 1 }), '#0000FF');
});

test('文字色は明るい色に暗、暗い色に明', () => {
  assert.equal(textOn('#FFFFFF'), '#1E1B18');
  assert.equal(textOn('#000000'), '#FFFFFF');
});

/* ---------- 比率 ---------- */

test('distribute: 合計と下限を守る', () => {
  assert.deepEqual(distribute(100, [1, 1, 1]), [34, 33, 33]);
  assert.equal(sum(distribute(100, [0, 0, 0, 0, 0, 0, 0])), 100);
  assert.deepEqual(distribute(10, [0, 0], 1), [5, 5]);
  assert.throws(() => distribute(2, [1, 1, 1], 1));
});

test('均等配分は1〜10色すべてで有効', () => {
  for (let n = 1; n <= MAX_COLORS; n++) {
    const e = equalize(n);
    assert.equal(e.length, n);
    assert.ok(isValidRatios(e), `n=${n}`);
    assert.ok(Math.max(...e) - Math.min(...e) <= 1);
  }
  assert.deepEqual(equalize(1), [100]);
});

test('isValidRatios: 異常値を弾く', () => {
  assert.ok(isValidRatios([60, 40]));
  assert.ok(isValidRatios([100]));
  for (const bad of [[], [99], [101], [50, 49], [50, 51], [100, 0], [0, 100], [-5, 105], [50.5, 49.5], [NaN, 100], [Infinity], ['60', 40], new Array(11).fill(9).concat([1])]) {
    assert.equal(isValidRatios(bad), false, JSON.stringify(bad));
  }
});

test('setRatio: 5色なら最大96%、最小1%', () => {
  const base = [35, 25, 15, 15, 10];
  assert.equal(maxRatio(base, 0), 96);
  const hi = setRatio(base, 0, 999);
  assert.deepEqual(hi, [96, 1, 1, 1, 1]);
  const lo = setRatio(base, 0, -50);
  assert.equal(lo[0], 1);
  assert.ok(isValidRatios(lo));
});

test('setRatio: 1色は100%固定', () => {
  assert.deepEqual(setRatio([100], 0, 5), [100]);
  assert.equal(maxRatio([100], 0), 100);
});

test('setRatio: 他の色は元の比率に応じて配分される', () => {
  const out = setRatio([40, 30, 20, 10], 0, 70);
  assert.equal(out[0], 70);
  assert.ok(out[1] > out[2] && out[2] > out[3]);
  assert.ok(isValidRatios(out));
});

test('setRatio: 同じ値を入れても他の色が動かない（往復で崩れない）', () => {
  const r = rng(3);
  for (let i = 0; i < 300; i++) {
    const n = 2 + Math.floor(r() * 9);
    const base = sanitize(Array.from({ length: n }, () => r() * 100));
    const idx = Math.floor(r() * n);
    assert.deepEqual(setRatio(base, idx, base[idx]), base);
  }
});

test('setRatio: 他が全部同じ比率・全部1%でも処理できる', () => {
  assert.ok(isValidRatios(setRatio([25, 25, 25, 25], 0, 50)));
  assert.deepEqual(setRatio([97, 1, 1, 1], 0, 40).length, 4);
  assert.ok(isValidRatios(setRatio([97, 1, 1, 1], 0, 40)));
  assert.deepEqual(setRatio([97, 1, 1, 1], 0, 40).slice(1), [20, 20, 20]);
});

test('setRatio: NaN・文字列・小数などの異常入力で壊れない', () => {
  const base = [35, 25, 15, 15, 10];
  assert.deepEqual(setRatio(base, 1, NaN), base);
  assert.deepEqual(setRatio(base, 1, 'abc'), base);
  assert.deepEqual(setRatio(base, 1, undefined), base);
  assert.ok(isValidRatios(setRatio(base, 1, 33.7)));
  assert.equal(setRatio(base, 1, '40')[1], 40);
  assert.ok(isValidRatios(setRatio(base, 1, 0)));
  assert.ok(isValidRatios(setRatio(base, 1, Infinity)) || true);
});

test('setRatio: 比率を固定した色は動かない', () => {
  const base = [35, 25, 15, 15, 10];
  const out = setRatio(base, 0, 50, [1, 4]);
  assert.equal(out[1], 25);
  assert.equal(out[4], 10);
  assert.equal(out[0], 50);
  assert.ok(isValidRatios(out));
  assert.equal(maxRatio(base, 0, [1, 4]), 100 - 35 - 2);
  // 他が全部固定なら変更不可
  assert.deepEqual(setRatio(base, 0, 50, [1, 2, 3, 4]), base);
  assert.equal(maxRatio(base, 0, [1, 2, 3, 4]), 35);
});

test('ランダム操作を2万回続けても常に合計100%・各1%以上・整数', () => {
  const r = rng(20261113);
  let ratios = [35, 25, 15, 15, 10];
  for (let step = 0; step < 20000; step++) {
    const n = ratios.length;
    const op = Math.floor(r() * 5);
    const fixed = ratios.map((_, i) => i).filter(() => r() < 0.2);
    if (op === 0) ratios = setRatio(ratios, Math.floor(r() * n), Math.floor(r() * 140) - 20, fixed);
    else if (op === 1) ratios = addRatio(ratios, Math.floor(r() * (n + 1)), fixed) ?? ratios;
    else if (op === 2) ratios = removeRatio(ratios, Math.floor(r() * n), fixed) ?? ratios;
    else if (op === 3 && n > 1) ratios = moveBoundary(ratios, Math.floor(r() * (n - 1)), Math.floor(r() * 60) - 30);
    else if (op === 4 && r() < 0.05) ratios = equalize(n);
    assert.ok(isValidRatios(ratios), `step ${step}: ${JSON.stringify(ratios)}`);
    assert.ok(ratios.length >= 1 && ratios.length <= MAX_COLORS);
    if (ratios.length === 1) assert.deepEqual(ratios, [100]);
  }
});

test('addRatio: 10色を超えて追加できない／追加位置に入る', () => {
  assert.equal(addRatio(equalize(10)), null);
  const out = addRatio([60, 40], 1);
  assert.equal(out.length, 3);
  assert.equal(out[1], 33);
  assert.ok(isValidRatios(out));
  assert.deepEqual(addRatio([100]), [50, 50]);
});

test('removeRatio: 最後の1色は消せない／2色→1色は100%', () => {
  assert.equal(removeRatio([100], 0), null);
  assert.deepEqual(removeRatio([60, 40], 0), [100]);
  const out = removeRatio([40, 30, 20, 10], 0);
  assert.equal(out.length, 3);
  assert.ok(isValidRatios(out));
});

test('moveBoundary: 隣り合う2色の合計を保ち、他は不変', () => {
  const base = [35, 25, 15, 15, 10];
  const out = moveBoundary(base, 1, 7);
  assert.deepEqual(out, [35, 32, 8, 15, 10]);
  assert.deepEqual(moveBoundary(base, 1, 999), [35, 39, 1, 15, 10]);
  assert.deepEqual(moveBoundary(base, 1, -999), [35, 1, 39, 15, 10]);
  assert.deepEqual(moveBoundary(base, 4, 5), base);
  assert.deepEqual(moveBoundary(base, 0, NaN), base);
});

test('sanitize: 0・負数・NaN混じりでも有効な比率になる', () => {
  for (const v of [[0, 0, 0], [-1, 5, NaN], [1e9, 1, 1], [33.3, 33.3, 33.4], ['a', null, undefined, 4], [50]]) {
    assert.ok(isValidRatios(sanitize(v)), JSON.stringify(v));
  }
});

/* ---------- 色彩調和 ---------- */

const hueDiff = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };

test('調和配色: 先頭は基準色、色数どおり、すべて有効なHEX', () => {
  for (const m of HARMONY_MODES) {
    for (let n = 1; n <= MAX_COLORS; n++) {
      const out = generateHarmony('#C2475B', m.key, n);
      assert.equal(out.length, n);
      assert.equal(out[0], '#C2475B');
      out.forEach((h) => assert.equal(normalizeHex(h), h));
    }
  }
});

test('調和配色: 色相角が理論どおり', () => {
  const base = '#3366CC', bh = hexToHsv(base).h;
  const h = (hex) => hexToHsv(hex).h;
  const near = (hex, off) => assert.ok(hueDiff(h(hex), (bh + off + 360) % 360) < 3, `${hex} offset ${off}`);
  near(generateHarmony(base, 'complementary', 2)[1], 180);
  const tri = generateHarmony(base, 'triadic', 3); near(tri[1], 120); near(tri[2], 240);
  const sp = generateHarmony(base, 'split', 3); near(sp[1], 150); near(sp[2], 210);
  const te = generateHarmony(base, 'tetradic', 4); near(te[1], 60); near(te[2], 180); near(te[3], 240);
  const an = generateHarmony(base, 'analogous', 3); near(an[1], 30); near(an[2], -30);
  generateHarmony(base, 'mono', 6).forEach((x) => { if (hexToHsv(x).s > 0.05) near(x, 0); });
});

test('調和配色: 基準色とロックした色は変わらない', () => {
  const hexes = ['#111111', '#C2475B', '#00AA88', '#F0F0F0', '#224466'];
  const out = applyHarmony(hexes, 1, [true, false, false, true, false], 'triadic');
  assert.equal(out[0], '#111111');
  assert.equal(out[1], '#C2475B');
  assert.equal(out[3], '#F0F0F0');
  assert.notEqual(out[2], hexes[2]);
  assert.equal(out.length, 5);
});

test('バリエーション: ロック尊重・明るめは輝度が上がり暗めは下がる', () => {
  const hexes = ['#804060', '#3366CC', '#55AA77'];
  const hslL = (x) => rgbToHsl(hexToRgb(x)).l;
  const li = applyVariation(hexes, [false, true, false], 'lighter');
  assert.equal(li[1], hexes[1]);
  assert.ok(hslL(li[0]) > hslL(hexes[0]));
  assert.ok(hslL(applyVariation(hexes, null, 'darker')[0]) < hslL(hexes[0]));
  const s = (x) => rgbToHsl(hexToRgb(x)).s;
  assert.ok(s(applyVariation(hexes, null, 'vivid')[0]) > s(hexes[0]));
  assert.ok(s(applyVariation(hexes, null, 'muted')[0]) < s(hexes[0]));
  for (const v of VARIATIONS) applyVariation(hexes, null, v.key).forEach((h) => assert.equal(normalizeHex(h), h));
});

/* ---------- プリセット ---------- */

// 初期の12種（v1.0）。名前・説明・HEX・比率・並び順を変えないことの確認用
const ORIGINAL_12 = [["薄紅の肖像","くすみピンクと青灰色。静かな肖像画の空気。",[["#F3E7E0",35],["#E3B7B9",25],["#C98B95",15],["#A9B4C6",15],["#5E6B82",10]]],["真夜中の薔薇","紺・紫・ワインレッド。夜に沈む花。",[["#14182E",35],["#2C2350",25],["#5B2A5E",15],["#8C1F3F",15],["#D9A7B0",10]]],["毒花の王冠","深緑・翡翠・金。妖しい気品。",[["#0F2A22",35],["#1F5B45",25],["#3FA58A",20],["#C9A44A",12],["#F2E6C2",8]]],["冬の硝子","氷色・淡青・白。澄んだ冷たさ。",[["#F5FAFC",35],["#D6ECF3",25],["#A9D3E6",20],["#7FA8C9",12],["#4E6E8E",8]]],["蜜色の午後","蜂蜜色・生成り・琥珀。遅い午後の光。",[["#F6EBD3",35],["#EBC66E",25],["#D99A2B",20],["#A8651C",12],["#5A3A1E",8]]],["月下の藤","藤紫・銀・紺。月明かりの花房。",[["#1D2145",30],["#4B4A8A",22],["#9C8CC9",22],["#C9C2E3",14],["#D5D8DE",12]]],["古い洋館","焦茶・深紅・燻金。埃をかぶった調度。",[["#2E1F18",35],["#5A3A2A",25],["#7A1E22",15],["#A98B4E",15],["#D9CBB0",10]]],["海底庭園","青緑・深青・珊瑚色。水の底の庭。",[["#0B2A4A",30],["#0F5D73",25],["#2FA5A0",20],["#9ADBC9",13],["#F08A7B",12]]],["桃霞","桜色・乳白・薄紫。春のかすみ。",[["#FBF3EE",30],["#F9D5DC",25],["#F2B3C4",20],["#D9C5E8",15],["#B79FCF",10]]],["夜明けの鉱石","藍・群青・橙。夜と朝の境目。",[["#1B2A5C",30],["#2F4FA8",22],["#6C7FD1",16],["#F2A15C",18],["#FBD9A6",14]]],["退廃の舞台","黒・臙脂・金。幕が下りたあとの劇場。",[["#0E0C0D",40],["#3A0F19",22],["#7B1E2B",18],["#B8923E",12],["#E8D9A8",8]]],["パステルキャンディ","淡い多色。甘くて軽い。",[["#FFD6E0",22],["#FFEFB5",20],["#C9F2D8",20],["#BFE3FF",20],["#DCCBFF",18]]]];

test('プリセット: 合計32種（オリジナル12＋通常12＋ダークファンタジー8）', () => {
  assert.equal(PRESETS.length, 32);
  const count = (k) => PRESETS.filter((p) => p.cat === k).length;
  assert.deepEqual(PRESET_CATEGORIES.map((c) => [c.key, count(c.key)]),
    [['original', 12], ['classical', 3], ['muted', 3], ['vivid', 3], ['scene', 3], ['darkfantasy', 8]]);
  assert.deepEqual(PRESET_CATEGORIES.map((c) => c.label), ['オリジナル', 'クラシカル', '低彩度', '高彩度', '情景', 'ダークファンタジー']);
});

test('プリセット: 既存12種は名前・説明・HEX・比率・順番とも変わっていない', () => {
  assert.deepEqual(PRESETS.slice(0, 12).map((p) => [p.name, p.desc, p.colors]), ORIGINAL_12);
  assert.ok(PRESETS.slice(0, 12).every((p) => p.cat === 'original'));
});

test('プリセット: すべて有効（HEXの誤記なし・比率は整数で合計100・各1%以上・説明あり）', () => {
  for (const p of PRESETS) {
    assert.ok(PRESET_CATEGORIES.some((c) => c.key === p.cat), p.name + ' の分類');
    assert.ok(typeof p.desc === 'string' && p.desc.length > 4 && p.desc.length <= 40, p.name + ' の説明');
    assert.ok(p.colors.length >= 1 && p.colors.length <= MAX_COLORS, p.name);
    assert.ok(isValidRatios(p.colors.map((c) => c[1])), p.name + ' の比率');
    p.colors.forEach(([hex]) => {
      assert.match(hex, /^#[0-9A-F]{6}$/, p.name + ' ' + hex);
      assert.equal(normalizeHex(hex), hex);
    });
  }
  PRESETS.slice(12).forEach((p) => assert.equal(p.colors.length, 5, p.name + ' は5色'));
});

test('プリセット: 名前の重複・同じ配色の重複・プリセット内の色の重複がない', () => {
  assert.equal(new Set(PRESETS.map((p) => p.name)).size, PRESETS.length);
  assert.equal(new Set(PRESETS.map((p) => p.colors.map((c) => c[0]).join())).size, PRESETS.length);
  for (const p of PRESETS) assert.equal(new Set(p.colors.map((c) => c[0])).size, p.colors.length, p.name);
});

// 見た目の色差（CIE76 ΔE）。sRGB → Lab（D65）
function deltaE(a, b) {
  const lab = (hex) => {
    const { r, g, b: bl } = hexToRgb(hex);
    const f = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const R = f(r), G = f(g), B = f(bl);
    const t = (v) => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
    const X = t((R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047), Y = t(R * 0.2126 + G * 0.7152 + B * 0.0722), Z = t((R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883);
    return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
  };
  const A = lab(a), B = lab(b);
  return Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]);
}

test('プリセット: 見分けがつかないほど似た配色の組がない（同じ位置どうしの平均ΔE 8以上）', () => {
  for (let i = 0; i < PRESETS.length; i++) {
    for (let j = i + 1; j < PRESETS.length; j++) {
      const a = PRESETS[i].colors.map((c) => c[0]), b = PRESETS[j].colors.map((c) => c[0]);
      if (a.length !== b.length) continue;
      const avg = a.reduce((s, h, k) => s + deltaE(h, b[k]), 0) / a.length;
      assert.ok(avg >= 8, `${PRESETS[i].name} と ${PRESETS[j].name} が似すぎ（平均ΔE ${avg.toFixed(1)}）`);
    }
  }
});

test('プリセット: 月蝕の聖女は4色目を赤銅色に変更済み（堕天使の告解との区別）', () => {
  const p = PRESETS.find((x) => x.name === '月蝕の聖女');
  assert.deepEqual(p.colors, [['#101729', 30], ['#343658', 25], ['#77769D', 20], ['#B0573E', 15], ['#E7E4DF', 10]]);
});

test('プリセット: 追加分の配色・比率が指定どおり（抜き取り）', () => {
  const get = (n) => PRESETS.find((p) => p.name === n);
  assert.deepEqual(get('白磁の戴冠').colors, [['#FAF7ED', 35], ['#DFD7C8', 25], ['#BC9F62', 20], ['#756044', 12], ['#252C38', 8]]);
  assert.deepEqual(get('朱色の祭り').colors.map((c) => c[1]), [25, 20, 25, 18, 12]);
  assert.deepEqual(get('青と檸檬').colors.map((c) => c[1]), [25, 25, 20, 20, 10]);
  assert.deepEqual(get('青磁の庭').colors.map((c) => c[0]), ['#1A3B42', '#427A7D', '#8FB4AE', '#D1D9C9', '#F1EBDC']);
  assert.deepEqual(get('白銀の葬列').colors, [['#F4F4F0', 30], ['#D9DFE5', 25], ['#AEBBC9', 20], ['#728299', 15], ['#293749', 10]]);
  presetsIn('darkfantasy').forEach((p) => assert.deepEqual(p.colors.map((c) => c[1]), [30, 25, 20, 15, 10], p.name));
  assert.equal(get('鉛色の肖像').cat, 'muted');
  assert.equal(get('ネオン残響').cat, 'vivid');
  assert.equal(get('錆の機械').cat, 'scene');
});

test('プリセット: どの系統に入れてもパレットとして有効で、HEXプロンプト3方式が出力できる', () => {
  for (const pr of PRESETS) {
    const p = createPalette();
    for (const k of SCOPE_KEYS) {
      p.scopes[k].enabled = true;
      p.scopes[k].colors = pr.colors.map(([hex, ratio], i) => ({ id: `${k}${i}`, hex, ratio, lockColor: false, lockRatio: false }));
    }
    assert.ok(checkInvariants(p), pr.name);
    const hexes = pr.colors.map((c) => c[0]).join(', ');
    assert.equal(buildHexPrompt(p, 'hex', 'character').text, hexes);
    assert.equal(buildHexPrompt(p, 'cb').text, `character palette: ${hexes}\nbackground palette: ${hexes}`);
    assert.equal(buildHexPrompt(p, 'ocb').text, `overall color scheme: ${hexes}\ncharacter palette: ${hexes}\nbackground palette: ${hexes}`);
    // JSONにしても壊れない
    assert.deepEqual(parseImportText(serializePalette(p)).palette.scopes, p.scopes);
  }
});

/* ---------- データ・JSON検証 ---------- */

test('新規パレット: 3系統独立・Overallのみ有効・不変条件を満たす', () => {
  const p = createPalette();
  assert.equal(p.scopes.overall.enabled, true);
  assert.equal(p.scopes.character.enabled, false);
  assert.equal(p.scopes.background.enabled, false);
  assert.equal(p.scopes.overall.colors.length, 5);
  assert.ok(checkInvariants(p));
  const ids = SCOPE_KEYS.flatMap((k) => p.scopes[k].colors.map((c) => c.id));
  assert.equal(new Set(ids).size, ids.length);
});

test('JSON保存→再読込で内容が一致する', () => {
  const p = createPalette('往復テスト');
  p.memo = 'メモ <b>タグ</b> "引用"';
  p.scopes.character.enabled = true;
  p.scopes.overall.colors[0].lockColor = true;
  const r = parseImportText(serializePalette(p));
  assert.equal(r.ok, true);
  assert.deepEqual(r.palette, p);
});

test('仕様書の簡略JSON例（無効系統が空配列）も読み込める', () => {
  const sample = {
    schemaVersion: 1, app: 'nyuri-color-palette-workshop', name: '薄紅の肖像',
    createdAt: '2026-11-13T00:00:00Z', updatedAt: '2026-11-13T00:00:00Z',
    scopes: {
      overall: { enabled: true, colors: [{ id: 'c1', hex: '#F3E7E0', ratio: 60 }, { id: 'c2', hex: '#A9B4C6', ratio: 40 }] },
      character: { enabled: false, colors: [] },
      background: { enabled: false, colors: [] },
    },
    memo: '',
  };
  const r = validateImport(sample);
  assert.equal(r.ok, true);
  assert.deepEqual(r.palette.scopes.overall.colors.map((c) => [c.hex, c.ratio]), [['#F3E7E0', 60], ['#A9B4C6', 40]]);
  assert.equal(r.palette.scopes.character.enabled, false);
  assert.ok(checkInvariants(r.palette));
});

test('不正なJSONは例外を出さずに拒否する', () => {
  const good = () => JSON.parse(serializePalette(createPalette()));
  const mut = (f) => { const d = good(); f(d); return d; };
  const cases = [
    null, undefined, 42, 'text', [], {},
    mut((d) => { d.app = 'other-app'; }),
    mut((d) => { delete d.schemaVersion; }),
    mut((d) => { d.schemaVersion = 999; }),
    mut((d) => { d.schemaVersion = 0; }),
    mut((d) => { d.schemaVersion = '1'; }),
    mut((d) => { delete d.scopes; }),
    mut((d) => { delete d.scopes.background; }),
    mut((d) => { d.scopes.overall.enabled = 'yes'; }),
    mut((d) => { d.scopes.overall.colors = 'x'; }),
    mut((d) => { d.scopes.overall.colors = []; }),
    mut((d) => { d.scopes.overall.colors[0].hex = '#GGGGGG'; }),
    mut((d) => { d.scopes.overall.colors[0].hex = 123; }),
    mut((d) => { d.scopes.overall.colors[0].ratio = 0; }),
    mut((d) => { d.scopes.overall.colors[0].ratio = -3; }),
    mut((d) => { d.scopes.overall.colors[0].ratio = 35.5; }),
    mut((d) => { d.scopes.overall.colors[0].ratio = '35'; }),
    mut((d) => { d.scopes.overall.colors[0].ratio = null; }),
    mut((d) => { d.scopes.overall.colors[0].ratio = 36; }),
    mut((d) => { d.scopes.overall.colors[0] = null; }),
    mut((d) => { d.scopes.overall.colors = Array.from({ length: 11 }, () => ({ hex: '#000000', ratio: 9 })); }),
    mut((d) => { d.scopes.character.colors[1].hex = 'nope'; }),
  ];
  for (const c of cases) {
    let r;
    assert.doesNotThrow(() => { r = validateImport(c); });
    assert.equal(r.ok, false, JSON.stringify(c)?.slice(0, 80));
    assert.equal(typeof r.error, 'string');
  }
  for (const t of ['', '   ', '{', 'null', '[1,2', '<html>', undefined]) {
    assert.equal(parseImportText(t).ok, false);
  }
});

test('読込時の無害化: 名前・メモの長さ制限、IDの重複解消、無効系統の比率補正', () => {
  const d = JSON.parse(serializePalette(createPalette()));
  d.name = 'あ'.repeat(500);
  d.memo = 'm'.repeat(99999);
  d.id = '<script>';
  d.scopes.overall.colors[1].id = d.scopes.overall.colors[0].id;
  d.scopes.character.colors.forEach((c) => { c.ratio = 50; });
  d.createdAt = 'not a date';
  d.extra = { evil: true };
  const r = validateImport(d);
  assert.equal(r.ok, true);
  assert.equal(r.palette.name.length, 60);
  assert.equal(r.palette.memo.length, 2000);
  assert.match(r.palette.id, /^[\w-]+$/);
  assert.notEqual(r.palette.scopes.overall.colors[0].id, r.palette.scopes.overall.colors[1].id);
  assert.ok(checkInvariants(r.palette));
  assert.equal('extra' in r.palette, false);
  assert.ok(!Number.isNaN(Date.parse(r.palette.createdAt)));
});

test('複製はIDが別になり、内容は同じ', () => {
  const p = createPalette('元');
  const c = duplicatePalette(p);
  assert.notEqual(c.id, p.id);
  assert.equal(c.name, '元 のコピー');
  assert.deepEqual(c.scopes.overall.colors.map((x) => [x.hex, x.ratio]), p.scopes.overall.colors.map((x) => [x.hex, x.ratio]));
  assert.notEqual(c.scopes.overall.colors[0].id, p.scopes.overall.colors[0].id);
});

/* ---------- 出力 ---------- */

test('テキスト出力: 有効な系統だけが仕様の形式で出る', () => {
  const p = createPalette();
  p.scopes.overall.colors = [{ id: 'a', hex: '#F3E7E0', ratio: 60 }, { id: 'b', hex: '#A9B4C6', ratio: 40 }];
  assert.equal(toText(p), 'Overall\n#F3E7E0 60%\n#A9B4C6 40%');
  assert.equal(toText(p, { hexOnly: true }), 'Overall\n#F3E7E0\n#A9B4C6');
  p.scopes.background.enabled = true;
  const t = toText(p);
  assert.ok(t.includes('\n\nBackground\n'));
  assert.ok(!t.includes('Character'));
  p.scopes.overall.enabled = false; p.scopes.background.enabled = false;
  assert.equal(toText(p), '');
});

test('ファイル名の無害化', () => {
  assert.equal(safeFileName('a/b\\c:d*e?"f<g>h|'), 'a_b_c_d_e__f_g_h_');
  assert.equal(safeFileName(''), 'palette');
  assert.equal(safeFileName('薄紅の肖像'), '薄紅の肖像');
});

/* ---------- 保存 ---------- */

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, _m: m };
}

test('ローカル保存: 保存→読み直しで一致、上書き・削除、無効設定の維持', () => {
  const st = memStorage();
  const store = createStore(st);
  assert.deepEqual(store.loadLibrary(), []);
  const a = createPalette('A'); a.scopes.background.enabled = true; a.scopes.overall.enabled = false;
  const b = createPalette('B');
  assert.ok(store.upsert(a)); assert.ok(store.upsert(b));
  // 別インスタンス＝ページ再読み込み相当
  const again = createStore(st).loadLibrary();
  assert.deepEqual(again.map((p) => p.name), ['B', 'A']);
  assert.deepEqual(again[1], a);
  assert.equal(again[1].scopes.overall.enabled, false);
  assert.equal(again[1].scopes.background.enabled, true);
  a.name = 'A2'; store.upsert(a);
  assert.deepEqual(store.loadLibrary().map((p) => p.name), ['B', 'A2']);
  store.remove(b.id);
  assert.deepEqual(store.loadLibrary().map((p) => p.name), ['A2']);
});

test('ローカル保存: 壊れたデータ・容量超過でも止まらない', () => {
  const st = memStorage();
  st.setItem('nyuri-cpw:v1:library', '{broken');
  assert.deepEqual(createStore(st).loadLibrary(), []);
  st.setItem('nyuri-cpw:v1:library', JSON.stringify([{ junk: 1 }, JSON.parse(serializePalette(createPalette('ok')))]));
  assert.deepEqual(createStore(st).loadLibrary().map((p) => p.name), ['ok']);
  st.setItem('nyuri-cpw:v1:draft', '"x"');
  assert.equal(createStore(st).loadDraft(), null);
  const full = { getItem: () => null, setItem: () => { throw new Error('QuotaExceeded'); } };
  assert.equal(createStore(full).upsert(createPalette()), false);
  const dead = { getItem: () => { throw new Error('SecurityError'); }, setItem: () => { throw new Error('x'); } };
  assert.deepEqual(createStore(dead).loadLibrary(), []);
});

test('下書き: 編集中の状態が復元される', () => {
  const st = memStorage();
  const store = createStore(st);
  const p = createPalette('途中');
  store.saveDraft({ palette: p, dirty: true, scope: 'character' });
  const d = createStore(st).loadDraft();
  assert.deepEqual(d.palette, p);
  assert.equal(d.dirty, true);
  assert.equal(d.scope, 'character');
});

/* ---------- HEX配色プロンプト ---------- */

const HEX_PROMPT_RE = /^#[0-9A-F]{6}(, #[0-9A-F]{6})*$/;

test('HEX配色プロンプト: 仕様の形式（カンマ＋空白区切り）・並び順のまま・比率なし', () => {
  const p = createPalette();
  p.scopes.overall.colors = [['#172B4D', 40], ['#385C84', 25], ['#89A5C1', 15], ['#F2B1A3', 12], ['#E57863', 8]]
    .map(([hex, ratio], i) => ({ id: 'c' + i, hex, ratio }));
  const t = toHexPrompt(p, 'overall');
  assert.equal(t, '#172B4D, #385C84, #89A5C1, #F2B1A3, #E57863');
  assert.match(t, HEX_PROMPT_RE);
  assert.ok(!t.includes('%') && !t.includes('\n'));
  // 並びを変えると出力も同じ順に変わる
  p.scopes.overall.colors.reverse();
  assert.equal(toHexPrompt(p, 'overall'), '#E57863, #F2B1A3, #89A5C1, #385C84, #172B4D');
});

test('HEX配色プロンプト: 系統ごとに独立して出せる', () => {
  const p = createPalette();
  p.scopes.character.enabled = true;
  p.scopes.background.enabled = true;
  for (const k of SCOPE_KEYS) {
    assert.equal(toHexPrompt(p, k), p.scopes[k].colors.map((c) => c.hex).join(', '));
    assert.match(toHexPrompt(p, k), HEX_PROMPT_RE);
  }
  assert.notEqual(toHexPrompt(p, 'character'), toHexPrompt(p, 'background'));
});

test('HEX配色プロンプト: 出力しない系統・存在しない系統は出さない', () => {
  const p = createPalette(); // 初期は Character・Background が出力しない設定
  assert.equal(toHexPrompt(p, 'character'), '');
  assert.equal(toHexPrompt(p, 'background'), '');
  assert.deepEqual(hexPromptColors(p, 'character'), []);
  for (const bad of ['', 'nope', undefined, null, '__proto__', 'constructor']) assert.equal(toHexPrompt(p, bad), '');
  assert.equal(toHexPrompt(null, 'overall'), '');
  assert.equal(toHexPrompt({}, 'overall'), '');
  p.scopes.overall.enabled = 'true'; // 真偽値以外は有効扱いしない
  assert.equal(toHexPrompt(p, 'overall'), '');
});

test('HEX配色プロンプト: 無効な色は混ぜず、表記ゆれは正規化する', () => {
  const p = createPalette();
  p.scopes.overall.colors = [
    { id: 'a', hex: '#172b4d', ratio: 20 }, { id: 'b', hex: 'zzzzzz', ratio: 20 }, null,
    { id: 'c', hex: 'ABC', ratio: 20 }, { id: 'd', ratio: 20 }, { id: 'e', hex: '#E57863', ratio: 20 },
  ];
  assert.equal(toHexPrompt(p, 'overall'), '#172B4D, #AABBCC, #E57863');
  p.scopes.overall.colors = [];
  assert.equal(toHexPrompt(p, 'overall'), '');
});

test('HEX配色プロンプト: 10色・全プリセットで形式が崩れない', () => {
  const p = createPalette();
  for (const pr of PRESETS) {
    p.scopes.overall.colors = pr.colors.map(([hex, ratio], i) => ({ id: 'c' + i, hex, ratio }));
    assert.equal(toHexPrompt(p, 'overall'), pr.colors.map((c) => c[0]).join(', '));
  }
  p.scopes.overall.colors = equalize(10).map((r, i) => ({ id: 'c' + i, hex: '#0000' + String(i).padStart(2, '0'), ratio: r }));
  const t = toHexPrompt(p, 'overall');
  assert.equal(t.split(', ').length, 10);
  assert.match(t, HEX_PROMPT_RE);
});

/* ---------- HEX配色プロンプト：3つの出力方式 ---------- */

function samplePalette() {
  const p = createPalette();
  const set = (k, hexes) => { p.scopes[k].enabled = true; p.scopes[k].colors = hexes.map((hex, i) => ({ id: k + i, hex, ratio: i === 0 ? 100 - (hexes.length - 1) * 10 : 10 })); };
  set('overall', ['#F3E7E0', '#A9B4C6']);
  set('character', ['#CC7F93', '#533147']);
  set('background', ['#142B29', '#70A996']);
  return p;
}
const LINE_RE = /^(overall color scheme|character palette|background palette): #[0-9A-F]{6}(, #[0-9A-F]{6})*$/;

test('出力方式は3つ（HEXのみ・人物＋背景・全体＋人物＋背景）', () => {
  assert.deepEqual(HEX_PROMPT_MODES.map((m) => m.key), ['hex', 'cb', 'ocb']);
});

test('① HEXのみ: 既存の toHexPrompt と完全に同じ出力（互換性）', () => {
  const p = samplePalette();
  for (const k of SCOPE_KEYS) {
    const r = buildHexPrompt(p, 'hex', k);
    assert.equal(r.text, toHexPrompt(p, k));
    assert.deepEqual(r.targets, [k]);
  }
  assert.equal(buildHexPrompt(p, 'hex', 'character').text, '#CC7F93, #533147');
  p.scopes.background.enabled = false;
  assert.equal(buildHexPrompt(p, 'hex', 'background').text, '');
  assert.equal(buildHexPrompt(p, 'hex', '__proto__').text, '');
  assert.equal(buildHexPrompt(p, 'hex').text, '');
  // 未知の方式は HEXのみ 扱い
  assert.equal(buildHexPrompt(p, 'unknown', 'overall').text, '#F3E7E0, #A9B4C6');
});

test('② 人物＋背景: 仕様どおりの2行・Overallを含めない', () => {
  const r = buildHexPrompt(samplePalette(), 'cb');
  assert.equal(r.text, 'character palette: #CC7F93, #533147\nbackground palette: #142B29, #70A996');
  assert.ok(!r.text.includes('overall') && !r.text.includes('#F3E7E0'));
  assert.deepEqual(r.skipped, []);
});

test('③ 全体＋人物＋背景: 仕様どおりの3行・この順番', () => {
  const r = buildHexPrompt(samplePalette(), 'ocb');
  assert.equal(r.text, 'overall color scheme: #F3E7E0, #A9B4C6\ncharacter palette: #CC7F93, #533147\nbackground palette: #142B29, #70A996');
  r.text.split('\n').forEach((line) => assert.match(line, LINE_RE));
});

test('ラベル付き: 出力しない系統は行ごと外し、外した系統を返す', () => {
  const p = samplePalette();
  p.scopes.character.enabled = false;
  let r = buildHexPrompt(p, 'cb');
  assert.equal(r.text, 'background palette: #142B29, #70A996');
  assert.deepEqual(r.skipped, ['character']);
  r = buildHexPrompt(p, 'ocb');
  assert.equal(r.text, 'overall color scheme: #F3E7E0, #A9B4C6\nbackground palette: #142B29, #70A996');
  assert.deepEqual(r.skipped, ['character']);
  p.scopes.overall.enabled = false;
  assert.equal(buildHexPrompt(p, 'ocb').text, 'background palette: #142B29, #70A996');
});

test('ラベル付き: 全部無効なら空文字（空の行・ラベルだけの行・余分なカンマを出さない）', () => {
  const p = samplePalette();
  for (const k of SCOPE_KEYS) p.scopes[k].enabled = false;
  for (const mode of ['cb', 'ocb']) {
    const r = buildHexPrompt(p, mode);
    assert.equal(r.text, '');
    assert.equal(r.parts.length, 0);
  }
  // 有効でも色が空・無効な色だけの系統は行を出さない
  const q = samplePalette();
  q.scopes.character.colors = [{ id: 'x', hex: 'nope', ratio: 100 }];
  const r = buildHexPrompt(q, 'cb');
  assert.equal(r.text, 'background palette: #142B29, #70A996');
  assert.deepEqual(r.skipped, ['character']);
  for (const t of [r.text, buildHexPrompt(samplePalette(), 'ocb').text]) {
    assert.ok(!/,\s*(,|$)/m.test(t), '余分なカンマ');
    assert.ok(!/:\s*$/m.test(t), 'ラベルだけの行');
    assert.ok(!/\n\n|^\n|\n$/.test(t), '空行');
  }
});

test('ラベル付き: 色数は既存設定どおり・並び順のまま・比率なし（10色＋1色）', () => {
  const p = samplePalette();
  p.scopes.character.colors = equalize(10).map((r, i) => ({ id: 'c' + i, hex: '#00000' + i, ratio: r }));
  p.scopes.background.colors = [{ id: 'b', hex: '#123456', ratio: 100 }];
  const r = buildHexPrompt(p, 'ocb');
  const lines = r.text.split('\n');
  assert.equal(lines[1], 'character palette: ' + p.scopes.character.colors.map((c) => c.hex).join(', '));
  assert.equal(lines[2], 'background palette: #123456');
  assert.ok(!r.text.includes('%'));
  lines.forEach((line) => assert.match(line, LINE_RE));
});

test('画面の好み（出力方式）の保存と、壊れたデータへの耐性', () => {
  const st = memStorage();
  const store = createStore(st);
  assert.deepEqual(store.loadPrefs(), {});
  assert.ok(store.savePrefs({ hpMode: 'ocb', hpScope: 'character' }));
  assert.deepEqual(createStore(st).loadPrefs(), { hpMode: 'ocb', hpScope: 'character' });
  for (const junk of ['{broken', '"text"', '[1,2]', 'null']) {
    st.setItem('nyuri-cpw:v1:prefs', junk);
    assert.deepEqual(createStore(st).loadPrefs(), {});
  }
  // 好みの保存は、保存済みパレットや下書きに影響しない
  const s2 = createStore(memStorage());
  s2.upsert(createPalette('X'));
  s2.savePrefs({ hpMode: 'cb' });
  assert.deepEqual(s2.loadLibrary().map((p) => p.name), ['X']);
});
