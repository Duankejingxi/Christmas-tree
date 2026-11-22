'use strict';
// 本地开发/测试用：同时提供网页，并把 /api 交给 functions/api/index.js 处理（和 EdgeOne 上跑的是同一份代码）。
//   运行：node server/dev.js        然后打开 http://localhost:8000
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const PORT = +process.env.PORT || 8000;
const ROOT = path.resolve(__dirname, '..');
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
const ALLOWED = new Set(['index.html', 'admin.html', 'css', 'js', 'lib', 'assets']);

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
}).listen(PORT, () => loadHandler().then(() => console.log(`dev server http://localhost:${PORT}`)));
