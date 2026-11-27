import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { StringDecoder } from 'node:string_decoder';

const JOB_PATH = '/api/jobs/';
const ROUTES = new Map([
  ['chat', '/api/chat'],
  ['render', '/api/render'],
  ['plan-import', '/api/plan/import'],
  ['ceiling-import', '/api/ceiling-import'],
]);
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_BODY = 40 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_CHUNKS = 16_384;
const MAX_POLL_CHUNKS = 16;
const MAX_ACTIVE = 4;
const MAX_ACTIVE_PER_OWNER = 2;
const MAX_JOBS = 32;
const MAX_JOB_AGE = 15 * 60_000;
const POLL_LEASE = 3 * 60_000;
const FINISHED_TTL = 20 * 60_000;

function sendJson(res, status, value, headers = {}) {
  if (res.destroyed || res.writableEnded) return;
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

async function readBody(req) {
  if (Number(req.headers['content-length']) > MAX_BODY) return null;
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_BODY) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function finish(job, failure) {
  if (job.finishedAt !== null) return;
  job.finishedAt = Date.now();
  if (failure) {
    job.status = failure.status;
    job.error = failure.message;
    job.upstream?.destroy();
  }
  job.upstream = null;
  job.release();
  job.release = null;
}

async function consume(job, res) {
  if (job.finishedAt !== null) {
    res.destroy();
    return;
  }
  const decoder = new StringDecoder('utf8');
  job.status = res.statusCode;
  job.mediaType = res.headers['content-type'] || null;
  let size = 0;
  try {
    for await (const chunk of res) {
      if (job.finishedAt !== null) return;
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES || job.chunks.length >= MAX_OUTPUT_CHUNKS) {
        finish(job, { status: 502, message: 'AI 返回的数据超过限制，请缩小处理范围后重试。' });
        return;
      }
      const text = decoder.write(chunk);
      if (text) job.chunks.push(text);
    }
    const tail = decoder.end();
    if (tail && job.finishedAt === null) job.chunks.push(tail);
    finish(job);
  } catch {
    finish(job, { status: 502, message: '本机 AI 服务的响应中断，请重试。' });
  }
}

/**
 * Cloudflare Quick Tunnel transports short JSON responses. Keep the existing
 * HTTP/SSE API alive on loopback and collect its response for cursor polling.
 * The gateway supplies the authenticated owner's identity. Browser headers
 * never reach the loopback service.
 */
