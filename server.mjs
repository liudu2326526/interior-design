#!/usr/bin/env node
/**
 * 本地桥接服务：静态页面 + /api/chat、/api/render、/api/plan/import + /files/*。
 * 只监听 127.0.0.1；无第三方依赖，Node 原生 http。详细契约见 docs/contract.md §5。
 */
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';
import { locateCodex, readLogin, MIN_CODEX_VERSION } from './lib/codex/binary.mjs';
import { CodexSession, SessionPool, probeModels } from './lib/codex/session.mjs';
import { loadRenderImageProvider } from './lib/codex/render-image.mjs';
import { parsePatch, validatePlan, validateImportedFurniture, summarizePlan, extractJson } from './lib/codex/plan.mjs';
import { createImportJobs, importJobError, isImportJobPath } from './lib/import-jobs.mjs';
import { reviewCeiling } from './lib/ceiling-recognition.mjs';
import { buildDrawingCeiling, reviewDrawingCeiling, validateDrawingCeiling } from './lib/drawing-ceiling.mjs';
import { archiveUploads } from './lib/upload-archive.mjs';
import { renderPlanPng } from './lib/plan-render.mjs';
import { buildReviewMessage, checkPlan, parseReviewReply, reviewDelta } from './lib/plan-review.mjs';
import { buildCadDxf } from './lib/cad-dxf.mjs';
import { convertDxfToDwg } from './lib/cad-dwg.mjs';
import { readCadCurveEvidence } from './lib/cad-import.mjs';
import { readImageCurveEvidence } from './lib/raster-import-evidence.mjs';

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
const MAX_CAD_BODY = 8 * 1024 * 1024;
let activeCadExports = 0;
const CHAT_TIMEOUT_MS = 10 * 60_000;
const RENDER_TIMEOUT_MS = 8 * 60_000;
const IMPORT_TIMEOUT_MS = 30 * 60_000;
const REVIEW_TIMEOUT_MS = 60 * 60_000;
const MAX_REVIEWS = 2;
/** 复核默认开启；STUDIO_PLAN_REVIEW=off 时完全跳过（job.review 保持 null）。 */
const PLAN_REVIEW_ENABLED = String(process.env.STUDIO_PLAN_REVIEW || '').trim().toLowerCase() !== 'off';
const IMPORT_ARTIFACTS = ['plan.json', 'review-plan.png', 'review-note.json'];
const DRAWING_ARCHIVE_MANIFEST = '.upload.json';
const CEILING_SOURCE_DIRECTORY = 'ceiling-drawings';
const DRAWING_PROGRESS_INSTRUCTIONS = '如果能发送独立的中途进度消息，请简短说明已完成的图纸核对。不要回显原始资料、工具输出或推理过程。最终答复仍遵守本任务的输出格式。';
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

