import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { test } from 'node:test';
import { createImportJobs, isImportJobPath } from '../lib/import-jobs.mjs';

async function fixture(t, execute, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'studio-jobs-'));
  const stores = [];
  const open = worker => {
    const store = createImportJobs({ directory, execute: worker, ...options });
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

async function until(check) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const found = await check();
    if (found) return found;
    await wait(10);
  }
  assert.fail('The job did not reach the expected state');
}

function success(body) {
  return { status: 200, body: { plan: { name: body.name } } };
}

test('accepts background jobs, keeps an owner-scoped queue and only returns output to the submitting owner', async t => {
  const gates = new Map();
  const seen = [];
  const { store, directory } = await fixture(t, (body, context) => {
    seen.push(context.owner);
    return new Promise(resolve => gates.set(context.id, () => resolve(success(body))));
  }, { concurrency: 1, capacity: 2 });
  const first = await submit(store, 'remote', '一层户型');
  assert.ok(isImportJobPath('/api/jobs/' + first.id));
  await until(() => gates.has(first.id));
  const second = await submit(store, 'local', '二层户型');
  await assert.rejects(submit(store, 'local', '三层户型'), { status: 429 });
  assert.equal((await store.get('remote', first.id, 0)).phase, 'running');
  assert.deepEqual((await store.list('local')).map(job => job.id), [second.id]);
  assert.deepEqual((await store.list('remote')).map(job => job.name), ['一层户型']);
  assert.equal(await store.get('local', first.id, 0), null);
  assert.equal(await store.cancel('local', first.id), false);
  assert.equal((await store.get('local', second.id, 0)).phase, 'queued');
  assert.equal((await stat(path.join(directory, first.id))).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(directory, first.id, 'input.json'))).mode & 0o777, 0o600);

  gates.get(first.id)();
  const finished = await until(async () => {
    const job = await store.get('remote', first.id, 0);
    return job.done && job;
  });
  assert.equal(finished.phase, 'done');
  assert.equal(finished.status, 200);
  assert.deepEqual(JSON.parse(finished.chunks.join('')), { plan: { name: '一层户型' } });
  assert.deepEqual((await store.get('remote', first.id, finished.cursor)).chunks, []);
  await assert.rejects(store.get('remote', first.id, 2), { status: 400 });
  await until(() => gates.has(second.id));
  gates.get(second.id)();
  await until(async () => (await store.get('local', second.id, 0)).done);
  await until(() => access(path.join(directory, first.id, 'input.json')).then(() => false, () => true));
  assert.deepEqual(seen, ['remote', 'local']);
});

test('resumes running jobs after service restart and keeps completed results without uploaded files', async t => {
  let interrupted = false;
  const { store, open, directory } = await fixture(t, (_body, { signal }) =>
    new Promise((_, reject) => signal.addEventListener('abort', () => {
      interrupted = true;
      reject(signal.reason);
    }, { once: true })));
  const pending = await submit(store, 'remote', '公寓');
  await until(async () => (await store.get('remote', pending.id, 0)).phase === 'running');
  await until(async () => JSON.parse(await readFile(path.join(directory, pending.id, 'job.json'), 'utf8')).phase === 'running');
  await wait(50);
  store.close();
  assert.equal(interrupted, true);
  const recovered = open(success);
  await until(async () => (await recovered.get('remote', pending.id, 0)).done);
  recovered.close();
  const restored = open(() => assert.fail('completed import was executed twice'));
  assert.equal((await restored.list('remote'))[0].phase, 'done');
  const job = await restored.get('remote', pending.id, 0);
  assert.deepEqual(JSON.parse(job.chunks[0]), { plan: { name: '公寓' } });
  await assert.rejects(access(path.join(directory, pending.id, 'input.json')), { code: 'ENOENT' });
});

test('cancels queued and running work and retains actionable failures', async t => {
  let activeSignal;
  const { store, directory } = await fixture(t, (body, { signal }) => {
    if (body.name === '缺少尺寸') return { status: 422, body: { error: '请补充横向尺寸。' } };
    activeSignal = signal;
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  }, { concurrency: 1 });
  const active = await submit(store, 'local', '正在识别的项目');
  await until(() => activeSignal);
  const queued = await submit(store, 'local', '等待中的项目');
  assert.equal(await store.cancel('local', queued.id), true);
  assert.equal((await store.get('local', queued.id, 0)).phase, 'canceled');
  assert.equal(activeSignal.aborted, false);
  assert.equal(await store.cancel('local', active.id), true);
  assert.equal(activeSignal.aborted, true);
  assert.equal((await store.get('local', active.id, 0)).status, 410);
  await assert.rejects(access(path.join(directory, active.id, 'input.json')), { code: 'ENOENT' });
  const failure = await submit(store, 'local', '缺少尺寸');
  const issue = await until(async () => {
    const job = await store.get('local', failure.id, 0);
    return job.done && job;
  });
  assert.equal(issue.phase, 'failed');
  assert.equal(issue.status, 422);
  assert.equal(issue.error, '请补充横向尺寸。');
});

test('reports bounded owner-scoped import progress without rewriting the manifest', async t => {
  let advance;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { store, directory } = await fixture(t, async (body, { onProgress }) => {
    advance = onProgress;
    await gate;
    onProgress('validating', '已确认 2 个房间。');
    return success(body);
  });
  const submitted = await submit(store, 'local', '进度测试');
  assert.equal(submitted.progress.stage, 'queued');
  await until(() => advance);
  const preparing = await store.get('local', submitted.id, 0);
  assert.equal(preparing.progress.stage, 'preparing');
  advance('waiting-model');
  advance('recognizing', '外墙\n已确认\u0000。' + '测试'.repeat(500));
  advance('recognizing', '{"walls":[]}');
  advance('waiting-model', '过期的更新');

  const [listed] = await store.list('local');
  assert.equal(listed.updatedAt, preparing.updatedAt);
  assert.equal(listed.progress.stage, 'recognizing');
  assert.match(listed.progress.message, /^外墙 已确认 。/);
  assert.ok(listed.progress.message.length <= 360);
  assert.equal(await store.get('remote', submitted.id, 0), null);
  assert.deepEqual(await store.list('remote'), []);
  const saved = JSON.parse(await readFile(path.join(directory, submitted.id, 'job.json'), 'utf8'));
  assert.equal(Object.hasOwn(saved, 'progress'), false);

  release();
  const finished = await until(async () => {
    const row = await store.get('local', submitted.id, 0);
    return row.done && row;
  });
  advance('recognizing', '迟到的更新');
  assert.deepEqual((await store.get('local', submitted.id, 1)).progress, finished.progress);
  assert.equal(finished.progress.stage, 'done');
  assert.equal(finished.progress.message, '已确认 2 个房间。');
});
