import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { test } from 'node:test';
import { createImportJobs, isImportJobPath } from '../lib/import-jobs.mjs';

async function fixture(t, execute, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'studio-review-'));
  const stores = [];
  const open = (worker, overrides = {}) => {
    const store = createImportJobs({ directory, execute: worker, ...options, ...overrides });
    stores.push(store);
    return store;
  };
  t.after(async () => {
    stores.forEach(store => store.close());
    await rm(directory, { recursive: true, force: true });
  });
  return { store: open(execute), open, directory };
}

const submit = (store, owner, name) => store.submit(owner, () => ({ body: { name }, name }));

async function archiveDrawing(body, folder) {
  await mkdir(folder, { mode: 0o700 });
  await writeFile(path.join(folder, '原图.png'), Buffer.from(body.name), { mode: 0o600 });
  await writeFile(path.join(folder, '.upload.json'), JSON.stringify({ files: ['原图.png'] }), { mode: 0o600 });
}

async function until(check) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const found = await check();
    if (found) return found;
    await wait(10);
  }
  assert.fail('未等到预期状态（timed out waiting for state）');
}

function waitForInputCleanup(directory, id) {
  // A job reports done before its worker finishes deleting the request file.
  return until(() => stat(path.join(directory, id, 'input.json')).then(() => false, error => {
    if (error.code === 'ENOENT') return true;
    throw error;
  }));
}

async function success(body, context) {
  await mkdir(context.workDirectory, { recursive: true });
  return { status: 200, body: { plan: { name: body.name } } };
}

test('a finished import can run a review hook without blocking the queue', async t => {
  const executed = [];
  let releaseAfter;
  const gate = new Promise(resolve => { releaseAfter = resolve; });
  const { store, directory } = await fixture(t, async (body, context) => {
    executed.push(body.name);
    if (body.name !== '第一个') return success(body, context);
    return {
      ...(await success(body, context)),
      after: async ({ updateReview, saveReview }) => {
        await updateReview({ state: 'running', count: 0 });
        await gate;
        const review = {
          state: 'differ',
          summary: '入户门位置有偏差。',
          issues: [{ where: '门', detail: '入户门偏移 200mm' }],
          fixed: null,
          delta: { rooms: { before: 1, after: 1 }, area: { before: 10, after: 10 } },
          updatedAt: Date.now(),
        };
        // 自动复核走的是 importJobs 的 after 钩子；成功写盘必须返回 true，
        // 否则调用方会把 undefined 当成失败并把结果标记为 unavailable。
        assert.equal(await saveReview(review), true, 'saveReview 成功时应返回 true');
        await updateReview({ state: 'differ', count: 1, updatedAt: review.updatedAt });
      },
    };
  }, { concurrency: 1 });

  const first = await submit(store, 'local', '第一个');
  assert.equal(first.review, null, '新建任务 review 应为 null');
  await until(() => executed.includes('第一个'));

  // 复核钩子还在等 gate，识别槽位必须已经释放，第二个任务能开始执行。
  const second = await submit(store, 'local', '第二个');
  await until(() => executed.includes('第二个'));
  await until(async () => (await store.get('local', second.id, 0)).phase === 'done');

  const done = await until(async () => {
    const job = await store.get('local', first.id, 0);
    return job.done && job.review?.state === 'running' && job;
  });
  assert.equal(done.review.state, 'running');
  releaseAfter();

  const review = await until(async () => {
    const list = await store.list('local');
    const job = list.find(item => item.id === first.id);
    return job?.review?.state === 'differ' && job.review;
  });
  assert.equal(review.count, 1);

  const stored = await store.getReview('local', first.id);
  assert.equal(stored.state, 'differ');
  assert.equal(stored.summary, '入户门位置有偏差。');
  assert.equal(stored.issues.length, 1);

  const reviewFile = path.join(directory, first.id, 'review.json');
  const raw = JSON.parse(await readFile(reviewFile, 'utf8'));
  assert.equal(raw.state, 'differ');
  assert.equal((await stat(reviewFile)).mode & 0o777, 0o600);
  assert.equal((await stat(path.join(directory, first.id, 'job.json'))).mode & 0o777, 0o600);

  const list = await store.list('local');
  assert.ok(list.every(job => Object.hasOwn(job, 'review')), '列表必须带 review 字段');
  assert.equal((await store.list('remote')).length, 0);
});

