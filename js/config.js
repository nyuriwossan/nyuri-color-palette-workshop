// アプリ全体の定数。PixAI側の仕様が変わったらここを直す。
export const APP_ID = 'nyuri-color-palette-workshop';
export const APP_NAME = 'にゅりカラーパレット工房';
export const APP_VERSION = '1.0.0';
export const SCHEMA_VERSION = 1;

export const MAX_COLORS = 10;
export const MIN_COLORS = 1;
export const MIN_RATIO = 1;
export const TOTAL_RATIO = 100;

export const NAME_MAX = 60;
export const MEMO_MAX = 2000;
export const IMPORT_MAX_BYTES = 200 * 1024;

export const SCOPES = [
  { key: 'overall', label: 'Overall', ja: '全体', hint: '画像全体の色調' },
  { key: 'character', label: 'Character', ja: '人物', hint: '肌・髪・衣装など' },
  { key: 'background', label: 'Background', ja: '背景', hint: '背景・環境' },
];
export const SCOPE_KEYS = SCOPES.map((s) => s.key);
