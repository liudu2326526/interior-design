import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createPublicJobRelay } from './public-jobs.mjs';
import { isImportJobPath } from '../lib/import-jobs.mjs';

const accessKeyPath = process.env.STUDIO_PUBLIC_ACCESS_KEY_FILE;
const accessKeyHashPath = process.env.STUDIO_PUBLIC_ACCESS_KEY_HASH_FILE;
const bridgeTokenPath = process.env.STUDIO_PUBLIC_BRIDGE_TOKEN_FILE;
const port = Number(process.env.STUDIO_PUBLIC_PORT || 4174);
const origin = 'http://127.0.0.1:4173';
const publicOwner = 'remote-owner';
const rootCookie = '__Host-studio-session';
const lifetime = 7 * 24 * 60 * 60 * 1000;
const maxSessions = 24;
const renderPath = /^\/files\/public-ai\/remote-owner\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.png$/;
const assets = new Map([
  ['/data/empty-plan.json', new URL('../data/empty-plan.json', import.meta.url)],
  ['/data/125c-plan.json', new URL('../data/125c-plan.json', import.meta.url)],
]);
const editorScriptPath = /^\/js\/[a-z][a-z0-9-]*\.js$/;
const editorFile = new URL('../index.html', import.meta.url);
const encoder = (value) => createHash('sha256').update(value).digest();

function configuredMount(value) {
  if (!value) return null;
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      !/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\/?$/.test(url.pathname)) {
    throw new Error('STUDIO_PUBLIC_URL must be an HTTPS URL with a deployment path');
  }
  return {
    host: url.host,
    origin: url.origin,
    prefix: url.pathname.replace(/\/$/, ''),
    cookieName: '__Secure-interior-design-session',
  };
}

const namedMount = configuredMount(process.env.STUDIO_PUBLIC_URL);

function requestMount(req) {
  const host = req.headers.host?.toLowerCase();
  if (namedMount && host === namedMount.host) return namedMount;
  if (/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(host)) {
    return { origin: null, prefix: '', cookieName: rootCookie };
  }
  if (/^[a-z0-9-]+\.trycloudflare\.com$/.test(host)) {
    return { origin: `https://${host}`, prefix: '', cookieName: rootCookie };
  }
  return null;
}

async function readSecret(file) {
  if (!file) throw new Error('Public access requires both local secret files');
  const value = (await readFile(file, 'utf8')).trim();
  if (!/^[a-zA-Z0-9_-]{32,128}$/.test(value)) throw new Error('Invalid public access secret');
  return value;
}

