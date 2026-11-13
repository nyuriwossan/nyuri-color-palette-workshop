// 端末内（localStorage）への保存。storage を差し替えられるようにしてテスト可能にする。
import { validateImport } from './palette.js';

const LIB_KEY = 'nyuri-cpw:v1:library';
const DRAFT_KEY = 'nyuri-cpw:v1:draft';

export function createStore(storage) {
  const read = (key) => {
    try { const s = storage.getItem(key); return s ? JSON.parse(s) : null; } catch { return null; }
  };
  const write = (key, val) => {
    try { storage.setItem(key, JSON.stringify(val)); return true; } catch { return false; }
  };

  function loadLibrary() {
    const raw = read(LIB_KEY);
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const item of raw) {
      const r = validateImport(item);
      if (r.ok) out.push(r.palette);
    }
    return out;
  }
  const saveLibrary = (list) => write(LIB_KEY, list);

  /** 同じIDがあれば上書き、なければ先頭に追加 */
  function upsert(palette) {
    const list = loadLibrary();
    const i = list.findIndex((p) => p.id === palette.id);
    if (i >= 0) list[i] = palette; else list.unshift(palette);
    return saveLibrary(list);
  }
  function remove(id) {
    return saveLibrary(loadLibrary().filter((p) => p.id !== id));
  }

  /** 編集中の状態（未保存でもリロードで消えないように） */
  function loadDraft() {
    const raw = read(DRAFT_KEY);
    if (!raw || typeof raw !== 'object') return null;
    const r = validateImport(raw.palette);
    if (!r.ok) return null;
    return { palette: r.palette, dirty: raw.dirty === true, scope: raw.scope };
  }
  const saveDraft = (draft) => write(DRAFT_KEY, draft);

  return { loadLibrary, saveLibrary, upsert, remove, loadDraft, saveDraft };
}
