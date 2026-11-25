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
import { loadRenderImageProvider } from './lib/codex/render-image.mjs';
import { parsePatch, validatePlan, validateImportedFurniture, summarizePlan, extractJson } from './lib/codex/plan.mjs';
import { createImportJobs, importJobError, isImportJobPath } from './lib/import-jobs.mjs';
import { renderPlanPng } from './lib/plan-render.mjs';
import { buildReviewMessage, checkPlan, parseReviewReply, reviewDelta } from './lib/plan-review.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROJECTS = path.join(ROOT, 'projects');
const WORKDIR = path.join(ROOT, 'workdir');
const IMPORT_JOBS_DIR = path.resolve(process.env.STUDIO_IMPORT_JOBS_DIR ||
  path.join(os.homedir(), '.interior-design-studio', 'import-jobs'));
const PROMPTS = path.join(ROOT, 'prompts');
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 4173;
const PUBLIC_OWNER = 'remote-owner';
const PUBLIC_CHAT_ROOT = path.join(WORKDIR, 'public-chat');
const PUBLIC_RENDER_ROOT = path.join(PROJECTS, 'public-ai', PUBLIC_OWNER);
const PUBLIC_RENDER_URL = /^\/files\/public-ai\/remote-owner\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png)$/;
const PUBLIC_BRIDGE_TOKEN = loadPublicBridgeToken(process.env.STUDIO_PUBLIC_BRIDGE_TOKEN_FILE);
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const MAX_PUBLIC_RENDER_BYTES = 24 * 1024 * 1024;
const renderImage = loadRenderImageProvider(process.env.STUDIO_RENDER_IMAGE_CONFIG_FILE);

const MAX_BODY = 40 * 1024 * 1024;
const CHAT_TIMEOUT_MS = 10 * 60_000;
const RENDER_TIMEOUT_MS = 8 * 60_000;
const IMPORT_TIMEOUT_MS = 30 * 60_000;
const REVIEW_TIMEOUT_MS = 10 * 60_000;
const MAX_REVIEWS = 2;
/** 复核默认开启；STUDIO_PLAN_REVIEW=off 时完全跳过（job.review 保持 null）。 */
const PLAN_REVIEW_ENABLED = String(process.env.STUDIO_PLAN_REVIEW || '').trim().toLowerCase() !== 'off';
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

function loadPublicBridgeToken(file) {
  if (!file || !path.isAbsolute(file)) return null;
  try {
    const token = fs.readFileSync(file, 'utf8').trim();
    return token ? Buffer.from(token) : null;
  } catch {
    return null;
  }
}

function validPublicBridge(req) {
  if (req.headers['x-studio-public-owner'] !== PUBLIC_OWNER || !PUBLIC_BRIDGE_TOKEN) return false;
  const provided = req.headers['x-studio-public-bridge'];
  if (typeof provided !== 'string') return false;
  const token = Buffer.from(provided);
  return token.length === PUBLIC_BRIDGE_TOKEN.length && crypto.timingSafeEqual(token, PUBLIC_BRIDGE_TOKEN);
}

function imageExt(mime) {
  const value = String(mime || '').toLowerCase();
  if (value.includes('jpeg') || value.includes('jpg')) return 'jpg';
  if (value.includes('webp')) return 'webp';
  if (value.includes('gif')) return 'gif';
  return 'png';
}

