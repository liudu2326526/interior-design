import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+Xj1sAAAAASUVORK5CYII=';
const drawing = '原始图纸.png';
const note = '核实北面窗洞';
const serverPath = fileURLToPath(new URL('../server.mjs', import.meta.url));
const samplePlan = JSON.parse(await readFile(new URL('../data/empty-plan.json', import.meta.url)));

async function availablePort() {
  const socket = createServer().listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child, 'exit');
  child.kill();
  await exit;
}

async function until(check) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const value = await check();
    if (value) return value;
    await wait(30);
  }
  assert.fail('Timed out waiting for drawing review');
}

test('remote review reuses the archived drawing after restart and history expiry', { timeout: 20_000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'studio-drawing-archive-test-'));
  const runner = path.join(directory, 'codex.cjs');
  const trace = path.join(directory, 'trace.ndjson');
  const jobs = path.join(directory, 'jobs');
  const tokenFile = path.join(directory, 'bridge-token');
  const bridgeToken = 'test-drawing-archive-bridge';
  const serverChildren = [];
  t.after(async () => {
    await Promise.all(serverChildren.map(stop));
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(tokenFile, bridgeToken, { mode: 0o600 });
  await writeFile(runner, `#!/usr/bin/env node
    const { appendFileSync, readFileSync } = require('node:fs');
    const path = require('node:path');
    const readline = require('node:readline');
    if (process.argv[2] === '--version') return console.log('codex-cli 0.200.0');
    if (process.argv[2] === 'login') return console.log('Logged in using ChatGPT');
    const send = value => console.log(JSON.stringify(value));
    const answer = (id, result) => send({ id, result });
    readline.createInterface({ input: process.stdin }).on('line', line => {
      const { id, method, params } = JSON.parse(line);
      if (method === 'initialize') return answer(id, {});
      if (method === 'model/list') return answer(id, { data: [] });
      if (method === 'thread/start') return answer(id, { thread: { id: 'thread' } });
      if (method !== 'turn/start') return;
      const message = params.input[0].text;
      const images = params.input.slice(1).map(input => input.path);
      const source = images.find(file => path.basename(file) === ${JSON.stringify(drawing)});
      const kind = images.some(file => path.basename(file) === 'review-plan.png') ? 'review' : 'import';
      const observed = { kind, source, original: source && readFileSync(source).toString('base64'),
        note: message.includes(${JSON.stringify(note)}) };
      appendFileSync(process.env.STUDIO_DRAWING_TRACE, JSON.stringify(observed) + '\\n');
      const output = kind === 'import' ? ${JSON.stringify(samplePlan)} : { verdict: 'match', summary: '核对完成' };
      answer(id, { turn: { id: 'turn', status: 'inProgress' } });
      send({ method: 'item/completed', params: { threadId: 'thread', turnId: 'turn',
        item: { type: 'agentMessage', id: 'answer', phase: 'final_answer', text: JSON.stringify(output) } } });
      send({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed' } } });
    });
  `, { mode: 0o700 });

  async function start() {
    const port = await availablePort();
    const child = spawn(process.execPath, [serverPath], {
      env: { ...process.env, CODEX_PATH: runner, PORT: String(port), STUDIO_IMPORT_JOBS_DIR: jobs,
        STUDIO_PUBLIC_BRIDGE_TOKEN_FILE: tokenFile, STUDIO_PLAN_REVIEW: 'on', STUDIO_DRAWING_TRACE: trace },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    serverChildren.push(child);
    await once(child.stdout, 'data', { signal: AbortSignal.timeout(5000) });
    return {
      child,
      request: (route, { method = 'GET', data, remote = true } = {}) => fetch(`http://127.0.0.1:${port}${route}`, {
        method,
        headers: remote ? { 'x-studio-public-owner': 'remote-owner', 'x-studio-public-bridge': bridgeToken } : {},
        body: data === undefined ? undefined : JSON.stringify(data),
        signal: AbortSignal.timeout(5000),
      }),
    };
  }

  const first = await start();
  const response = await first.request('/api/jobs/plan-import', {
    method: 'POST', data: { files: [{ name: drawing, data: image }], note },
  });
  assert.equal(response.status, 202);
  const { id } = await response.json();
  assert.match(id, /^import-[a-f0-9-]{36}$/);
  const jobPath = path.join(jobs, id);
  const source = path.join(jobPath, 'source', drawing);
  const route = '/api/jobs/' + id;
  const reviewRoute = route + '/review';
  assert.deepEqual(await readFile(source), Buffer.from(image, 'base64'));
  assert.equal((await stat(source)).mode & 0o777, 0o600);

  async function waitForReview(instance) {
    return until(async () => {
      const latest = await instance.request(reviewRoute);
      if (latest.status === 404) return null;
      assert.equal(latest.status, 200);
      return latest.json();
    });
  }
  const automatic = await waitForReview(first);
  assert.equal(automatic.state, 'match');
  assert.equal(automatic.rerun, true);
  await until(async () => access(path.join(jobPath, 'work')).then(() => false, () => true));
  await stop(first.child);

  const manifest = path.join(jobPath, 'job.json');
  const historical = JSON.parse(await readFile(manifest));
  const old = Date.now() - 10 * 24 * 60 * 60 * 1000;
  for (const key of ['createdAt', 'updatedAt', 'startedAt', 'finishedAt']) historical[key] = old;
  historical.review.updatedAt = old;
  await writeFile(manifest, JSON.stringify(historical));

  const restarted = await start();
  assert.equal((await restarted.request(route + '?cursor=1', { remote: false })).status, 404);
  const oldJob = await restarted.request(route + '?cursor=1');
  assert.equal(oldJob.status, 200);
  assert.equal((await oldJob.json()).phase, 'done');
  const listed = await restarted.request('/api/jobs/plan-import?id=' + id);
  assert.equal(listed.status, 200);
  assert.ok((await listed.json()).jobs.some(job => job.id === id));
  assert.equal((await restarted.request(reviewRoute, { method: 'POST' })).status, 202);
  const rerun = await waitForReview(restarted);
  assert.equal(rerun.state, 'match');
  assert.equal(rerun.summary, '核对完成');
  assert.equal(rerun.rerun, true);
  assert.ok(rerun.updatedAt > automatic.updatedAt);

  const turns = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(turns.map(turn => turn.kind), ['import', 'review', 'review']);
  assert.ok(turns.every(turn => turn.original === image && turn.note));
  assert.notEqual(turns[1].source, turns[2].source);
  await until(async () => access(turns[2].source).then(() => false, () => true));
  assert.deepEqual(await readFile(source), Buffer.from(image, 'base64'));
});