test('close aborts a review that is still running', async t => {
  let reviewSignal = null;
  const { store } = await fixture(t, async (body, context) => {
    await mkdir(context.workDirectory, { recursive: true });
    return {
      status: 200,
      body: { plan: { name: body.name } },
      after: ({ signal }) => {
        reviewSignal = signal;
        return new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      },
    };
  });
  await submit(store, 'local', '关闭');
  await until(() => reviewSignal);
  assert.equal(reviewSignal.aborted, false);
  store.close();
  assert.equal(reviewSignal.aborted, true);
});

test('restore turns interrupted reviews into unavailable and keeps the manifest consistent', async t => {
  let executing = 0;
  const { store, open } = await fixture(t, async (body, context) => {
    executing++;
    return success(body, context);
  });
  const first = await submit(store, 'local', '待复核');
  const second = await submit(store, 'local', '复核中');
  await until(async () => {
    const list = await store.list('local');
    return list.length === 2 && list.every(job => job.phase === 'done');
  });
  await store.setReview('local', first.id, { state: 'pending', count: 0 });
  await store.setReview('local', second.id, { state: 'running', count: 0 });
  store.close();

  const restored = open(() => assert.fail('已完成的识别不应重新执行'));
  const list = await restored.list('local');
  assert.equal(list.length, 2);
  for (const job of list) {
    assert.equal(job.review.state, 'unavailable');
    assert.equal(job.review.count, 0);
    assert.equal(typeof job.review.updatedAt, 'number');
  }
  assert.equal(await restored.getReview('local', first.id), null);
  assert.equal(executing, 2);
});

test('restore adopts a review that was fully written but marked unavailable', async t => {
  const { store, open } = await fixture(t, (body, context) => success(body, context));
  const job = await submit(store, 'local', '已落盘');
  await until(async () => (await store.get('local', job.id, 0)).done);
  const review = {
    state: 'differ', summary: '入户门有偏差。',
    issues: [{ where: '门', detail: '偏移 200mm' }], fixed: null, delta: {}, updatedAt: Date.now(),
  };
  assert.equal(await store.saveReview('local', job.id, review), true);
  // 模拟「review.json 已写好，但 meta 被误标为 unavailable」的历史坏状态。
  await store.setReview('local', job.id, { state: 'unavailable', count: 0 });
  store.close();

  const restored = open(() => assert.fail('已完成的识别不应重新执行'));
  const row = (await restored.list('local')).find(item => item.id === job.id);
  assert.equal(row.review.state, 'differ');
  assert.equal(row.review.count, 1);
  const stored = await restored.getReview('local', job.id);
  assert.equal(stored.state, 'differ');
  assert.equal(stored.summary, '入户门有偏差。');
});

test('a finished import marks its review pending before the hook takes over', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { store } = await fixture(t, async (body, context) => ({
    ...(await success(body, context)),
    after: async () => { await gate; },
  }));
  const job = await submit(store, 'local', '待复核');
  const done = await until(async () => {
    const item = await store.get('local', job.id, 0);
    return item.phase === 'done' && item;
  });
  assert.equal(done.review.state, 'pending', '识别完成时复核状态就应占用，避免 POST 重跑插队');
  assert.equal(done.review.count, 0);
  release();
});

