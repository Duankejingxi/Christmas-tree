'use strict';
// 圣诞树后端：零依赖（只需要 Node 18+）。
// 数据：DATA_DIR/db.json（树和照片记录）+ DATA_DIR/photos/<树id>/<照片id>.jpg
// 同时把网页静态文件也一起提供出去，所以只部署这一个服务就够了。
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = +process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DATA = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const ROOT = path.resolve(__dirname, '..');
const MAX_OWNER = 10;
const MAX_FRIENDS = 500; // 朋友人数实际不限，这里只是防刷的安全上限
const MAX_BODY = 3 * 1024 * 1024;
const THEMES = ['ice', 'gold', 'pink'];

fs.mkdirSync(path.join(DATA, 'photos'), { recursive: true });

/* ------------------------------ 数据 ------------------------------ */
const DB_FILE = path.join(DATA, 'db.json');
let db = { trees: {}, photos: [] };
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { /* 第一次启动 */ }
const byTree = new Map();
function reindex() {
  byTree.clear();
  for (const p of db.photos) {
    if (!byTree.has(p.treeId)) byTree.set(p.treeId, []);
    byTree.get(p.treeId).push(p);
  }
}
reindex();

let saving = false, dirty = false;
function save() {
  dirty = true;
  if (saving) return;
  saving = true;
  const tmp = DB_FILE + '.tmp';
  const run = () => {
    dirty = false;
    fs.writeFile(tmp, JSON.stringify(db), (err) => {
      if (!err) fs.rename(tmp, DB_FILE, () => next());
      else { console.error('save failed', err); next(); }
    });
  };
  const next = () => { if (dirty) run(); else saving = false; };
  run();
}

const rid = (n) => {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  const b = crypto.randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += chars[b[i] % chars.length];
  return s;
};
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const norm = (s) => String(s || '').trim().toLowerCase();
const clean = (s, max) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);

/* ------------------------------ 限流 ------------------------------ */
const hits = new Map();
function limited(ip, key, max, windowMs) {
  const k = `${key}:${ip}`;
  const now = Date.now();
  const arr = (hits.get(k) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { hits.set(k, arr); return true; }
  arr.push(now);
  hits.set(k, arr);
  return false;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some((t) => now - t < 3600e3)) hits.delete(k); }, 600e3).unref();

