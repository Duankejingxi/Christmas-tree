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

const RULES = [
  { re: /^\/rest\/v1\/(trees|photos)(\?.*)?$/, methods: ['GET', 'POST'] },
  { re: /^\/rest\/v1\/rpc\/claim_tree$/, methods: ['POST'] },
  { re: /^\/storage\/v1\/object\/photos\/[A-Za-z0-9._\/-]+$/, methods: ['POST'] },
  { re: /^\/storage\/v1\/object\/public\/photos\/[A-Za-z0-9._\/-]+$/, methods: ['GET'] },
];
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'Content-Type, Prefer, x-upsert',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};
const err = (status, error) =>
  new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json; charset=UTF-8', ...CORS } });

export async function onRequest({ request }) {
  try {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const sp = new URL(request.url).searchParams;
    if (!sp.has('p')) {
      // 直接打开 /api：自检。functions=true 说明云函数在运行；supabase=true 说明它能连上数据库
      let status = -1;
      try {
        const r = await fetch(`${UPSTREAM}/rest/v1/trees?select=id&limit=1`, { headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` } });
        status = r.status;
      } catch (e) { /* 连不上 */ }
      return new Response(JSON.stringify({ version: 'proxy-v3', functions: true, supabase: status === 200, upstream_status: status }), {
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