export function createPublicJobRelay({ origin = 'http://127.0.0.1:4173', bridgeToken } = {}) {
  const upstreamOrigin = new URL(origin);
  if (upstreamOrigin.protocol !== 'http:' || upstreamOrigin.hostname !== '127.0.0.1') {
    throw new Error('The job relay requires a loopback HTTP origin');
  }
  const jobs = new Map();
  const activeByOwner = new Map();
  let active = 0;

  function reserve(ownerId, cancel) {
    const own = activeByOwner.get(ownerId) ?? new Set();
    if (active >= MAX_ACTIVE || own.size >= MAX_ACTIVE_PER_OWNER) return null;
    const slot = {
      cancel,
      cancelled: false,
      release() {
        if (!own.delete(slot)) return;
        active -= 1;
        if (own.size === 0) activeByOwner.delete(ownerId);
      },
    };
    own.add(slot);
    active += 1;
    activeByOwner.set(ownerId, own);
    return slot;
  }

  function sweep() {
    const now = Date.now();
    for (const [id, job] of jobs) {
      if (job.finishedAt !== null) {
        if (now - job.finishedAt >= FINISHED_TTL) jobs.delete(id);
      } else if (now - job.startedAt >= MAX_JOB_AGE) {
        finish(job, { status: 504, message: 'AI 任务超时，请重试。' });
      } else if (now - job.lastPolledAt >= POLL_LEASE) {
        finish(job, { status: 410, message: '浏览器已长时间断开，任务已停止。' });
      }
    }
  }
  setInterval(sweep, 15_000).unref();

  async function start(req, res, ownerId, target) {
    const slot = reserve(ownerId, () => req.destroy());
    if (!slot) {
      return sendJson(res, 429, { error: '正在处理的 AI 任务过多，请等当前任务结束后重试。' }, { 'Retry-After': '5' });
    }
    let body;
    try {
      body = await readBody(req);
    } catch {
      slot.release();
      return sendJson(res, 400, { error: '请求上传中断，请重试。' });
    }
    if (body === null || slot.cancelled || !req.complete || res.destroyed) {
      slot.release();
      if (body === null) {
        sendJson(res, 413, { error: '请求超出 40 MiB，请缩小文件后重试。' }, { Connection: 'close' });
        req.resume();
      }
      return;
    }

    if (jobs.size >= MAX_JOBS) {
      for (const [id, job] of jobs) {
        if (job.finishedAt === null) continue;
        jobs.delete(id);
        break;
      }
    }

    const id = randomUUID();
    const now = Date.now();
    const job = {
      ownerId, startedAt: now, lastPolledAt: now, finishedAt: null,
      chunks: [], status: null, mediaType: null, upstream: null, release: slot.release,
    };
    jobs.set(id, job);
    slot.cancel = () => finish(job, { status: 410, message: '任务已取消。' });
    res.once('close', () => {
      if (res.writableFinished) return;
      finish(job, { status: 410, message: '任务提交已取消。' });
      jobs.delete(id);
    });
    try {
      job.upstream = request(new URL(target, upstreamOrigin), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': body.length,
          'X-Studio-Public-Owner': 'remote-owner',
          ...(bridgeToken ? { 'X-Studio-Public-Bridge': bridgeToken } : {}),
        },
      }, upstream => { void consume(job, upstream); });
      job.upstream.once('error', () => {
        finish(job, { status: 502, message: '无法连接本机 AI 服务，请重试。' });
      });
      job.upstream.end(body);
    } catch {
      finish(job, { status: 502, message: '无法连接本机 AI 服务，请重试。' });
    }
    return sendJson(res, 202, { id });
  }

  async function handleJob(req, res, url, ownerId) {
    if (!url.pathname.startsWith(JOB_PATH)) return false;
    if (typeof ownerId !== 'string' || !ownerId) {
      sendJson(res, 401, { error: '请登录后使用 AI。' });
      return true;
    }
    sweep();
    const key = url.pathname.slice(JOB_PATH.length);
    const target = ROUTES.get(key);
    if (target) {
      if (req.method === 'POST') await start(req, res, ownerId, target);
      else sendJson(res, 405, { error: '不支持该请求方法。' }, { Allow: 'POST' });
      return true;
    }
    const job = JOB_ID.test(key) ? jobs.get(key) : null;
    if (!job || job.ownerId !== ownerId) {
      sendJson(res, 404, { error: '任务不存在或已过期。' });
      return true;
    }
    if (req.method === 'DELETE') {
      finish(job, { status: 410, message: '任务已取消。' });
      jobs.delete(key);
      sendJson(res, 200, { ok: true });
      return true;
    }
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: '不支持该请求方法。' }, { Allow: 'GET, DELETE' });
      return true;
    }
    const cursorParam = url.searchParams.get('cursor') ?? '0';
    const cursor = /^\d+$/.test(cursorParam) ? Number(cursorParam) : NaN;
    if (!Number.isSafeInteger(cursor) || cursor > job.chunks.length) {
      sendJson(res, 400, { error: '读取位置无效。' });
      return true;
    }
    job.lastPolledAt = Date.now();
    const chunks = job.chunks.slice(cursor, cursor + MAX_POLL_CHUNKS);
    const next = cursor + chunks.length;
    sendJson(res, 200, {
      chunks,
      cursor: next,
      done: job.finishedAt !== null && next === job.chunks.length,
      status: job.status,
      mediaType: job.mediaType,
      ...(job.error ? { error: job.error } : {}),
    });
    return true;
  }

  handleJob.cancelOwner = ownerId => {
    for (const slot of activeByOwner.get(ownerId) ?? []) {
      slot.cancelled = true;
      slot.cancel();
    }
    for (const [id, job] of jobs) {
      if (job.ownerId === ownerId) jobs.delete(id);
    }
  };
  return handleJob;
}