test('prune keeps jobs whose review is still pending or running', async t => {
  const { store } = await fixture(t, (body, context) => success(body, context), { history: 1 });
  const first = await submit(store, 'local', '复核中');
  await wait(5);
  await submit(store, 'local', '较旧');
  await wait(5);
  const newest = await submit(store, 'local', '最新');
  await until(async () => {
    const ids = [first.id, newest.id];
    const phases = await Promise.all(ids.map(id => store.get('local', id, 0)));
    return phases.every(job => job?.done);
  });
  await store.setReview('local', first.id, { state: 'running', count: 0 });
  const list = await store.list('local');
  assert.ok(list.some(job => job.id === first.id), '复核进行中的任务不应被清理');
  assert.ok(list.some(job => job.id === newest.id));
});

test('review URLs are accepted by the job path guard and owner isolation holds', async t => {
  const { store } = await fixture(t, (body, context) => success(body, context));
  const job = await submit(store, 'local', '隔离');
  await until(async () => (await store.get('local', job.id, 0)).done);

  assert.ok(isImportJobPath('/api/jobs/plan-import'));
  assert.ok(isImportJobPath('/api/jobs/' + job.id));
  assert.ok(isImportJobPath('/api/jobs/' + job.id + '/review'));
  assert.ok(!isImportJobPath('/api/jobs/' + job.id + '/reviewx'));
  assert.ok(!isImportJobPath('/api/jobs/' + job.id + '/reviews'));
  assert.ok(!isImportJobPath('/api/jobs/import-00000000-0000-0000-0000-000000000000'));

  assert.equal(await store.getReview('local', job.id), null, '还没有复核结果时返回 null');
  assert.equal(await store.getReview('remote', job.id), null, '他人任务返回 null');
  const payload = {
    state: 'match', summary: '一致', issues: [], fixed: null,
    delta: {}, updatedAt: Date.now(),
  };
  assert.equal(await store.saveReview('local', job.id, payload), true);
  await store.setReview('local', job.id, { state: 'match', count: 0 });
  const review = await store.getReview('local', job.id);
  assert.equal(review.state, 'match');
  assert.equal(await store.getReview('remote', job.id), null);

  const workDirectory = await store.workDirectory('local', job.id);
  assert.ok(workDirectory && workDirectory.endsWith(path.join(job.id, 'work')));
  assert.equal(await store.workDirectory('remote', job.id), null);
  assert.equal(await store.workDirectory('local', 'import-00000000-0000-4000-8000-000000000000'), null);
});

test('setReview merges into the manifest atomically and is listed with the job', async t => {
  const { store, directory } = await fixture(t, (body, context) => success(body, context));
  const job = await submit(store, 'local', '合并');
  await until(async () => (await store.get('local', job.id, 0)).done);
  const updated = await store.setReview('local', job.id, { state: 'running', count: 2 });
  assert.equal(updated.state, 'running');
  const merged = await store.setReview('local', job.id, { count: 3 });
  assert.equal(merged.state, 'running', '浅合并应保留旧字段');
  assert.equal(merged.count, 3);
  const meta = JSON.parse(await readFile(path.join(directory, job.id, 'job.json'), 'utf8'));
  assert.equal(meta.review.state, 'running');
  assert.equal(meta.review.count, 3);
  assert.equal(await store.setReview('remote', job.id, { state: 'match' }), null);
});