/* ------------------------------ 工具 ------------------------------ */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, x-owner-key',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};
function send(res, status, body, headers = {}) {
  const isObj = body !== null && typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, { ...CORS, 'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
}
const fail = (res, status, error) => send(res, status, { error });
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = +req.headers['content-length'] || 0;
    if (declared > limit) {
      // 一开始就知道太大：直接拒绝，并把剩余数据丢掉
      req.resume();
      return reject(Object.assign(new Error('too_large'), { code: 413 }));
    }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { chunks.length = 0; reject(Object.assign(new Error('too_large'), { code: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function clientIp(req) {
  const remote = req.socket.remoteAddress || '';
  if (remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1') {
    const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xf) return xf;
  }
  return remote;
}
const pubTree = (t) => ({ id: t.id, ownerName: t.ownerName, theme: t.theme, createdAt: t.createdAt });
const pubPhoto = (p) => ({
  id: p.id, nickname: p.nickname, message: p.message || '', isOwner: !!p.isOwner, createdAt: p.createdAt,
  url: `/photos/${p.treeId}/${p.id}.jpg`,
});

/* ------------------------------ 接口 ------------------------------ */
async function api(req, res, url) {
  const ip = clientIp(req);
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const method = req.method;

  if (parts[1] === 'health') return send(res, 200, { ok: true, trees: Object.keys(db.trees).length, photos: db.photos.length });

  // POST /api/trees
  if (parts[1] === 'trees' && parts.length === 2 && method === 'POST') {
    if (limited(ip, 'tree', 30, 3600e3)) return fail(res, 429, 'too_many');
    let body;
    try { body = JSON.parse((await readBody(req, 4096)).toString('utf8') || '{}'); } catch (e) { return fail(res, 400, 'bad_json'); }
    const name = clean(body.ownerName, 16);
    if (!name) return fail(res, 400, 'bad_name');
    const theme = THEMES.includes(body.theme) ? body.theme : 'ice';
    let id;
    do { id = rid(10); } while (db.trees[id]);
    const ownerKey = rid(24);
    db.trees[id] = { id, ownerName: name, theme, createdAt: new Date().toISOString(), keyHash: sha(ownerKey) };
    save();
    return send(res, 201, { tree: pubTree(db.trees[id]), ownerKey });
  }

  const tree = parts[1] === 'trees' && parts[2] ? db.trees[parts[2]] : null;
  if (parts[1] === 'trees' && parts[2] && !tree) return fail(res, 404, 'no_tree');

  // GET /api/trees/:id
  if (tree && parts.length === 3 && method === 'GET') return send(res, 200, pubTree(tree), { 'Cache-Control': 'no-store' });

  // GET /api/trees/:id/photos
  if (tree && parts[3] === 'photos' && method === 'GET') {
    const list = (byTree.get(tree.id) || []).slice().sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    return send(res, 200, list.map(pubPhoto), { 'Cache-Control': 'no-store' });
  }

  // GET /api/trees/:id/nickname?name=xx
  if (tree && parts[3] === 'nickname' && method === 'GET') {
    const n = norm(url.searchParams.get('name'));
    const taken = norm(tree.ownerName) === n || (byTree.get(tree.id) || []).some((p) => !p.isOwner && norm(p.nickname) === n);
    return send(res, 200, { taken }, { 'Cache-Control': 'no-store' });
  }

  // POST /api/trees/:id/photos?nickname=&message=&cid=   body = JPEG
  if (tree && parts[3] === 'photos' && method === 'POST') {
    if (limited(ip, 'photo', 40, 3600e3)) return fail(res, 429, 'too_many');
    let buf;
    try { buf = await readBody(req, MAX_BODY); } catch (e) { return fail(res, e.code === 413 ? 413 : 400, e.code === 413 ? 'too_large' : 'bad_body'); }
    if (buf.length < 100 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return fail(res, 400, 'not_jpeg');
    const nickname = clean(url.searchParams.get('nickname'), 16);
    const message = clean(url.searchParams.get('message'), 60);
    const cid = clean(url.searchParams.get('cid'), 40);
    if (!nickname) return fail(res, 400, 'bad_name');
    const list = byTree.get(tree.id) || [];
    // 重试幂等：同一次上传（cid 相同）直接返回已有记录
    if (cid) {
      const dup = list.find((p) => p.cid === cid);
      if (dup) return send(res, 200, pubPhoto(dup));
    }
    const key = String(req.headers['x-owner-key'] || '');
    const isOwner = !!key;
    if (isOwner) {
      const a = Buffer.from(sha(key)), b = Buffer.from(tree.keyHash);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return fail(res, 403, 'bad_owner');
      if (list.filter((p) => p.isOwner).length >= MAX_OWNER) return fail(res, 409, 'tree_full');
    } else {
      const n = norm(nickname);
      if (norm(tree.ownerName) === n || list.some((p) => !p.isOwner && norm(p.nickname) === n)) return fail(res, 409, 'nickname_taken');
      if (list.filter((p) => !p.isOwner).length >= MAX_FRIENDS) return fail(res, 409, 'tree_full');
    }
    let id;
    do { id = rid(12); } while (list.some((p) => p.id === id));
    const dir = path.join(DATA, 'photos', tree.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.jpg`), buf);
    const rec = { id, treeId: tree.id, nickname, message, isOwner, cid, createdAt: new Date().toISOString() };
    db.photos.push(rec);
    if (!byTree.has(tree.id)) byTree.set(tree.id, []);
    byTree.get(tree.id).push(rec);
    save();
    return send(res, 201, pubPhoto(rec));
  }
  return fail(res, 404, 'not_found');
}

/* ------------------------------ 静态文件 ------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};
const ALLOWED_TOP = new Set(['index.html', 'css', 'js', 'lib', 'assets']);
function serveFile(req, res, file, cache) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found');
    const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const headers = { ...CORS, 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', ETag: etag, 'Cache-Control': cache };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
    headers['Content-Length'] = st.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}
function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const safe = path.normalize(rel).replace(/^([/\\])+/, '');
  if (safe.includes('..')) return send(res, 400, 'Bad path');
  const top = safe.split(path.sep)[0];
  if (!ALLOWED_TOP.has(top)) return send(res, 404, 'Not found');
  const file = path.join(ROOT, safe);
  if (!file.startsWith(ROOT + path.sep)) return send(res, 400, 'Bad path');
  const heavy = top === 'lib' || top === 'assets';
  serveFile(req, res, file, heavy ? 'public, max-age=86400' : 'no-cache');
}
function servePhoto(req, res, url) {
  const m = /^\/photos\/([a-z0-9]{6,16})\/([a-z0-9]{6,20})\.jpg$/.exec(url.pathname);
  if (!m) return send(res, 404, 'Not found');
  serveFile(req, res, path.join(DATA, 'photos', m[1], `${m[2]}.jpg`), 'public, max-age=31536000, immutable');
}

/* ------------------------------ 入口 ------------------------------ */
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (url.pathname.startsWith('/photos/')) return servePhoto(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    return serveStatic(req, res, url);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) fail(res, 500, 'server_error');
    else res.end();
  }
});
server.requestTimeout = 60000;
server.listen(PORT, HOST, () => console.log(`christmas-tree server on http://${HOST}:${PORT}  data=${DATA}`));
