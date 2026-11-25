/* 统一后台任务（lib/task-jobs.mjs）与公网租期的零依赖测试。
 * 全部使用假执行器，不启动 codex。 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { test } from 'node:test';
import { createTaskJobs, isTaskJobPath } from '../lib/task-jobs.mjs';
import { createPublicJobRelay, RELAY_LIMITS } from '../deploy/public-jobs.mjs';

async function fixture(t, execute, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'studio-task-jobs-'));
  const stores = [];
  const open = worker => {
    const store = createTaskJobs({ directory, execute: worker, sweepMs: 20, ...options });
    stores.push(store);
    return store;
  };
  t.after(async () => {
    stores.forEach(store => store.close());
    await rm(directory, { recursive: true, force: true });
  });
  return { store: open(execute), open, directory };
}

async function until(check) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const found = await check();
    if (found) return found;
    await wait(10);
  }
  assert.fail('任务没有进入预期状态');
}

/** 把 chunks 里的 SSE 帧还原成事件。 */
function events(update) {
  return update.chunks.join('')
    .split('\n\n')
    .filter(Boolean)
    .map(frame => JSON.parse(frame.replace(/^data: /, '')));
}

const ownership = { projectId: 'p-1', schemeId: 's-1', baseRevision: 7 };

test('提交后在客户端不再轮询的情况下继续执行，完成后按游标取回事件与结果', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { store, directory } = await fixture(t, async ({ payload, emit }) => {
    emit({ type: 'status', text: '正在生成修改…' });
    await gate;
    emit({ type: 'result', result: { reply: payload.message, ops: [] } });
    emit({ type: 'done' });
    return { status: 200, result: { reply: payload.message, ops: [] } };
  });

  const job = await store.submit({ kind: 'chat', owner: 'local', ownership, payload: { message: '把沙发左移' } });
  assert.match(job.id, /^task-[0-9a-f-]{36}$/);
  assert.equal(job.kind, 'chat');
  assert.equal(job.reused, false);
  assert.ok(isTaskJobPath('/api/jobs/task/' + job.id));
  assert.ok(!isTaskJobPath('/api/jobs/task/abc/extra'));

  const running = await until(async () => {
    const update = await store.get('local', job.id, 0);
    return update.phase === 'running' && update.chunks.length ? update : null;
  });
  assert.equal(running.done, false);
  assert.deepEqual(running.ownership, ownership);
  assert.deepEqual(events(running), [{ type: 'status', text: '正在生成修改…' }]);

  // 客户端从这一刻起完全不再请求；任务必须继续跑完。
  await wait(60);
  release();

  const finished = await until(async () => {
    const update = await store.get('local', job.id, running.cursor);
    return update.done ? update : null;
  });
  assert.equal(finished.phase, 'done');
  assert.equal(finished.status, 200);
  assert.deepEqual(events(finished), [
    { type: 'result', result: { reply: '把沙发左移', ops: [] } },
    { type: 'done' },
  ]);
  assert.deepEqual(finished.result, { reply: '把沙发左移', ops: [] });
  assert.deepEqual(finished.ownership, ownership);
  assert.deepEqual((await store.get('local', job.id, finished.cursor)).chunks, []);

  const stored = JSON.parse(await readFile(path.join(directory, job.id, 'result.json'), 'utf8'));
  assert.deepEqual(stored, { reply: '把沙发左移', ops: [] });
});

test('进行中的重复提交复用同一任务，结束后再提交会新建任务', async t => {
  const gates = [];
  const { store } = await fixture(t, ({ payload }) => new Promise(resolve => {
    gates.push(() => resolve({ status: 200, result: { reply: payload.message } }));
  }));

  const first = await store.submit({ kind: 'chat', owner: 'local', ownership, payload: { message: '换地板' } });
  const duplicate = await store.submit({
    kind: 'chat', owner: 'local', ownership, payload: { message: '换地板' },
  });
  assert.equal(duplicate.id, first.id);
  assert.equal(duplicate.reused, true);

  const other = await store.submit({ kind: 'chat', owner: 'local', ownership, payload: { message: '换墙面' } });
  assert.notEqual(other.id, first.id);
  assert.equal(other.reused, false);

  // 幂等键含 kind 与方案归属：同一参数换方案不能复用。
  const scheme = await store.submit({
    kind: 'chat', owner: 'local', ownership: { ...ownership, schemeId: 's-2' }, payload: { message: '换地板' },
  });
  assert.notEqual(scheme.id, first.id);

  const polled = await store.get('local', first.id, 0);
  assert.deepEqual(polled.ownership, ownership);

  for (const gate of gates) gate();
  await until(async () => (await store.get('local', first.id, 0)).done);
  await until(async () => (await store.get('local', other.id, 0)).done);

  const again = await store.submit({ kind: 'chat', owner: 'local', ownership, payload: { message: '换地板' } });
  assert.notEqual(again.id, first.id);
  assert.equal(again.reused, false);
});