test('keeps review progress separate from result version and resets it on a rerun', async t => {
  let entered;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { store, directory } = await fixture(t, async (body, context) => ({
    ...await success(body, context),
    after: async ({ onProgress, updateReview }) => {
      onProgress('preparing');
      onProgress('waiting-model');
      entered = true;
      await gate;
      await updateReview({ state: 'running' });
      onProgress('comparing', '正在比较外墙。');
      onProgress('validating', '外墙与原图一致。');
      await updateReview({ state: 'match', updatedAt: 123 });
    },
  }));
  const { id } = await submit(store, 'local', '复核进度');
  await until(() => entered);
  const { review: waiting } = await store.get('local', id, 1);
  assert.equal(waiting.state, 'pending');
  assert.equal(waiting.progress.stage, 'waiting-model');
  await store.setReviewProgress('remote', id, 'validating', '未经许可更新');
  assert.deepEqual((await store.get('local', id, 1)).review, waiting);

  release();
  const finished = await until(async () => {
    const { review } = await store.get('local', id, 1);
    return review.state === 'match' && review;
  });
  assert.equal(finished.updatedAt, 123);
  assert.equal(finished.progress.stage, 'done');
  assert.equal(finished.progress.message, '外墙与原图一致。');
  assert.ok(finished.progress.updatedAt > 123);

  await store.setReview('local', id, { state: 'pending', updatedAt: 456 });
  const { review: pending } = await store.get('local', id, 1);
  assert.deepEqual(pending.progress, { stage: 'queued', updatedAt: 456 });
  await store.setReviewProgress('local', id, 'preparing', '检查原始户型图');
  const { review: preparing } = await store.get('local', id, 1);
  assert.equal(preparing.progress.message, '检查原始户型图');
  assert.equal(preparing.updatedAt, 456);
  const saved = JSON.parse(await readFile(path.join(directory, id, 'job.json'), 'utf8'));
  assert.equal(Object.hasOwn(saved.review, 'progress'), false);
  await store.setReview('local', id, { state: 'unavailable' });
  assert.equal((await store.get('local', id, 1)).review.progress.message, undefined);
});

test('keeps originals and results by owner and ID beyond both recent-list limits and a restart', async t => {
  const { store, open, directory } = await fixture(t, success, { history: 1, archiveInput: archiveDrawing });
  const first = await submit(store, 'remote', '底图一');
  assert.equal(first.sourceArchived, true);
  const folder = path.join(directory, first.id);
  assert.equal(await readFile(path.join(folder, 'source', '原图.png'), 'utf8'), '底图一');
  await until(async () => (await store.get('remote', first.id, 0)).done);
  const second = await submit(store, 'remote', '底图二');
  await until(async () => (await store.get('remote', second.id, 0)).done);
  await until(async () => {
    const visible = await store.list('remote');
    return visible.length === 1 && visible[0].id === second.id;
  });
  assert.equal(await store.get('local', first.id, 0), null);
  assert.equal(await store.sourceDirectory('local', first.id), null);
  assert.deepEqual(await store.list('local', [first.id]), []);
  assert.deepEqual((await store.list('remote', [first.id, first.id])).map(job => job.id), [second.id, first.id]);
  assert.equal(JSON.parse((await store.get('remote', first.id, 0)).chunks[0]).plan.name, '底图一');
  store.close();

  const file = path.join(folder, 'job.json');
  const meta = JSON.parse(await readFile(file, 'utf8'));
  meta.updatedAt = meta.createdAt = meta.finishedAt = Date.now() - 9 * 24 * 60 * 60_000;
  await writeFile(file, JSON.stringify(meta));
  const restored = open(() => assert.fail('archived imports must not be re-executed'));
  assert.deepEqual((await restored.list('remote')).map(job => job.id), [second.id]);
  assert.equal(await restored.workDirectory('remote', first.id), null);
  assert.equal(await restored.sourceDirectory('remote', first.id), path.join(folder, 'source'));

  await restored.setReview('remote', first.id, { state: 'pending', count: 0 });
  assert.equal((await restored.list('remote')).length, 2, 'a recent job and an active archived review remain visible');
  const review = { state: 'match', issues: [], summary: '一致', updatedAt: Date.now() };
  assert.equal(await restored.saveReview('remote', first.id, review), true);
  await restored.setReview('remote', first.id, { state: 'match', count: 0 });
  assert.deepEqual((await restored.list('remote')).map(job => job.id), [first.id], 'recently reviewed older project is discoverable');
  assert.deepEqual(await restored.getReview('remote', first.id), review);
});

