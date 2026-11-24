#!/usr/bin/env node
/**
 * 本地桥接服务：静态页面 + /api/chat、/api/render、/api/plan/import + /files/*。
 * 只监听 127.0.0.1；无第三方依赖，Node 原生 http。详细契约见 docs/contract.md §5。
 */
import { createServer } from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { locateCodex, readLogin, MIN_CODEX_VERSION } from './lib/codex/binary.mjs';
import { CodexSession, SessionPool, probeModels } from './lib/codex/session.mjs';
import { parsePatch, validatePlan, summarizePlan, extractJson } from './lib/codex/plan.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROJECTS = path.join(ROOT, 'projects');
const WORKDIR = path.join(ROOT, 'workdir');
const PROMPTS = path.join(ROOT, 'prompts');
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 4173;

const MAX_BODY = 40 * 1024 * 1024;
const CHAT_TIMEOUT_MS = 10 * 60_000;
const RENDER_TIMEOUT_MS = 8 * 60_000;
const IMPORT_TIMEOUT_MS = 10 * 60_000;
const MAX_CONCURRENT_TURNS = 4;
const MAX_CHAT_SESSIONS = 6;
const SSE_HEARTBEAT_MS = 15_000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.pdf': 'application/pdf',
  '.woff2': 'font/woff2',
};

// ---------------------------------------------------------------- 通用工具

function contentType(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

function sendJson(res, status, payload) {
  if (res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    ...(status === 413 ? { Connection: 'close' } : {}),
  });
  res.end(body);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(text);
}

function openSSE(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, SSE_HEARTBEAT_MS);
  heartbeat.unref?.();

  const state = { closed: false };
  res.on('close', () => {
    state.closed = true;
  });

  return {
    send(event) {
      if (res.writableEnded || state.closed) return;
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        state.closed = true; // 客户端已经断开，后续 send 直接丢弃
      }
    },
    close() {
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    },
    get closed() {
      return state.closed || res.writableEnded;
    },
  };
}

function readJson(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      req.pause();
      reject(error);
    };
    const tooLarge = () => {
      const error = new Error(`请求体过大（上限 ${Math.round(limit / 1024 / 1024)}MB）`);
      error.status = 413;
      return error;
    };
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > limit) return fail(tooLarge());
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) return fail(tooLarge());
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        const error = new Error('请求体不是合法 JSON（invalid JSON body）');
        error.status = 400;
        reject(error);
      }
    });
    req.on('error', (error) => fail(error));
  });
}

/** 把相对路径安全地拼到 base 下；越界返回 null。 */
function safeJoin(base, relative) {
  const cleaned = String(relative).replace(/^\/+/, '');
  if (!cleaned || cleaned.includes('\0')) return null;
  const resolved = path.resolve(base, cleaned);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
  return resolved;
}

async function isFile(file) {
  try {
    return (await fsp.stat(file)).isFile();
  } catch {
    return false;
  }
}

function decodeBase64(data) {
  const text = String(data || '')
    .replace(/^data:[^;]+;base64,/, '')
    .replace(/\s+/g, '');
  if (!text) return null;
  const buffer = Buffer.from(text, 'base64');
  return buffer.length ? buffer : null;
}

function imageExt(mime) {
  const value = String(mime || '').toLowerCase();
  if (value.includes('jpeg') || value.includes('jpg')) return 'jpg';
  if (value.includes('webp')) return 'webp';
  if (value.includes('gif')) return 'gif';
  return 'png';
}

/** 上传文件名：去目录、去控制字符，保留原扩展名。 */
function safeFileName(name, index) {
  const base = String(name || '').split(/[/\\]/).pop() || '';
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^\p{L}\p{N}._() \-]/gu, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120);
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : `file-${index}`;
}

function truncate(text, max) {
  const value = String(text || '');
  return value.length > max ? `${value.slice(0, max)}\n…（已截断，truncated）` : value;
}

function errorMessage(error) {
  if (!error) return '未知错误（unknown error）';
  const message = error instanceof Error ? error.message : String(error);
  return truncate(message, 2000);
}

/** 并发上限：codex 进程较重，同一时间最多跑这么多个回合。 */
function createLimiter(max) {
  let active = 0;
  const queue = [];
  const pump = () => {
    if (active >= max || queue.length === 0) return;
    queue.shift()();
  };
  return (task) =>
    new Promise((resolve, reject) => {
      const runTask = () => {
        active++;
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            active--;
            pump();
          });
      };
      if (active < max) runTask();
      else queue.push(runTask);
    });
}

