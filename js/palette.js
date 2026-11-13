// パレットのデータ構造・生成・検証（アプリ独自形式）
import { APP_ID, SCHEMA_VERSION, SCOPE_KEYS, MAX_COLORS, NAME_MAX, MEMO_MAX } from './config.js';
import { normalizeHex } from './color.js';
import { isValidRatios, sanitize } from './ratio.js';

export const DEFAULT_NAME = '無題のパレット';

let seq = 0;
export function uid(prefix) {
  const rnd = (globalThis.crypto && crypto.randomUUID)
    ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
    : (Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
  return `${prefix}_${rnd}${(seq++).toString(36)}`;
}

export function createColor(hex, ratio) {
  return { id: uid('c'), hex: normalizeHex(hex), ratio, lockColor: false, lockRatio: false };
}

const DEFAULTS = {
  overall: [['#F3E7E0', 35], ['#E3B7B9', 25], ['#C98B95', 15], ['#A9B4C6', 15], ['#5E6B82', 10]],
  character: [['#F6E3D7', 30], ['#3B3247', 25], ['#B79FCF', 20], ['#F2F0EC', 15], ['#C2475B', 10]],
  background: [['#DCE6EE', 35], ['#A9B8C9', 25], ['#6F7F96', 20], ['#3F4A5E', 12], ['#EFD9B8', 8]],
};

export function defaultColors(scopeKey) {
  return DEFAULTS[scopeKey].map(([h, r]) => createColor(h, r));
}

export function createPalette(name = DEFAULT_NAME) {
  const now = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    app: APP_ID,
    id: uid('p'),
    name,
    createdAt: now,
    updatedAt: now,
    scopes: {
      overall: { enabled: true, colors: defaultColors('overall') },
      character: { enabled: false, colors: defaultColors('character') },
      background: { enabled: false, colors: defaultColors('background') },
    },
    memo: '',
  };
}

export function clonePalette(p) {
  return JSON.parse(JSON.stringify(p));
}

/** 別パレットとして複製（ID類を振り直す） */
export function duplicatePalette(p, name) {
  const c = clonePalette(p);
  const now = new Date().toISOString();
  c.id = uid('p');
  c.name = (name ?? (p.name + ' のコピー')).slice(0, NAME_MAX);
  c.createdAt = now;
  c.updatedAt = now;
  for (const k of SCOPE_KEYS) c.scopes[k].colors.forEach((col) => { col.id = uid('c'); });
  return c;
}

// 旧バージョンのデータを現行スキーマへ上げる関数を版ごとに登録する。
// 例: MIGRATIONS[1] = (data) => ({ ...data, schemaVersion: 2, 新項目: 既定値 })
const MIGRATIONS = {};

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const fail = (error) => ({ ok: false, error });

function cleanDate(s, fallback) {
  if (typeof s === 'string' && s.length <= 40 && !Number.isNaN(Date.parse(s))) return new Date(s).toISOString();
  return fallback;
}

/**
 * 読み込んだJSON（パース済み）を検証し、安全なパレットに組み直して返す。
 * 不正なら { ok:false, error } を返し、例外は投げない。
 */
export function validateImport(input) {
  try {
    let d = input;
    if (!isObj(d)) return fail('パレットのデータではありません。');
    if (d.app !== APP_ID) return fail('このアプリで保存したJSONではないようです。');
    if (!Number.isInteger(d.schemaVersion) || d.schemaVersion < 1) return fail('スキーマバージョンが不正です。');
    if (d.schemaVersion > SCHEMA_VERSION) return fail('新しいバージョンのアプリで作られたデータです。アプリを更新してください。');
    let guard = 0;
    while (d.schemaVersion < SCHEMA_VERSION) {
      const m = MIGRATIONS[d.schemaVersion];
      if (!m || guard++ > 50) return fail('このバージョンのデータは変換できません。');
      d = m(d);
    }
    if (!isObj(d.scopes)) return fail('scopes がありません。');

    const now = new Date().toISOString();
    const usedIds = new Set();
    const scopes = {};
    for (const key of SCOPE_KEYS) {
      const sc = d.scopes[key];
      if (!isObj(sc)) return fail(`${key} のデータがありません。`);
      if (typeof sc.enabled !== 'boolean') return fail(`${key} の有効・無効が不正です。`);
      if (!Array.isArray(sc.colors)) return fail(`${key} の色データが不正です。`);
      if (sc.colors.length > MAX_COLORS) return fail(`${key} の色数が上限（${MAX_COLORS}色）を超えています。`);
      if (sc.enabled && sc.colors.length < 1) return fail(`${key} は有効なのに色がありません。`);
      const colors = [];
      for (const c of sc.colors) {
        if (!isObj(c)) return fail(`${key} に不正な色データがあります。`);
        const hex = normalizeHex(c.hex);
        if (!hex) return fail(`${key} に不正なHEXコードがあります。`);
        if (typeof c.ratio !== 'number' || !Number.isFinite(c.ratio)) return fail(`${key} に不正な比率があります。`);
        let id = (typeof c.id === 'string' && /^[\w-]{1,40}$/.test(c.id)) ? c.id : uid('c');
        if (usedIds.has(id)) id = uid('c');
        usedIds.add(id);
        colors.push({ id, hex, ratio: c.ratio, lockColor: c.lockColor === true, lockRatio: c.lockRatio === true });
      }
      const ratios = colors.map((c) => c.ratio);
      if (sc.enabled) {
        if (!isValidRatios(ratios)) return fail(`${key} の比率が不正です（整数・各1%以上・合計100%が必要）。`);
      } else if (colors.length === 0) {
        // 無効で空の系統は、あとで有効にしたときのために既定色を入れておく
        colors.push(...defaultColors(key));
      } else if (!isValidRatios(ratios)) {
        // 無効な系統の編集途中データは、壊さず有効な比率に整える
        sanitize(ratios).forEach((r, i) => { colors[i].ratio = r; });
      }
      scopes[key] = { enabled: sc.enabled, colors };
    }

    let name = typeof d.name === 'string' ? d.name.trim().slice(0, NAME_MAX) : '';
    if (!name) name = DEFAULT_NAME;
    const memo = typeof d.memo === 'string' ? d.memo.slice(0, MEMO_MAX) : '';
    const id = (typeof d.id === 'string' && /^[\w-]{1,40}$/.test(d.id)) ? d.id : uid('p');
    const createdAt = cleanDate(d.createdAt, now);
    return {
      ok: true,
      palette: { schemaVersion: SCHEMA_VERSION, app: APP_ID, id, name, createdAt, updatedAt: cleanDate(d.updatedAt, createdAt), scopes, memo },
    };
  } catch (e) {
    return fail('データを読み取れませんでした。');
  }
}

/** JSON文字列から読み込む（パース失敗も安全に扱う） */
export function parseImportText(text) {
  if (typeof text !== 'string' || !text.trim()) return fail('JSONが空です。');
  let data;
  try { data = JSON.parse(text); } catch { return fail('JSONとして読み取れませんでした。'); }
  return validateImport(data);
}

/** 保存・出力用のJSON文字列 */
export function serializePalette(p) {
  return JSON.stringify(p, null, 2);
}

/** 現在のアプリ内パレットが不変条件を満たしているか（テスト・自己点検用） */
export function checkInvariants(p) {
  for (const key of SCOPE_KEYS) {
    const cs = p.scopes[key].colors;
    if (cs.length < 1 || cs.length > MAX_COLORS) return false;
    if (!cs.every((c) => normalizeHex(c.hex) === c.hex)) return false;
    if (!isValidRatios(cs.map((c) => c.ratio))) return false;
  }
  return true;
}