test('retains uploads even when canceled or recognition fails and rejects a partial archive before accepting a job', async t => {
  const { store, directory } = await fixture(t, async (body, { signal }) => {
    if (body.name === '失败图') return { status: 422, body: { error: '识别失败' } };
    return new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  }, { history: 0, archiveInput: async (body, staging) => {
    await archiveDrawing(body, staging);
    if (body.name === '写入错误') throw new Error('archive write failed');
  } });
  await assert.rejects(submit(store, 'remote', '写入错误'), /archive write failed/);
  assert.deepEqual(await readdir(directory), []);
  const failed = await submit(store, 'remote', '失败图');
  const canceled = await submit(store, 'remote', '取消图');
  await until(async () => (await store.get('remote', failed.id, 0)).phase === 'failed');
  await store.cancel('remote', canceled.id);
  await until(async () => (await store.list('remote')).length === 0);
  for (const item of [failed, canceled]) {
    const source = await store.sourceDirectory('remote', item.id);
    assert.equal(await readFile(path.join(source, '原图.png'), 'utf8'), item.name);
  }
});

test('migrates remaining legacy inputs, work, and recovered source directories before removing scratch files', async t => {
  const { store, open, directory } = await fixture(t, success);
  const jobs = [];
  for (const name of ['旧请求', '旧工作区', '已恢复原件']) {
    const job = await submit(store, 'local', name);
    await until(async () => (await store.get('local', job.id, 0)).done);
    await waitForInputCleanup(directory, job.id);
    jobs.push(job);
  }
  store.close();
  const [request, work, recovered] = jobs.map(job => path.join(directory, job.id));
  await writeFile(path.join(request, 'input.json'), JSON.stringify({ name: jobs[0].name }));
  await writeFile(path.join(work, 'work', '原图.png'), jobs[1].name);
  await archiveDrawing({ name: jobs[2].name }, path.join(recovered, 'source'));
  const restored = open(success, {
    archiveInput: archiveDrawing,
    archiveWork: async (legacy, staging) => {
      const source = await readFile(path.join(legacy, '原图.png'), 'utf8').catch(() => null);
      if (!source) return false;
      await archiveDrawing({ name: source }, staging);
      return true;
    },
  });
  for (const job of jobs) {
    assert.equal((await restored.get('local', job.id, 0)).sourceArchived, true);
    const source = await restored.sourceDirectory('local', job.id);
    assert.equal(await readFile(path.join(source, '原图.png'), 'utf8'), job.name);
    assert.equal(await restored.workDirectory('local', job.id), null);
  }
  await assert.rejects(stat(path.join(request, 'input.json')), { code: 'ENOENT' });
});

test('a failed legacy migration keeps the only surviving files for a later recovery', async t => {
  const { store, open, directory } = await fixture(t, success);
  const job = await submit(store, 'remote', '归档待恢复');
  await until(async () => (await store.get('remote', job.id, 0)).done);
  await waitForInputCleanup(directory, job.id);
  store.close();
  const folder = path.join(directory, job.id);
  const input = JSON.stringify({ name: job.name });
  await writeFile(path.join(folder, 'input.json'), input);
  await writeFile(path.join(folder, 'work', '原图.png'), job.name);
  t.mock.method(console, 'error', () => {});
  const interrupted = open(success, {
    history: 0,
    archiveInput: async () => { throw new Error('injected storage fault'); },
  });
  assert.deepEqual(await interrupted.list('remote'), []);
  assert.equal(await readFile(path.join(folder, 'input.json'), 'utf8'), input);
  assert.equal(await readFile(path.join(folder, 'work', '原图.png'), 'utf8'), job.name);
  interrupted.close();
  const restored = open(success, { archiveInput: archiveDrawing });
  assert.equal(await readFile(path.join(await restored.sourceDirectory('remote', job.id), '原图.png'), 'utf8'), job.name);
});
