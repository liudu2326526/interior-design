import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const prefix = '/api/jobs/';
const collection = prefix + 'plan-import';
const importId = /^import-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const terminal = new Set(['done', 'failed', 'canceled']);
const owners = new Set(['local', 'remote']);
const maxResult = 4 * 1024 * 1024;
const retention = 7 * 24 * 60 * 60_000;
const pendingAgeLimit = 3 * 60 * 60_000;

export function isImportJobPath(pathname) {
  return pathname === collection || (pathname.startsWith(prefix) && importId.test(pathname.slice(prefix.length)));
}

export function importJobError(status, message) {
  return Object.assign(new Error(message), { status });
}

async function saveFile(file, data) {
  const temp = file + '.tmp';
  await writeFile(temp, data, { mode: 0o600 });
  await rename(temp, file);
}

function logStorageError(error) {
  console.error('图纸任务存储异常（drawing job storage）:', error.message);
}

export function createImportJobs({ directory, execute, concurrency = 2, capacity = 8, history = 32 }) {
  const jobs = new Map();
  let uploads = 0;
  let active = 0;
  let closing = false;
  const ready = restore();
  ready.catch(logStorageError);
  const sweep = setInterval(() => {
    if (!closing) void ready.then(prune).catch(logStorageError);
  }, 5 * 60_000);
  sweep.unref();

  function manifest(job) {
    return path.join(directory, job.meta.id, 'job.json');
  }

  function inputFile(job) {
    return path.join(directory, job.meta.id, 'input.json');
  }

  function resultFile(job) {
    return path.join(directory, job.meta.id, 'result.json');
  }

  function describe({ owner, status, error, ...visible }) {
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
      rm(path.dirname(manifest(job)), { recursive: true, force: true }).catch(logStorageError)));
  }

  async function restore() {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !importId.test(entry.name)) continue;
      const folder = path.join(directory, entry.name);
      const meta = await readFile(path.join(folder, 'job.json'), 'utf8').then(JSON.parse).catch(() => null);
      if (!meta || meta.id !== entry.name || !owners.has(meta.owner) ||
          (!terminal.has(meta.phase) && !['queued', 'running'].includes(meta.phase))) {
        await rm(folder, { recursive: true, force: true }).catch(logStorageError);
        continue;
      }
      const job = { meta, controller: null, write: Promise.resolve() };
      jobs.set(meta.id, job);
      await rm(path.join(folder, 'work'), { recursive: true, force: true }).catch(logStorageError);
      if (terminal.has(meta.phase)) {
        await rm(inputFile(job), { force: true }).catch(logStorageError);
        if (meta.phase !== 'done') await rm(resultFile(job), { force: true }).catch(logStorageError);
      } else if ((await stat(resultFile(job)).catch(() => null))?.isFile()) {
        // The service may have stopped after saving the result and before updating the state.
        await finish(job, 'done', 200, null);
      } else if (Date.now() - meta.createdAt >= pendingAgeLimit) {
        await finish(job, 'failed', 504, '图纸识别等待时间过长，请重新提交。');
      } else if (meta.phase === 'running') {
        await update(job, { phase: 'queued', startedAt: null }).catch(logStorageError);
      }
    }
    await prune();
    pump();
  }

  async function finish(job, phase, status, error) {
    await update(job, { phase, status, error, finishedAt: Date.now() }).catch(logStorageError);
    await rm(inputFile(job), { force: true }).catch(logStorageError);
  }

  async function run(job) {
    try {
      await update(job, { phase: 'running', startedAt: Date.now() });
      const body = JSON.parse(await readFile(inputFile(job), 'utf8'));
      if (job.controller.signal.aborted) return;
      const result = await execute(body, {
        id: job.meta.id,
        owner: job.meta.owner,
        workDirectory: path.join(directory, job.meta.id, 'work'),
        signal: job.controller.signal,
      });
      if (job.controller.signal.aborted) return;
      if (result.status >= 400) {
        await finish(job, 'failed', result.status, result.body.error || '图纸识别失败，请重试。');
        return;
      }
      const content = JSON.stringify(result.body);
      if (Buffer.byteLength(content) > maxResult) {
        await finish(job, 'failed', 502, '识别结果过大，请缩小图纸范围后重试。');
        return;
      }
      await saveFile(resultFile(job), content);
      if (!job.controller.signal.aborted) await finish(job, 'done', result.status, null);
    } catch (error) {
      if (job.controller.signal.aborted) return;
      logStorageError(error);
      await finish(job, 'failed', 502, '图纸识别暂时无法完成，请重新提交。');
    } finally {
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

  return {
    async submit(owner, read) {
      await ready;
      const pending = [...jobs.values()].filter(job => !terminal.has(job.meta.phase)).length;
      if (uploads + pending >= capacity) throw importJobError(429, '图纸任务队列已满，请稍后重试。');
      uploads++;
      try {
        const { body, name } = await read();
        const id = 'import-' + randomUUID();
        const now = Date.now();
        const meta = {
          id, owner, name, phase: 'queued', status: null, error: null,
          createdAt: now, updatedAt: now, startedAt: null, finishedAt: null,
        };
        const job = { meta, controller: null, write: Promise.resolve() };
        const folder = path.join(directory, id);
        await mkdir(folder, { mode: 0o700 });
        try {
          await writeFile(inputFile(job), JSON.stringify(body), { mode: 0o600, flag: 'wx' });
          await saveFile(manifest(job), JSON.stringify(meta));
        } catch (error) {
          await rm(folder, { recursive: true, force: true }).catch(logStorageError);
          throw error;
        }
        jobs.set(id, job);
        pump();
        return describe(meta);
      } finally {
        uploads--;
      }
    },

    async list(owner) {
      await ready;
      await prune();
      return allFor(owner).map(job => describe(job.meta));
    },

    async get(owner, id, cursor) {
      await ready;
      const job = jobs.get(id);
      if (!job || job.meta.owner !== owner) return null;
      const meta = job.meta;
      const hasResult = meta.phase === 'done';
      if (!Number.isInteger(cursor) || cursor < 0 || cursor > Number(hasResult)) {
        throw importJobError(400, '读取位置无效。');
      }
      const output = hasResult && cursor === 0 ? await readFile(resultFile(job), 'utf8').catch(error => {
        if (error.code !== 'ENOENT' || jobs.has(id)) throw error;
        return null;
      }) : '';
      if (output === null) return null;
      const chunks = output ? [output] : [];
      return {
        ...describe(meta), status: meta.status, chunks, cursor: cursor + chunks.length,
        done: terminal.has(meta.phase), mediaType: hasResult ? 'application/json; charset=utf-8' : null,
        ...(meta.error ? { error: meta.error } : {}),
      };
    },

    async cancel(owner, id) {
      await ready;
      const job = jobs.get(id);
      if (!job || job.meta.owner !== owner) return false;
      if (terminal.has(job.meta.phase)) return true;
      job.controller?.abort();
      await finish(job, 'canceled', 410, '图纸任务已取消。');
      await prune();
      return true;
    },

    close() {
      closing = true;
      clearInterval(sweep);
      for (const job of jobs.values()) job.controller?.abort();
    },
  };
}
