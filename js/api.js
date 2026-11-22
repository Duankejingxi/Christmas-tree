// 共享圣诞树的数据层：Supabase（云端）或 localStorage（本机演示）
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

export const MAX_FRIENDS = 10;
export const MAX_OWNER = 10;
export const cloudEnabled = !!(SUPABASE_URL && SUPABASE_ANON_KEY);

const randomId = (n = 10) => {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return [...bytes].map((b) => chars[b % chars.length]).join('');
};
async function sha256hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class TreeFullError extends Error {
  constructor() { super('tree_full'); this.name = 'TreeFullError'; }
}

/* ------------------------------ Supabase ------------------------------ */
const base = SUPABASE_URL.replace(/\/+$/, '');
const headers = (extra = {}) => ({ apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, ...extra });

async function rest(path, opts = {}) {
  const res = await fetch(`${base}/rest/v1/${path}`, { ...opts, headers: headers(opts.headers) });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (/tree_full/.test(text)) throw new TreeFullError();
    throw new Error(`请求失败 (${res.status})`);
  }
  return res.status === 204 ? null : res.json();
}

const supabaseApi = {
  async createTree(ownerName, theme = 'ice') {
    const id = randomId();
    const ownerKey = randomId(24);
    const rows = await rest('trees', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({ id, owner_name: ownerName, owner_key_hash: await sha256hex(ownerKey), theme }),
    });
    return { tree: normTree(rows[0]), ownerKey };
  },
  async getTree(id) {
    const rows = await rest(`trees?id=eq.${encodeURIComponent(id)}&select=id,owner_name,created_at,theme`);
    return rows[0] ? normTree(rows[0]) : null;
  },
  async listPhotos(treeId) {
    const rows = await rest(`photos?tree_id=eq.${encodeURIComponent(treeId)}&select=id,nickname,path,created_at,is_owner,message&order=created_at.asc`);
    return rows.map(normPhoto);
  },
  // opts: { ownerKey?, message? }
  async claimTree(id, hash) {
    return rest('rpc/claim_tree', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_id: id, p_hash: hash }),
    });
  },
  async addPhoto(treeId, nickname, blob, opts = {}) {
    const path = `${treeId}/${Date.now()}-${randomId(6)}.jpg`;
    const up = await fetch(`${base}/storage/v1/object/photos/${path}`, {
      method: 'POST',
      headers: headers({ 'Content-Type': 'image/jpeg', 'x-upsert': 'false' }),
      body: blob,
    });
    if (!up.ok) throw new Error(`照片上传失败 (${up.status})`);
    const body = { tree_id: treeId, nickname, path, is_owner: !!opts.ownerKey, message: opts.message || null };
    if (opts.ownerKey) body.owner_key = opts.ownerKey;
    const rows = await rest('photos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify(body),
    });
    return normPhoto(rows[0]);
  },
};

function normTree(r) {
  return { id: r.id, ownerName: r.owner_name, createdAt: r.created_at, theme: r.theme || 'ice' };
}
function normPhoto(r) {
  return {
    id: r.id,
    nickname: r.nickname,
    url: r.url || `${base}/storage/v1/object/public/photos/${r.path}`,
    createdAt: r.created_at,
    isOwner: !!r.is_owner,
    message: r.message || '',
  };
}

/* ------------------------- 本机演示（localStorage） ------------------------- */
const LS_KEY = 'xmas.demo.trees';
const loadAll = () => { try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch (e) { return {}; } };
const saveAll = (all) => {
  try { localStorage.setItem(LS_KEY, JSON.stringify(all)); }
  catch (e) { throw new Error('本机存储空间不足（演示模式）'); }
};
const blobToDataURL = (blob) => new Promise((res, rej) => {
  const fr = new FileReader();
  fr.onload = () => res(fr.result);
  fr.onerror = rej;
  fr.readAsDataURL(blob);
});

const localApi = {
  async createTree(ownerName, theme = 'ice') {
    const all = loadAll();
    const id = randomId();
    const ownerKey = randomId(24);
    all[id] = { id, owner_name: ownerName, created_at: new Date().toISOString(), key: ownerKey, theme, photos: [] };
    saveAll(all);
    return { tree: normTree(all[id]), ownerKey };
  },
  async getTree(id) {
    const t = loadAll()[id];
    return t ? normTree(t) : null;
  },
  async listPhotos(treeId) {
    const t = loadAll()[treeId];
    return t ? t.photos.map(normPhoto) : [];
  },
  async claimTree() { return false; },
  async addPhoto(treeId, nickname, blob, opts = {}) {
    const all = loadAll();
    const t = all[treeId];
    if (!t) throw new Error('找不到这棵树');
    const isOwner = !!opts.ownerKey;
    if (isOwner && opts.ownerKey !== t.key) throw new Error('没有权限');
    const limit = isOwner ? MAX_OWNER : MAX_FRIENDS;
    if (t.photos.filter((p) => !!p.is_owner === isOwner).length >= limit) throw new TreeFullError();
    const row = {
      id: randomId(12), nickname, url: await blobToDataURL(blob), created_at: new Date().toISOString(),
      is_owner: isOwner, message: opts.message || '',
    };
    t.photos.push(row);
    saveAll(all);
    return normPhoto(row);
  },
};

export const api = cloudEnabled ? supabaseApi : localApi;

/* ------------------------------ 我创建的树 ------------------------------ */
const MINE_KEY = 'xmas.myTrees';
export function myTrees() {
  try { return JSON.parse(localStorage.getItem(MINE_KEY)) || []; } catch (e) { return []; }
}
export function rememberMyTree(tree, ownerKey) {
  try {
    const list = myTrees().filter((t) => t.id !== tree.id);
    list.unshift({ id: tree.id, ownerName: tree.ownerName, key: ownerKey });
    localStorage.setItem(MINE_KEY, JSON.stringify(list.slice(0, 20)));
  } catch (e) { /* ignore */ }
}
export const isMyTree = (id) => myTrees().some((t) => t.id === id);

/* ------------------------------ 我装饰过的树 ------------------------------ */
const DECO_KEY = 'xmas.decorated';
export function hasDecorated(id) {
  try { return (JSON.parse(localStorage.getItem(DECO_KEY)) || []).includes(id); } catch (e) { return false; }
}
export function markDecorated(id) {
  try {
    const list = JSON.parse(localStorage.getItem(DECO_KEY)) || [];
    if (!list.includes(id)) list.push(id);
    localStorage.setItem(DECO_KEY, JSON.stringify(list.slice(-100)));
  } catch (e) { /* ignore */ }
}

/* ------------------------------ 图片压缩 ------------------------------ */
export async function compressImage(file, max = 1600, quality = 0.86) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('无法读取这张图片'));
      i.src = url;
    });
    const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const cv = document.createElement('canvas');
    cv.width = Math.round(img.naturalWidth * s);
    cv.height = Math.round(img.naturalHeight * s);
    cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
    return await new Promise((res) => cv.toBlob(res, 'image/jpeg', quality));
  } finally {
    URL.revokeObjectURL(url);
  }
}
