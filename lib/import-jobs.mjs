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
const importStages = ['queued', 'preparing', 'waiting-model', 'recognizing', 'validating'];
const reviewStages = ['queued', 'preparing', 'waiting-model', 'comparing', 'validating'];
const maxProgressMessage = 360;

function progressMessage(text) {
  if (typeof text !== 'string') return '';
  const message = text.slice(0, maxProgressMessage * 4)
    .replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!message || message.startsWith('{') || message.startsWith('[') || message.includes('```')) return '';
  if (message.length <= maxProgressMessage) return message;
  return message.slice(0, maxProgressMessage - 1).replace(/[\uD800-\uDBFF]$/, '').trimEnd() + '…';
}

function setProgress(job, key, stages, stage, text) {
  const previous = job[key];
  if (!stages.includes(stage) || stages.indexOf(stage) < stages.indexOf(previous?.stage)) return;
  const message = progressMessage(text) || previous?.message;
  if (stage !== previous?.stage || message !== previous?.message) {
    job[key] = { stage, updatedAt: Date.now(), ...(message ? { message } : {}) };
  }
}

export function isImportJobPath(pathname) {
  if (pathname === collection) return true;
  if (!pathname.startsWith(prefix)) return false;
  const rest = pathname.slice(prefix.length);
  if (importId.test(rest)) return true;
  // /api/jobs/<id>/review 复用任务级接口；id 之后只允许这一种后缀。
  const review = /^(.+)\/review$/.exec(rest);
  return Boolean(review && importId.test(review[1]));
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

  function reviewFile(job) {
    return path.join(directory, job.meta.id, 'review.json');
  }

  function describe(job) {
    const { owner, status, error, ...visible } = job.meta;
    const { phase, review, createdAt, startedAt, finishedAt } = visible;
    const importStage = phase === 'running' ? 'preparing' : phase;
    const progress = job.progress ?? { stage: importStage, updatedAt: finishedAt ?? startedAt ?? createdAt };
    if (!review) return { ...visible, progress };
    const reviewStage = { pending: 'queued', running: 'preparing', match: 'done', differ: 'done' }[review.state]
      ?? 'unavailable';
    return {
      ...visible, progress,
      review: { ...review, progress: job.reviewProgress ?? { stage: reviewStage, updatedAt: review.updatedAt } },
    };
  }

  function update(job, changes) {
    const meta = { ...job.meta, ...changes, updatedAt: Date.now() };
    job.meta = meta;
    job.write = job.write.catch(() => {}).then(() => saveFile(manifest(job), JSON.stringify(meta)));
    return job.write;
  }

  /** 复核状态浅合并进 meta.review，并持久化 manifest。 */
  function updateReview(job, patch) {
    const review = { ...(job.meta.review || {}), updatedAt: Date.now(), ...(patch || {}) };
    if (patch?.state === 'pending' || patch?.state === 'unavailable') job.reviewProgress = null;
    if (patch?.state === 'match' || patch?.state === 'differ') {
      const message = job.reviewProgress?.message;
      job.reviewProgress = { stage: 'done', updatedAt: Date.now(), ...(message ? { message } : {}) };
    }
    return update(job, { review });
  }

  function updateReviewProgress(job, stage, text) {
    if (closing || !['pending', 'running'].includes(job.meta.review?.state)) return;
    setProgress(job, 'reviewProgress', reviewStages, stage, text);
  }

  function writeReview(job, review) {
    return job.write.catch(() => {}).then(() => saveFile(reviewFile(job), JSON.stringify(review)));
  }

  function allFor(owner) {
    return [...jobs.values()].filter(job => job.meta.owner === owner)
      .sort((a, b) => b.meta.createdAt - a.meta.createdAt);
  }

  async function prune() {
    const now = Date.now();
    const expired = [];
    // 复核进行中的任务（pending / running）仍会被写入 job.json 和 review.json，不能删除。
    const reviewing = job => job.meta.review?.state === 'pending' || job.meta.review?.state === 'running';
    for (const owner of owners) {
      const ended = allFor(owner).filter(job =>
        terminal.has(job.meta.phase) && !job.controller && !job.reviewController && !reviewing(job));
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
      if (job.meta.review === undefined) job.meta.review = null;
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
      // 服务重启后，未完成的复核不可能继续；标记为不可用，前端保持静默。
      if (job.meta.phase === 'done' &&
          (job.meta.review?.state === 'pending' || job.meta.review?.state === 'running')) {
        await update(job, {
          review: { ...job.meta.review, state: 'unavailable', count: 0, updatedAt: Date.now() },
        }).catch(logStorageError);
        await rm(reviewFile(job), { force: true }).catch(logStorageError);
      }
      // 复核正文已完整落盘、meta 却停在 unavailable（写盘成功但调用方误判等）：
      // 以磁盘上的结果为准恢复状态，避免「结果存在但看不了」。
      if (job.meta.phase === 'done' && job.meta.review?.state === 'unavailable') {
        const stored = await readFile(reviewFile(job), 'utf8').then(JSON.parse).catch(() => null);
        if (stored && (stored.state === 'match' || stored.state === 'differ')) {
          await update(job, {
            review: {
              state: stored.state,
              count: Array.isArray(stored.issues) ? stored.issues.length : 0,
              updatedAt: Number.isFinite(+stored.updatedAt) ? +stored.updatedAt : Date.now(),
            },
          }).catch(logStorageError);
        } else {
          await rm(reviewFile(job), { force: true }).catch(logStorageError);
        }
      }
    }
    await prune();
    pump();
  }

  async function finish(job, phase, status, error, changes) {
    const finishedAt = Date.now();
    const message = phase === 'done' && job.progress?.message;
    job.progress = { stage: phase, updatedAt: finishedAt, ...(message ? { message } : {}) };
    await update(job, { phase, status, error, finishedAt, ...(changes || {}) }).catch(logStorageError);
    await rm(inputFile(job), { force: true }).catch(logStorageError);
  }

  async function run(job) {
    let followUp = null;
    const { signal } = job.controller;
    try {
      await update(job, { phase: 'running', startedAt: Date.now() });
      const body = JSON.parse(await readFile(inputFile(job), 'utf8'));
      if (signal.aborted) return;
      const result = await execute(body, {
        id: job.meta.id,
        owner: job.meta.owner,
        workDirectory: path.join(directory, job.meta.id, 'work'),
        signal,
        onProgress: (stage, text) => {
          if (!signal.aborted && job.meta.phase === 'running') {
            setProgress(job, 'progress', importStages, stage, text);
          }
        },
      });
      if (signal.aborted) return;
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
      // 复核在识别成功后才运行；它不占用识别并发槽位，由 finally 之后的逻辑启动。
      const reviewNext = !signal.aborted && !closing &&
        typeof result?.after === 'function';
      if (!signal.aborted) {
        // 与 done 同一次写入占用复核状态，堵住「识别完成但复核还没标记」的窗口，
        // 避免此时到达的 POST /review 并发跑第二份复核。
        await finish(job, 'done', result.status, null, reviewNext
          ? { review: { state: 'pending', count: 0, updatedAt: Date.now() } } : null);
        if (reviewNext) followUp = result.after;
      }
    } catch (error) {
      if (signal.aborted) return;
      logStorageError(error);
      await finish(job, 'failed', 502, '图纸识别暂时无法完成，请重新提交。');
    } finally {
      job.controller = null;
      active--;
      pump();
    }

    if (!followUp || closing) return;
    const controller = new AbortController();
    job.reviewController = controller;
    try {
      await followUp({
        signal: controller.signal,
        updateReview: (patch) => updateReview(job, patch),
        onProgress: (stage, text) => {
          if (!controller.signal.aborted) updateReviewProgress(job, stage, text);
        },
        // 与 store.saveReview 的契约一致：成功返回 true，调用方据此判断是否落盘成功。
        saveReview: (review) => writeReview(job, review).then(() => true),
      });
    } catch (error) {
      logStorageError(error);
    } finally {
      job.reviewController = null;
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
          createdAt: now, updatedAt: now, startedAt: null, finishedAt: null, review: null,
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
        return describe({ meta });
      } finally {
        uploads--;
      }
    },

    async list(owner) {
      await ready;
      await prune();
      return allFor(owner).map(describe);
    },

    async get(owner, id, cursor) {
      await ready;
      const job = jobs.get(id);
      if (!job || job.meta.owner !== owner) return null;
      const meta = job.meta;
      const description = describe(job);
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
        ...description, status: meta.status, chunks, cursor: cursor + chunks.length,
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

    /** 读取复核结果；不存在、owner 不符或状态不可用时返回 null。 */
    async getReview(owner, id) {
      await ready;
      const job = jobs.get(id);
      if (!job || job.meta.owner !== owner) return null;
      const state = job.meta.review?.state;
      if (state !== 'match' && state !== 'differ') return null;
      const text = await readFile(reviewFile(job), 'utf8').catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (text === null) return null;
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    },

    /** 合并 meta.review（POST 重跑 / 状态流转）；任务不存在或 owner 不符返回 null。 */
    async setReview(owner, id, patch) {
      await ready;
      const job = jobs.get(id);
      if (!job || job.meta.owner !== owner) return null;
      await updateReview(job, patch).catch(logStorageError);
      return job.meta.review;
    },

    async setReviewProgress(owner, id, stage, text) {
      await ready;
      const job = jobs.get(id);
      if (job?.meta.owner === owner) updateReviewProgress(job, stage, text);
    },

    /** 识别工作目录；不存在或 owner 不符返回 null。 */
    async workDirectory(owner, id) {
      await ready;
      const job = jobs.get(id);
      if (!job || job.meta.owner !== owner) return null;
      const folder = path.join(directory, id, 'work');
      const info = await stat(folder).catch(() => null);
      return info?.isDirectory() ? folder : null;
    },

    /** 供服务端保存复核结果（POST 重跑时复用）。 */
    async saveReview(owner, id, review) {
      await ready;
      const job = jobs.get(id);
      if (!job || job.meta.owner !== owner) return false;
      try {
        await writeReview(job, review);
        return true;
      } catch (error) {
        logStorageError(error);
        return false;
      }
    },

    close() {
      closing = true;
      clearInterval(sweep);
      for (const job of jobs.values()) {
        job.controller?.abort();
        job.reviewController?.abort();
      }
    },
  };
}
