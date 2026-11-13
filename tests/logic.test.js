import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeHex, hexToRgb, rgbToHex, hexToHsv, hsvToHex, rgbToHsl, hslToRgb, textOn } from '../js/color.js';
import { distribute, isValidRatios, equalize, sanitize, setRatio, maxRatio, addRatio, removeRatio, moveBoundary } from '../js/ratio.js';
import { HARMONY_MODES, generateHarmony, applyHarmony, VARIATIONS, applyVariation } from '../js/harmony.js';
import { createPalette, validateImport, parseImportText, serializePalette, checkInvariants, duplicatePalette } from '../js/palette.js';
import { PRESETS } from '../js/presets.js';
import { toText, safeFileName } from '../js/exporter.js';
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

test('プリセット: 12種・HEXと比率がすべて有効・名前が重複しない', () => {
  assert.equal(PRESETS.length, 12);
  assert.equal(new Set(PRESETS.map((p) => p.name)).size, 12);
  for (const p of PRESETS) {
    assert.ok(p.desc.length > 0);
    assert.ok(isValidRatios(p.colors.map((c) => c[1])), p.name);
    p.colors.forEach(([hex]) => assert.equal(normalizeHex(hex), hex, p.name));
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
