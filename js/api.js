// 共享圣诞树的数据层：经 EdgeOne 转发函数（functions/api）访问 Supabase，或 localStorage（本机演示）
import { API_URL } from './config.js';

export const MAX_FRIENDS = 500; // 朋友人数实际不限，这里只是防刷的安全上限
export const MAX_OWNER = 10;
// API_URL: null = 本机演示模式；'' = 转发函数和网页在同一个域名下（默认）；'https://xx' = 指定地址
export const cloudEnabled = API_URL !== null && API_URL !== undefined;

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
export class NicknameTakenError extends Error {
  constructor() { super('该昵称已被注册'); this.name = 'NicknameTakenError'; }
}
const normName = (s) => String(s || '').trim().toLowerCase();
export class NetworkError extends Error {
  constructor(msg = '网络连接失败') { super(msg); this.name = 'NetworkError'; }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// 带超时的 fetch：跨境网络偶尔会卡住不返回，超时后算作网络错误
async function fetchT(url, opts = {}, ms = 15000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } catch (e) {
    throw new NetworkError(e && e.name === 'AbortError' ? '网络太慢，请求超时' : '网络连接失败');
  } finally {
    clearTimeout(timer);
  }
}
// 只对网络错误重试（服务器明确拒绝的不重试）
async function retry(fn, tries = 3) {
  let err;
  for (let i = 0; i < tries; i++) {
    try { return await fn(i); } catch (e) {
      err = e;
      if (!(e instanceof NetworkError)) throw e;
      if (i < tries - 1) await wait(700 * Math.pow(2, i));
    }
  }
  throw err;
}

/* ------------------------------ Supabase ------------------------------ */
const base = cloudEnabled ? String(API_URL).replace(/\/+$/, '') : '';
// 所有请求都发给自己域名下的 /api，由转发函数带上密钥去访问 Supabase
const px = (p) => `${base}/api?p=${encodeURIComponent(p)}`;
const headers = (extra = {}) => extra;

async function rest(path, opts = {}) {
  const res = await fetchT(px(`/rest/v1/${path}`), { ...opts, headers: headers(opts.headers) }, opts.timeout || 15000);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (/tree_full/.test(text)) throw new TreeFullError();
    if (/nickname_taken/.test(text)) throw new NicknameTakenError();
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
  async ping() {
    try { await fetchT(px('/rest/v1/trees?select=id&limit=1'), {}, 6000); return true; } catch (e) { return false; }
  },
  async getTree(id) {
    const rows = await retry(() => rest(`trees?id=eq.${encodeURIComponent(id)}&select=id,owner_name,created_at,theme`));
    return rows[0] ? normTree(rows[0]) : null;
  },
  async listPhotos(treeId) {
    const rows = await retry(() => rest(`photos?tree_id=eq.${encodeURIComponent(treeId)}&select=id,nickname,path,created_at,is_owner,message&order=created_at.asc`));
    return rows.map(normPhoto);
  },
  // opts: { ownerKey?, message? }
  // 这个昵称在这棵树上是否已被朋友或主人使用
  async nicknameTaken(treeId, nickname) {
    const [rows, trees] = await retry(() => Promise.all([
      rest(`photos?tree_id=eq.${encodeURIComponent(treeId)}&is_owner=eq.false&select=nickname`),
      rest(`trees?id=eq.${encodeURIComponent(treeId)}&select=owner_name`),
    ]));
    const n = normName(nickname);
    return rows.some((r) => normName(r.nickname) === n) || trees.some((t) => normName(t.owner_name) === n);
  },
  async claimTree(id, hash) {
    return rest('rpc/claim_tree', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_id: id, p_hash: hash }),
    });
  },
  async addPhoto(treeId, nickname, blob, opts = {}) {
    // 同一次上传重试时沿用同一个路径，避免重复
    const path = opts.path || `${treeId}/${Date.now()}-${randomId(6)}.jpg`;
    opts.path = path;
    if (!opts.uploaded) {
      await retry(async () => {
        const up = await fetchT(px(`/storage/v1/object/photos/${path}`), {
          method: 'POST',
          headers: headers({ 'Content-Type': 'image/jpeg', 'x-upsert': 'false' }),
          body: blob,
        }, 45000);
        if (up.ok) return;
        const t = await up.text().catch(() => '');
        if (/already exists|Duplicate/i.test(t)) return; // 上一次其实已经传上去了
        if (up.status >= 500) throw new NetworkError('服务器繁忙');
        throw new Error(`照片上传失败 (${up.status})`);
      });
      opts.uploaded = true;
    }
    const body = { tree_id: treeId, nickname, path, is_owner: !!opts.ownerKey, message: opts.message || null };
    if (opts.ownerKey) body.owner_key = opts.ownerKey;
    const findMine = async () => {
      const got = await rest(`photos?path=eq.${encodeURIComponent(path)}&select=id,nickname,path,created_at,is_owner,message`);
      return got[0] ? normPhoto(got[0]) : null;
    };
    return retry(async (attempt) => {
      try {
        const rows = await rest('photos', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
          body: JSON.stringify(body),
        });
        return normPhoto(rows[0]);
      } catch (e) {
        // 上一次请求其实成功了、只是没收到回复：这时会撞上自己的名字，查一下是不是已经存上了
        if (attempt > 0 || e instanceof NetworkError || e instanceof NicknameTakenError) {
          const mine = await findMine().catch(() => null);
          if (mine) return mine;
        }
        throw e;
      }
    });
  },
};

function normTree(r) {
  return { id: r.id, ownerName: r.owner_name, createdAt: r.created_at, theme: r.theme || 'ice' };
}
function normPhoto(r) {
  return {
    id: r.id,
    nickname: r.nickname,
    url: r.url || px(`/storage/v1/object/public/photos/${r.path}`),
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
  async nicknameTaken(treeId, nickname) {
    const t = loadAll()[treeId];
    if (!t) return false;
    const n = normName(nickname);
    return normName(t.owner_name) === n || t.photos.some((p) => !p.is_owner && normName(p.nickname) === n);
  },
  async addPhoto(treeId, nickname, blob, opts = {}) {
    const all = loadAll();
    const t = all[treeId];
    if (!t) throw new Error('找不到这棵树');
    const isOwner = !!opts.ownerKey;
    if (isOwner && opts.ownerKey !== t.key) throw new Error('没有权限');
    const limit = isOwner ? MAX_OWNER : MAX_FRIENDS;
    if (t.photos.filter((p) => !!p.is_owner === isOwner).length >= limit) throw new TreeFullError();
    if (!isOwner && await this.nicknameTaken(treeId, nickname)) throw new NicknameTakenError();
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
export async function compressImage(file, max = 1280, quality = 0.82) {
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
    let blob = await new Promise((res) => cv.toBlob(res, 'image/jpeg', quality));
    // 还是太大就再缩一档，跨境上传越小越稳
    if (blob && blob.size > 450 * 1024 && max > 1000) return compressImage(file, 1024, 0.78);
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}
