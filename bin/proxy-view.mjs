#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const staticRoot = join(projectRoot, 'dist', 'client');
const args = process.argv.slice(2);

function valueAfter(flag, fallback) {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(`多线代理控制台

用法：proxy-view [选项]

  --port <端口>  本地监听端口，默认 9876
  --no-open      启动后不自动打开浏览器
  -h, --help     显示帮助
`);
  process.exit(0);
}

const port = Number.parseInt(valueAfter('--port', '9876'), 10);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  console.error('端口必须是 1024 到 65535 之间的整数。');
  process.exit(1);
}

if (!existsSync(join(staticRoot, 'index.html'))) {
  console.error('没有找到前端构建产物。请先运行：npm run build');
  process.exit(1);
}

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function isPrivateController(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
  if (url.pathname !== '/' || url.search || url.hash) return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost') return true;
  const version = isIP(host);
  if (version === 4) {
    const octets = host.split('.').map(Number);
    return octets[0] === 10
      || octets[0] === 127
      || (octets[0] === 169 && octets[1] === 254)
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168);
  }
  if (version === 6) {
    return host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb');
  }
  return false;
}

function allowedApiPath(method, pathname) {
  if (method === 'GET') {
    return pathname === '/version'
      || pathname === '/providers/proxies'
      || pathname === '/proxies'
      || pathname === '/connections'
      || /^\/proxies\/[^/]+\/delay$/.test(pathname);
  }
  return method === 'DELETE' && /^\/connections\/[^/]+$/.test(pathname);
}

function sendJson(response, status, message) {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify({ message }));
}

async function proxyMihomo(request, response, requestUrl) {
  const apiPath = requestUrl.pathname.slice('/api/mihomo'.length) || '/';
  if (!allowedApiPath(request.method ?? 'GET', apiPath)) {
    sendJson(response, 405, '不允许访问这个 Mihomo API。');
    return;
  }

  const endpointHeader = request.headers['x-mihomo-endpoint'];
  const endpoint = Array.isArray(endpointHeader) ? endpointHeader[0] : endpointHeader;
  if (!endpoint || !isPrivateController(endpoint)) {
    sendJson(response, 400, '控制器必须是有效的局域网 IP 地址。');
    return;
  }

  const upstreamUrl = new URL(`${apiPath}${requestUrl.search}`, `${endpoint.replace(/\/+$/, '')}/`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers: request.headers.authorization
        ? { Authorization: request.headers.authorization }
        : undefined,
      redirect: 'manual',
      signal: controller.signal,
    });
    const body = Buffer.from(await upstream.arrayBuffer());
    response.writeHead(upstream.status, {
      'Cache-Control': 'no-store',
      'Content-Type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
    });
    response.end(body);
  } catch (error) {
    const message = error instanceof Error && error.name === 'AbortError'
      ? '连接 Mihomo API 超时。'
      : '无法连接 Mihomo API，请检查地址和路由器连通性。';
    sendJson(response, 502, message);
  } finally {
    clearTimeout(timeout);
  }
}

function serveStatic(response, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    sendJson(response, 400, '无效路径。');
    return;
  }
  const relativePath = normalize(decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, ''));
  const filePath = resolve(staticRoot, relativePath);
  if (filePath !== staticRoot && !filePath.startsWith(`${staticRoot}${sep}`)) {
    sendJson(response, 403, '禁止访问。');
    return;
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    sendJson(response, 404, '未找到文件。');
    return;
  }
  response.writeHead(200, {
    'Cache-Control': extname(filePath) === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    'Content-Type': mimeTypes[extname(filePath)] ?? 'application/octet-stream',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
  createReadStream(filePath).pipe(response);
}

const server = createServer(async (request, response) => {
  const host = request.headers.host;
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
    sendJson(response, 403, '无效 Host。');
    return;
  }
  const requestUrl = new URL(request.url ?? '/', `http://${host}`);
  if (requestUrl.pathname.startsWith('/api/mihomo')) {
    await proxyMihomo(request, response, requestUrl);
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendJson(response, 405, '只允许读取静态文件。');
    return;
  }
  serveStatic(response, requestUrl.pathname);
});

server.on('error', (error) => {
  console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用。` : error);
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  const dashboardUrl = `http://127.0.0.1:${port}`;
  console.log(`多线代理控制台已启动：${dashboardUrl}`);
  console.log('按 Ctrl+C 停止。');
  if (args.includes('--no-open')) return;
  const command = process.platform === 'darwin'
    ? ['open', [dashboardUrl]]
    : process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', dashboardUrl]]
      : ['xdg-open', [dashboardUrl]];
  const child = spawn(command[0], command[1], { detached: true, stdio: 'ignore' });
  child.unref();
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
