/**
 * 统一后台任务：提交与浏览器连接解耦，事件与结果落盘，可按游标轮询、跨重启恢复。
 * server.mjs 的 /api/jobs/chat、/api/jobs/render、/api/jobs/task/<id> 都落在这里。
 * 契约见 docs/jobs.md；设计依据 docs/superpowers/specs/2026-11-25-v2-design.md §6.1。
 */
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const collection = '/api/jobs/task';
const taskId = /^task-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const terminal = new Set(['done', 'failed', 'canceled']);
const owners = new Set(['local', 'remote']);
const MAX_EVENT_BYTES = 4 * 1024 * 1024;
const MAX_RESULT_BYTES = 4 * 1024 * 1024;
const MAX_REQUEST_BYTES = 40 * 1024 * 1024;
const MAX_POLL_FRAMES = 512;
const DEFAULT_TIMEOUT_MS = 15 * 60_000;

export function isTaskJobPath(pathname) {
  if (pathname === collection || pathname === collection + '/') return true;
  if (!pathname.startsWith(collection + '/')) return false;
  return !pathname.slice(collection.length + 1).includes('/');
}

export function taskJobError(status, message) {
  return Object.assign(new Error(message), { status });
}

/** SSE 帧：与 /api/chat、/api/render 的实时流同形，前端可复用同一解析器。 */
function frame(event) {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** 幂等摘要必须与键顺序无关。 */
function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map(key => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** projectId / schemeId / baseRevision 原样保存；只接受字符串或数字。 */
function normalizeOwnership(raw) {
  const result = { projectId: null, schemeId: null, baseRevision: null };
  if (raw === undefined || raw === null) return result;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw taskJobError(400, 'ownership 必须是对象。');
  for (const key of Object.keys(result)) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw taskJobError(400, `ownership.${key} 必须是字符串或数字。`);
    }
    result[key] = typeof value === 'string' ? value.slice(0, 200) : value;
  }
  return result;
}

async function saveFile(file, data) {
  const temp = file + '.tmp';
  await writeFile(temp, data, { mode: 0o600 });
  await rename(temp, file);
}

function logStorageError(error) {
  console.error('后台任务存储异常（task job storage）:', error.message);
}

/**
 * @param {object} options
 * @param {string} options.directory 任务目录（默认由 server.mjs 决定）
 * @param {(input: {id,kind,owner,ownership,payload,signal,emit}) => Promise<{status:number,result?:unknown,error?:string}>} options.execute
 * @param {Record<string,{timeoutMs?:number}>} options.kinds 允许的任务类型与各自时限
 * @param {number} [options.concurrency] 同时执行的任务数
 * @param {number} [options.capacity] 未结束任务上限（超过返回 429）
 * @param {number} [options.history] 每个访问范围最多保留的终态任务数
 * @param {number} [options.retention] 终态任务保留毫秒数（默认 30 分钟）
 * @param {number} [options.sweepMs] 清理间隔
 */
