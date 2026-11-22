/**
 * 圣诞树后端：EdgeOne Pages 云函数（路径 /api），数据存在 EdgeOne KV。
 *
 * 需要在控制台把一个 KV 命名空间绑定到本项目，变量名必须是：xmas_kv
 *
 * 所有操作都走同一个路径，用 ?op= 区分：
 *   POST /api?op=create                       建树        body: {ownerName, theme}
 *   GET  /api?op=tree&t=ID                    树的信息
 *   GET  /api?op=photos&t=ID                  树上的全部照片（不含图片本身）
 *   GET  /api?op=nick&t=ID&name=XX            昵称是否已被占用
 *   POST /api?op=add&t=ID&nickname=&message=&cid=   传一张照片  body: JPEG 二进制
 *   GET  /api?op=photo&t=ID&p=PHOTOID         取图片本身
 *   GET  /api?op=health
 *
 * KV 里的键：
 *   t:<树>            树的记录 JSON
 *   p:<树>:<照片>     照片的记录 JSON（有这条才算照片存在）
 *   b:<树>:<照片>:<n> 图片内容的第 n 块（base64 文本，每块 ≤ 60000 字符，所以不依赖 KV 的大值支持）
 *   n:<树>:<昵称>     朋友昵称占位（防重名）
 *   c:<树>:<cid>      一次上传的幂等标记（重试不会重复保存）
 *   cnt:<树>:o|f      主人 / 朋友的照片数
 */
const CHUNK = 60000;
const MAX_OWNER = 10;
const MAX_FRIENDS = 500;      // 朋友人数实际不限，这里只是防刷的安全上限
const MAX_BYTES = 800 * 1024; // 单张照片上限（前端上传的一般只有 150–300KB）
const THEMES = ['ice', 'gold', 'pink'];

const HEAD = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'Content-Type, x-owner-key',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};
const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=UTF-8', 'cache-control': 'no-store', ...HEAD, ...extra },
  });
const fail = (status, error) => json({ error }, status);

function kv() {
  if (typeof xmas_kv === 'undefined') throw Object.assign(new Error('kv_missing'), { status: 503 });
  return xmas_kv; // eslint-disable-line no-undef
}
const getJ = async (key) => {
  const v = await kv().get(key);
  if (v === null || v === undefined || v === '') return null;
  try { return JSON.parse(v); } catch (e) { return null; }
};
const putJ = (key, obj) => kv().put(key, JSON.stringify(obj));

