import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { loadRenderImageProvider } from '../lib/codex/render-image.mjs';

const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOXkAAAAASUVORK5CYII=', 'base64');
const input = { image, mime: 'image/png', prompt: '保留房间构造，生成照片级效果图。' };

function fixture(t, configFields) {
  const folder = mkdtempSync(join(tmpdir(), 'studio-render-image-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const authFile = join(folder, 'auth.json');
  writeFileSync(authFile, JSON.stringify({ OPENAI_API_KEY: 'image-fixture-token' }));
  const configFile = join(folder, 'image.json');
  writeFileSync(configFile, JSON.stringify({
    baseUrl: 'https://provider.example/v1/',
    model: 'gpt-image-2',
    authFile,
    ...configFields,
  }));
  return configFile;
}

test('image provider sends only the configured multipart edit request', async t => {
  const render = loadRenderImageProvider(fixture(t, { model: 'gpt-image-2.6-sunburst', quality: 'high' }));
  const mock = t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://provider.example/v1/images/edits');
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, 'Bearer image-fixture-token');
    assert.equal(init.body.get('model'), 'gpt-image-2.6-sunburst');
    assert.equal(init.body.get('quality'), 'high');
    assert.equal(init.body.get('prompt'), input.prompt);
    assert.equal(init.body.get('output_format'), 'png');
    const file = init.body.get('image[]');
    assert.equal(file.type, 'image/png');
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), image);
    return Response.json({ data: [{ b64_json: image.toString('base64') }] });
  });
  assert.deepEqual(await render(input), image);
  assert.equal(mock.mock.callCount(), 1);
});

test('image provider rejects wrong format, remote URLs, and overlarge outputs', async t => {
  const render = loadRenderImageProvider(fixture(t));
  const mock = t.mock.method(globalThis, 'fetch', () => assert.fail('Unexpected upstream call'));
  await assert.rejects(render({ ...input, mime: 'image/jpeg' }), /格式不匹配/);
  mock.mock.mockImplementationOnce(() => Response.json({ data: [{ url: 'https://unsafe.example/reference.png' }] }));
  await assert.rejects(render(input), /Base64/);
  mock.mock.mockImplementationOnce(() => Response.json({ data: [{ b64_json: Buffer.from('not an image').toString('base64') }] }));
  await assert.rejects(render(input), /PNG/);
  mock.mock.mockImplementationOnce(() => new Response('oversized', { headers: { 'content-length': '40000000' } }));
  await assert.rejects(render(input), /数据过大/);
  assert.equal(mock.mock.callCount(), 3);
});

test('disabled or invalid config never sends a request and aborted edits stop', async t => {
  assert.equal(loadRenderImageProvider(), null);
  assert.throws(() => loadRenderImageProvider(fixture(t, { baseUrl: 'http://provider.example' })), /HTTPS/);
  assert.throws(() => loadRenderImageProvider(fixture(t, { baseUrl: 'https://user:secret@provider.example' })), /HTTPS/);
  const render = loadRenderImageProvider(fixture(t));
  const controller = new AbortController();
  setImmediate(() => controller.abort());
  t.mock.method(globalThis, 'fetch', (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  await assert.rejects(render({ ...input, signal: controller.signal }), { name: 'AbortError' });
});

test('optional result URLs pin a public IPv4 address and leave credentials on the API request', async t => {
  const render = loadRenderImageProvider(fixture(t, { allowPublicResultUrls: true }));
  const href = 'https://cdn.example/image.png?signature=fixture';
  t.mock.method(globalThis, 'fetch', () => Response.json({ data: [{ url: href }] }));
  t.mock.method(dns.Resolver.prototype, 'resolve4', async host => {
    assert.equal(host, 'cdn.example');
    return ['93.184.215.14'];
  });
  const request = t.mock.method(https, 'get', (url, options, callback) => {
    assert.equal(url.href, href);
    assert.deepEqual(options.headers, { Accept: 'image/png' });
    assert.equal(options.family, 4);
    assert.equal(options.agent, false);
    options.lookup('cdn.example', {}, (error, address, family) => {
      assert.equal(error, null);
      assert.equal(address, '93.184.215.14');
      assert.equal(family, 4);
    });
    queueMicrotask(() => callback(Object.assign(Readable.from([image]), { statusCode: 200, headers: {} })));
    return new EventEmitter();
  });
  assert.deepEqual(await render(input), image);
  assert.equal(request.mock.callCount(), 1);
  request.mock.mockImplementationOnce((url, options, callback) => {
    queueMicrotask(() => callback(Object.assign(Readable.from([]), {
      statusCode: 302, headers: { location: 'https://another.example/image.png' },
    })));
    return new EventEmitter();
  });
  await assert.rejects(render(input), /下载失败/);
  assert.equal(request.mock.callCount(), 2);
});

test('optional data URI and URL validation never reach disallowed destinations', async t => {
  const render = loadRenderImageProvider(fixture(t, { allowPublicResultUrls: true }));
  let url = 'data:image/png;base64,' + image.toString('base64');
  t.mock.method(globalThis, 'fetch', () => Response.json({ data: [{ url }] }));
  const dnsLookup = t.mock.method(dns.Resolver.prototype, 'resolve4', async () => ['93.184.215.14', '169.254.169.254']);
  const request = t.mock.method(https, 'get', () => assert.fail('Unexpected result download'));
  assert.deepEqual(await render(input), image);
  for (const disallowed of [
    'http://cdn.example/image.png', 'https://cdn.example:8443/image.png',
    'https://any:secret@cdn.example/image.png', 'https://93.184.215.14/image.png',
    'https://0x7f000001/image.png',
  ]) {
    url = disallowed;
    await assert.rejects(render(input), /公网 HTTPS 域名/);
  }
  url = 'https://cdn.example/image.png';
  await assert.rejects(render(input), /公网 IPv4/);
  assert.equal(dnsLookup.mock.callCount(), 1);
  assert.equal(request.mock.callCount(), 0);
});
