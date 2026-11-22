/**
 * 转发函数（EdgeOne Pages 云函数，路径 /api）。
 *
 * 作用：国内用户访问你自己的域名，由这个函数替他们去访问海外的 Supabase。
 * 不需要 KV、不需要任何存储——数据仍然存在 Supabase 里。
 *
 * 前端请求格式：/api?p=<要访问的 Supabase 路径>，例如
 *   /api?p=%2Frest%2Fv1%2Fphotos%3Ftree_id%3Deq.abc    →   Supabase 的 /rest/v1/photos?tree_id=eq.abc
 * 只放行下面白名单里的路径，其他一律拒绝，所以它不能被拿来转发别的网站。
 */
const UPSTREAM = 'https://uzctvqnidrltmwhqjcys.supabase.co';
// 这是 Supabase 的「anon 公开密钥」，本来就是给网页公开使用的（数据安全靠数据库里的权限规则）
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV6Y3R2cW5pZHJsdG13aHFqY3lzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTUzMjk5NjQsImV4cCI6MjExMDkwNTk2NH0.thvm7JogVgm0KyPZ7F6ByQtqQ7zDKwF87JfX2w37WvQ';
const MAX_BODY = 1024 * 1024;
// 后台密码的 SHA-256（密码本身不在代码里）。要换密码：算出新密码的 SHA-256 替换这一行。
const ADMIN_HASH = '751ca28861ae16918946976b3626a13fadfb97af587606b891434c77377c85d1';
const DAY = 86400000;
const CST = 8 * 3600000; // 统计按北京时间算天

const RULES = [
  { re: /^\/rest\/v1\/(trees|photos)(\?.*)?$/, methods: ['GET', 'POST'] },
  { re: /^\/rest\/v1\/rpc\/claim_tree$/, methods: ['POST'] },
  { re: /^\/storage\/v1\/object\/photos\/[A-Za-z0-9._\/-]+$/, methods: ['POST'] },
  { re: /^\/storage\/v1\/object\/public\/photos\/[A-Za-z0-9._\/-]+$/, methods: ['GET'] },
];
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'Content-Type, Prefer, x-upsert, x-admin-key',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};
const err = (status, error) =>
  new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json; charset=UTF-8', ...CORS } });