function isImportImage(buffer) {
  return buffer.subarray(0, 8).equals(PNG_SIGNATURE)
    || buffer.subarray(0, 3).toString('hex') === 'ffd8ff'
    || (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP');
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
const reviewQueue = createLimiter(MAX_REVIEWS);
/** POST /api/jobs/<id>/review 触发的重跑控制器；关闭服务时一并中止。 */
const rerunReviews = new Set();
/** 正在重跑复核的任务 id，阻止并发重复提交。 */
const reviewing = new Set();
const importJobs = createImportJobs({
  directory: IMPORT_JOBS_DIR,
  execute: async (body, { id, owner, workDirectory, signal }) => {
    // 识别阶段不清理工作目录：复核需要原图和 plan.json。
    const result = await analyzePlanImport(body, { id, importDir: workDirectory, signal, cleanup: false });
    if (result.status >= 400) {
      // 公网任务失败后不保留用户上传的文件。
      if (owner === 'remote') await fsp.rm(workDirectory, { recursive: true, force: true }).catch(() => {});
      return result;
    }
    if (!PLAN_REVIEW_ENABLED) {
      // 复核关闭时不需要保留工作目录，恢复识别完成后立即清理的旧行为。
      await fsp.rm(workDirectory, { recursive: true, force: true }).catch(() => {});
      return result;
    }
    // 重新复核时仍要带上用户备注；与识别产物一起留在工作目录。
    if (typeof body?.note === 'string' && body.note) {
      await fsp.writeFile(path.join(workDirectory, 'review-note.json'),
        JSON.stringify({ note: body.note }), { mode: 0o600 }).catch(() => {});
    }
    return {
      ...result,
      after: ({ signal: reviewSignal, updateReview, saveReview }) =>
        runPlanReview({
          workDirectory,
          body,
          result: result.body,
          signal: reviewSignal,
          updateReview,
          saveReview,
        }).finally(() => (owner === 'remote'
          ? fsp.rm(workDirectory, { recursive: true, force: true }).catch(() => {})
          : undefined)),
    };
  },
});

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
  const publicRequest = req.headers['x-studio-public-owner'] !== undefined
    || req.headers['x-studio-public-bridge'] !== undefined;
  if (publicRequest && !validPublicBridge(req)) {
    return sendJson(res, 403, { error: '禁止访问（forbidden）' });
  }
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
    return handleHealth(res, url, publicRequest);
  }
  if (pathname === '/api/chat') {
    if (!api(['POST'])) return;
    return handleChat(req, res, publicRequest);
  }
  if (pathname === '/api/render') {
    if (!api(['POST'])) return;
    return handleRender(req, res, publicRequest);
  }
  if (pathname === '/api/plan/import' || pathname === '/api/plan/import/') {
    if (!api(['POST'])) return;
    return handlePlanImport(req, res, publicRequest);
  }
  const reviewPath = /^\/api\/jobs\/(.+)\/review$/.exec(pathname);
  if (reviewPath && isImportJobPath(pathname)) {
    // 复核子资源要先于通用 job 路由处理（后者只接受 GET / DELETE）。
    if (!api(['GET', 'POST'])) return;
    return handlePlanReview(req, res, reviewPath[1], publicRequest ? 'remote' : 'local');
  }
  if (isImportJobPath(pathname)) {
    const collection = pathname === '/api/jobs/plan-import';
    if (!api(collection ? ['GET', 'POST'] : ['GET', 'DELETE'])) return;
    return handleImportJob(req, res, pathname.slice('/api/jobs/'.length), url, publicRequest ? 'remote' : 'local');
  }
  if (publicRequest) {
    const render = PUBLIC_RENDER_URL.exec(pathname);
    if (!render || render[0] !== pathname) return sendText(res, 404, 'Not found');
    if (!api(['GET', 'HEAD'])) return;
    return servePublicRender(req, res, render[1]);
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

async function handleHealth(res, url, publicRequest) {
  const probe = await getProbe({ force: !publicRequest && url.searchParams.has('force') });
  if (publicRequest) {
    return sendJson(res, 200, { ok: true, codex: { found: probe.found } });
  }
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
      parts.push(`当前上下文（JSON，含 plan / state / selection / view）：\n\`\`\`json\n${json}\n\`\`\``);
    }
  }
  parts.push('请严格按系统提示词输出一个 JSON 对象（reply / ops / focus），不要输出其他内容。');
  return parts.join('\n\n');
}