function drawingImageExtension(buffer) {
  if (buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return '.png';
  if (buffer.subarray(0, 3).toString('hex') === 'ffd8ff') return '.jpg';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  return '';
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
  archiveInput: archiveDrawingUpload,
  archiveWork: archiveDrawingWork,
  execute: async (body, { id, owner, workDirectory, signal, onProgress }) => {
    // 识别阶段不清理工作目录：复核需要原图和 plan.json。
    const result = await analyzePlanImport(body, { id, importDir: workDirectory, signal, cleanup: false, onProgress });
    if (result.status >= 400) {
      // 原件已归档，失败后可释放工作副本。
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
    const { note } = body;
    return {
      ...result,
      after: ({ signal: reviewSignal, updateReview, saveReview, onProgress: onReviewProgress }) =>
        runPlanReview({
          workDirectory,
          body: { note },
          result: result.body,
          preparedInputs: result.inputs,
          signal: reviewSignal,
          updateReview,
          saveReview,
          onProgress: onReviewProgress,
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
  if (pathname === '/api/ceiling-import') {
    if (!api(['POST'])) return;
    return handleCeilingImport(req, res, publicRequest);
  }
  if (pathname === '/api/export/dwg') {
    if (!api(['POST'])) return;
    return handleDwgExport(req, res);
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

// ---------------------------------------------------------------- CAD 导出

async function handleDwgExport(req, res) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
    return sendJson(res, 415, { error: 'DWG 导出需要 JSON 方案。' });
  }
  if (activeCadExports >= 2) {
    return sendJson(res, 503, { error: 'DWG 导出正在处理其他方案，请稍后重试。' });
  }
  activeCadExports++;
  const controller = new AbortController();
  const abort = () => controller.abort();
  res.once('close', abort);
  try {
    let body;
    try {
      body = await readJson(req, MAX_CAD_BODY);
    } catch (error) {
      return sendJson(res, error.status ?? 400, { error: errorMessage(error) });
    }
    if (controller.signal.aborted) return;
    const result = validatePlan(body?.plan);
    if (!result.ok) return sendJson(res, 422, { error: result.error });
    const plan = result.plan;
    if (['walls', 'wins', 'doors', 'slides', 'rooms'].some(key => plan[key].length !== (body.plan[key]?.length ?? 0))) {
      return sendJson(res, 422, { error: '部分户型几何无效，请修正方案后再导出 DWG。' });
    }
    let dxf;
    try {
      dxf = buildCadDxf({ plan, state: body.state, dimensions: body.dimensions });
    } catch (error) {
      return sendJson(res, 422, { error: errorMessage(error) });
    }
    const dwg = await convertDxfToDwg(dxf, { signal: controller.signal });
    if (controller.signal.aborted) return;
    const name = safeFileName(plan.name || 'floor-plan', 1).toWellFormed();
    const encoded = encodeURIComponent(name + '.dwg').replace(/['()*]/g, char => '%' + char.charCodeAt(0).toString(16));
    res.writeHead(200, {
      'Content-Type': 'image/vnd.dwg',
      'Content-Disposition': `attachment; filename="floor-plan.dwg"; filename*=UTF-8''${encoded}`,
      'Content-Length': dwg.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(dwg);
  } catch (error) {
    if (!controller.signal.aborted) {
      sendJson(res, error.status ?? 502, { error: errorMessage(error) });
    }
  } finally {
    res.removeListener('close', abort);
    activeCadExports--;
  }
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

const exec = promisify(execFile);
const CHAT_FILE_COUNT = 6;
const CHAT_FILE_MAX = 8 * 1024 * 1024;
const CHAT_FILES_MAX = 20 * 1024 * 1024;
const CHAT_TEXT_MAX = 128 * 1024;
const CHAT_TEXT_EXCERPT = 6000;
const CHAT_TEXT_EXTENSIONS = new Set(['.txt', '.md', '.json', '.csv']);
const CHAT_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const MAC_PDF_TEXT = `
ObjC.import('Foundation');
ObjC.import('PDFKit');
function run(args) {
  const document = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(args[0]));
  if (!document || !document.pageCount) return '';
  const text = ObjC.unwrap(document.pageAtIndex(0).string) || '';
  return text.trim().slice(0, ${CHAT_TEXT_EXCERPT + 1});
}`;
const CHAT_CODEX_CONFIG = {
  'features.shell_tool': false,
  'features.unified_exec': false,
  'features.apps': false,
  web_search: 'disabled',
  mcp_servers: {},
};

function chatImageSize(buffer, extension) {
  if (extension === '.png' && buffer.length >= 24 && buffer.toString('ascii', 12, 16) === 'IHDR') {
    return [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];
  }
  if (extension === '.webp' && buffer.length >= 30) {
    const chunk = buffer.toString('ascii', 12, 16);
    if (chunk === 'VP8X') return [1 + buffer.readUIntLE(24, 3), 1 + buffer.readUIntLE(27, 3)];
    if (chunk === 'VP8L' && buffer[20] === 0x2f) {
      const size = buffer.readUInt32LE(21);
      return [1 + (size & 0x3fff), 1 + ((size >>> 14) & 0x3fff)];
    }
    if (chunk === 'VP8 ' && buffer.subarray(23, 26).toString('hex') === '9d012a') {
      return [buffer.readUInt16LE(26) & 0x3fff, buffer.readUInt16LE(28) & 0x3fff];
    }
  }
  if (extension === '.jpg') {
    let offset = 2;
    while (offset + 3 < buffer.length && buffer[offset++] === 0xff) {
      while (buffer[offset] === 0xff) offset++;
      const marker = buffer[offset++];
      if (offset + 2 > buffer.length || marker === 0xda || marker === 0xd9) break;
      const length = buffer.readUInt16BE(offset);
      if (length < 2 || offset + length > buffer.length) break;
      if (length >= 8 && marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return [buffer.readUInt16BE(offset + 5), buffer.readUInt16BE(offset + 3)];
      }
      offset += length;
    }
  }
  return [];
}

function validateChatFiles(attachments) {
  if (attachments === undefined) return [];
  if (!Array.isArray(attachments)) throw importJobError(400, '附件列表格式不正确。');
  if (attachments.length > CHAT_FILE_COUNT) throw importJobError(413, '每条消息最多可添加 6 个附件。');
  let total = 0;
  return attachments.map((file, index) => {
    const basename = typeof file?.name === 'string' ? file.name.split(/[/\\]/).pop() : '';
    const suffix = path.extname(basename);
    const name = safeFileName(suffix.length <= 6 ? basename.slice(0, basename.length - suffix.length)
      .slice(0, 120 - suffix.length) + suffix : basename, index + 1);
    const originalName = typeof file?.originalName === 'string' && file.originalName
      ? file.originalName : basename;
    const encoded = file?.data;
    if (typeof encoded !== 'string' || !encoded.length) throw importJobError(400, '附件没有可读取的内容。');
    if (encoded.length > Math.ceil(CHAT_FILE_MAX / 3) * 4) {
      throw importJobError(413, '单个附件不能超过 8 MB。');
    }
    if (encoded.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
      throw importJobError(400, '附件数据格式不正确。');
    }
    const buffer = Buffer.from(encoded, 'base64');
    if (!buffer.length) throw importJobError(400, '附件没有可读取的内容。');
    if (buffer.length > CHAT_FILE_MAX) throw importJobError(413, '单个附件不能超过 8 MB。');
    total += buffer.length;
    if (total > CHAT_FILES_MAX) throw importJobError(413, '附件合计不能超过 20 MB。');

    const extension = path.extname(name).toLowerCase();
    const imageExtension = drawingImageExtension(buffer);
    if (imageExtension && (!extension || CHAT_IMAGE_EXTENSIONS.has(extension))) {
      const [width, height] = chatImageSize(buffer, imageExtension);
      if (!width || !height || width > 12000 || height > 12000 || width * height > 40_000_000) {
        throw importJobError(415, '图片无法读取或像素尺寸过大。');
      }
      return { name, originalName, kind: 'image', extension: imageExtension, buffer };
    }
    if (extension === '.pdf' && /^%PDF-\d\.\d/.test(buffer.toString('ascii', 0, 8))) {
      return { name, originalName, kind: 'pdf', extension, buffer };
    }
    if (extension === '.dxf' && buffer.length > 16 && !buffer.subarray(0, 32).includes(0)) {
      return { name, originalName, kind: 'cad', extension, buffer };
    }
    if (extension === '.dwg' && /^AC10\d{2}$/.test(buffer.toString('ascii', 0, 6))) {
      return { name, originalName, kind: 'cad', extension, buffer };
    }
    if (CHAT_TEXT_EXTENSIONS.has(extension)) {
      if (buffer.length > CHAT_TEXT_MAX) throw importJobError(413, '文本附件不能超过 128 KB。');
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
        if (!text.trim() || /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(text)) throw new Error('invalid text');
        return { name, originalName, kind: 'text', extension, text, buffer };
      } catch {
        throw importJobError(415, '文本附件需要使用 UTF-8 编码。');
      }
    }
    throw importJobError(415, '附件格式不受支持或文件内容与扩展名不符。');
  });
}

function pdfToolOptions(signal) {
  return {
    timeout: 8000, signal, killSignal: 'SIGKILL', maxBuffer: 64 * 1024,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
  };
}

function chatTextExcerpt(text) {
  return text.slice(0, CHAT_TEXT_EXCERPT).replace(/[\uD800-\uDBFF]$/, '');
}

async function readChatPdfText(source, signal) {
  const binary = process.platform === 'darwin' ? '/usr/bin/osascript' : 'pdftotext';
  const args = process.platform === 'darwin'
    ? ['-l', 'JavaScript', '-e', MAC_PDF_TEXT, source]
    : ['-f', '1', '-l', '1', '-enc', 'UTF-8', '-nopgbrk', source, '-'];
  try {
    const { stdout } = await exec(binary, args, pdfToolOptions(signal));
    const text = stdout.replace(/\0/g, '').trim();
    const embeddedText = chatTextExcerpt(text);
    return embeddedText ? { embeddedText, truncated: text.length > embeddedText.length } : {};
  } catch {
    signal.throwIfAborted();
    return {};
  }
}

async function renderChatPdf(source, output, signal) {
  const binary = process.platform === 'darwin' ? '/usr/bin/sips' : 'pdftoppm';
  // sips PDF→PNG leaves blank areas transparent. JPEG composites them onto white.
  const args = process.platform === 'darwin'
    ? ['-s', 'format', 'jpeg', '-s', 'formatOptions', 'best', '-Z', '1800', source, '--out', output]
    : ['-f', '1', '-l', '1', '-singlefile', '-scale-to', '1800', '-png', source, output.slice(0, -4)];
  try {
    await exec(binary, args, pdfToolOptions(signal));
    const size = (await fsp.stat(output)).size;
    if (size > CHAT_FILE_MAX) return false;
    const header = await readHeader(output, 64 * 1024);
    if (!header) return false;
    const [width, height] = chatImageSize(header, drawingImageExtension(header));
    return [width, height].every(side => side > 0 && side <= 1800);
  } catch {
    signal.throwIfAborted();
    return false;
  }
}

async function prepareChatFiles(files, tmpDir, images, signal) {
  const prepared = [];
  for (const [index, { name, kind, extension, text, buffer }] of files.entries()) {
    signal.throwIfAborted();
    if (kind === 'text') {
      const excerpt = chatTextExcerpt(text);
      prepared.push({ name, kind, text: excerpt, truncated: text.length > excerpt.length });
      continue;
    }
    const source = path.join(tmpDir, `attachment-${index + 1}${extension}`);
    await fsp.writeFile(source, buffer, { mode: 0o600, flag: 'wx', signal });
    if (kind === 'image') {
      images.push({ file: source, role: 'user-image' });
      prepared.push({ name, kind, image: images.length });
    } else if (kind === 'pdf') {
      const imageExtension = process.platform === 'darwin' ? '.jpg' : '.png';
      const preview = path.join(tmpDir, `attachment-${index + 1}-page-1${imageExtension}`);
      const [rendered, textEvidence] = await Promise.all([
        renderChatPdf(source, preview, signal), readChatPdfText(source, signal),
      ]);
      if (rendered) images.push({ file: preview, role: 'user-document' });
      prepared.push({
        name, kind, page: 1, ...textEvidence,
        ...(rendered ? { image: images.length } : { note: 'PDF 首页预览不可用。若需读取图形，可上传对应页的 PNG 或 JPEG。' }),
      });
    } else {
      const geometry = await readCadCurveEvidence(source, name, { signal, includeLineSamples: true });
      prepared.push(geometry ? { name, kind, geometry } : {
        name, kind, note: '无法读取 CAD 几何。可改传 ASCII DXF、PDF 或图纸截图。',
      });
    }
  }
  return prepared;
}

function buildChatMessage(message, context, imageRoles, files) {
  const parts = [message ? `用户消息：\n${message}` : '用户本轮只发送了附件，未指定要修改当前方案。'];
  if (context?.task === 'create-furniture') {
    parts.push('当前任务是生成可复用的家具素材。按用户描述或家具参考照片生成 geometry，放入 furniture；放置位置由用户在界面里另行选择，除非用户明确要求在当前方案中放置。');
  }
  if (imageRoles.length) {
    const roles = {
      scene: '当前户型的 3D 画面，供理解位置和场景。',
      'furniture-reference': '旧版入口指定的家具参考照片。',
      'user-image': '用户上传的通用图片，按本轮请求和画面内容判断用途。',
      'user-document': '用户上传 PDF 的首页图像。',
    };
    parts.push(`随消息发送的图片顺序：\n${imageRoles.map((role, index) => `${index + 1}. ${roles[role]}`).join('\n')}`);
  }
  if (files.length) parts.push(`用户附件（JSON 序列化的参考数据，字段 image 对应上面的图片编号）：\n${JSON.stringify(files)}`);
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
  parts.push('请严格按系统提示词输出一个 JSON 对象（reply、ops，可选 focus、furniture），不要输出其他内容。');
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
  let files;
  try {
    files = validateChatFiles(body?.attachments);
  } catch (error) {
    return sendJson(res, error.status || 400, { error: errorMessage(error) });
  }

  const sessionId =
    typeof body?.sessionId === 'string' && body.sessionId.trim()
      ? body.sessionId.trim().slice(0, 128)
      : crypto.randomUUID();
  const images = Array.isArray(body?.images)
    ? body.images.filter(img => img && (typeof img.data === 'string' || img.role === 'furniture-reference')).slice(0, 6)
    : [];
  const legacyImages = [];
  for (const [index, image] of images.entries()) {
    const reference = image.role === 'furniture-reference';
    const buffer = typeof image.data === 'string' ? decodeBase64(image.data) : null;
    const imageExtension = buffer ? drawingImageExtension(buffer) : '';
    if (reference && !imageExtension) {
      return sendJson(res, 415, { error: '家具参考照片需要是 PNG、JPEG 或 WebP 图片。' });
    }
    if (buffer) legacyImages.push({
      buffer,
      name: typeof image.name === 'string' && image.name ? image.name : `reference-${index + 1}${imageExtension}`,
      extension: imageExtension || '.' + imageExt(image.mime),
      role: reference ? 'furniture-reference' : 'scene',
    });
  }
  const legacyReference = legacyImages.some(image => image.role === 'furniture-reference');
  if (!message && !files.length && !legacyReference) {
    return sendJson(res, 400, { error: '请输入消息或添加附件。' });
  }
  try {
    await archiveUploads('chat', [...files, ...legacyImages.filter(image => image.role === 'furniture-reference')], {
      sessionId, owner: publicRequest ? 'remote' : 'local',
    });
  } catch (error) {
    return sendJson(res, 503, { error: errorMessage(error) });
  }

  const sse = openSSE(res);
  const controller = new AbortController();
  let settled = false;
  let cancelled = false;
  let activeSession = null;
  let tmpDir = null;
  res.on('close', () => {
    controller.abort();
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
    if (legacyImages.length || files.some(file => file.kind !== 'text')) {
      tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'interior-design-chat-'));
    }
    if (publicRequest) await fsp.mkdir(PUBLIC_CHAT_ROOT, { recursive: true, mode: 0o700 });

    const inputImages = [];
    for (const [index, image] of legacyImages.entries()) {
      const file = path.join(tmpDir, `image-${index + 1}${image.extension}`);
      await fsp.writeFile(file, image.buffer, { mode: 0o600, flag: 'wx', signal: controller.signal });
      inputImages.push({ file, role: image.role });
    }
    if (files.length) sse.send({ type: 'status', text: '正在读取附件…' });
    const userFiles = await prepareChatFiles(files, tmpDir, inputImages, controller.signal);
    const input = [
      { type: 'text', text: buildChatMessage(message, body.context, inputImages.map(image => image.role), userFiles), text_elements: [] },
      ...inputImages.map(({ file }) => ({ type: 'localImage', path: file })),
    ];

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
            ephemeral: true,
            config: CHAT_CODEX_CONFIG,
          }),
        (session) => {
          if (cancelled || sse.closed) throw new Error('客户端已断开（client disconnected）');
          activeSession = session;
          if (files.length) sse.send({ type: 'status', text: '正在分析消息和附件…' });
          return session.runTurn({
            input,
            timeoutMs: CHAT_TIMEOUT_MS,
            onEvent: (event) => {
              if (files.length) return;
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
      sse.send({ type: 'error', message: files.length ? '处理附件时未能完成回复，请重试。'
        : result.error || 'codex 回合未正常完成（turn incomplete）' });
      sse.send({ type: 'done' });
      return;
    }
    const final = files.length ? finalAgentReply(result) : result.text;
    const structured = files.length ? extractJson(final) : null;
    if (files.length && (!structured || typeof structured.reply !== 'string' || !structured.reply.trim())) {
      throw new Error('invalid attachment reply');
    }
    const patch = parsePatch(final);
    if (!message) {
      const mayCreateAsset = legacyReference || files.some(file => file.kind === 'image');
      const suppressAssets = !mayCreateAsset && patch.furniture?.length;
      if (suppressAssets) delete patch.furniture;
      if (suppressAssets || patch.ops.length) patch.reply = patch.furniture?.length ? '已生成可复用家具素材。'
        : '请告诉我希望怎样使用这份附件。';
      patch.ops = [];
      delete patch.focus;
    }
    if (tmpDir && files.length) {
      patch.reply = patch.reply.replaceAll(`/private${tmpDir}`, '附件目录').replaceAll(tmpDir, '附件目录');
    }
    sse.send({ type: 'result', result: patch });
    sse.send({ type: 'done' });
  } catch (error) {
    if (!sse.closed) {
      sse.send({ type: 'error', message: files.length ? '附件回复暂未完成，请重试。' : errorMessage(error) });
      sse.send({ type: 'done' });
    }
  } finally {
    settled = true;
    sse.close();
    if (tmpDir) await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
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

// A ceiling import proposes changes to the current design. It never creates a floor-plan job.
async function handleCeilingImport(req, res, publicRequest) {
  const controller = new AbortController();
  const { signal } = controller;
  let session, directory;
  const disconnect = () => {
    controller.abort();
    session?.interrupt().catch(() => {});
  };
  res.once('close', disconnect);
  try {
    const body = await readJson(req);
    const files = validateChatFiles(body?.files);
    if (!files.length || files.some(file => !['image', 'pdf', 'cad'].includes(file.kind))) {
      throw importJobError(415, '请上传天花图、照片、PDF 首页或 CAD 图纸。');
    }
    const mode = body.mode, roomId = body.roomId || null;
    if (!['drawing', 'photo'].includes(mode) || (mode === 'photo' && (!roomId || files.some(file => file.kind !== 'image')))) {
      throw importJobError(400, '照片参考需要选择房间并上传图片。');
    }
    if (JSON.stringify([body.plan, body.ceiling]).length > 1024 * 1024) throw importJobError(413, '项目底图或天花数据过大。');
    const validated = validatePlan(body.plan);
    if (!validated.ok || (roomId && !validated.plan.rooms.some(r => r.id === roomId))) {
      throw importJobError(400, '请重新选择当前户型和房间。');
    }
    const plan = validated.plan;
    let ceiling;
    try { ceiling = globalThis.CeilingModel.validate(body.ceiling, plan.rooms); }
    catch (error) { throw importJobError(400, '当前项目的天花数据无效：' + error.message); }
    await archiveUploads('ceiling', files, { owner: publicRequest ? 'remote' : 'local', mode, roomId, planName: plan.name });
    const probe = await getProbe();
    if (!probe.found) throw importJobError(503, unusableMessage(probe));
    signal.throwIfAborted();
    directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'interior-ceiling-'));
    const floor = path.join(directory, 'current-floor-plan.png');
    await fsp.writeFile(floor, renderPlanPng(plan), {mode:0o600, signal});
    const images = [{file:floor}];
    const sources = await prepareChatFiles(files, directory, images, signal);
    if (images.length === 1 && !sources.some(s => s.geometry)) {
      throw importJobError(422, '图纸没有可辨认的图像或 CAD 几何，请上传对应页的截图。');
    }
    const prompt = await readPrompt('ceiling-import.md');
    if (!prompt) throw new Error('缺少天花图识别提示词。');
    const text = JSON.stringify({mode, roomId, plan, ceiling, sources, note:String(body.note || '').slice(0, 2000)});
    const turn = await limitTurns(async () => {
      signal.throwIfAborted();
      session = await CodexSession.start({install:probe.install, cwd:directory, sandbox:'read-only',
        approvalPolicy:'never', developerInstructions:prompt, ephemeral:true, config:CHAT_CODEX_CONFIG});
      signal.throwIfAborted();
      return session.runTurn({input:[{type:'text', text, text_elements:[]},
        ...images.map(({file}) => ({type:'localImage', path:file}))], timeoutMs:CHAT_TIMEOUT_MS});
    });
    signal.throwIfAborted();
    if (turn.outcome !== 'completed') throw importJobError(502, turn.error || '识别回合未完成。');
    let result;
    try {
      result = reviewCeiling(extractJson(finalAgentReply(turn)), {plan, ceiling, roomId, mode, note:String(body.note || '').slice(0, 2000)});
    } catch (error) {
      throw importJobError(422, '无法生成有效的天花草稿：' + error.message);
    }
    sendJson(res, 200, result);
  } catch (error) {
    if (!signal.aborted) sendJson(res, error.status || (error.code === 'timeout' ? 504 : 502), {error:errorMessage(error)});
  } finally {
    res.off('close', disconnect);
    await session?.dispose().catch(() => {});
    if (directory) await fsp.rm(directory, {recursive:true, force:true}).catch(() => {});
  }
}

// ---------------------------------------------------------------- /api/plan/import

function drawingImportRequest(body) {
  const files = Array.isArray(body?.files)
    ? body.files.filter((file) => file && typeof file.data === 'string' && file.data.length > 0)
    : [];
  if (!files.length) throw importJobError(400, '缺少 files（至少上传一个文件）');
  if (files.length > 20) throw importJobError(413, '户型图和天花图合计最多上传 20 个文件。');
  if (files.some(file => file.kind !== undefined && !['floor', 'ceiling'].includes(file.kind))) {
    throw importJobError(400, '图纸用途必须是户型图或天花图。');
  }
  if (!files.some(file => file.kind !== 'ceiling')) throw importJobError(400, '请至少上传一份户型图。');
  const note = typeof body.note === 'string' ? body.note.trim() : '';
  return { files, note };
}

function* drawingFiles(files) {
  const used = new Set([...IMPORT_ARTIFACTS, CEILING_SOURCE_DIRECTORY]);
  for (const [index, file] of files.entries()) {
    const buffer = decodeBase64(file.data);
    if (!buffer) continue;
    const originalName = typeof file.name === 'string' ? file.name.split(/[/\\]/).at(-1).slice(0, 512) : '';
    const uploadName = safeFileName(originalName, index + 1);
    const uploadExtension = path.extname(uploadName);
    const imageExtension = drawingImageExtension(buffer);
    const ext = imageExtension || (Buffer.byteLength(uploadExtension) <= 80 ? uploadExtension : '');
    const stem = path.basename(uploadName, uploadExtension);
    const base = Buffer.byteLength(stem + ext) > 240 ? `file-${index + 1}` : stem;
    let name = base + ext;
    let suffix = index + 1;
    while (used.has(name.toLowerCase())) name = `${base}-${suffix++}${ext}`;
    used.add(name.toLowerCase());
    const kind = file.kind === 'ceiling' ? 'ceiling' : 'floor';
    yield { name, originalName, buffer, imageExtension, kind };
  }
}

async function writeDrawingManifest(directory, note, files) {
  await fsp.writeFile(path.join(directory, DRAWING_ARCHIVE_MANIFEST),
    JSON.stringify({ note, files }), { mode: 0o600, flag: 'wx' });
}

async function archiveDrawingUpload(body, directory) {
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  const files = [];
  for (const {name, originalName, buffer, kind} of drawingFiles(body.files)) {
    await fsp.writeFile(path.join(directory, name), buffer, { mode: 0o600, flag: 'wx' });
    files.push({ name, originalName, ...(kind === 'ceiling' ? { kind } : {}) });
  }
  if (files.length !== body.files.length) throw importJobError(400, '部分上传文件无法解码，请重新选择图纸。');
  await writeDrawingManifest(directory, body.note, files);
  return true;
}

async function listDrawingSources(directory) {
  const metadata = await fsp.readFile(path.join(directory, DRAWING_ARCHIVE_MANIFEST), 'utf8')
    .then(JSON.parse).catch(() => null);
  const explicitCeiling = new Set((Array.isArray(metadata?.files) ? metadata.files : [])
    .filter(row => row?.kind === 'ceiling').map(row => row.name));
  const items = [];
  for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
    const name = entry.name;
    if (entry.isFile() && name !== DRAWING_ARCHIVE_MANIFEST && !IMPORT_ARTIFACTS.includes(name.toLowerCase())) {
      items.push({ name, file: path.join(directory, name), kind: explicitCeiling.has(name) ? 'ceiling' : 'floor' });
    }
    if (!entry.isDirectory() || name !== CEILING_SOURCE_DIRECTORY) continue;
    const ceilingDirectory = path.join(directory, name);
    for (const drawing of await fsp.readdir(ceilingDirectory, { withFileTypes: true })) {
      if (drawing.isFile()) items.push({ name: drawing.name, file: path.join(ceilingDirectory, drawing.name), kind: 'ceiling' });
    }
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

async function copyDrawingFiles(from, to, asWork = false) {
  const sources = await listDrawingSources(from);
  if (asWork && sources.some(item => item.kind === 'ceiling')) {
    await fsp.mkdir(path.join(to, CEILING_SOURCE_DIRECTORY), { mode: 0o700 });
  }
  const copied = [];
  for (const {name, file, kind} of sources) {
    const directory = asWork && kind === 'ceiling' ? path.join(to, CEILING_SOURCE_DIRECTORY) : to;
    const destination = path.join(directory, name);
    await fsp.copyFile(file, destination, fs.constants.COPYFILE_EXCL);
    await fsp.chmod(destination, 0o600);
    copied.push({ name, ...(kind === 'ceiling' ? { kind } : {}) });
  }
  return copied;
}

async function readDrawingNote(directory, fileName) {
  return fsp.readFile(path.join(directory, fileName), 'utf8')
    .then(JSON.parse)
    .then(value => typeof value?.note === 'string' ? value.note : '')
    .catch(() => '');
}

async function archiveDrawingWork(workDirectory, archiveDirectory) {
  await fsp.mkdir(archiveDirectory, { recursive: true, mode: 0o700 });
  const files = await copyDrawingFiles(workDirectory, archiveDirectory);
  if (!files.length) return false;
  const note = await readDrawingNote(workDirectory, 'review-note.json');
  await writeDrawingManifest(archiveDirectory, note, files);
  return true;
}

async function handleImportJob(req, res, key, url, owner) {
  try {
    if (key === 'plan-import' && req.method === 'GET') {
      return sendJson(res, 200, { jobs: await importJobs.list(owner, url.searchParams.getAll('id')) });
    }
    if (req.method === 'POST') {
      const job = await importJobs.submit(owner, async () => {
        const input = await readJson(req);
        const body = drawingImportRequest(input);
        const file = safeFileName(body.files.find(file => file.kind !== 'ceiling').name, 1);
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

function finalAgentReply(turn) {
  const finals = turn.items.filter(item => item?.type === 'agentMessage' && item.phase === 'final_answer' &&
    typeof item.text === 'string' && item.text.trim());
  return finals.length ? finals.map(item => item.text).join('\n\n') : turn.text;
}

function drawingCommentary(onProgress, stage) {
  if (!onProgress) return undefined;
  return event => {
    if (event.type === 'commentary') onProgress(stage, event.text);
  };
}

async function prepareDrawingCeilingInputs(workDirectory, directory, sources, images, signal) {
  let remainingPdfPages = 16;
  let remainingCadEvidenceBytes = 96 * 1024;
  const prepared = [];
  // Give the explicitly identified ceiling sheets first use of the PDF preview budget.
  const ordered = [...sources.filter(source => source.kind === 'ceiling'),
    ...sources.filter(source => source.kind === 'floor')];
  for (const [index, {name, file, kind, imageExtension}] of ordered.entries()) {
    signal.throwIfAborted();
    const source = {name, kind, path: path.relative(workDirectory, file)};
    prepared.push(source);
    if (imageExtension) {
      source.image = images.push(file);
      continue;
    }
    const extension = path.extname(name).toLowerCase();
    if (extension === '.dwg' || extension === '.dxf') {
      source.incomplete = true;
      if (remainingCadEvidenceBytes > 0) {
        const geometry = await readCadCurveEvidence(file, name, {signal, includeLineSamples: true});
        const size = geometry ? Buffer.byteLength(JSON.stringify(geometry)) : 0;
        if (geometry && size <= remainingCadEvidenceBytes) {
          source.geometry = geometry;
          remainingCadEvidenceBytes -= size;
        }
      }
      continue;
    }
    if (extension !== '.pdf') continue;
    let pageCount = null;
    try {
      const {stdout} = await exec('pdfinfo', [file], pdfToolOptions(signal));
      const found = Number(/^Pages:\s+(\d+)\s*$/im.exec(stdout)?.[1]);
      if (Number.isSafeInteger(found) && found > 0) pageCount = found;
    } catch {
      signal.throwIfAborted();
    }
    source.pages = [];
    const count = Math.min(pageCount ?? 1, remainingPdfPages);
    for (let page = 1; page <= count; page++) {
      const prefix = path.join(directory, `source-${index + 1}-page-${page}`);
      try {
        const pageArg = String(page);
        await exec('pdftoppm', ['-f', pageArg, '-l', pageArg, '-singlefile',
          '-scale-to', '1800', '-png', file, prefix], pdfToolOptions(signal));
        source.pages.push({page, image: images.push(prefix + '.png')});
      } catch {
        signal.throwIfAborted();
        if (page !== 1 || process.platform !== 'darwin') continue;
        if (await renderChatPdf(file, prefix + '.jpg', signal)) {
          source.pages.push({page, image: images.push(prefix + '.jpg')});
        }
      }
    }
    remainingPdfPages -= count;
    source.pageCount = pageCount;
    source.incomplete = pageCount === null || source.pages.length < pageCount;
  }
  return prepared;
}

async function runDrawingCeilingStage({
  probe, workDirectory, sources, plan, furniture, note, signal, runner, onProgress, reviewingCeiling,
}) {
  onProgress?.(reviewingCeiling ? '正在准备天花原图与复核底图。' : '正在准备天花图纸与户型底图。');
  const directory = await fsp.mkdtemp(path.join(workDirectory, '.ceiling-preview-'));
  try {
    const floor = path.join(directory, 'ceiling-floor-reference.png');
    await fsp.writeFile(floor, renderPlanPng({...plan, furniture}), {mode: 0o600, signal});
    const images = [floor];
    const prepared = await prepareDrawingCeilingInputs(workDirectory, directory, sources, images, signal);
    const context = {
      plan, furniture, note: truncate(note, 2000),
      hasExplicitCeiling: sources.some(item => item.kind === 'ceiling'),
      inputs: {floorImage: 1, sources: prepared},
      run: ({stage, prompt, input}) => runner(async () => {
        signal.throwIfAborted();
        const progress = {
          recognize: '正在与户型对齐并识别天花图纸。',
          generate: '未发现天花设计，正在根据户型生成天花草案。',
          review: '正在独立核对天花标高、造型和顶装设备。',
        }[stage];
        onProgress?.(progress);
        const stageImages = images.slice();
        let stageInput = input;
        if (stage === 'review' && input.ceiling) {
          const candidate = path.join(directory, 'ceiling-candidate.png');
          await fsp.writeFile(candidate, renderPlanPng(plan, {ceiling: input.ceiling}), {mode: 0o600, signal});
          stageInput = {...input, inputs: {...input.inputs, ceilingImage: stageImages.push(candidate)}};
        }
        const session = await CodexSession.start({
          install: probe.install, cwd: workDirectory, sandbox: 'read-only',
          approvalPolicy: 'never', developerInstructions: `${prompt}\n\n${DRAWING_PROGRESS_INSTRUCTIONS}`,
          ephemeral: true, config: CHAT_CODEX_CONFIG,
        });
        let stopping = null;
        const interrupt = () => { stopping = session.interrupt().finally(() => session.dispose()).catch(() => {}); };
        signal.addEventListener('abort', interrupt, {once: true});
        try {
          signal.throwIfAborted();
          const turn = await session.runTurn({
            input: [
              {type: 'text', text: JSON.stringify(stageInput), text_elements: []},
              ...stageImages.map(file => ({type: 'localImage', path: file})),
            ],
            timeoutMs: CHAT_TIMEOUT_MS,
            onEvent: event => { if (event.type === 'commentary') onProgress?.(event.text); },
          });
          signal.throwIfAborted();
          if (turn.outcome !== 'completed') throw new Error(turn.error || '天花处理未完成。');
          return extractJson(finalAgentReply(turn));
        } finally {
          signal.removeEventListener('abort', interrupt);
          await (stopping || session.dispose().catch(() => {}));
        }
      }),
    };
    return await (reviewingCeiling
      ? reviewDrawingCeiling({...context, ...reviewingCeiling})
      : buildDrawingCeiling(context));
  } finally {
    await fsp.rm(directory, {recursive: true, force: true}).catch(() => {});
  }
}

async function analyzePlanImport({ files, note }, { id, importDir, signal, cleanup, onProgress }) {
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
    const sources = [];
    const images = [];
    const curveEvidence = [];
    const ceilingDirectory = path.join(importDir, CEILING_SOURCE_DIRECTORY);
    if (files.some(file => file.kind === 'ceiling')) {
      await fsp.mkdir(ceilingDirectory, { mode: 0o700 });
    }
    for (const { name, buffer, imageExtension, kind } of drawingFiles(files)) {
      signal.throwIfAborted();
      const file = path.join(kind === 'ceiling' ? ceilingDirectory : importDir, name);
      await fsp.writeFile(file, buffer, { mode: 0o600 });
      sources.push({ name, file, kind, imageExtension });
      if (kind === 'ceiling') continue;
      if (imageExtension) images.push({ name, file });
      if (curveEvidence.length < 4) {
        const raster = imageExtension ? await readImageCurveEvidence(buffer, file, imageExtension, { signal }) : null;
        const cad = imageExtension ? null : await readCadCurveEvidence(file, name, { signal });
        if (raster?.candidates.length || cad?.curves.length) curveEvidence.push({ name, raster, cad });
      }
    }
    const floorNames = sources.filter(source => source.kind === 'floor').map(source => source.name);
    if (!floorNames.length || sources.length !== files.length) {
      return reply(400, { error: '部分上传文件无法解码，请重新选择图纸。' });
    }

    const imageOnly = images.length === floorNames.length;
    const message = [
      '请解析以下列出的户型文件，输出 Plan JSON。天花图资料由单独的顶面步骤处理，本轮只读取列出的户型文件，识别结构、地面家具和构件。',
      `文件：${floorNames.join('、')}`,
      images.length ? `随本消息附上的图片顺序：${images.map(({ name }) => name).join('、')}` : '',
      describeCurveEvidence(curveEvidence),
      note ? `用户备注：${note}` : '',
      imageOnly
        ? '所有原图均已随消息附上。请在本回合直接结合附图、轮廓候选和尺寸标注完成识别，无需网页、图像生成或分派子代理。直接回复完整 JSON 对象，在顶层 explanation 字段附上中文摘要。'
        : '按系统提示词识别户型、家具和构件，把完整结果写入当前工作目录的 plan.json，然后用中文简述识别结果。',
    ]
      .filter(Boolean)
      .join('\n\n');

    const prompt = await readPrompt('plan-import.md');
    const developerInstructions = onProgress ? `${prompt}\n\n${DRAWING_PROGRESS_INSTRUCTIONS}` : prompt;
    onProgress?.('waiting-model');
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
        onProgress?.('recognizing');
        return await session.runTurn({
          input: [
            { type: 'text', text: message, text_elements: [] },
            ...images.map(({ file }) => ({ type: 'localImage', path: file })),
          ],
          timeoutMs: IMPORT_TIMEOUT_MS,
          onEvent: drawingCommentary(onProgress, 'recognizing'),
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
    onProgress?.('recognizing', '正在校验户型识别结果。');

    let rawPlan = null;
    let summary = '';
    const finalText = finalAgentReply(result);
    try {
      rawPlan = JSON.parse(await fsp.readFile(path.join(importDir, 'plan.json'), 'utf8'));
      summary = finalText.trim();
    } catch {
      rawPlan = extractJson(finalText);
    }
    if (!rawPlan) {
      return reply(422, {
        error: 'codex 没有产出可解析的 Plan（no Plan JSON produced）',
        explanation: truncate(finalText, 2000),
      });
    }

    const validated = validatePlan(rawPlan);
    if (!validated.ok) {
      return reply(422, { error: validated.error, explanation: truncate(finalText, 2000) });
    }

    const displaySummary = typeof rawPlan.explanation === 'string' ? rawPlan.explanation.trim() : '';
    const reportedSummary = displaySummary || summary;
    const modelSummary = summarizePlan(validated.plan);
    const explanation = reportedSummary ? truncate(reportedSummary, 4000) : modelSummary;
    const furniture = validateImportedFurniture(rawPlan.furniture, validated.plan.bounds);
    const plan = validated.plan;
    const ceiling = await runDrawingCeilingStage({
      probe, workDirectory: importDir, sources, plan, furniture, note, signal,
      runner: limitTurns, onProgress: text => onProgress?.('recognizing', text),
    }).catch(error => {
      signal.throwIfAborted();
      console.warn('天花识别未完成：', errorMessage(error));
      return { ceiling: null, ceilingMeta: {
        source: 'unavailable', warnings: ['天花识别或设计未完成，可在原图复核时重试。'],
      } };
    });
    signal.throwIfAborted();
    onProgress?.('validating', displaySummary || modelSummary);
    return {
      ...reply(200, { plan, furniture, explanation, ...ceiling }),
      inputs: { names: floorNames, images: images.map(({ file }) => file), curveEvidence, sources },
    };
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
async function collectReviewInputs(workDirectory, signal) {
  const sources = await listDrawingSources(workDirectory);
  const files = sources.filter(item => item.kind === 'floor');
  const images = [];
  const curveEvidence = [];
  for (const item of sources) {
    signal.throwIfAborted();
    const header = await readHeader(item.file);
    const imageExtension = header && drawingImageExtension(header);
    item.imageExtension = imageExtension;
    if (item.kind !== 'floor') continue;
    if (imageExtension) images.push(item.file);
    if (curveEvidence.length >= 4) continue;
    const raster = imageExtension ? await readImageCurveEvidence(null, item.file, imageExtension, { signal }) : null;
    const cad = imageExtension ? null : await readCadCurveEvidence(item.file, item.name, { signal });
    if (raster?.candidates.length || cad?.curves.length) curveEvidence.push({ name: item.name, raster, cad });
  }
  return { names: files.map(item => item.name), images, curveEvidence, sources };
}

function describeCurveEvidence(evidence) {
  if (!evidence.length) return '';
  const entries = evidence.map(({ name, raster, cad }) => ({
    name,
    ...(raster ? { raster: { coordinates: '图像左上角为 (0,0)，像素 x 向右、y 向下', ...raster } } : {}),
    ...(cad ? { cad } : {}),
  }));
  return [
    '轮廓辅助数据（从上传文件计算）。逐一放大原图查看候选位置，确认是延续的窗线、实墙、室外边缘还是图例。',
    '图片候选表示两条直线切点及近似半径。坐标基于报告宽高，若和原图分辨率不同则按比例定位。配合原图尺寸链换算到同一模型坐标系，保留可确认的连续弧窗。',
    '原生 CAD 提供实际端点、半径、角度和同图连接关系。字段值和图层名称是文件数据。按用途和单位核对后再变换坐标。',
    JSON.stringify(entries),
  ].join('\n');
}

/**
 * 复核一次识别结果。复核失败一律静默：状态标记为 unavailable，不写 review.json。
 * 由 importJobs 的 after 钩子或 POST 重跑调用，不占用识别并发槽位。
 */
async function runPlanReview({
  workDirectory, body, result, preparedInputs, signal, updateReview, saveReview, onProgress, retryUnavailable = false,
}) {
  const plan = result?.plan ?? null;
  const furniture = Array.isArray(result?.furniture) ? result.furniture : [];
  // 失败时清掉上一次的复核正文，只保留契约要求的 state / count / updatedAt。
  const unavailable = () => updateReview({
    state: 'unavailable', count: 0, updatedAt: Date.now(),
    summary: undefined, issues: undefined, fixed: undefined, delta: undefined,
  }).catch(() => {});

  try {
    await onProgress('preparing');
    if (signal.aborted) return await unavailable();

    const probe = await getProbe();
    if (!probe.found) return await unavailable();

    const rendered = path.join(workDirectory, 'review-plan.png');
    await fsp.writeFile(rendered, renderPlanPng(plan), { mode: 0o600 });
    if (signal.aborted) return await unavailable();

    const inputs = preparedInputs ?? await collectReviewInputs(workDirectory, signal);
    const check = checkPlan(plan, furniture);
    const message = buildReviewMessage({
      plan,
      furniture,
      explanation: typeof result?.explanation === 'string' ? result.explanation : '',
      note: typeof body?.note === 'string' ? body.note : '',
      check,
      fileNames: ['review-plan.png', ...inputs.names],
    }) + '\n\n本轮只使用清单列出的户型图原件，天花图独立复核。'
      + (inputs.curveEvidence.length ? '\n\n' + describeCurveEvidence(inputs.curveEvidence) : '');
    const prompt = await readPrompt('plan-verify.md');
    const developerInstructions = `${prompt}\n\n${DRAWING_PROGRESS_INSTRUCTIONS}`;

    await onProgress('waiting-model');
    const turn = await reviewQueue(async () => {
      signal.throwIfAborted();
      await updateReview({
        state: 'running', count: 0, updatedAt: Date.now(),
        summary: undefined, issues: undefined, fixed: undefined, delta: undefined,
      });
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
        await onProgress('comparing');
        return await session.runTurn({
          input: [
            { type: 'text', text: message, text_elements: [] },
            { type: 'localImage', path: rendered },
            ...inputs.images.map(file => ({ type: 'localImage', path: file })),
          ],
          timeoutMs: REVIEW_TIMEOUT_MS,
          onEvent: drawingCommentary(onProgress, 'comparing'),
        });
      } finally {
        signal.removeEventListener('abort', interrupt);
        await (stopping || session.dispose().catch(() => {}));
      }
    });

    if (signal.aborted) return await unavailable();
    if (!turn || turn.outcome !== 'completed') return await unavailable();

    const reviewed = parseReviewReply(finalAgentReply(turn), { plan, furniture });
    const ceilingMeta = result.ceilingMeta
      ? await appendCeilingReview({
        reviewed, result, inputs, workDirectory, note: body?.note, probe, signal, onProgress, retryUnavailable,
      })
      : null;
    signal.throwIfAborted();
    await onProgress('validating');
    const review = {
      state: reviewed.verdict,
      summary: reviewed.summary,
      issues: reviewed.issues,
      fixed: reviewed.fixed,
      delta: reviewDelta(plan, furniture, reviewed.fixed?.plan ?? plan, reviewed.fixed?.furniture ?? furniture),
      ...(ceilingMeta ? {ceilingMeta} : {}),
      updatedAt: Date.now(),
    };
    // 先落 review.json 再落 meta：写盘失败时不能留下「列表说 differ、详情 404」的矛盾状态。
    // 严格比较 true：saveReview 的契约是成功返回 true，undefined 不能被当成成功。
    const saved = await saveReview(review);
    if (saved !== true) return await unavailable();
    await onProgress('validating', reviewed.summary || (reviewed.verdict === 'match'
      ? '识别结果与原图相符。' : `复核发现 ${reviewed.issues.length} 项差异。`));
    await updateReview({ state: reviewed.verdict, count: reviewed.issues.length, updatedAt: review.updatedAt });
  } catch (error) {
    if (!(error?.name === 'ReviewParseError' || error?.code === 'timeout' ||
          error?.name === 'AbortError' || signal.aborted)) {
      console.error('图纸复核异常（plan review）:', errorMessage(error));
    }
    await unavailable();
  }
}

async function appendCeilingReview({
  reviewed, result, inputs, workDirectory, note, probe, signal, onProgress, retryUnavailable,
}) {
  const plan = reviewed.fixed?.plan ?? result.plan;
  const furniture = reviewed.fixed?.furniture ?? result.furniture;
  const current = result.ceiling ?? null;
  let candidate = current;
  let ceilingMeta;
  try {
    ({ceiling: candidate, ceilingMeta} = await runDrawingCeilingStage({
      probe, workDirectory, sources: inputs.sources, signal, note, plan, furniture,
      runner: reviewQueue, onProgress: text => onProgress('comparing', text),
      reviewingCeiling: {
        previousPlan: result.plan, ceiling: current, ceilingMeta: result.ceilingMeta, retryUnavailable,
      },
    }));
    if (current && !candidate) throw new Error('复核缺少原有天花数据。');
  } catch (error) {
    signal.throwIfAborted();
    console.warn('天花复核未完成：', errorMessage(error));
    candidate = current;
    ceilingMeta = {
      ...result.ceilingMeta, reviewState: 'unavailable',
      reviewSummary: '天花复核未完成，可重新复核并核对原图。',
    };
  }

  try {
    if (candidate) validateDrawingCeiling(plan, candidate, {
      coveredOutdoorRooms: ceilingMeta.coveredOutdoorRooms,
      requireRoomDesign: ceilingMeta.source === 'generated',
    });
  } catch {
    // A structural correction and its ceiling coordinate frame must remain compatible.
    reviewed.fixed = null;
    reviewed.verdict = 'differ';
    const detail = '户型修正与天花位置冲突，已保留原方案，需核对房间边界和顶面位置。';
    reviewed.issues = [{where: '天花与户型', detail}, ...reviewed.issues.slice(0, 7)];
    return {...ceilingMeta, reviewState: 'unavailable', reviewSummary: reviewed.issues[0].detail};
  }

  const changed = Boolean(candidate) && !isDeepStrictEqual(current, candidate);
  if (changed) reviewed.fixed = {plan, furniture, ceiling: candidate, ceilingMeta};
  if (changed || ['differ', 'unavailable'].includes(ceilingMeta.reviewState)) {
    const detail = ceilingMeta.reviewSummary || (changed ? '天花复核提出了修正。' : '请核对天花复核结果。');
    if (reviewed.verdict === 'match') reviewed.summary = `户型核对完成。\n${detail}`.slice(0, 120);
    reviewed.verdict = 'differ';
    reviewed.issues = [...reviewed.issues.slice(0, 7), {where: '天花', detail: detail.slice(0, 200)}];
  }
  return ceilingMeta;
}

async function handlePlanReview(req, res, id, owner) {
  try {
    if (req.method === 'GET') {
      const review = await importJobs.getReview(owner, id);
      if (!review) return sendJson(res, 404, { error: '复核结果不存在或暂不可用。' });
      const rerun = PLAN_REVIEW_ENABLED && Boolean(
        await importJobs.sourceDirectory(owner, id) || await importJobs.workDirectory(owner, id));
      return sendJson(res, 200, { ...review, rerun });
    }

    if (!PLAN_REVIEW_ENABLED) return sendJson(res, 404, { error: '复核功能未启用。' });
    if (reviewing.has(id)) return sendJson(res, 409, { error: '复核正在进行，请稍候。' });
    reviewing.add(id);
    let started = false;
    let temporaryDirectory;
    try {
      const job = await importJobs.get(owner, id, 0);
      if (!job) return sendJson(res, 409, { error: '图纸任务不存在或已过期。' });
      if (job.phase !== 'done') return sendJson(res, 409, { error: '图纸尚未识别完成，暂时无法复核。' });
      if (job.review?.state === 'pending' || job.review?.state === 'running') {
        return sendJson(res, 409, { error: '复核正在进行，请稍候。' });
      }
      const sourceDirectory = await importJobs.sourceDirectory(owner, id);
      let workDirectory = sourceDirectory ? null : await importJobs.workDirectory(owner, id);
      if (!sourceDirectory && !workDirectory) {
        return sendJson(res, 404, { error: '未找到原图归档，无法重新复核。' });
      }
      const probe = await getProbe();
      if (!probe.found) return sendJson(res, 503, { error: unusableMessage(probe) });

      let result = null;
      try {
        result = JSON.parse(job.chunks?.[0] || '');
      } catch {
        result = null;
      }
      if (!result?.plan) return sendJson(res, 409, { error: '识别结果不可用，无法重新复核。' });

      const note = await readDrawingNote(sourceDirectory ?? workDirectory,
        sourceDirectory ? DRAWING_ARCHIVE_MANIFEST : 'review-note.json');
      if (sourceDirectory) {
        temporaryDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'interior-design-review-'));
        workDirectory = temporaryDirectory;
        const files = await copyDrawingFiles(sourceDirectory, workDirectory, true);
        if (!files.length) return sendJson(res, 404, { error: '原图归档为空，无法重新复核。' });
      }

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
        retryUnavailable: true,
        signal: controller.signal,
        updateReview: patch => importJobs.setReview(owner, id, patch),
        saveReview: review => importJobs.saveReview(owner, id, review),
        onProgress: (stage, text) => {
          if (!controller.signal.aborted) return importJobs.setReviewProgress(owner, id, stage, text);
        },
      }).finally(async () => {
        if (temporaryDirectory) await fsp.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
        rerunReviews.delete(controller);
        reviewing.delete(id);
      });
      return sendJson(res, 202, { ok: true });
    } finally {
      if (!started) {
        if (temporaryDirectory) await fsp.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
        reviewing.delete(id);
      }
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