test('归属缺省为 null，类型非法、任务类型未知、队列已满都给出明确错误', async t => {
  const { store } = await fixture(t, () => new Promise(() => {}), { capacity: 1 });

  const bare = await store.submit({ kind: 'render', owner: 'local', payload: { image: 'x' } });
  assert.deepEqual(bare.ownership, { projectId: null, schemeId: null, baseRevision: null });

  await assert.rejects(store.submit({ kind: 'paint', owner: 'local', payload: {} }), { status: 400 });
  await assert.rejects(store.submit({ kind: 'toString', owner: 'local', payload: {} }), { status: 400 });
  await assert.rejects(store.submit({ kind: 'chat', owner: 'intruder', payload: {} }), { status: 400 });
  await assert.rejects(store.submit({ kind: 'chat', owner: 'local', payload: [] }), { status: 400 });
  await assert.rejects(
    store.submit({ kind: 'chat', owner: 'local', ownership: { projectId: { id: 1 } }, payload: {} }),
    { status: 400 },
  );
  await assert.rejects(store.submit({ kind: 'chat', owner: 'local', payload: { message: 'a' } }), { status: 429 });
});

test('失败与异常都会落成终态，读取游标与访问范围受校验', async t => {
  const { store } = await fixture(t, async ({ payload }) => {
    if (payload.message === 'throw') throw new Error('codex 崩了');
    return { status: 422, error: '模型拒绝了这次修改。' };
  });

  const failed = await store.submit({ kind: 'chat', owner: 'local', payload: { message: 'no' } });
  const failedState = await until(async () => {
    const update = await store.get('local', failed.id, 0);
    return update.done ? update : null;
  });
  assert.equal(failedState.phase, 'failed');
  assert.equal(failedState.status, 422);
  assert.equal(failedState.error, '模型拒绝了这次修改。');
  assert.equal(failedState.result, undefined);

  const thrown = await store.submit({ kind: 'chat', owner: 'local', payload: { message: 'throw' } });
  const thrownState = await until(async () => {
    const update = await store.get('local', thrown.id, 0);
    return update.done ? update : null;
  });
  assert.equal(thrownState.phase, 'failed');
  assert.equal(thrownState.status, 502);

  assert.equal(await store.get('remote', thrown.id, 0), null);
  assert.equal(await store.get('local', 'task-' + randomUUID(), 0), null);
  await assert.rejects(store.get('local', thrown.id, 9), { status: 400 });
  await assert.rejects(store.get('local', thrown.id, -1), { status: 400 });
});

test('取消运行中的任务会中止信号并保留可读的终态', async t => {
  let signal;
  const { store } = await fixture(t, ({ signal: abort }) => {
    signal = abort;
    return new Promise((resolve, reject) => {
      abort.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    });
  });

  const job = await store.submit({ kind: 'chat', owner: 'local', payload: { message: '等一下' } });
  await until(async () => signal && (await store.get('local', job.id, 0)).phase === 'running');
  assert.equal(await store.cancel('local', job.id), true);
  assert.equal(signal.aborted, true);
  const canceled = await store.get('local', job.id, 0);
  assert.equal(canceled.phase, 'canceled');
  assert.equal(canceled.status, 410);
  assert.equal(canceled.done, true);
  assert.equal(await store.cancel('local', job.id), true);
  assert.equal(await store.cancel('remote', job.id), false);
});

test('终态任务按保留期清理目录，运行中的任务不会被清掉', async t => {
  const { store, directory } = await fixture(t, async () => ({ status: 200, result: { ok: true } }), {
    retention: 60,
  });

  const job = await store.submit({ kind: 'render', owner: 'local', payload: { image: 'x' } });
  await until(async () => (await store.get('local', job.id, 0)).done);
  await until(async () => !(await store.get('local', job.id, 0)));
  await until(() => access(path.join(directory, job.id)).then(() => false, () => true));
  assert.deepEqual(await store.list('local'), []);
});