export function createTaskJobs({
  directory,
  execute,
  kinds = { chat: {}, render: {} },
  concurrency = 2,
  capacity = 8,
  history = 64,
  retention = 30 * 60_000,
  sweepMs = 60_000,
} = {}) {
  if (!directory) throw new Error('createTaskJobs 需要 directory');
  const jobs = new Map();
  let active = 0;
  let closing = false;
  const ready = restore();
  ready.catch(logStorageError);
  const sweep = setInterval(() => {
    if (!closing) void ready.then(prune).catch(logStorageError);
  }, sweepMs);
  sweep.unref?.();

  function folder(job) {
    return path.join(directory, job.meta.id);
  }

  function manifest(job) {
    return path.join(folder(job), 'job.json');
  }

  function inputFile(job) {
    return path.join(folder(job), 'input.json');
  }

  function eventsFile(job) {
    return path.join(folder(job), 'events.jsonl');
  }

  function resultFile(job) {
    return path.join(folder(job), 'result.json');
  }

  function describe(job) {
    const { owner, key, ...visible } = job.meta;
    return visible;
  }

  function update(job, changes) {
    const meta = { ...job.meta, ...changes, updatedAt: Date.now() };
    job.meta = meta;
    job.write = job.write.catch(() => {}).then(() => saveFile(manifest(job), JSON.stringify(meta)));
    return job.write;
  }

  function allFor(owner) {
    return [...jobs.values()].filter(job => job.meta.owner === owner)
      .sort((a, b) => b.meta.createdAt - a.meta.createdAt);
  }

  async function finish(job, phase, status, error) {
    await update(job, { phase, status, error: error ?? null, finishedAt: Date.now() }).catch(logStorageError);
    await rm(inputFile(job), { force: true }).catch(logStorageError);
  }

  /** 记录一个事件帧：内存立即可读，磁盘按序追加，跨重启可回放。 */
  function emit(job, event) {
    if (terminal.has(job.meta.phase) || job.canceled) return;
    let text;
    try {
      text = frame(event);
    } catch {
      return;
    }
    const size = Buffer.byteLength(text);
    if (job.bytes + size > MAX_EVENT_BYTES) {
      job.overflow = true;
      job.controller?.abort();
      return;
    }
    job.bytes += size;
    job.chunks.push(text);
    job.append = job.append.catch(() => {}).then(() => appendFile(eventsFile(job), text, { mode: 0o600 }));
  }

  async function prune() {
    const now = Date.now();
    const expired = [];
    for (const owner of owners) {
      const ended = allFor(owner).filter(job => terminal.has(job.meta.phase) && !job.controller);
      for (const [index, job] of ended.entries()) {
        if (index < history && now - job.meta.finishedAt < retention) continue;
        jobs.delete(job.meta.id);
        expired.push(job);
      }
    }
    await Promise.all(expired.map(job =>
      rm(folder(job), { recursive: true, force: true }).catch(logStorageError)));
  }

  async function run(job) {
    const controller = job.controller;
    const { signal } = controller;
    const timeoutMs = kinds[job.meta.kind]?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => {
      job.timedOut = true;
      controller.abort();
    }, timeoutMs);
    timer.unref?.();
    try {
      await update(job, { phase: 'running', startedAt: Date.now() });
      if (signal.aborted) return;
      const outcome = await execute({
        id: job.meta.id,
        kind: job.meta.kind,
        owner: job.meta.owner,
        ownership: job.meta.ownership,
        payload: job.payload,
        signal,
        emit: event => emit(job, event),
      });
      if (closing || job.canceled) return;
      if (job.overflow) {
        await finish(job, 'failed', 502, '任务输出超过限制，请缩小处理范围后重试。');
        return;
      }
      if (job.timedOut) {
        await finish(job, 'failed', 504, '任务超时，请重试。');
        return;
      }
      if (signal.aborted) {
        await finish(job, 'failed', 499, '任务已中断，请重试。');
        return;
      }
      if (!outcome || !(outcome.status < 400)) {
        await finish(job, 'failed', outcome?.status || 502, outcome?.error || '任务暂时无法完成，请重试。');
        return;
      }
      const content = JSON.stringify(outcome.result ?? null);
      if (Buffer.byteLength(content) > MAX_RESULT_BYTES) {
        await finish(job, 'failed', 502, '任务结果过大，请重试。');
        return;
      }
      await saveFile(resultFile(job), content);
      job.result = outcome.result ?? null;
      await finish(job, 'done', 200, null);
    } catch (error) {
      if (closing || job.canceled) return;
      if (job.timedOut) await finish(job, 'failed', 504, '任务超时，请重试。');
      else if (job.overflow) await finish(job, 'failed', 502, '任务输出超过限制，请稍后重试。');
      else if (signal.aborted) await finish(job, 'failed', 499, '任务已中断，请重试。');
      else {
        logStorageError(error);
        await finish(job, 'failed', 502, '任务暂时无法完成，请重试。');
      }
    } finally {
      clearTimeout(timer);
      job.controller = null;
      active--;
      pump();
    }
  }

  function pump() {
    if (closing || active >= concurrency) return;
    const queued = [...jobs.values()].filter(job => job.meta.phase === 'queued')
      .sort((a, b) => a.meta.createdAt - b.meta.createdAt);
    for (const job of queued.slice(0, concurrency - active)) {
      job.controller = new AbortController();
      active++;
      void run(job);
    }
  }

  async function restore() {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !taskId.test(entry.name)) continue;
      const meta = await readFile(path.join(directory, entry.name, 'job.json'), 'utf8')
        .then(JSON.parse).catch(() => null);
      if (!meta || meta.id !== entry.name || !owners.has(meta.owner) ||
          !Object.hasOwn(kinds, meta.kind) || !['queued', 'running'].includes(meta.phase) && !terminal.has(meta.phase)) {
        await rm(path.join(directory, entry.name), { recursive: true, force: true }).catch(logStorageError);
        continue;
      }
      const text = await readFile(path.join(directory, entry.name, 'events.jsonl'), 'utf8').catch(() => '');
      const job = {
        meta,
        controller: null,
        write: Promise.resolve(),
        append: Promise.resolve(),
        chunks: text.split('\n\n').filter(Boolean).map(item => item + '\n\n'),
        bytes: Buffer.byteLength(text),
        result: await readFile(path.join(directory, entry.name, 'result.json'), 'utf8')
          .then(JSON.parse).catch(() => null),
        payload: null,
      };
      jobs.set(meta.id, job);
      // 服务重启后 codex 回合无法续接：中断的任务只能明确失败，保留已产生的事件。
      if (!terminal.has(meta.phase)) {
        await finish(job, 'failed', 503, '服务已重启，任务已中断，请重新提交。');
      } else {
        await rm(inputFile(job), { force: true }).catch(logStorageError);
      }
    }
    await prune();
    pump();
  }

  return {
    /** 提交任务；相同 kind + 归属 + 参数且仍在进行中时复用同一任务。 */
    async submit({ kind, owner, ownership, payload } = {}) {
      await ready;
      if (!owner || !owners.has(owner)) throw taskJobError(400, '任务访问范围无效（invalid owner）。');
      if (!kind || !Object.hasOwn(kinds, kind)) throw taskJobError(400, '未知任务类型（unknown task kind）。');
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw taskJobError(400, '任务参数无效（invalid payload）。');
      }
      const normalized = normalizeOwnership(ownership);
      const content = stableJson(payload);
      if (Buffer.byteLength(content) > MAX_REQUEST_BYTES) {
        throw taskJobError(413, '任务参数过大，请缩小后重试。');
      }
      const key = digest([kind, normalized.projectId, normalized.schemeId, content].join('\u0000'));

      const active = [...jobs.values()].find(job =>
        job.meta.key === key && job.meta.owner === owner && !terminal.has(job.meta.phase));
      if (active) return { ...describe(active), reused: true };

      const pending = [...jobs.values()].filter(job => !terminal.has(job.meta.phase));
      if (pending.length >= capacity) throw taskJobError(429, '后台任务队列已满，请稍后重试。');

      const id = 'task-' + randomUUID();
      const now = Date.now();
      const meta = {
        id, kind, owner, key, ownership: normalized, phase: 'queued', status: null, error: null,
        createdAt: now, updatedAt: now, startedAt: null, finishedAt: null,
      };
      const job = {
        meta, key, controller: null, write: Promise.resolve(), append: Promise.resolve(),
        chunks: [], bytes: 0, result: null, payload,
      };
      await mkdir(folder(job), { recursive: true, mode: 0o700 });
      try {
        await writeFile(inputFile(job), JSON.stringify(payload), { mode: 0o600, flag: 'wx' });
        await saveFile(manifest(job), JSON.stringify(meta));
      } catch (error) {
        await rm(folder(job), { recursive: true, force: true }).catch(logStorageError);
        throw error;
      }
      jobs.set(id, job);
      pump();
      return { ...describe(job), reused: false };
    },

    /** 轮询：返回游标之后的事件帧、终态标记与最终结果。 */
    async get(owner, id, cursor = 0) {
      await ready;
      const job = jobs.get(id);
      if (!job || job.meta.owner !== owner) return null;
      if (!Number.isInteger(cursor) || cursor < 0 || cursor > job.chunks.length) {
        throw taskJobError(400, '读取位置无效（invalid cursor）。');
      }
      const chunks = job.chunks.slice(cursor, cursor + MAX_POLL_FRAMES);
      const next = cursor + chunks.length;
      const completed = terminal.has(job.meta.phase);
      return {
        ...describe(job),
        cursor: next,
        chunks,
        done: completed && next === job.chunks.length,
        ...(completed && job.result !== null ? { result: job.result } : {}),
      };
    },

    /** 当前访问范围内的任务（供项目列表显示可回来的入口）。 */
    async list(owner) {
      await ready;
      await prune();
      return allFor(owner).map(describe);
    },

    async cancel(owner, id) {
      await ready;
      const job = jobs.get(id);
      if (!job || job.meta.owner !== owner) return false;
      if (terminal.has(job.meta.phase)) return true;
      job.canceled = true;
      job.controller?.abort();
      await finish(job, 'canceled', 410, '任务已取消。');
      await prune();
      return true;
    },

    /** 供测试与运维显式触发保留期清理。 */
    async prune() {
      await ready;
      await prune();
    },

    close() {
      closing = true;
      clearInterval(sweep);
      for (const job of jobs.values()) job.controller?.abort();
    },
  };
}
