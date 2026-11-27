import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+Xj1sAAAAASUVORK5CYII=';
const upload = (name, value) => ({ name, data: Buffer.from(value).toString('base64') });

function samplePdf() {
  const contents = (text) => {
    const stream = `BT /F1 14 Tf 20 120 Td (${text}) Tj ET\n`;
    return `<< /Length ${stream.length} >>\nstream\n${stream}endstream`;
  };
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 250 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    contents('Aisle width: 1370 mm'),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 250 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    contents('Aisle width: 9170 mm'),
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((body, index) => {
    const offset = pdf.length;
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
    return `${String(offset).padStart(10, '0')} 00000 n \n`;
  });
  const start = pdf.length;
  const size = objects.length + 1;
  return `${pdf}xref\n0 ${size}\n0000000000 65535 f \n${offsets.join('')}trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
}

test('chat accepts mixed sources, protects scene state for uploads alone and preserves legacy turns', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'studio-chat-test-'));
  const runner = path.join(directory, 'codex.cjs');
  const trace = path.join(directory, 'trace.ndjson');
  const archive = path.join(directory, 'uploads');
  await writeFile(runner, `#!/usr/bin/env node
    const assert = require('node:assert/strict');
    const { appendFileSync, existsSync } = require('node:fs');
    const readline = require('node:readline');
    if (process.argv[2] === '--version') return console.log('codex-cli 0.200.0');
    if (process.argv[2] === 'login') return console.log('Logged in using ChatGPT');
    const send = value => console.log(JSON.stringify(value));
    const answer = (id, result) => send({ id, result });
    let count = 0;
    readline.createInterface({ input: process.stdin }).on('line', line => {
      const { id, method, params } = JSON.parse(line);
      if (method === 'initialize') return answer(id, {});
      if (method === 'model/list') return answer(id, { data: [] });
      if (method === 'thread/start') {
        assert.equal(params.ephemeral, true);
        assert.equal(params.config['features.shell_tool'], false);
        assert.equal(params.config.web_search, 'disabled');
        return answer(id, { thread: { id: 'thread' } });
      }
      if (method !== 'turn/start') return;
      const turnId = 'turn-' + ++count;
      const message = params.input[0].text;
      const images = params.input.slice(1).map(input => input.path);
      appendFileSync(process.env.STUDIO_TEST_CHAT_TRACE, JSON.stringify({ count, message, images, exist: images.every(existsSync) }) + '\\n');
      answer(id, { turn: { id: turnId, status: 'inProgress' } });
      send({ method: 'item/agentMessage/delta', params: { threadId: 'thread', turnId, delta: 'unstructured-stream' } });
      const patch = { reply: '测试结果。', ops: [] };
      if (message.includes('用户本轮只发送了附件')) {
        patch.ops = [{ op: 'deleteFurniture', id: 'f1' }];
        patch.furniture = [{ type: 'chair', name: '测试椅', w: 430, d: 460 }];
      } else if (images.length && message.includes('用户附件（JSON')) {
        patch.reply += ' ' + images[0];
        patch.ops = [{ op: 'moveFurniture', id: 'f1', dx: 200, dy: 0 }];
      }
      send({ method: 'item/completed', params: { threadId: 'thread', turnId,
        item: { type: 'agentMessage', id: 'answer', phase: 'final_answer', text: JSON.stringify(patch) } } });
      send({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: turnId, status: 'completed' } } });
    });
  `, { mode: 0o700 });
  const socket = createServer().listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server.mjs', import.meta.url))], {
    env: { ...process.env, CODEX_PATH: runner, PORT: String(port), STUDIO_PUBLIC_BRIDGE_TOKEN_FILE: '',
      STUDIO_IMPORT_JOBS_DIR: path.join(directory, 'jobs'), STUDIO_UPLOAD_ARCHIVE_DIR: archive, STUDIO_TEST_CHAT_TRACE: trace },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  });
  await once(child.stdout, 'data', { signal: AbortSignal.timeout(5000) });
  const post = (body, headers) => fetch(`http://127.0.0.1:${port}/api/chat`, {
    method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
  });
  const events = async response => {
    assert.equal(response.status, 200);
    return (await response.text()).split('\n').filter(line => line.startsWith('data: '))
      .map(line => JSON.parse(line.slice(6)));
  };
  const result = updates => updates.find(update => update.type === 'result')?.result;
  assert.equal((await post(null)).status, 400);
  assert.equal((await post({ attachments: [upload('unsafe.html', '<html/>')] })).status, 415);
  assert.equal((await post({ attachments: [{ name: 'test.txt', data: 'invalid!' }] })).status, 400);
  assert.equal((await post({ attachments: [upload('long.txt', 'a'.repeat(131073))] })).status, 413);
  assert.equal((await post({ attachments: [{ name: 'asset.png', data: png }] },
    { 'x-studio-public-owner': 'remote-owner', 'x-studio-public-bridge': 'forged' })).status, 403);

  const sessionId = 'attachment-continuity';
  const legacy = await events(await post({ sessionId, message: '普通问答', images: [{ data: png }] }));
  assert.ok(legacy.some(event => event.type === 'delta'));
  const photo = await events(await post({ sessionId, attachments: [{ name: '../单椅.png', data: png }] }));
  assert.ok(!photo.some(event => event.type === 'delta'));
  assert.equal(result(photo).furniture[0].name, '测试椅');
  assert.deepEqual(result(photo).ops, []);

  const dxf = '0\nSECTION\n2\nENTITIES\n0\nLINE\n8\nwall\n10\n0\n20\n0\n11\n3000\n21\n0\n0\nENDSEC\n0\nEOF\n';
  const csv = '\uFEFF长,200\r\n' + '测试'.repeat(3100);
  const files = [upload('参考.pdf', samplePdf()), { ...upload('尺寸.csv', csv), originalName: '详图，尺寸.CSV' },
    upload('图纸.dxf', dxf), { ...upload('尺寸.csv', '另外一份\r\n'), originalName: '详图，尺寸.CSV' }];
  const mixed = await events(await post({ sessionId, message: '参考尺寸，把 f1 右移 200 毫米', images: [{ data: png }], attachments: files }));
  assert.equal(result(mixed).ops[0].dx, 200);
  assert.doesNotMatch(result(mixed).reply, /\/.*interior-design-chat/);
  const document = await events(await post({ sessionId, attachments: [upload('说明.txt', '桌宽 1200 mm')] }));
  assert.deepEqual(result(document).ops, []);
  assert.equal(result(document).furniture, undefined);
  const turns = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(turns.map(turn => turn.count), [1, 2, 3, 4]);
  const [original, imageTurn, mixedTurn] = turns;
  assert.match(original.message, /当前户型的 3D 画面/);
  assert.match(imageTurn.message, /用户上传的通用图片/);
  assert.match(imageTurn.message, /单椅\.png/);
  assert.doesNotMatch(imageTurn.message, /\.\.\/单椅/);
  assert.match(mixedTurn.message, /straightSegments.*"count":1/);
  assert.match(mixedTurn.message, /"truncated":true/);
  const mac = process.platform === 'darwin';
  if (mac || spawnSync('pdftotext', ['-v'], { stdio: 'ignore', timeout: 2000 }).status === 0) {
    assert.match(mixedTurn.message, /"page":1,"embeddedText":"Aisle width: 1370 mm"/);
    assert.doesNotMatch(mixedTurn.message, /9170 mm/);
  }
  if (mac) assert.ok(mixedTurn.images.some(file => file.endsWith('-page-1.jpg')));
  assert.ok([original, imageTurn, mixedTurn].every(turn => turn.exist && turn.images.length > 0));
  await wait(50);
  for (const file of [original, imageTurn, mixedTurn].flatMap(turn => turn.images)) {
    await assert.rejects(access(file), { code: 'ENOENT' });
  }
  // The model rejected this ceiling response. Its accepted original must still be retrievable.
  const plan = JSON.parse(await readFile(new URL('../data/125c-plan.json', import.meta.url), 'utf8'));
  const ceiling = await fetch(`http://127.0.0.1:${port}/api/ceiling-import`, {
    method: 'POST', body: JSON.stringify({ plan, ceiling: { rooms: {} }, mode: 'drawing',
      files: [{ name: '天花平面.png', data: png }] }),
  });
  assert.equal(ceiling.status, 422, await ceiling.text());

  async function archivedFiles(source) {
    const category = path.join(archive, source);
    const batches = await readdir(category);
    const entries = [];
    for (const id of batches) {
      const batch = path.join(category, id);
      const manifest = JSON.parse(await readFile(path.join(batch, 'manifest.json')));
      assert.equal(manifest.source, source);
      assert.equal(manifest.context.owner, 'local');
      assert.equal((await stat(batch)).mode & 0o777, 0o700);
      for (const { name, file, bytes } of manifest.files) {
        const saved = path.join(batch, file);
        const data = await readFile(saved);
        assert.equal(bytes, data.length);
        assert.equal((await stat(saved)).mode & 0o777, 0o600);
        entries.push({ name, data });
      }
    }
    return entries;
  }
  const chatOriginals = await archivedFiles('chat');
  assert.equal(chatOriginals.length, files.length + 2);
  assert.deepEqual(chatOriginals.find(file => file.name === '单椅.png').data, Buffer.from(png, 'base64'));
  assert.deepEqual(chatOriginals.filter(file => file.name === '详图，尺寸.CSV').map(file => file.data),
    [Buffer.from(csv), Buffer.from('另外一份\r\n')]);
  assert.deepEqual(await archivedFiles('ceiling'), [{ name: '天花平面.png', data: Buffer.from(png, 'base64') }]);
  await rename(path.join(archive, 'chat'), path.join(archive, 'completed-chat'));
  await writeFile(path.join(archive, 'chat'), 'unavailable');
  const unavailable = await post({ attachments: [upload('说明.txt', '需保存的原件')] });
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { error: '上传原件保存失败，请稍后重试。' });
});
