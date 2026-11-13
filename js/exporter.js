// テキスト・PNG出力
import { SCOPES, SCOPE_KEYS, APP_NAME } from './config.js';
import { textOn, normalizeHex } from './color.js';

export function enabledScopes(palette) {
  return SCOPES.filter((s) => palette.scopes[s.key].enabled);
}

/** PixAIへ手入力するためのテキスト。hexOnly なら比率を省く。 */
export function toText(palette, { hexOnly = false } = {}) {
  return enabledScopes(palette)
    .map((s) => [s.label, ...palette.scopes[s.key].colors.map((c) => (hexOnly ? c.hex : `${c.hex} ${c.ratio}%`))].join('\n'))
    .join('\n\n');
}

/**
 * 画像生成AIのプロンプト本文に貼るためのHEX列（PixAI・NovelAI共通）。
 * 指定した系統の色を、パレットの並び順のまま「#AAAAAA, #BBBBBB」の形で返す。
 * 比率は入れない。出力しない設定の系統・存在しない系統・無効な色は出さない。
 */
export function hexPromptColors(palette, scopeKey) {
  const sc = palette && palette.scopes && palette.scopes[scopeKey];
  if (!sc || sc.enabled !== true || !Array.isArray(sc.colors)) return [];
  return sc.colors.map((c) => normalizeHex(c && c.hex)).filter(Boolean);
}
export function toHexPrompt(palette, scopeKey) {
  return hexPromptColors(palette, scopeKey).join(', ');
}

/** HEX配色プロンプトの出力方式。scopes が null のものは「1系統を選んでHEXだけ」。 */
export const HEX_PROMPT_MODES = [
  { key: 'hex', label: 'HEXのみ', sub: '割り当てはAI任せ', scopes: null },
  { key: 'cb', label: '人物＋背景', sub: 'ラベル付き', scopes: ['character', 'background'] },
  { key: 'ocb', label: '全体＋人物＋背景', sub: 'ラベル付き', scopes: ['overall', 'character', 'background'] },
];
export const HEX_PROMPT_LABELS = {
  overall: 'overall color scheme',
  character: 'character palette',
  background: 'background palette',
};

/**
 * 出力方式に応じたHEXプロンプトを組み立てる。
 * 戻り値: { mode, targets: 対象系統, parts: [{key, label, hexes}], skipped: 出力しない等で外した系統, text }
 * ラベル付き方式は「ラベル: #A, #B」を系統ごとに改行。空の行・余分なカンマは出さない。
 */
export function buildHexPrompt(palette, modeKey, scopeKey) {
  const m = HEX_PROMPT_MODES.find((x) => x.key === modeKey) || HEX_PROMPT_MODES[0];
  const targets = m.scopes ? m.scopes.slice() : (SCOPE_KEYS.includes(scopeKey) ? [scopeKey] : []);
  const parts = [], skipped = [];
  for (const k of targets) {
    const hexes = hexPromptColors(palette, k);
    if (hexes.length) parts.push({ key: k, label: m.scopes ? HEX_PROMPT_LABELS[k] : null, hexes });
    else skipped.push(k);
  }
  const text = m.scopes
    ? parts.map((p) => `${p.label}: ${p.hexes.join(', ')}`).join('\n')
    : (parts[0] ? parts[0].hexes.join(', ') : '');
  return { mode: m.key, targets, parts, skipped, text };
}

/** 保存ファイル名に使える文字列へ */
export function safeFileName(name) {
  const s = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 40);
  return s || 'palette';
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** PNG用のCanvasを描いて返す（ブラウザ専用）。有効な系統がなければ null。 */
export function drawPaletteCanvas(palette, doc = document) {
  const scopes = enabledScopes(palette);
  if (scopes.length === 0) return null;
  const W = 1080, P = 64, BAR_H = 150, ROW_H = 92, GAP = 56;
  const SANS = '"Hiragino Sans","Hiragino Kaku Gothic ProN","Noto Sans JP","Yu Gothic",Meiryo,sans-serif';
  const MONO = 'ui-monospace,"SF Mono",Menlo,Consolas,monospace';
  let H = P + 70 + 44 + 40;
  for (const s of scopes) H += 50 + BAR_H + 24 + palette.scopes[s.key].colors.length * ROW_H + GAP;
  H += 30;

  const cv = doc.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#F6F3EE';
  ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = 'alphabetic';

  let y = P + 52;
  ctx.fillStyle = '#26221E';
  ctx.font = `700 54px ${SANS}`;
  let title = palette.name;
  while (ctx.measureText(title).width > W - P * 2 && title.length > 1) title = title.slice(0, -2) + '…';
  ctx.fillText(title, P, y);
  y += 50;
  ctx.fillStyle = '#7A7268';
  ctx.font = `400 26px ${SANS}`;
  ctx.fillText(`${APP_NAME}｜PixAI Tsubaki.3 用の配色メモ（非公式）`, P, y);
  y += 54;

  for (const s of scopes) {
    const colors = palette.scopes[s.key].colors;
    ctx.fillStyle = '#26221E';
    ctx.font = `700 34px ${SANS}`;
    ctx.fillText(s.label, P, y + 30);
    ctx.fillStyle = '#7A7268';
    ctx.font = `400 26px ${SANS}`;
    ctx.fillText(`${s.ja}・${colors.length}色`, P + ctx.measureText(s.label).width + 70, y + 30);
    y += 50;

    const bw = W - P * 2;
    ctx.save();
    roundRect(ctx, P, y, bw, BAR_H, 18);
    ctx.clip();
    let x = P, acc = 0;
    colors.forEach((c, i) => {
      acc += c.ratio;
      const x2 = i === colors.length - 1 ? P + bw : P + Math.round((bw * acc) / 100);
      ctx.fillStyle = c.hex;
      ctx.fillRect(x, y, x2 - x, BAR_H);
      x = x2;
    });
    ctx.restore();
    ctx.strokeStyle = 'rgba(0,0,0,.18)';
    ctx.lineWidth = 2;
    roundRect(ctx, P, y, bw, BAR_H, 18);
    ctx.stroke();
    y += BAR_H + 24;

    colors.forEach((c, i) => {
      const cy = y + i * ROW_H;
      ctx.fillStyle = c.hex;
      roundRect(ctx, P, cy + 8, 76, 76, 14);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,.2)';
      ctx.stroke();
      ctx.fillStyle = textOn(c.hex);
      ctx.font = `700 26px ${SANS}`;
      ctx.textAlign = 'center';
      ctx.fillText(String(i + 1), P + 38, cy + 56);
      ctx.textAlign = 'left';
      ctx.fillStyle = '#26221E';
      ctx.font = `600 40px ${MONO}`;
      ctx.fillText(c.hex, P + 104, cy + 60);
      ctx.textAlign = 'right';
      ctx.font = `700 40px ${SANS}`;
      ctx.fillText(`${c.ratio}%`, W - P, cy + 60);
      ctx.textAlign = 'left';
    });
    y += colors.length * ROW_H + GAP;
  }
  return cv;
}