// ---------------------------------------------------------------- codex 探测

let probeCache = null; // { at, value: Promise }
const modelsCache = new Map(); // key -> { at, value: Promise }

/** 探测本机 codex：可执行文件、版本、登录态。结果缓存 30 秒。 */
function getProbe({ force = false } = {}) {
  if (!force && probeCache && Date.now() - probeCache.at < 30_000) return probeCache.value;
  probeCache = { at: Date.now(), value: probeNow() };
  return probeCache.value;
}

async function probeNow() {
  const install = await locateCodex();
  if (!install.installed) {
    return {
      installed: false,
      found: false,
      compatible: false,
      loggedIn: false,
      version: null,
      path: null,
      account: null,
      models: [],
      detail: '未找到 codex（codex not found）',
      install,
    };
  }

  const [login, models] = await Promise.all([readLogin(install), getModels(install)]);
  const found = install.compatible && login.loggedIn;
  return {
    installed: true,
    found,
    compatible: install.compatible,
    loggedIn: login.loggedIn,
    version: install.version,
    path: install.path,
    account: login.account,
    models,
    detail: !install.compatible
      ? `codex 版本过低（${install.version ?? '未知'}），需要 ≥ ${MIN_CODEX_VERSION}`
      : !login.loggedIn
        ? 'codex 尚未登录（codex is not logged in）'
        : null,
    install,
  };
}

/** 模型表缓存 10 分钟；失败或空表 1 分钟后再试。 */
function getModels(install) {
  const key = `${install.path}\0${install.version ?? ''}`;
  const hit = modelsCache.get(key);
  if (hit && Date.now() - hit.at < (hit.ttl ?? 10 * 60_000)) return hit.value;
  const entry = { at: Date.now(), ttl: 10 * 60_000, value: null };
  entry.value = probeModels(install, { cwd: ROOT }).catch(() => []).then((models) => {
    if (!models.length) entry.ttl = 60_000;
    return models;
  });
  modelsCache.set(key, entry);
  return entry.value;
}

function unusableMessage(probe) {
  if (!probe.installed) {
    return '未找到 codex（codex not found）。请先安装：npm i -g @openai/codex，或设置 CODEX_PATH 指向可执行文件。';
  }
  if (!probe.compatible) {
    return `codex 版本过低（${probe.version ?? '未知'}），本服务需要 ≥ ${MIN_CODEX_VERSION}。请升级后重试。`;
  }
  if (!probe.loggedIn) {
    return 'codex 尚未登录（codex is not logged in）。请在终端运行 codex login 后重试。';
  }
  return 'codex 暂不可用（codex unavailable）。';
}

// ---------------------------------------------------------------- 提示词

