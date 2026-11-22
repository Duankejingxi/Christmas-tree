// 共享圣诞树的数据层：自己的服务器（server/server.js）或 localStorage（本机演示）
import { API_URL } from './config.js';

export const MAX_FRIENDS = 500; // 朋友人数实际不限，这里只是防刷的安全上限
export const MAX_OWNER = 10;
// API_URL: null = 本机演示模式；'' = 和网页同一个域名；'https://xxx' = 指定的服务器地址
export const cloudEnabled = API_URL !== null && API_URL !== undefined;

const randomId = (n = 10) => {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return [...bytes].map((b) => chars[b % chars.length]).join('');
};

export class TreeFullError extends Error {
  constructor() { super('tree_full'); this.name = 'TreeFullError'; }
}
export class NicknameTakenError extends Error {
  constructor() { super('该昵称已被注册'); this.name = 'NicknameTakenError'; }
}
export class NetworkError extends Error {
  constructor(msg = '网络连接失败') { super(msg); this.name = 'NetworkError'; }
}
const normName = (s) => String(s || '').trim().toLowerCase();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// 带超时的 fetch：网络偶尔会卡住不返回，超时后算作网络错误
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

/* ------------------------------ 自己的服务器 ------------------------------ */
const base = cloudEnabled ? String(API_URL).replace(/\/+$/, '') : '';

async function call(path, opts = {}, ms = 15000) {
  const res = await fetchT(`${base}${path}`, opts, ms);
  if (res.ok) return res.status === 204 ? null : res.json();
  let code = '';
  try { code = (await res.json()).error || ''; } catch (e) { /* ignore */ }
  if (code === 'tree_full') throw new TreeFullError();
  if (code === 'nickname_taken') throw new NicknameTakenError();
  if (res.status === 429) throw new Error('操作太频繁了，稍等一会儿再试');
  if (res.status === 413) throw new Error('照片太大了');
  if (res.status >= 500) throw new NetworkError('服务器繁忙');
  throw new Error(code ? `请求失败 (${code})` : `请求失败 (${res.status})`);
}

const serverApi = {
  async ping() {
    try { await fetchT(`${base}/api/health`, {}, 6000); return true; } catch (e) { return false; }
  },
  async createTree(ownerName, theme = 'ice') {
    const r = await retry(() => call('/api/trees', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ownerName, theme }),
    }));
    return { tree: normTree(r.tree), ownerKey: r.ownerKey };
  },
  async getTree(id) {
    try {
      return normTree(await retry(() => call(`/api/trees/${encodeURIComponent(id)}`)));
    } catch (e) {
      if (e instanceof Error && /no_tree/.test(e.message)) return null;
      throw e;
    }
  },
  async listPhotos(treeId) {
    const rows = await retry(() => call(`/api/trees/${encodeURIComponent(treeId)}/photos`));
    return rows.map(normPhoto);
  },
  async nicknameTaken(treeId, nickname) {
    const r = await retry(() => call(`/api/trees/${encodeURIComponent(treeId)}/nickname?name=${encodeURIComponent(nickname)}`));
    return !!r.taken;
  },
  async claimTree() { return false; },
  // opts: { ownerKey?, message?, clientId? } —— clientId 让重试变成幂等的，不会重复存
  async addPhoto(treeId, nickname, blob, opts = {}) {
    opts.clientId = opts.clientId || randomId(20);
    const q = new URLSearchParams({ nickname, cid: opts.clientId });
    if (opts.message) q.set('message', opts.message);
    const headers = { 'Content-Type': 'image/jpeg' };
    if (opts.ownerKey) headers['x-owner-key'] = opts.ownerKey;
    const row = await retry(() => call(`/api/trees/${encodeURIComponent(treeId)}/photos?${q}`, { method: 'POST', headers, body: blob }, 60000));
    return normPhoto(row);
  },
};

function normTree(r) {
  return { id: r.id, ownerName: r.ownerName, createdAt: r.createdAt, theme: r.theme || 'ice' };
}
function normPhoto(r) {
  return {
    id: r.id,
    nickname: r.nickname,
    url: r.url && r.url.startsWith('http') ? r.url : `${base}${r.url}`,
    createdAt: r.createdAt,
    isOwner: !!r.isOwner,
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

export const api = cloudEnabled ? serverApi : localApi;

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
