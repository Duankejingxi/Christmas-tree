'use strict';
// 本地开发/测试用：同时提供网页，并把 /api 交给 functions/api/index.js 处理（和 EdgeOne 上跑的是同一份代码）。
// KV 用一个本地文件模拟，并且故意限制单个值 ≤ 128KB，用来验证照片分块存储在小值限制下也能工作。
//   运行：node server/dev.js        然后打开 http://localhost:8000
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const PORT = +process.env.PORT || 8000;
const ROOT = path.resolve(__dirname, '..');
const KV_FILE = process.env.KV_FILE || path.join(os.tmpdir(), 'xmas-dev-kv.json');
const MAX_VALUE = +process.env.KV_MAX_VALUE || 128 * 1024;

let initial = {};
try { initial = JSON.parse(fs.readFileSync(KV_FILE, 'utf8')); } catch (e) { /* 第一次运行 */ }
const store = new Map(Object.entries(initial));
let timer = null;
const persist = () => {
  clearTimeout(timer);
  timer = setTimeout(() => fs.writeFileSync(KV_FILE, JSON.stringify(Object.fromEntries(store))), 100);
};
globalThis.xmas_kv = {
  async get(k) { return store.has(k) ? store.get(k) : null; },
  async put(k, v) {
    if (typeof v !== 'string') throw new Error('value must be string');
    if (v.length > MAX_VALUE) throw new Error(`value too large (${v.length} > ${MAX_VALUE})`);
    store.set(k, v);
    persist();
  },
  async delete(k) { store.delete(k); persist(); },
  async list({ prefix = '', cursor = '', limit = 10 } = {}) {
    const all = [...store.keys()].filter((k) => k.startsWith(prefix) && k > cursor).sort();
    return { keys: all.slice(0, limit).map((key) => ({ key })), complete: all.length <= limit };
  },
};

let handler;
async function loadHandler() {
  const tmp = path.join(os.tmpdir(), `xmas-api-${process.pid}.mjs`);
  fs.copyFileSync(path.join(ROOT, 'functions/api/index.js'), tmp);
  handler = (await import(pathToFileURL(tmp).href)).onRequest;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
};
const ALLOWED = new Set(['index.html', 'css', 'js', 'lib', 'assets']);

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      const request = new Request(url.href, {
        method: req.method,
        headers: req.headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
      });
      const r = await handler({ request });
      res.writeHead(r.status, Object.fromEntries(r.headers));
      return res.end(Buffer.from(await r.arrayBuffer()));
    }
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const safe = path.normalize(rel).replace(/^[/\\]+/, '');
    if (safe.includes('..') || !ALLOWED.has(safe.split(path.sep)[0])) { res.writeHead(404); return res.end('Not found'); }
    fs.readFile(path.join(ROOT, safe), (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(safe)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  } catch (e) {
    console.error(e);
    res.writeHead(500);
    res.end('error');
  }
}).listen(PORT, () => loadHandler().then(() => console.log(`dev server http://localhost:${PORT}  (KV: ${KV_FILE}, max value ${MAX_VALUE} bytes)`)));
