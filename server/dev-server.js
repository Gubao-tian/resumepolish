/**
 * 本地单端口服务器（tech-design T7）：dist/ 静态托管 + POST /api/rewrite。
 * 用法：npm start（默认 8787；vite dev server 经代理把 /api 转发到此端口）。
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { handleRewriteRequest } from '../api/rewrite.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const PORT = Number(process.env.PORT || 8787);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** 读取 JSON 请求体（上限 1MB，超限/非 JSON 返回 null） */
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) {
        resolve(null);
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

export const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
  if (req.method === 'GET' && url.pathname === '/api/health') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ status: 'ok', mock: process.env.MOCK === '1' || !process.env.LLM_API_KEY }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/rewrite') {
    const body = await readBody(req);
    const result = await handleRewriteRequest({
      method: 'POST',
      body: body ?? {},
      ip: req.socket?.remoteAddress || 'anonymous',
    });
    res.statusCode = result.status;
    for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
    res.end(JSON.stringify(result.body));
    return;
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    let path = decodeURIComponent(url.pathname);
    if (path === '/') path = '/index.html';
    const file = normalize(join(DIST, path));
    if (!file.startsWith(DIST)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }
    try {
      const content = await readFile(file);
      res.statusCode = 200;
      res.setHeader('Content-Type', MIME[extname(file)] || 'application/octet-stream');
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch {
      res.statusCode = 404;
      res.end('Not Found（请先执行 npm run build 生成 dist/）');
    }
    return;
  }
  res.statusCode = 405;
  res.end('Method Not Allowed');
});

// 仅当作为主入口运行时监听端口（被测试 import 时不启动）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`dev-server listening on http://127.0.0.1:${PORT}（/api/rewrite + dist/ 静态托管）`);
  });
}