async function handleChat(req, res, publicRequest) {
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
    if (publicRequest) await fsp.mkdir(PUBLIC_CHAT_ROOT, { recursive: true, mode: 0o700 });

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
        publicRequest ? `public-chat:${sessionId}` : `chat:${sessionId}`,
        () =>
          CodexSession.start({
            install: probe.install,
            cwd: publicRequest ? PUBLIC_CHAT_ROOT : ROOT,
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

const renderImageTool = {
  type: 'function',
  name: 'image_gen',
  description: 'Generate the final photorealistic interior render from the reference screenshot already attached to this turn. The image is saved to the requested PNG target by the tool.',
  inputSchema: {
    type: 'object',
    properties: { prompt: { type: 'string', description: 'Describe the photorealistic lighting, materials, and furnishing details to keep from the reference.' } },
    required: ['prompt'],
    additionalProperties: false,
  },
};

function createRenderTool(shot, body, targetFile, sse) {
  let generation;
  let generated = false;
  let error;
  return {
    get generated() { return generated; },
    get error() { return error; },
    dynamicTools: [renderImageTool],
    async onToolCall({ arguments: args, signal }) {
      const prompt = typeof args?.prompt === 'string' ? args.prompt.trim() : '';
      if (!prompt) return { success: false, contentItems: [{ type: 'inputText', text: 'Please provide a render prompt.' }] };
      generation ??= (async () => {
        sse.send({ type: 'status', text: '正在根据参考视角生成图像…' });
        try {
          const constraints = [
            'Render the attached interior-design screenshot as a photorealistic architectural visualization.',
            'Keep the camera angle, crop, walls, door and window openings, and furniture layout from the screenshot.',
            `Design style: ${truncate(String(body.style || '现代简约'), 80)}.`,
            typeof body.note === 'string' ? truncate(body.note, 1000) : '',
            truncate(prompt, 6000),
          ].filter(Boolean).join('\n');
          const image = await renderImage({ image: shot, mime: body.mime, prompt: constraints, signal });
          signal.throwIfAborted();
          await fsp.writeFile(targetFile, image, { flag: 'wx', mode: 0o600 });
          generated = true;
          return { success: true, contentItems: [{ type: 'inputText', text: 'The requested PNG has been generated and saved. Return a short confirmation.' }] };
        } catch (cause) {
          error = errorMessage(cause);
          return { success: false, contentItems: [{ type: 'inputText', text: 'The image provider did not return a finished PNG.' }] };
        }
      })();
      return generation;
    },
  };
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

/** Public renders must originate from this job and contain an actual PNG. */
async function openPublicPng(directory, filename, expectedDirectory) {
  let handle;
  try {
    if (await fsp.realpath(directory) !== expectedDirectory) return null;
    handle = await fsp.open(path.join(directory, filename), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= PNG_SIGNATURE.length || stat.size > MAX_PUBLIC_RENDER_BYTES || stat.nlink !== 1) {
      await handle.close();
      return null;
    }
    const signature = Buffer.alloc(PNG_SIGNATURE.length);
    await handle.read(signature, 0, signature.length, 0);
    if (!signature.equals(PNG_SIGNATURE)) {
      await handle.close();
      return null;
    }
    return { handle, size: stat.size };
  } catch {
    await handle?.close().catch(() => {});
    return null;
  }
}

async function expectedPublicRenderRoot() {
  return path.join(await fsp.realpath(PROJECTS), 'public-ai', PUBLIC_OWNER);
}

async function savePublicRender(directory, filename, expectedDirectory) {
  const image = await openPublicPng(directory, filename, expectedDirectory);
  if (!image) return null;
  try {
    await fsp.mkdir(PUBLIC_RENDER_ROOT, { recursive: true, mode: 0o700 });
    if (await fsp.realpath(PUBLIC_RENDER_ROOT) !== await expectedPublicRenderRoot()) {
      throw new Error('公网效果图目录不可用（public render directory unavailable）');
    }
    const content = await image.handle.readFile();
    await fsp.writeFile(path.join(PUBLIC_RENDER_ROOT, filename), content, { flag: 'wx', mode: 0o600 });
    return `/files/public-ai/${PUBLIC_OWNER}/${filename}`;
  } finally {
    await image.handle.close();
  }
}

async function handleRender(req, res, publicRequest) {
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
    tmpDir = path.join(os.tmpdir(), 'interior-design-studio', `render-${id}`);
    await fsp.mkdir(tmpDir, { recursive: true, mode: 0o700 });
    const rendersDir = path.join(publicRequest ? tmpDir : PROJECTS, 'renders');
    await fsp.mkdir(rendersDir, { recursive: true });
    const beforeNames = publicRequest ? null : new Set(await fsp.readdir(rendersDir).catch(() => []));
    const expectedDirectory = publicRequest ? path.join(await fsp.realpath(tmpDir), 'renders') : null;
    const filename = `${id}.png`;
    const targetFile = path.join(rendersDir, filename);
    const shotPath = path.join(tmpDir, `shot.${imageExt(body.mime)}`);
    await fsp.writeFile(shotPath, shot);

    sse.send({ type: 'status', text: '正在生成效果图，可能需要 1–3 分钟…' });
    const tool = renderImage ? createRenderTool(shot, body, targetFile, sse) : null;
    let developerInstructions = await readPrompt('render.md');
    if (tool) {
      developerInstructions += '\n使用本会话提供的 image_gen 函数并传入 prompt。工具会使用已附参考图并将 PNG 写入目标位置。无需自行复制文件。';
    }
    const input = [
      { type: 'text', text: buildRenderMessage(body, targetFile), text_elements: [] },
      { type: 'localImage', path: shotPath },
    ];

    const result = await limitTurns(async () => {
      // 排队期间客户端可能已经断开：不再启动新的 codex 会话。
      if (cancelled || sse.closed) throw new Error('客户端已断开（client disconnected）');
      const session = await CodexSession.start({
        install: probe.install,
        cwd: publicRequest ? tmpDir : ROOT,
        sandbox: 'workspace-write',
        approvalPolicy: 'never',
        developerInstructions,
        dynamicTools: tool?.dynamicTools,
        onToolCall: tool?.onToolCall,
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
    if (tool && !tool.generated) {
      sse.send({ type: 'error', message: tool.error || 'Codex 未调用生图工具，请重试。' });
      sse.send({ type: 'done' });
      return;
    }

    let url;
    if (publicRequest) {
      url = await savePublicRender(rendersDir, filename, expectedDirectory);
    } else {
      const blob = `${result.text}\n${JSON.stringify(result.items)}`;
      const file = await findRenderFile(rendersDir, beforeNames, id, blob);
      if (file) url = `/files/renders/${encodeURIComponent(path.basename(file))}`;
    }
    if (!url) {
      sse.send({ type: 'error', message: 'codex 没有生成图片（no image produced）。请重试，或在 note 里补充更具体的要求。' });
      sse.send({ type: 'done' });
      return;
    }

    const style = typeof body.style === 'string' && body.style ? body.style : '现代简约';
    sse.send({
      type: 'image',
      url,
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

function drawingImportRequest(body) {
  const files = Array.isArray(body?.files)
    ? body.files.filter((file) => file && typeof file.data === 'string' && file.data.length > 0).slice(0, 20)
    : [];
  if (!files.length) throw importJobError(400, '缺少 files（至少上传一个文件）');
  const note = typeof body.note === 'string' ? body.note.trim() : '';
  return { files, note };
}

async function handleImportJob(req, res, key, url, owner) {
  try {
    if (key === 'plan-import' && req.method === 'GET') {
      return sendJson(res, 200, { jobs: await importJobs.list(owner) });
    }
    if (req.method === 'POST') {
      const job = await importJobs.submit(owner, async () => {
        const input = await readJson(req);
        const body = drawingImportRequest(input);
        const file = safeFileName(body.files[0].name, 1);
        const name = (typeof input.projectName === 'string' ? input.projectName : '')
          .replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100)
          || path.basename(file, path.extname(file));
        return { body, name };
      });
      return sendJson(res, 202, job);
    }
    if (req.method === 'DELETE') {
      const found = await importJobs.cancel(owner, key);
      return sendJson(res, found ? 200 : 404, found ? { ok: true } : { error: '图纸任务不存在或已过期。' });
    }
    const value = url.searchParams.get('cursor') ?? '0';
    const cursor = /^\d+$/.test(value) ? Number(value) : NaN;
    const job = await importJobs.get(owner, key, cursor);
    return sendJson(res, job ? 200 : 404, job || { error: '图纸任务不存在或已过期。' });
  } catch (error) {
    if (error.status) return sendJson(res, error.status, { error: errorMessage(error) });
    console.error('图纸任务接口异常（drawing job API）:', error.message);
    return sendJson(res, 503, { error: '图纸任务暂不可用，请稍后重试。' });
  }
}

async function handlePlanImport(req, res, publicRequest) {
  const controller = new AbortController();
  res.once('close', () => controller.abort());
  let body;
  try {
    body = drawingImportRequest(await readJson(req));
  } catch (error) {
    return sendJson(res, error.status || 400, { error: errorMessage(error) });
  }
  const id = crypto.randomUUID();
  const result = await analyzePlanImport(body, {
    id, importDir: path.join(WORKDIR, `import-${id}`), signal: controller.signal, cleanup: publicRequest,
  });
  if (!controller.signal.aborted) sendJson(res, result.status, result.body);
}

async function analyzePlanImport({ files, note }, { id, importDir, signal, cleanup }) {
  const reply = (status, fields) => ({ status, body: { ...fields, id } });
  let activeSession = null;
  let stoppingSession = null;
  const interrupt = () => {
    const session = activeSession;
    if (session) stoppingSession = session.interrupt().finally(() => session.dispose()).catch(() => {});
  };
  signal.addEventListener('abort', interrupt, { once: true });
  try {
    signal.throwIfAborted();
    const probe = await getProbe();
    signal.throwIfAborted();
    if (!probe.found) return reply(503, { error: unusableMessage(probe) });
    await fsp.mkdir(importDir, { recursive: true, mode: 0o700 });
    const written = [];
    const images = [];
    const used = new Set(['plan.json']);
    for (let i = 0; i < files.length; i++) {
      signal.throwIfAborted();
      const buffer = decodeBase64(files[i].data);
      if (!buffer) continue;
      const originalName = safeFileName(files[i].name, i + 1);
      const ext = path.extname(originalName);
      let name = originalName;
      let suffix = i + 1;
      while (used.has(name.toLowerCase())) {
        name = `${path.basename(originalName, ext)}-${suffix++}${ext}`;
      }
      used.add(name.toLowerCase());
      const file = path.join(importDir, name);
      await fsp.writeFile(file, buffer, { mode: 0o600 });
      written.push(name);
      if (isImportImage(buffer)) images.push({ name, file });
    }
    if (!written.length) return reply(400, { error: '上传的文件无法解码（cannot decode files）' });

    const imageOnly = images.length === written.length;
    const message = [
      '请解析本工作目录中的户型文件，输出 Plan JSON。',
      `文件：${written.join('、')}`,
      images.length ? `随本消息附上的图片顺序：${images.map(({ name }) => name).join('、')}` : '',
      note ? `用户备注：${note}` : '',
      imageOnly
        ? '所有原图均已随消息附上。识别户型、家具和构件后直接回复完整 JSON 对象，在顶层 explanation 字段附上中文摘要。'
        : '按系统提示词识别户型、家具和构件，把完整结果写入当前工作目录的 plan.json，然后用中文简述识别结果。',
    ]
      .filter(Boolean)
      .join('\n\n');

    const developerInstructions = await readPrompt('plan-import.md');
    const result = await limitTurns(async () => {
      signal.throwIfAborted();
      const session = await CodexSession.start({
        install: probe.install,
        cwd: importDir,
        sandbox: 'workspace-write',
        approvalPolicy: 'never',
        developerInstructions,
      });
      activeSession = session;
      try {
        signal.throwIfAborted();
        return await session.runTurn({
          input: [
            { type: 'text', text: message, text_elements: [] },
            ...images.map(({ file }) => ({ type: 'localImage', path: file })),
          ],
          timeoutMs: IMPORT_TIMEOUT_MS,
        });
      } finally {
        activeSession = null;
        await (stoppingSession || session.dispose().catch(() => {}));
      }
    });

    signal.throwIfAborted();
    if (result.outcome !== 'completed') {
      return reply(502, { error: result.error || 'codex 回合未正常完成（turn incomplete）' });
    }

    let rawPlan = null;
    let summary = '';
    try {
      rawPlan = JSON.parse(await fsp.readFile(path.join(importDir, 'plan.json'), 'utf8'));
      summary = result.text.trim();
    } catch {
      rawPlan = extractJson(result.text);
    }
    if (!rawPlan) {
      return reply(422, {
        error: 'codex 没有产出可解析的 Plan（no Plan JSON produced）',
        explanation: truncate(result.text, 2000),
      });
    }

    const validated = validatePlan(rawPlan);
    if (!validated.ok) {
      return reply(422, { error: validated.error, explanation: truncate(result.text, 2000) });
    }

    if (typeof rawPlan.explanation === 'string' && rawPlan.explanation.trim()) summary = rawPlan.explanation.trim();
    const explanation = summary ? truncate(summary, 4000) : summarizePlan(validated.plan);
    const furniture = validateImportedFurniture(rawPlan.furniture, validated.plan.bounds);
    return reply(200, { plan: validated.plan, furniture, explanation });
  } catch (error) {
    if (error?.code === 'timeout' && error.message.startsWith('codex 响应超时')) {
      return reply(504, { error: '图纸识别超过 30 分钟，请尝试拆分图纸或重新提交。' });
    }
    return reply(502, { error: errorMessage(error) });
  } finally {
    signal.removeEventListener('abort', interrupt);
    if (cleanup) await fsp.rm(importDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------- 图纸复核

/** 只读文件头，用来判断工作目录里的文件是不是图片。 */
async function readHeader(file, length = 16) {
  const handle = await fsp.open(file, 'r').catch(() => null);
  if (!handle) return null;
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close().catch(() => {});
  }
}

/** 工作目录里除识别产物外的文件；图片重新作为 localImage 附给复核回合。 */
async function collectReviewInputs(workDirectory) {
  const entries = await fsp.readdir(workDirectory, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (name === 'plan.json' || name === 'review-plan.png' || name === 'review-note.json') continue;
    files.push({ name, file: path.join(workDirectory, name) });
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  const images = [];
  for (const item of files) {
    const header = await readHeader(item.file);
    if (header && isImportImage(header)) images.push(item.file);
  }
  return { names: files.map(item => item.name), images };
}

/**
 * 复核一次识别结果。复核失败一律静默：状态标记为 unavailable，不写 review.json。
 * 由 importJobs 的 after 钩子或 POST 重跑调用，不占用识别并发槽位。
 */
async function runPlanReview({ workDirectory, body, result, signal, updateReview, saveReview }) {
  const plan = result?.plan ?? null;
  const furniture = Array.isArray(result?.furniture) ? result.furniture : [];
  // 失败时清掉上一次的复核正文，只保留契约要求的 state / count / updatedAt。
  const unavailable = () => updateReview({
    state: 'unavailable', count: 0, updatedAt: Date.now(),
    summary: undefined, issues: undefined, fixed: undefined, delta: undefined,
  }).catch(() => {});

  try {
    await updateReview({
      state: 'running', count: 0, updatedAt: Date.now(),
      summary: undefined, issues: undefined, fixed: undefined, delta: undefined,
    });
    if (signal.aborted) return await unavailable();

    const probe = await getProbe();
    if (!probe.found) return await unavailable();

    const rendered = path.join(workDirectory, 'review-plan.png');
    await fsp.writeFile(rendered, renderPlanPng(plan), { mode: 0o600 });
    if (signal.aborted) return await unavailable();

    const inputs = await collectReviewInputs(workDirectory);
    const check = checkPlan(plan, furniture);
    const message = buildReviewMessage({
      plan,
      furniture,
      explanation: typeof result?.explanation === 'string' ? result.explanation : '',
      note: typeof body?.note === 'string' ? body.note : '',
      check,
      fileNames: ['review-plan.png', ...inputs.names],
    });
    const developerInstructions = await readPrompt('plan-verify.md');

    const turn = await reviewQueue(async () => {
      signal.throwIfAborted();
      const session = await CodexSession.start({
        install: probe.install,
        cwd: workDirectory,
        sandbox: 'read-only',
        approvalPolicy: 'never',
        developerInstructions,
      });
      let stopping = null;
      const interrupt = () => {
        stopping = session.interrupt().finally(() => session.dispose()).catch(() => {});
      };
      signal.addEventListener('abort', interrupt, { once: true });
      try {
        signal.throwIfAborted();
        return await session.runTurn({
          input: [
            { type: 'text', text: message, text_elements: [] },
            { type: 'localImage', path: rendered },
            ...inputs.images.map(file => ({ type: 'localImage', path: file })),
          ],
          timeoutMs: REVIEW_TIMEOUT_MS,
        });
      } finally {
        signal.removeEventListener('abort', interrupt);
        await (stopping || session.dispose().catch(() => {}));
      }
    });

    if (signal.aborted) return await unavailable();
    if (!turn || turn.outcome !== 'completed') return await unavailable();

    const reviewed = parseReviewReply(turn.text, { plan, furniture });
    const afterPlan = reviewed.fixed?.plan ?? plan;
    const afterFurniture = reviewed.fixed?.furniture ?? furniture;
    const review = {
      state: reviewed.verdict,
      summary: reviewed.summary,
      issues: reviewed.issues,
      fixed: reviewed.fixed,
      delta: reviewDelta(plan, furniture, afterPlan, afterFurniture),
      updatedAt: Date.now(),
    };
    // 先落 review.json 再落 meta：写盘失败时不能留下「列表说 differ、详情 404」的矛盾状态。
    // 严格比较 true：saveReview 的契约是成功返回 true，undefined 不能被当成成功。
    const saved = await saveReview(review);
    if (saved !== true) return await unavailable();
    await updateReview({ state: reviewed.verdict, count: reviewed.issues.length, updatedAt: review.updatedAt });
  } catch (error) {
    if (!(error?.name === 'ReviewParseError' || error?.code === 'timeout' ||
          error?.name === 'AbortError' || signal.aborted)) {
      console.error('图纸复核异常（plan review）:', errorMessage(error));
    }
    await unavailable();
  }
}

async function handlePlanReview(req, res, id, owner) {
  try {
    if (req.method === 'GET') {
      const review = await importJobs.getReview(owner, id);
      if (!review) return sendJson(res, 404, { error: '复核结果不存在或暂不可用。' });
      // 重新复核需要工作目录里的原图；公网任务复核结束后上传文件已清理，前端据此隐藏按钮。
      const rerun = Boolean(await importJobs.workDirectory(owner, id));
      return sendJson(res, 200, { ...review, rerun });
    }

    if (!PLAN_REVIEW_ENABLED) return sendJson(res, 404, { error: '复核功能未启用。' });
    if (reviewing.has(id)) return sendJson(res, 409, { error: '复核正在进行，请稍候。' });
    reviewing.add(id);
    let started = false;
    try {
      const job = await importJobs.get(owner, id, 0);
      if (!job) return sendJson(res, 409, { error: '图纸任务不存在或已过期。' });
      if (job.phase !== 'done') return sendJson(res, 409, { error: '图纸尚未识别完成，暂时无法复核。' });
      if (job.review?.state === 'pending' || job.review?.state === 'running') {
        return sendJson(res, 409, { error: '复核正在进行，请稍候。' });
      }
      const workDirectory = await importJobs.workDirectory(owner, id);
      // 工作目录清理后无法再复核：这是永久状态，用 404 而不是 409（后者会让客户端以为稍后能重试）。
      if (!workDirectory) return sendJson(res, 404, { error: '复核工作目录已清理，无法重新复核。' });
      const probe = await getProbe();
      if (!probe.found) return sendJson(res, 503, { error: unusableMessage(probe) });

      let result = null;
      try {
        result = JSON.parse(job.chunks?.[0] || '');
      } catch {
        result = null;
      }
      if (!result?.plan) return sendJson(res, 409, { error: '识别结果不可用，无法重新复核。' });

      const note = await fsp.readFile(path.join(workDirectory, 'review-note.json'), 'utf8')
        .then(text => JSON.parse(text))
        .then(value => (typeof value?.note === 'string' ? value.note : ''))
        .catch(() => '');

      await importJobs.setReview(owner, id, {
        state: 'pending', count: 0, updatedAt: Date.now(),
        summary: undefined, issues: undefined, fixed: undefined, delta: undefined,
      });
      const controller = new AbortController();
      rerunReviews.add(controller);
      started = true;
      void runPlanReview({
        workDirectory,
        body: { note },
        result,
        signal: controller.signal,
        updateReview: patch => importJobs.setReview(owner, id, patch),
        saveReview: review => importJobs.saveReview(owner, id, review),
      }).finally(() => {
        rerunReviews.delete(controller);
        reviewing.delete(id);
      });
      return sendJson(res, 202, { ok: true });
    } finally {
      if (!started) reviewing.delete(id);
    }
  } catch (error) {
    if (error.status) return sendJson(res, error.status, { error: errorMessage(error) });
    console.error('图纸复核接口异常（plan review API）:', error.message);
    return sendJson(res, 503, { error: '复核暂不可用，请稍后重试。' });
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
    const importDir = await fsp.realpath(IMPORT_JOBS_DIR).catch(() => IMPORT_JOBS_DIR);
    if ((realFile !== realRoot && !realFile.startsWith(realRoot + path.sep))
        || realFile === importDir || realFile.startsWith(importDir + path.sep)) {
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

async function servePublicRender(req, res, filename) {
  const expectedDirectory = await expectedPublicRenderRoot().catch(() => null);
  const image = await openPublicPng(PUBLIC_RENDER_ROOT, filename, expectedDirectory);
  if (!image) return sendText(res, 404, 'Not found');
  if (res.destroyed) {
    await image.handle.close();
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'image/png',
    'Content-Length': image.size,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') {
    await image.handle.close();
    return res.end();
  }
  const stream = image.handle.createReadStream({ start: 0 });
  res.on('close', () => stream.destroy());
  stream.on('error', () => res.destroy()).pipe(res);
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
  importJobs.close();
  for (const controller of rerunReviews) controller.abort();
  rerunReviews.clear();
  reviewing.clear();
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