async function loadAccessKeyHash() {
  if (!accessKeyHashPath) return encoder(await readSecret(accessKeyPath));
  const hash = (await readFile(accessKeyHashPath, 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/i.test(hash)) throw new Error('Invalid public access key hash');
  return Buffer.from(hash, 'hex');
}

const [expectedKey, bridgeToken] = await Promise.all([loadAccessKeyHash(), readSecret(bridgeTokenPath)]);
const relay = createPublicJobRelay({ origin, bridgeToken });
const bridgeHeaders = {
  'x-studio-public-owner': publicOwner,
  'x-studio-public-bridge': bridgeToken,
};
const sessions = new Map();

function revoke(id) {
  sessions.delete(id);
  relay.cancelOwner?.(id);
}

const cleanup = setInterval(() => {
  for (const [id, { expires }] of sessions) {
    if (expires <= Date.now()) revoke(id);
  }
}, 60_000);
cleanup.unref();

function session(req, { cookieName, origin: sessionOrigin }) {
  const saved = (req.headers.cookie || '').split(';').find(part => part.trimStart().startsWith(cookieName + '='));
  const id = saved?.trim().slice(cookieName.length + 1);
  const active = sessions.get(id);
  if (!active || active.origin !== sessionOrigin) return null;
  if (active.expires > Date.now()) return id;
  revoke(id);
  return null;
}

function cookie({ cookieName, prefix }, value, maxAge) {
  return `${cookieName}=${value}; Max-Age=${maxAge}; Path=${prefix}/; Secure; HttpOnly; SameSite=Strict`;
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function send(res, req, status, type, body) {
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function redirect(res, location, headers = {}) {
  res.writeHead(303, { Location: location, ...headers });
  res.end();
}

function loginPage(res, req, prefix, status = 200) {
  const error = status === 401 ? '<p role="alert">访问密钥不正确，请重试。</p>' : '';
  send(res, req, status, 'text/html; charset=utf-8', `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>登录 AI · 户型装修设计</title>
<style>
  *{box-sizing:border-box} body{margin:0;padding:24px;min-height:100dvh;display:grid;place-items:center;background:#f4f0e9;color:#282520;font:16px system-ui,sans-serif}
  main{width:min(100%,420px);padding:28px;border:1px solid #e0d8cb;border-radius:18px;background:#fffdfa}
  h1{font-size:23px;margin:0 0 8px} p{line-height:1.6;color:#655c50} form{display:grid;gap:10px;margin:22px 0}
  input,button{border:1px solid #d4cabc;border-radius:8px;padding:11px;font:inherit} button{background:#985a37;color:white;cursor:pointer}
  a{color:#814521} [role=alert]{color:#a02b22}
</style></head><body><main>
<h1>登录 AI</h1><p>输入访问密钥，使用 AI 助手、图纸识别和效果图生成。</p>${error}
<form method="post" action="${prefix}/auth/login"><label for="key">访问密钥</label>
<input id="key" name="key" type="password" maxlength="128" autocomplete="current-password" required autofocus>
<button type="submit">登录</button></form><a href="${prefix}/">返回编辑器</a></main></body></html>`);
}

async function checkKey(req) {
  if (!req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) return false;
  if (Number(req.headers['content-length']) > 4096) return false;
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) return false;
    chunks.push(chunk);
  }
  const data = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  return timingSafeEqual(expectedKey, encoder((data.get('key') || '').trim()));
}

function isSameOrigin(req, mount) {
  return mount.origin !== null && req.headers.origin === mount.origin;
}

async function sendEditor(req, res, owner, prefix) {
  const source = await readFile(editorFile, 'utf8');
  const authControl = owner
    ? `<form method="post" action="${prefix}/auth/logout"><button class="btn" type="submit" title="退出 AI 登录">退出 AI</button></form>`
    : `<a class="btn" style="text-decoration:none" href="${prefix}/auth/login" title="登录以使用 AI 功能">登录 AI</a>`;
  const html = source
    .replace('</head>', `<meta name="studio-public-access" content="${owner ? 'owner' : 'guest'}">\n<meta name="studio-path-prefix" content="${prefix}">\n</head>`)
    .replace('<details class="menu">', `${authControl}\n    <details class="menu">`);
  send(res, req, 200, 'text/html; charset=utf-8', html);
}

async function sendHealth(res) {
  const upstream = await fetch(origin + '/api/health', { headers: bridgeHeaders, signal: AbortSignal.timeout(25_000) });
  if (!upstream.ok) return json(res, 503, { error: 'AI 服务暂时不可用' });
  const data = await upstream.json();
  json(res, 200, { ok: data.ok === true, codex: { found: data.codex?.found === true } });
}

async function sendRender(req, res, pathname) {
  const upstream = await fetch(origin + pathname, {
    method: req.method, headers: bridgeHeaders, signal: AbortSignal.timeout(25_000),
  });
  if (!upstream.ok || !upstream.headers.get('content-type')?.startsWith('image/png')) {
    await upstream.body?.cancel();
    return json(res, 404, { error: '效果图不存在' });
  }
  const headers = { 'Content-Type': 'image/png' };
  const length = upstream.headers.get('content-length');
  if (length) headers['Content-Length'] = length;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  await pipeline(Readable.fromWeb(upstream.body), res);
}

async function forwardBridge(req, res, pathname, search = '') {
  const controller = new AbortController();
  res.once('close', () => controller.abort());
  const options = { method: req.method, headers: { ...bridgeHeaders }, signal: controller.signal };
  if (req.method === 'POST') {
    for (const name of ['content-type', 'content-length']) {
      if (req.headers[name]) options.headers[name] = req.headers[name];
    }
    options.duplex = 'half';
    options.body = Readable.toWeb(req);
  }
  const upstream = await fetch(origin + pathname + search, options);
  const headers = {};
  for (const name of ['content-type', 'content-length', 'content-disposition', 'allow', 'retry-after']) {
    const value = upstream.headers.get(name);
    if (value) headers[name] = value;
  }
  res.writeHead(upstream.status, headers);
  if (!upstream.body) return res.end();
  await pipeline(Readable.fromWeb(upstream.body), res);
}

async function route(req, res) {
  const rawUrl = req.url || '/';
  const incomingPath = rawUrl.split('?')[0];
  const read = req.method === 'GET' || req.method === 'HEAD';
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // A same-origin form POST must retain its Origin for the CSRF check.
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'; base-uri 'none'; form-action 'self'");

  const mount = requestMount(req);
  if (!mount || !incomingPath.startsWith('/') || incomingPath.startsWith('//')) {
    return json(res, 404, { error: '资源不存在' });
  }
  const { prefix } = mount;
  if (prefix && incomingPath === prefix && read) return redirect(res, prefix + '/');
  if (!incomingPath.startsWith(prefix + '/')) return json(res, 404, { error: '资源不存在' });
  const pathname = incomingPath.slice(prefix.length);
  const owner = session(req, mount);
  if (read && (pathname === '/' || pathname === '/index.html')) return sendEditor(req, res, owner, prefix);
  if (read && assets.has(pathname)) {
    return send(res, req, 200, 'application/json; charset=utf-8', await readFile(assets.get(pathname)));
  }
  if (read && editorScriptPath.test(pathname)) {
    const script = await readFile(new URL('..' + pathname, import.meta.url)).catch(error => {
      if (error.code === 'ENOENT' || error.code === 'EISDIR') return null;
      throw error;
    });
    if (script) return send(res, req, 200, 'text/javascript; charset=utf-8', script);
  }
  if (pathname === '/auth/login' && read) {
    if (owner) return redirect(res, prefix + '/');
    return loginPage(res, req, prefix);
  }
  if (req.method === 'POST' && (pathname === '/auth/login' || pathname === '/auth/logout')) {
    if (!isSameOrigin(req, mount)) return json(res, 403, { error: '请从公网编辑器发起登录或退出' });
    if (pathname === '/auth/logout') {
      if (owner) revoke(owner);
      return redirect(res, prefix + '/', { 'Set-Cookie': cookie(mount, '', 0) });
    }
    if (!(await checkKey(req))) return loginPage(res, req, prefix, 401);
    if (owner) revoke(owner);
    if (sessions.size >= maxSessions) revoke(sessions.keys().next().value);
    const id = randomBytes(32).toString('base64url');
    sessions.set(id, { expires: Date.now() + lifetime, origin: mount.origin });
    return redirect(res, prefix + '/', { 'Set-Cookie': cookie(mount, id, lifetime / 1000) });
  }
  if (pathname === '/api/export/dwg' && req.method === 'POST') {
    if (!owner) return json(res, 401, { error: '请登录后导出 DWG' });
    if (!isSameOrigin(req, mount)) return json(res, 403, { error: '请求来源无效' });
    return forwardBridge(req, res, pathname);
  }
  if (pathname.startsWith('/api/jobs/') || pathname === '/api/health' || renderPath.test(pathname)) {
    if (!owner) return json(res, 401, { error: '请登录 AI 后重试' });
    if (read && pathname === '/api/health') return sendHealth(res);
    if (read && renderPath.test(pathname)) return sendRender(req, res, pathname);
    if (pathname.startsWith('/api/jobs/')) {
      if (!read && !isSameOrigin(req, mount)) return json(res, 403, { error: '请求来源无效' });
      const url = new URL(rawUrl.slice(prefix.length), 'http://localhost');
      if (isImportJobPath(pathname)) return forwardBridge(req, res, pathname, url.search);
      if (await relay(req, res, url, owner)) return;
    }
  }
  return json(res, 404, { error: '资源不存在' });
}

createServer((req, res) => {
  route(req, res).catch(() => {
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) return res.end();
    json(res, 502, { error: 'AI 服务暂时不可用，请稍后重试' });
  });
}).listen(port, '127.0.0.1', () => {
  console.log(`Public interior design gateway listening on 127.0.0.1:${port}`);
});