async function sha(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
// PostgREST 每次最多返回 1000 行，分页取完
async function pgAll(path, max = 30000) {
  const out = [];
  for (let from = 0; from < max; from += 1000) {
    const r = await fetch(UPSTREAM + path, {
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, 'Range-Unit': 'items', Range: `${from}-${from + 999}` },
    });
    if (!r.ok) throw new Error(`upstream ${r.status}`);
    const rows = await r.json();
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}
const dayKey = (iso) => new Date(new Date(iso).getTime() + CST).toISOString().slice(0, 10);

async function adminStats() {
  const [trees, photos] = await Promise.all([
    pgAll('/rest/v1/trees?select=id,owner_name,theme,created_at,from_tree&order=created_at.asc,id.asc'),
    pgAll('/rest/v1/photos?select=tree_id,is_owner,nickname,message,created_at&order=created_at.asc,id.asc'),
  ]);
  const byId = new Map(trees.map((t) => [t.id, t]));
  const friends = new Map(); // 树 -> 朋友照片数
  const ownerPhotos = new Map();
  let friendPhotos = 0, ownerCount = 0;
  const people = new Set();
  for (const ph of photos) {
    if (ph.is_owner) { ownerCount++; ownerPhotos.set(ph.tree_id, (ownerPhotos.get(ph.tree_id) || 0) + 1); }
    else { friendPhotos++; friends.set(ph.tree_id, (friends.get(ph.tree_id) || 0) + 1); people.add(String(ph.nickname || '').trim().toLowerCase()); }
  }
  const now = Date.now();
  const today = dayKey(new Date(now).toISOString());
  const span = (days) => trees.filter((t) => now - new Date(t.created_at).getTime() < days * DAY).length;
  const daily = [];
  for (let i = 29; i >= 0; i--) {
    const k = dayKey(new Date(now - i * DAY).toISOString());
    daily.push({ d: k.slice(5), trees: 0, friends: 0, _k: k });
  }
  const idx = new Map(daily.map((x, i) => [x._k, i]));
  trees.forEach((t) => { const i = idx.get(dayKey(t.created_at)); if (i !== undefined) daily[i].trees++; });
  photos.forEach((ph) => { if (ph.is_owner) return; const i = idx.get(dayKey(ph.created_at)); if (i !== undefined) daily[i].friends++; });
  daily.forEach((x) => delete x._k);
  const themes = { ice: 0, gold: 0, pink: 0 };
  trees.forEach((t) => { themes[t.theme] = (themes[t.theme] || 0) + 1; });
  const row = (t) => ({
    id: t.id, ownerName: t.owner_name, theme: t.theme, createdAt: t.created_at,
    friends: friends.get(t.id) || 0, ownerPhotos: ownerPhotos.get(t.id) || 0, fromShare: !!t.from_tree,
  });
  const withFriends = trees.filter((t) => (friends.get(t.id) || 0) > 0).length;
  return {
    generatedAt: new Date().toISOString(),
    totals: {
      trees: trees.length,
      today: trees.filter((t) => dayKey(t.created_at) === today).length,
      last7: span(7),
      last30: span(30),
      friendPhotos,
      ownerPhotos: ownerCount,
      friendPeople: people.size,
      treesWithFriends: withFriends,
      viaShare: trees.filter((t) => t.from_tree).length,
    },
    daily,
    themes,
    topTrees: trees.map(row).sort((a, b) => b.friends - a.friends).filter((t) => t.friends > 0).slice(0, 10),
    recentTrees: trees.slice(-30).reverse().map(row),
    recentFriends: photos.filter((ph) => !ph.is_owner).slice(-20).reverse().map((ph) => ({
      nickname: ph.nickname, message: ph.message || '', createdAt: ph.created_at,
      tree: byId.get(ph.tree_id) ? byId.get(ph.tree_id).owner_name : '',
    })),
  };
}

export async function onRequest({ request }) {
  try {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const sp = new URL(request.url).searchParams;
    if (sp.get('admin') === 'stats') {
      const key = request.headers.get('x-admin-key') || '';
      if ((await sha(key)) !== ADMIN_HASH) return err(401, 'bad_password');
      return new Response(JSON.stringify(await adminStats()), {
        status: 200, headers: { 'content-type': 'application/json; charset=UTF-8', 'cache-control': 'no-store', ...CORS },
      });
    }
    if (!sp.has('p')) {
      // 直接打开 /api：自检。functions=true 说明云函数在运行；supabase=true 说明它能连上数据库
      let status = -1;
      try {
        const r = await fetch(`${UPSTREAM}/rest/v1/trees?select=id&limit=1`, { headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` } });
        status = r.status;
      } catch (e) { /* 连不上 */ }
      return new Response(JSON.stringify({ version: 'proxy-v4', functions: true, supabase: status === 200, upstream_status: status }), {
        status: 200, headers: { 'content-type': 'application/json; charset=UTF-8', 'cache-control': 'no-store', ...CORS },
      });
    }
    const p = sp.get('p') || '';
    if (!p.startsWith('/') || p.includes('..') || p.length > 2000) return err(400, 'bad_path');
    const rule = RULES.find((r) => r.re.test(p));
    if (!rule || !rule.methods.includes(request.method)) return err(403, 'not_allowed');

    const headers = { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` };
    for (const h of ['content-type', 'prefer', 'x-upsert']) {
      const v = request.headers.get(h);
      if (v) headers[h] = v;
    }
    let body;
    if (request.method === 'POST') {
      body = await request.arrayBuffer();
      if (body.byteLength > MAX_BODY) return err(413, 'too_large');
    }
    const up = await fetch(UPSTREAM + p, { method: request.method, headers, body });
    const out = { ...CORS, 'content-type': up.headers.get('content-type') || 'application/octet-stream' };
    if (request.method === 'GET' && p.startsWith('/storage/v1/object/public/')) {
      out['cache-control'] = 'public, max-age=31536000, immutable'; // 照片不会被修改，可以长期缓存
    } else {
      out['cache-control'] = 'no-store';
    }
    return new Response(await up.arrayBuffer(), { status: up.status, headers: out });
  } catch (e) {
    console.error(e);
    return err(502, 'upstream_error');
  }
}