test('重启后读回已完成任务，崩溃遗留的运行中任务标为中断', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'studio-task-jobs-'));
  const stores = [];
  const open = worker => {
    const store = createTaskJobs({ directory, execute: worker, sweepMs: 20 });
    stores.push(store);
    return store;
  };
  t.after(async () => {
    stores.forEach(store => store.close());
    await rm(directory, { recursive: true, force: true });
  });

  const first = open(async ({ emit }) => {
    emit({ type: 'status', text: '正在生成效果图…' });
    emit({ type: 'image', url: '/files/renders/a.png', prompt: '[现代简约] angle' });
    return { status: 200, result: { url: '/files/renders/a.png', prompt: '[现代简约] angle' } };
  });
  const job = await first.submit({ kind: 'render', owner: 'local', ownership, payload: { image: 'x' } });
  await until(async () => (await first.get('local', job.id, 0)).done);
  first.close();

  // 模拟进程在任务运行中被杀掉：目录里留下 running 的 job.json 和半截事件。
  const crashed = 'task-' + randomUUID();
  const now = Date.now();
  await mkdir(path.join(directory, crashed));
  await writeFile(path.join(directory, crashed, 'job.json'), JSON.stringify({
    id: crashed, kind: 'chat', owner: 'local', phase: 'running', status: null, error: null,
    ownership: { projectId: null, schemeId: null, baseRevision: null },
    createdAt: now, updatedAt: now, startedAt: now, finishedAt: null,
  }), { mode: 0o600 });
  await writeFile(path.join(directory, crashed, 'events.jsonl'),
    'data: {"type":"status","text":"处理中"}\n\n', { mode: 0o600 });

  const restored = open(() => assert.fail('重启后不应再次执行任务'));
  const stored = await restored.get('local', job.id, 0);
  assert.equal(stored.phase, 'done');
  assert.deepEqual(events(stored), [
    { type: 'status', text: '正在生成效果图…' },
    { type: 'image', url: '/files/renders/a.png', prompt: '[现代简约] angle' },
  ]);
  assert.deepEqual(stored.result, { url: '/files/renders/a.png', prompt: '[现代简约] angle' });
  assert.deepEqual(stored.ownership, ownership);

  const interrupted = await restored.get('local', crashed, 0);
  assert.equal(interrupted.phase, 'failed');
  assert.equal(interrupted.status, 503);
  assert.match(interrupted.error, /中断/);
  assert.deepEqual(events(interrupted), [{ type: 'status', text: '处理中' }]);
  assert.deepEqual((await restored.list('local')).map(item => [item.kind, item.phase]), [
    ['chat', 'failed'],
    ['render', 'done'],
  ]);
});

/* ------------------------------ 公网租期 ------------------------------ */

async function listen(t, handle) {
  const server = createServer(handle).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  return 'http://127.0.0.1:' + server.address().port;
}

async function relayFixture(t, options = {}) {
  const upstream = await listen(t, (req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
    res.write('data: {"type":"status","text":"处理中"}\n\n');
    // 不结束：任务一直运行，租期才有意义。
  });
  const relay = createPublicJobRelay({ origin: upstream, bridgeToken: 'fixture-token', ...options });
  const url = await listen(t, (req, res) => {
    relay(req, res, new URL(req.url, 'http://test.invalid'), req.headers['x-fixture-owner'])
      .then(handled => { if (!handled) res.writeHead(404).end(); })
      .catch(error => res.writeHead(500).end(String(error)));
  });
  return { url };
}

async function relayStart(url) {
  const response = await fetch(url + '/api/jobs/chat', {
    method: 'POST',
    headers: { 'x-fixture-owner': 'alice' },
    body: '{}',
  });
  assert.equal(response.status, 202);
  return (await response.json()).id;
}

const poll = (url, id) => fetch(url + '/api/jobs/' + id, { headers: { 'x-fixture-owner': 'alice' } })
  .then(response => response.json());

test('公网任务轮询租期为 10 分钟，总时限保持 15 分钟', async t => {
  assert.equal(RELAY_LIMITS.POLL_LEASE, 10 * 60_000);
  assert.equal(RELAY_LIMITS.MAX_JOB_AGE, 15 * 60_000);
  assert.ok(RELAY_LIMITS.POLL_LEASE > 3 * 60_000);

  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const { url } = await relayFixture(t);
  const id = await relayStart(url);
  now += RELAY_LIMITS.POLL_LEASE - 1;
  const first = await poll(url, id);
  assert.equal(first.done, false);
  now += RELAY_LIMITS.POLL_LEASE;
  const later = await poll(url, id);
  assert.equal(later.done, true);
  assert.equal(later.status, 504);

  const renewed = await relayStart(url);
  now += RELAY_LIMITS.POLL_LEASE - 1;
  assert.equal((await poll(url, renewed)).done, false);
  now += 1;
  assert.equal((await poll(url, renewed)).done, false);

  const idle = await relayStart(url);
  now += RELAY_LIMITS.POLL_LEASE;
  const expired = await poll(url, idle);
  assert.equal(expired.done, true);
  assert.equal(expired.status, 410);
  assert.match(expired.error, /断开/);
});

test('公网任务超过总时限后停止，即使一直在轮询', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const { url } = await relayFixture(t);
  const id = await relayStart(url);
  now += RELAY_LIMITS.POLL_LEASE - 1;
  assert.equal((await poll(url, id)).done, false);
  now += RELAY_LIMITS.MAX_JOB_AGE - RELAY_LIMITS.POLL_LEASE + 1;
  const later = await poll(url, id);
  assert.equal(later.done, true);
  assert.equal(later.status, 504);
  assert.match(later.error, /超时/);
});
