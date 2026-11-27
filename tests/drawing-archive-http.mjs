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
const ceilingDrawing = '天花平面.png';
const note = '核实北面窗洞';
const serverPath = fileURLToPath(new URL('../server.mjs', import.meta.url));
const samplePlan = JSON.parse(await readFile(new URL('../data/empty-plan.json', import.meta.url)));
const zone = {
  id: 'north', name: '北侧边吊', poly: [[0, 0], [8000, 0], [8000, 500], [0, 500]],
  drop: 150, color: '#ededed',
};
const fixture = {id: 'light-1', type: 'downlight', zoneId: 'north', x: 2000, y: 250};
const ceilingRooms = drop => ({room1: {zones: [{...zone, drop}], edges: [], fixtures: [fixture]}});

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

test('drawing jobs archive both sheets, review a ceiling after restart, and design for floor-only submissions', { timeout: 30_000 }, async t => {
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
      const ceilingSource = images.find(file => path.basename(file) === ${JSON.stringify(ceilingDrawing)});
      let ceilingTask;
      try { ceilingTask = JSON.parse(message); } catch {}
      const kind = ceilingTask?.stage
        ? 'ceiling-' + ceilingTask.stage
        : images.some(file => path.basename(file) === 'review-plan.png') ? 'review' : 'import';
      const observed = { kind, source, original: source && readFileSync(source).toString('base64'),
        note: message.includes(${JSON.stringify(note)}), ceilingSource,
        ceilingOriginal: ceilingSource && readFileSync(ceilingSource).toString('base64'),
        ceilingTag: ceilingTask?.inputs?.sources?.find(item => item.kind === 'ceiling')?.name,
        ceilingCandidate: images[ceilingTask?.inputs?.ceilingImage - 1] };
      appendFileSync(process.env.STUDIO_DRAWING_TRACE, JSON.stringify(observed) + '\\n');
      let output;
      switch (kind) {
        case 'import': output = ${JSON.stringify(samplePlan)}; break;
        case 'review': output = {verdict: 'match', summary: '户型核对完成'}; break;
        case 'ceiling-recognize':
          output = ceilingSource
            ? {status: 'found', alignment: '已按两处墙角和门洞核对', rooms: ${JSON.stringify(ceilingRooms(150))}}
            : {status: 'absent', rooms: {}};
          break;
        case 'ceiling-generate':
          output = {rooms: ${JSON.stringify(ceilingRooms(120))}, warnings: ['需现场核对净高']};
          break;
        case 'ceiling-review':
          output = ceilingSource
            ? {verdict: 'differ', summary: '图纸下吊量为 160 mm', rooms: ${JSON.stringify(ceilingRooms(160))}}
            : {verdict: 'match', summary: '已按房间和家具布局检查草案'};
          break;
      }
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
  const noFloor = await first.request('/api/jobs/plan-import', {
    method: 'POST', data: { files: [{ name: ceilingDrawing, data: image, kind: 'ceiling' }], note },
  });
  assert.equal(noFloor.status, 400);
  const response = await first.request('/api/jobs/plan-import', {
    method: 'POST', data: { files: [
      {name: ceilingDrawing, data: image, kind: 'ceiling'}, {name: drawing, data: image},
    ], note },
  });
  assert.equal(response.status, 202);
  const { id } = await response.json();
  assert.match(id, /^import-[a-f0-9-]{36}$/);
  const jobPath = path.join(jobs, id);
  const source = path.join(jobPath, 'source', drawing);
  const ceilingSource = path.join(jobPath, 'source', ceilingDrawing);
  const route = '/api/jobs/' + id;
  const reviewRoute = route + '/review';
  assert.deepEqual(await readFile(source), Buffer.from(image, 'base64'));
  assert.deepEqual(await readFile(ceilingSource), Buffer.from(image, 'base64'));
  assert.equal((await stat(source)).mode & 0o777, 0o600);
  const archive = JSON.parse(await readFile(path.join(jobPath, 'source', '.upload.json'), 'utf8'));
  assert.equal(archive.files.find(file => file.name === ceilingDrawing).kind, 'ceiling');

  async function waitForReview(instance, url = reviewRoute) {
    return until(async () => {
      const latest = await instance.request(url);
      if (latest.status === 404) return null;
      assert.equal(latest.status, 200);
      return latest.json();
    });
  }
  const result = async (instance, url = route) => {
    const response = await instance.request(url);
    assert.equal(response.status, 200);
    return JSON.parse((await response.json()).chunks[0]);
  };
  const automatic = await waitForReview(first);
  assert.equal(automatic.state, 'differ');
  assert.equal(automatic.rerun, true);
  assert.equal(automatic.ceilingMeta.source, 'drawing');
  assert.equal(automatic.fixed.ceiling.rooms.room1.zones[0].drop, 160);
  assert.equal((await result(first)).ceiling.rooms.room1.zones[0].drop, 150);
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
  assert.equal(rerun.state, 'differ');
  assert.equal(rerun.ceilingMeta.reviewSummary, '图纸下吊量为 160 mm');
  assert.equal(rerun.rerun, true);
  assert.ok(rerun.updatedAt > automatic.updatedAt);

  const floorOnly = await restarted.request('/api/jobs/plan-import', {
    method: 'POST', data: {files: [{name: drawing, data: image}], note},
  });
  assert.equal(floorOnly.status, 202);
  const floorRoute = '/api/jobs/' + (await floorOnly.json()).id;
  const generatedReview = await waitForReview(restarted, floorRoute + '/review');
  const generated = await result(restarted, floorRoute);
  assert.equal(generatedReview.state, 'match');
  assert.equal(generatedReview.ceilingMeta.reviewState, 'match');
  assert.equal(generated.ceilingMeta.source, 'generated');
  assert.equal(generated.ceilingMeta.estimated, true);
  assert.equal(generated.ceiling.rooms.room1.fixtures[0].zoneId, 'north');

  const turns = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(turns.map(turn => turn.kind), [
    'import', 'ceiling-recognize', 'review', 'ceiling-review', 'review', 'ceiling-review',
    'import', 'ceiling-recognize', 'ceiling-generate', 'review', 'ceiling-review',
  ]);
  assert.ok(turns.every(turn => turn.original === image && turn.note));
  assert.notEqual(turns[3].ceilingSource, turns[5].ceilingSource);
  assert.ok([turns[1], turns[3], turns[5]].every(turn =>
    turn.ceilingOriginal === image && turn.ceilingTag === ceilingDrawing));
  assert.ok(turns.filter(turn => ['import', 'review'].includes(turn.kind)).every(turn => !turn.ceilingSource));
  assert.ok(turns.filter(turn => turn.kind === 'ceiling-review').every(turn =>
    path.basename(turn.ceilingCandidate || '') === 'ceiling-candidate.png'));
  await until(async () => access(turns[5].ceilingSource).then(() => false, () => true));
  assert.deepEqual(await readFile(source), Buffer.from(image, 'base64'));
});