async function readPrompt(name) {
  try {
    return await fsp.readFile(path.join(PROMPTS, name), 'utf8');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------- 会话池

const pool = new SessionPool({ max: MAX_CHAT_SESSIONS, idleMs: 30 * 60_000 });
const limitTurns = createLimiter(MAX_CONCURRENT_TURNS);

// ---------------------------------------------------------------- 路由

async function route(req, res) {
  let url;
  try {
    url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  } catch {
    return sendJson(res, 400, { error: '请求地址不合法（bad request URL）' });
  }
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return sendJson(res, 400, { error: '请求地址编码不合法（bad URL encoding）' });
  }

  const method = req.method || 'GET';
  const api = (allow) => {
    if (!allow.includes(method)) {
      res.setHeader('Allow', allow.join(', '));
      sendJson(res, 405, { error: '方法不允许（method not allowed）' });
      return false;
    }
    return true;
  };

  if (pathname === '/api/health') {
    if (!api(['GET', 'HEAD'])) return;
    return handleHealth(req, res, url);
  }
  if (pathname === '/api/chat') {
    if (!api(['POST'])) return;
    return handleChat(req, res);
  }
  if (pathname === '/api/render') {
    if (!api(['POST'])) return;
    return handleRender(req, res);
  }
  if (pathname === '/api/plan/import' || pathname === '/api/plan/import/') {
    if (!api(['POST'])) return;
    return handlePlanImport(req, res);
  }
  if (pathname.startsWith('/api/')) {
    return sendJson(res, 404, { error: '接口不存在（unknown API）' });
  }
  if (pathname.startsWith('/files/')) {
    if (!api(['GET', 'HEAD'])) return;
    return serveFiles(req, res, pathname.slice('/files/'.length));
  }
  if (!api(['GET', 'HEAD'])) return;
  return serveStatic(req, res, pathname);
}

// ---------------------------------------------------------------- /api/health

async function handleHealth(req, res, url) {
  const probe = await getProbe({ force: url.searchParams.has('force') });
  const body = {
    ok: true,
    codex: {
      found: probe.found,
      version: probe.version,
      path: probe.path,
      account: probe.account,
      models: probe.models,
      installed: probe.installed,
      loggedIn: probe.loggedIn,
      compatible: probe.compatible,
      minVersion: MIN_CODEX_VERSION,
      ...(probe.detail ? { detail: probe.detail } : {}),
    },
    projectRoot: ROOT,
  };
  sendJson(res, 200, body);
}

// ---------------------------------------------------------------- /api/chat

function buildChatMessage(message, context) {
  const parts = [`用户消息：\n${message}`];
  if (context && typeof context === 'object') {
    let json = '';
    try {
      json = JSON.stringify(context);
    } catch {
      json = '';
    }
    if (json && json !== '{}') {
      parts.push(`当前上下文（JSON，含 plan / state / selection / view）：\n\`\`\`json\n${truncate(json, 120_000)}\n\`\`\``);
    }
  }
  parts.push('请严格按系统提示词输出一个 JSON 对象（reply / ops / focus），不要输出其他内容。');
  return parts.join('\n\n');
}

async function handleChat(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch (error) {
    return sendJson(res, error.status || 400, { error: errorMessage(error) });
  }

  const message = typeof body?.message === 'string' ? body.message.trim() : '';
  if (!message) return sendJson(res, 400, { error: 'message 不能为空（message is required）' });

  const sessionId =
    typeof body.sessionId === 'string' && body.sessionId.trim()
      ? body.sessionId.trim().slice(0, 128)
      : crypto.randomUUID();
  const images = Array.isArray(body.images)
    ? body.images.filter((img) => img && typeof img.data === 'string').slice(0, 6)
    : [];

  const sse = openSSE(res);
  let settled = false;
  let cancelled = false;
  let activeSession = null;
  let tmpDir = null;
  res.on('close', () => {
    cancelled = true;
    if (!settled) activeSession?.interrupt().catch(() => {});
  });

  try {
    const probe = await getProbe();
    if (!probe.found) {
      sse.send({ type: 'error', message: unusableMessage(probe) });
      sse.send({ type: 'done' });
      return;
    }

    sse.send({ type: 'status', text: '正在连接 codex…' });
    tmpDir = path.join(os.tmpdir(), 'interior-design-studio', `chat-${crypto.randomUUID()}`);
    await fsp.mkdir(tmpDir, { recursive: true });

    const input = [{ type: 'text', text: buildChatMessage(message, body.context), text_elements: [] }];
    for (let i = 0; i < images.length; i++) {
      const buffer = decodeBase64(images[i].data);
      if (!buffer) continue;
      const file = path.join(tmpDir, `image-${i + 1}.${imageExt(images[i].mime)}`);
      await fsp.writeFile(file, buffer);
      input.push({ type: 'localImage', path: file });
    }

    const developerInstructions = await readPrompt('patch.md');
    const result = await limitTurns(() => {
      // 排队期间客户端可能已经断开：不要再占用 codex 会话跑一个没人接收的回合。
      if (cancelled || sse.closed) throw new Error('客户端已断开（client disconnected）');
      return pool.run(
        `chat:${sessionId}`,
        () =>
          CodexSession.start({
            install: probe.install,
            cwd: ROOT,
            sandbox: 'read-only',
            approvalPolicy: 'never',
            developerInstructions,
          }),
        (session) => {
          if (cancelled || sse.closed) throw new Error('客户端已断开（client disconnected）');
          activeSession = session;
          return session.runTurn({
            input,
            timeoutMs: CHAT_TIMEOUT_MS,
            onEvent: (event) => {
              if (event.type === 'status' && event.text) sse.send({ type: 'status', text: event.text });
              else if (event.type === 'delta' && event.text) sse.send({ type: 'delta', text: event.text });
            },
          });
        },
      );
    });
    activeSession = null;

    if (cancelled || sse.closed) return;
    if (result.outcome !== 'completed') {
      sse.send({ type: 'error', message: result.error || 'codex 回合未正常完成（turn incomplete）' });
      sse.send({ type: 'done' });
      return;
    }
    sse.send({ type: 'result', result: parsePatch(result.text) });
    sse.send({ type: 'done' });
  } catch (error) {
    if (!sse.closed) {
      sse.send({ type: 'error', message: errorMessage(error) });
      sse.send({ type: 'done' });
    }
  } finally {
    settled = true;
    sse.close();
    if (tmpDir) fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------- /api/render

function buildRenderMessage(body, targetFile) {
  const kind = body.kind === 'room' ? `房间「${body.roomId || '当前视角'}」` : '整体视角';
  let scene = '';
  try {
    scene = truncate(JSON.stringify(body.scene ?? {}), 60_000);
  } catch {
    scene = '{}';
  }
  return [
    '请根据截图生成一张室内设计效果图。',
    `类型：${kind}。风格：${body.style || '现代简约'}。`,
    body.note ? `补充要求：${body.note}` : '',
    '',
    '场景数据（JSON）：',
    '```json',
    scene,
    '```',
    '',
    '要求：',
    '1. 调用 image_gen 工具生成图片；保持截图中的机位、构图、墙体布局、门窗位置、家具位置与朝向不变。',
    '2. 只提升真实感与光照，不要改变户型结构、不要增删房间或家具。',
    `3. 把最终图片以 PNG 保存到：${targetFile}`,
    '4. 回复一句中文说明，并给出最终文件路径。',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * 从通知/最终文本里找生成的图片；找不到时扫描 renders 目录中本次新增的文件兜底。
 */
async function findRenderFile(rendersDir, beforeNames, id, blob) {
  const exact = path.join(rendersDir, `${id}.png`);
  if (await isFile(exact)) return exact;

  const pattern = /renders[\\/]([A-Za-z0-9._\-]+\.(?:png|jpe?g|webp))/gi;
  let match;
  while ((match = pattern.exec(blob || ''))) {
    const candidate = path.join(rendersDir, match[1]);
    if (await isFile(candidate)) return candidate;
  }

  let best = null;
  const entries = await fsp.readdir(rendersDir).catch(() => []);
  for (const name of entries) {
    if (!/\.(png|jpe?g|webp)$/i.test(name) || beforeNames.has(name)) continue;
    const file = path.join(rendersDir, name);
    const stat = await fsp.stat(file).catch(() => null);
    if (!stat || !stat.isFile()) continue;
    if (!best || stat.mtimeMs > best.mtimeMs) best = { file, mtimeMs: stat.mtimeMs };
  }
  return best?.file ?? null;
}

async function handleRender(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch (error) {
    return sendJson(res, error.status || 400, { error: errorMessage(error) });
  }

  const shot = decodeBase64(body?.image);
  if (!shot) return sendJson(res, 400, { error: '缺少 image（当前视角截图，base64）' });

  const sse = openSSE(res);
  let settled = false;
  let cancelled = false;
  let activeSession = null;
  let tmpDir = null;
  res.on('close', () => {
    cancelled = true;
    if (!settled) activeSession?.interrupt().catch(() => {});
  });

  try {
    const probe = await getProbe();
    if (!probe.found) {
      sse.send({ type: 'error', message: unusableMessage(probe) });
      sse.send({ type: 'done' });
      return;
    }

    const id = crypto.randomUUID();
    const rendersDir = path.join(PROJECTS, 'renders');
    await fsp.mkdir(rendersDir, { recursive: true });
    const beforeNames = new Set(await fsp.readdir(rendersDir).catch(() => []));
    const targetFile = path.join(rendersDir, `${id}.png`);

    tmpDir = path.join(os.tmpdir(), 'interior-design-studio', `render-${id}`);
    await fsp.mkdir(tmpDir, { recursive: true });
    const shotPath = path.join(tmpDir, `shot.${imageExt(body.mime)}`);
    await fsp.writeFile(shotPath, shot);

    sse.send({ type: 'status', text: '正在生成效果图，可能需要 1–3 分钟…' });
    const developerInstructions = await readPrompt('render.md');
    const input = [
      { type: 'text', text: buildRenderMessage(body, targetFile), text_elements: [] },
      { type: 'localImage', path: shotPath },
    ];

    const result = await limitTurns(async () => {
      // 排队期间客户端可能已经断开：不再启动新的 codex 会话。
      if (cancelled || sse.closed) throw new Error('客户端已断开（client disconnected）');
      const session = await CodexSession.start({
        install: probe.install,
        cwd: ROOT,
        sandbox: 'workspace-write',
        approvalPolicy: 'never',
        developerInstructions,
      });
      activeSession = session;
      try {
        if (cancelled || sse.closed) throw new Error('客户端已断开（client disconnected）');
        return await session.runTurn({
          input,
          timeoutMs: RENDER_TIMEOUT_MS,
          onEvent: (event) => {
            if (event.type === 'status' && event.text) sse.send({ type: 'status', text: event.text });
          },
        });
      } finally {
        activeSession = null;
        await session.dispose().catch(() => {});
      }
    });

    if (cancelled || sse.closed) return;
    if (result.outcome !== 'completed') {
      sse.send({ type: 'error', message: result.error || 'codex 回合未正常完成（turn incomplete）' });
      sse.send({ type: 'done' });
      return;
    }

    const blob = `${result.text}\n${JSON.stringify(result.items)}`;
    const file = await findRenderFile(rendersDir, beforeNames, id, blob);
    if (!file) {
      sse.send({ type: 'error', message: 'codex 没有生成图片（no image produced）。请重试，或在 note 里补充更具体的要求。' });
      sse.send({ type: 'done' });
      return;
    }

    const name = path.basename(file);
    const style = typeof body.style === 'string' && body.style ? body.style : '现代简约';
    sse.send({
      type: 'image',
      url: `/files/renders/${encodeURIComponent(name)}`,
      prompt: `[${style}] ${body.kind === 'room' ? `room:${body.roomId || ''}` : 'angle'}${body.note ? ` · ${body.note}` : ''}`,
    });
    sse.send({ type: 'done' });
  } catch (error) {
    if (!sse.closed) {
      sse.send({ type: 'error', message: errorMessage(error) });
      sse.send({ type: 'done' });
    }
  } finally {
    settled = true;
    sse.close();
    if (tmpDir) fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------- /api/plan/import

async function handlePlanImport(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch (error) {
    return sendJson(res, error.status || 400, { error: errorMessage(error) });
  }

  const files = Array.isArray(body?.files)
    ? body.files.filter((file) => file && typeof file.data === 'string' && file.data.length > 0).slice(0, 20)
    : [];
  if (!files.length) return sendJson(res, 400, { error: '缺少 files（至少上传一个文件）' });

  const probe = await getProbe();
  if (!probe.found) return sendJson(res, 503, { error: unusableMessage(probe) });

  const id = crypto.randomUUID();
  const importDir = path.join(WORKDIR, `import-${id}`);
  let activeSession = null;
  let clientGone = false;
  res.on('close', () => {
    clientGone = true;
    // 浏览器关掉页面 / 取消请求时，别让 codex 继续跑完整个解析回合。
    if (activeSession) activeSession.interrupt().catch(() => {});
  });
  try {
    await fsp.mkdir(importDir, { recursive: true });
    const written = [];
    const used = new Set();
    for (let i = 0; i < files.length; i++) {
      let name = safeFileName(files[i].name, i + 1);
      if (used.has(name)) {
        const ext = path.extname(name);
        name = `${path.basename(name, ext)}-${i + 1}${ext}`;
      }
      used.add(name);
      const buffer = decodeBase64(files[i].data);
      if (!buffer) continue;
      await fsp.writeFile(path.join(importDir, name), buffer);
      written.push(name);
    }
    if (!written.length) return sendJson(res, 400, { error: '上传的文件无法解码（cannot decode files）' });

    const note = typeof body.note === 'string' ? body.note.trim() : '';
    const message = [
      '请解析本工作目录中的户型文件，输出 Plan JSON。',
      `文件：${written.join('、')}`,
      note ? `用户备注：${note}` : '',
      '按系统提示词把完整 Plan 写入当前工作目录的 plan.json，然后用中文简述识别结果。',
    ]
      .filter(Boolean)
      .join('\n\n');

    const developerInstructions = await readPrompt('plan-import.md');
    const result = await limitTurns(async () => {
      if (clientGone) throw new Error('客户端已断开（client disconnected）');
      const session = await CodexSession.start({
        install: probe.install,
        cwd: importDir,
        sandbox: 'workspace-write',
        approvalPolicy: 'never',
        developerInstructions,
      });
      activeSession = session;
      try {
        if (clientGone) throw new Error('客户端已断开（client disconnected）');
        return await session.runTurn({
          input: [{ type: 'text', text: message, text_elements: [] }],
          timeoutMs: IMPORT_TIMEOUT_MS,
        });
      } finally {
        activeSession = null;
        await session.dispose().catch(() => {});
      }
    });

    if (clientGone) return;
    if (result.outcome !== 'completed') {
      return sendJson(res, 502, { error: result.error || 'codex 回合未正常完成（turn incomplete）', id });
    }

    let rawPlan = null;
    try {
      rawPlan = JSON.parse(await fsp.readFile(path.join(importDir, 'plan.json'), 'utf8'));
    } catch {
      rawPlan = extractJson(result.text);
    }
    if (!rawPlan) {
      return sendJson(res, 422, {
        error: 'codex 没有产出可解析的 Plan（no Plan JSON produced）',
        id,
        explanation: truncate(result.text, 2000),
      });
    }

    const validated = validatePlan(rawPlan);
    if (!validated.ok) {
      return sendJson(res, 422, { error: validated.error, id, explanation: truncate(result.text, 2000) });
    }

    const explanation = result.text.trim() ? truncate(result.text.trim(), 4000) : summarizePlan(validated.plan);
    return sendJson(res, 200, { plan: validated.plan, explanation, id });
  } catch (error) {
    return sendJson(res, 502, { error: errorMessage(error), id });
  }
}

// ---------------------------------------------------------------- 静态文件

async function serveStatic(req, res, pathname) {
  let relative;
  if (pathname === '/') relative = 'index.html';
  else {
    relative = pathname.replace(/^\/+/, '');
    if (pathname.endsWith('/')) relative = path.join(relative, 'index.html');
  }
  const file = safeJoin(ROOT, relative);
  if (!file) return sendJson(res, 403, { error: '禁止访问（forbidden）' });
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat || !stat.isFile()) return sendText(res, 404, 'Not found', 'text/plain; charset=utf-8');

  // 与 /files 一致：不允许用符号链接把项目根之外的文件暴露到静态服务里。
  try {
    const realRoot = await fsp.realpath(ROOT);
    const realFile = await fsp.realpath(file);
    if (realFile !== realRoot && !realFile.startsWith(realRoot + path.sep)) {
      return sendJson(res, 403, { error: '禁止访问（forbidden）' });
    }
  } catch {
    return sendText(res, 404, 'Not found', 'text/plain; charset=utf-8');
  }

  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    'Content-Type': contentType(file),
    'Content-Length': stat.size,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

async function serveFiles(req, res, relative) {
  if (!relative || relative.endsWith('/')) return sendJson(res, 404, { error: '文件不存在（not found）' });
  const file = safeJoin(PROJECTS, relative);
  if (!file) return sendJson(res, 403, { error: '禁止访问（forbidden）' });
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat || !stat.isFile()) return sendJson(res, 404, { error: '文件不存在（not found）' });

  // 防止 projects/ 里的符号链接指向项目根以外。
  try {
    const realBase = await fsp.realpath(PROJECTS);
    const realFile = await fsp.realpath(file);
    if (realFile !== realBase && !realFile.startsWith(realBase + path.sep)) {
      return sendJson(res, 403, { error: '禁止访问（forbidden）' });
    }
  } catch {
    return sendJson(res, 404, { error: '文件不存在（not found）' });
  }

  res.writeHead(200, {
    'Content-Type': contentType(file),
    'Content-Length': stat.size,
    'Cache-Control': 'public, max-age=300',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

// ---------------------------------------------------------------- 启动

const server = createServer((req, res) => {
  // 客户端中途断开时，写响应可能触发 error；不处理会变成进程级异常。
  res.on('error', () => {});
  route(req, res).catch((error) => {
    if (res.headersSent) {
      if (!res.writableEnded) res.end();
      return;
    }
    sendJson(res, 500, { error: errorMessage(error) });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`interior-design-studio → http://${HOST}:${PORT}`);
  console.log(`project root: ${ROOT}`);
});

server.on('error', (error) => {
  console.error(`服务启动失败（server error）：${errorMessage(error)}`);
  process.exitCode = 1;
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`收到 ${signal}，正在关闭…`);
  server.close();
  await pool.disposeAll().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

// 网络/子进程的意外错误不应让页面整体挂掉；记录后继续服务。
process.on('uncaughtException', (error) => {
  console.error('uncaughtException:', error);
});
process.on('unhandledRejection', (error) => {
  console.error('unhandledRejection:', error);
});

export { server };
