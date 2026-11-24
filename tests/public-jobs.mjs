import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createPublicJobRelay } from '../deploy/public-jobs.mjs';

async function listen(t, handle) {
  const server = createServer(handle).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  return 'http://127.0.0.1:' + server.address().port;
}

async function fixture(t, handleUpstream) {
  const upstream = await listen(t, handleUpstream);
  const relay = createPublicJobRelay({ origin: upstream, bridgeToken: 'fixture-token' });
  const url = await listen(t, (req, res) => {
    relay(req, res, new URL(req.url, 'http://test.invalid'), req.headers['x-fixture-owner']).then(handled => {
      if (!handled) res.writeHead(404).end();
    }).catch(error => res.writeHead(500).end(String(error)));
  });
  const call = (suffix, { owner = 'alice', headers, ...options } = {}) => fetch(`${url}/api/jobs/${suffix}`, {
    ...options,
    headers: { 'x-fixture-owner': owner, ...headers },
  });
  const start = async (kind, body = '{}') => {
    const res = await call(kind, {
      method: 'POST',
      body,
      headers: { 'x-studio-public-owner': 'forged-owner', 'x-studio-public-bridge': 'forged-token' },
    });
    assert.equal(res.status, 202);
    return (await res.json()).id;
  };
  return { call, start, relay, url };
}

async function pollUntil(call, id, condition, cursor = 0) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const response = await call(`${id}?cursor=${cursor}`);
    assert.equal(response.status, 200);
    const update = await response.json();
    if (condition(update)) return update;
    await delay(15);
  }
  assert.fail('The job did not reach the expected state');
}

test('streams loopback SSE with cursor retry and split UTF-8', async t => {
  const line = 'data: {"text":"楼梯"}\n\n';
  const bytes = Buffer.from(line);
  const split = bytes.indexOf(Buffer.from('楼')) + 1;
  let endResponse;
  let seen;
  const { call, start } = await fixture(t, async (req, res) => {
    const requestChunks = [];
    for await (const chunk of req) requestChunks.push(chunk);
    seen = {
      headers: req.headers,
      path: req.url,
      body: Buffer.concat(requestChunks).toString('utf8'),
    };
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    res.write(bytes.subarray(0, split));
    endResponse = () => res.end(bytes.subarray(split));
  });

  const input = '{"message":"楼梯","sessionId":"keep-browser-id"}';
  const id = await start('chat', input);
  assert.equal((await call(id, { owner: 'bob' })).status, 404);
  assert.equal((await call(id, { owner: 'bob', method: 'DELETE' })).status, 404);
  assert.equal((await call(id, { owner: '' })).status, 401);
  assert.equal((await call(id + '?cursor=-1')).status, 400);
  const first = await pollUntil(call, id, packet => packet.cursor > 0);
  assert.equal(first.status, 200);
  assert.equal(first.mediaType, 'text/event-stream; charset=utf-8');
  assert.deepEqual(first.chunks, ['data: {"text":"']);
  assert.equal(first.done, false);
  assert.deepEqual(await (await call(id)).json(), first);
  assert.equal(seen.path, '/api/chat');
  assert.equal(seen.body, input);
  assert.equal(seen.headers['x-studio-public-owner'], 'remote-owner');
  assert.equal(seen.headers['x-studio-public-bridge'], 'fixture-token');
  assert.equal(seen.headers['x-fixture-owner'], undefined);

  endResponse();
  const last = await pollUntil(call, id, packet => packet.done, first.cursor);
  assert.equal(first.chunks.join('') + last.chunks.join(''), line);
  assert.equal((await call(id, { method: 'DELETE' })).status, 200);
  assert.equal((await call(id)).status, 404);
});

test('preserves an import response and upstream HTTP error', async t => {
  const failure = JSON.stringify({ error: '图纸缺少尺寸标注' });
  let target;
  const { call, start } = await fixture(t, (req, res) => {
    target = req.url;
    req.resume();
    res.writeHead(422, { 'content-type': 'application/json; charset=utf-8' }).end(failure);
  });
  const id = await start('plan-import');
  const packet = await pollUntil(call, id, update => update.done);
  assert.equal(target, '/api/plan/import');
  assert.equal(packet.status, 422);
  assert.equal(packet.mediaType, 'application/json; charset=utf-8');
  assert.equal(packet.chunks.join(''), failure);
});

test('bounds submissions and cancels the owner’s pending jobs', async t => {
  let closed = 0;
  const { call, start, relay, url } = await fixture(t, (req, res) => {
    req.resume();
    res.on('close', () => { closed++; });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
  });
  const limited = await new Promise((resolve, reject) => {
    const req = request(url + '/api/jobs/render', {
      method: 'POST',
      headers: { 'x-fixture-owner': 'alice', 'content-length': 42 * 1024 * 1024 },
    }, res => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject).end();
  });
  assert.equal(limited, 413);
  const one = await start('chat');
  const two = await start('render');
  await pollUntil(call, one, update => update.status === 200);
  await pollUntil(call, two, update => update.status === 200);
  assert.equal((await call('plan-import', { method: 'POST', body: '{}' })).status, 429);

  relay.cancelOwner('alice');
  assert.equal((await call(one)).status, 404);
  assert.equal((await call(two)).status, 404);
  const later = await start('render');
  await pollUntil(call, later, update => update.status === 200);
  assert.equal(closed, 2);
  await call(later, { method: 'DELETE' });
});