const rid = (n) => {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  const b = crypto.getRandomValues(new Uint8Array(n));
  let s = '';
  for (let i = 0; i < n; i++) s += chars[b[i] % chars.length];
  return s;
};
async function sha(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
const norm = (s) => String(s || '').trim().toLowerCase();
const clean = (s, max) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
const okId = (s) => /^[a-z0-9]{6,20}$/.test(String(s || ''));

function toBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function fromBase64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function listAll(prefix) {
  const seen = new Set();
  let cursor = '';
  for (let loop = 0; loop < 60; loop++) {
    const page = await kv().list({ prefix, cursor, limit: 100 });
    const keys = Array.isArray(page && page.keys) ? page.keys : [];
    const before = seen.size;
    keys.forEach((k) => seen.add(k.key));
    if ((page && page.complete) || keys.length === 0 || seen.size === before) break;
    cursor = keys[keys.length - 1].key;
  }
  return [...seen];
}

const pubTree = (t) => ({ id: t.id, ownerName: t.ownerName, theme: t.theme, createdAt: t.createdAt });
const pubPhoto = (p) => ({
  id: p.id, nickname: p.nickname, message: p.message || '', isOwner: !!p.isOwner, createdAt: p.createdAt,
  url: `/api?op=photo&t=${p.treeId}&p=${p.id}`,
});

export async function onRequest({ request }) {
  try {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: HEAD });
    const url = new URL(request.url);
    const q = url.searchParams;
    const op = q.get('op') || '';
    const method = request.method;

    if (op === 'health') {
      let kvOk = true;
      try { kv(); } catch (e) { kvOk = false; }
      return json({ ok: true, kv: kvOk });
    }

    /* ---- 建树 ---- */
    if (op === 'create' && method === 'POST') {
      let body;
      try { body = JSON.parse((await request.text()) || '{}'); } catch (e) { return fail(400, 'bad_json'); }
      const name = clean(body.ownerName, 16);
      if (!name) return fail(400, 'bad_name');
      const theme = THEMES.includes(body.theme) ? body.theme : 'ice';
      const id = rid(10);
      const ownerKey = rid(24);
      const tree = { id, ownerName: name, theme, createdAt: new Date().toISOString(), keyHash: await sha(ownerKey) };
      await putJ(`t:${id}`, tree);
      return json({ tree: pubTree(tree), ownerKey }, 201);
    }

    const tid = q.get('t') || '';
    if (['tree', 'photos', 'nick', 'add', 'photo'].includes(op)) {
      if (!okId(tid)) return fail(404, 'no_tree');
      const tree = await getJ(`t:${tid}`);
      if (!tree) return fail(404, 'no_tree');

      if (op === 'tree') return json(pubTree(tree));

      if (op === 'photos') {
        const keys = await listAll(`p:${tid}:`);
        const rows = (await Promise.all(keys.map((k) => getJ(k)))).filter(Boolean);
        rows.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
        return json(rows.map(pubPhoto));
      }

      if (op === 'nick') {
        const n = norm(q.get('name'));
        if (!n) return json({ taken: false });
        const taken = norm(tree.ownerName) === n || !!(await kv().get(`n:${tid}:${encodeURIComponent(n)}`));
        return json({ taken });
      }

      if (op === 'photo') {
        const pid = q.get('p') || '';
        if (!okId(pid)) return fail(404, 'no_photo');
        const meta = await getJ(`p:${tid}:${pid}`);
        if (!meta) return fail(404, 'no_photo');
        const parts = await Promise.all(Array.from({ length: meta.chunks }, (_, i) => kv().get(`b:${tid}:${pid}:${i}`)));
        if (parts.some((x) => !x)) return fail(404, 'no_photo');
        return new Response(fromBase64(parts.join('')), {
          status: 200,
          headers: { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=31536000, immutable', ...HEAD },
        });
      }

      if (op === 'add' && method === 'POST') {
        const buf = new Uint8Array(await request.arrayBuffer());
        if (buf.length > MAX_BYTES) return fail(413, 'too_large');
        if (buf.length < 100 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return fail(400, 'not_jpeg');
        const nickname = clean(q.get('nickname'), 16);
        const message = clean(q.get('message'), 60);
        const cid = clean(q.get('cid'), 40).replace(/[^a-zA-Z0-9_-]/g, '');
        if (!nickname) return fail(400, 'bad_name');

        // 重试幂等：同一次上传已经存过，直接返回
        if (cid) {
          const prev = await kv().get(`c:${tid}:${cid}`);
          if (prev) {
            const meta = await getJ(`p:${tid}:${prev}`);
            if (meta) return json(pubPhoto(meta), 200);
          }
        }

        const key = request.headers.get('x-owner-key') || '';
        const isOwner = !!key;
        const cntKey = `cnt:${tid}:${isOwner ? 'o' : 'f'}`;
        const count = Number(await kv().get(cntKey)) || 0;
        const nKey = `n:${tid}:${encodeURIComponent(norm(nickname))}`;
        if (isOwner) {
          if ((await sha(key)) !== tree.keyHash) return fail(403, 'bad_owner');
          if (count >= MAX_OWNER) return fail(409, 'tree_full');
        } else {
          if (norm(tree.ownerName) === norm(nickname) || (await kv().get(nKey))) return fail(409, 'nickname_taken');
          if (count >= MAX_FRIENDS) return fail(409, 'tree_full');
        }

        const pid = rid(12);
        const b64 = toBase64(buf);
        const chunks = Math.ceil(b64.length / CHUNK);
        // 先写图片内容，最后才写记录：有记录才算存在，中途失败不会留下半张照片
        await Promise.all(Array.from({ length: chunks }, (_, i) => kv().put(`b:${tid}:${pid}:${i}`, b64.slice(i * CHUNK, (i + 1) * CHUNK))));
        const meta = { id: pid, treeId: tid, nickname, message, isOwner, createdAt: new Date().toISOString(), chunks, bytes: buf.length };
        await putJ(`p:${tid}:${pid}`, meta);
        if (!isOwner) await kv().put(nKey, pid);
        if (cid) await kv().put(`c:${tid}:${cid}`, pid);
        await kv().put(cntKey, String(count + 1));
        return json(pubPhoto(meta), 201);
      }
    }
    return fail(404, 'not_found');
  } catch (e) {
    console.error(e);
    if (e && e.message === 'kv_missing') return fail(503, 'kv_missing');
    return fail(500, 'server_error');
  }
}
