import dns from 'node:dns/promises';
import { readFileSync } from 'node:fs';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { isAbsolute } from 'node:path';

const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');
const pngEnd = Buffer.from('0000000049454e44ae426082', 'hex');
const maxImageBytes = 24 * 1024 * 1024;
const maxBase64Length = Math.ceil(maxImageBytes / 3) * 4;
const maxResponseBytes = maxBase64Length + 1024 * 1024;
const renderTimeoutMs = 6 * 60_000;
const inlinePngPrefix = 'data:image/png;base64,';
const nonPublicIpv4 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.31.196.0', 24], ['192.52.193.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['192.175.48.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 3], ['168.63.129.16', 32],
]) nonPublicIpv4.addSubnet(network, prefix, 'ipv4');

function readJsonFile(file, message) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error(message);
  }
}

function imageEndpoint(baseUrl) {
  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new Error('服务器效果图服务的 API 地址无效。');
  }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    throw new Error('服务器效果图服务需要无凭据的 HTTPS API 地址。');
  }
  base.pathname = base.pathname.replace(/\/+$/, '') + '/images/edits';
  return base.href;
}

function isPng(buffer) {
  return buffer.length >= 45 && buffer.subarray(0, 8).equals(pngSignature)
    && buffer.readUInt32BE(8) === 13 && buffer.toString('latin1', 12, 16) === 'IHDR'
    && buffer.readUInt32BE(16) > 0 && buffer.readUInt32BE(20) > 0
    && buffer.subarray(-12).equals(pngEnd);
}

function screenshotType(image) {
  if (isPng(image)) return ['image/png', 'png'];
  if (image.subarray(0, 3).toString('hex') === 'ffd8ff') return ['image/jpeg', 'jpg'];
  if (image.toString('latin1', 0, 4) === 'RIFF' && image.toString('latin1', 8, 12) === 'WEBP') {
    return ['image/webp', 'webp'];
  }
  throw new Error('效果图参考截图必须是 PNG、JPEG 或 WebP。');
}

async function readLimited(stream, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > limit) throw new Error('图像服务返回的数据过大。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function decodePng(encoded) {
  if (typeof encoded !== 'string' || !encoded.length || encoded.length > maxBase64Length) {
    throw new Error('图像服务未返回有效的 Base64 图片。');
  }
  const image = Buffer.from(encoded, 'base64');
  if (image.length > maxImageBytes || !isPng(image)) {
    throw new Error('图像服务未返回有效的 PNG 图片。');
  }
  const canonical = image.toString('base64');
  if (encoded !== canonical && encoded !== canonical.replace(/=+$/, '')) {
    throw new Error('图像服务未返回有效的 Base64 图片。');
  }
  return image;
}

async function publicImageAddress(url, signal) {
  const resolver = new dns.Resolver();
  const abort = () => resolver.cancel();
  signal.throwIfAborted();
  signal.addEventListener('abort', abort, { once: true });
  let addresses;
  try {
    addresses = await resolver.resolve4(url.hostname);
  } catch {
    signal.throwIfAborted();
    throw new Error('无法解析图像结果地址。');
  } finally {
    signal.removeEventListener('abort', abort);
  }
  if (!addresses.length || addresses.some(address => isIP(address) !== 4 || nonPublicIpv4.check(address, 'ipv4'))) {
    throw new Error('图像结果地址必须解析到公网 IPv4。');
  }
  return addresses[0];
}

async function downloadPublicPng(value, signal) {
  let url;
  try {
    if (value.length > 8192) throw new Error();
    url = new URL(value);
  } catch {
    throw new Error('图像服务返回的结果地址无效。');
  }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash
      || isIP(url.hostname) || !/^[a-z0-9.-]+\.[a-z0-9-]+$/i.test(url.hostname)) {
    throw new Error('图像结果需要使用公网 HTTPS 域名。');
  }
  const address = await publicImageAddress(url, signal);
  signal.throwIfAborted();
  const response = await new Promise((resolve, reject) => {
    // Keep the original hostname for TLS verification and pin DNS for this connection.
    const request = https.get(url, {
      agent: false,
      family: 4,
      autoSelectFamily: false,
      lookup: (_host, _options, done) => done(null, address, 4),
      headers: { Accept: 'image/png' },
      signal,
    }, resolve);
    request.once('error', () => reject(new Error('无法下载图像服务的公开结果。')));
  });
  if (response.statusCode !== 200 || Number(response.headers['content-length']) > maxImageBytes) {
    response.destroy();
    throw new Error('图像结果下载失败或超过大小上限。');
  }
  const image = await readLimited(response, maxImageBytes);
  if (!isPng(image)) throw new Error('图像服务未返回有效的 PNG 图片。');
  return image;
}

async function readImageResponse(response, allowPublicResultUrls, signal) {
  if (!response.ok || Number(response.headers.get('content-length')) > maxResponseBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error(response.ok ? '图像服务返回的数据过大。' : `图像服务返回 HTTP ${response.status}。`);
  }
  if (!response.body) throw new Error('图像服务未返回数据。');
  const raw = await readLimited(response.body, maxResponseBytes);
  let data;
  try {
    data = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new Error('图像服务返回的响应不是有效 JSON。');
  }
  const result = Array.isArray(data?.data) ? data.data[0] : null;
  if (!result) throw new Error('图像服务的响应没有图片记录。');
  if (result.b64_json) return decodePng(result.b64_json);
  if (allowPublicResultUrls && typeof result.url === 'string' && result.url) {
    if (result.url.startsWith(inlinePngPrefix)) return decodePng(result.url.slice(inlinePngPrefix.length));
    return downloadPublicPng(result.url, signal);
  }
  throw new Error(allowPublicResultUrls ? '图像结果缺少 Base64 图片和结果地址。' : '图像服务未返回有效的 Base64 图片。');
}

export function loadRenderImageProvider(configFile) {
  if (!configFile) return null;
  const config = readJsonFile(configFile, '无法读取服务器效果图配置。');
  const endpoint = imageEndpoint(config?.baseUrl);
  const model = typeof config?.model === 'string' ? config.model.trim() : '';
  const quality = config.quality ?? 'auto';
  if (!model || typeof config.authFile !== 'string' || !isAbsolute(config.authFile)) {
    throw new Error('服务器效果图配置缺少模型名称或凭据文件绝对路径。');
  }
  if (!['auto', 'low', 'medium', 'high', 'xhigh', 'max'].includes(quality)) {
    throw new Error('服务器效果图配置的质量档位无效。');
  }
  const auth = readJsonFile(config.authFile, '无法读取服务器效果图 API 凭据。');
  const key = typeof auth?.OPENAI_API_KEY === 'string' ? auth.OPENAI_API_KEY.trim() : '';
  if (!key || /\s/.test(key)) throw new Error('服务器效果图 API 凭据无效。');
  const allowPublicResultUrls = config.allowPublicResultUrls === true;

  return async ({ image, mime, prompt, signal }) => {
    if (!Buffer.isBuffer(image) || image.length === 0 || image.length > maxImageBytes) {
      throw new Error('效果图参考截图为空或超过大小上限。');
    }
    const [type, extension] = screenshotType(image);
    if (mime && (typeof mime !== 'string' || mime.toLowerCase() !== type)) {
      throw new Error('效果图参考截图格式不匹配。');
    }
    const description = typeof prompt === 'string' ? prompt.trim() : '';
    if (!description || description.length > 32_000) throw new Error('效果图提示词为空或过长。');

    const form = new FormData();
    form.set('model', model);
    form.set('prompt', description);
    form.set('quality', quality);
    form.set('output_format', 'png');
    form.set('image[]', new Blob([image], { type }), `scene.${extension}`);
    const timeout = AbortSignal.timeout(renderTimeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    requestSignal.throwIfAborted();
    let response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        body: form,
        redirect: 'error',
        signal: requestSignal,
      });
    } catch {
      requestSignal.throwIfAborted();
      throw new Error('无法连接服务器图像服务。');
    }
    return readImageResponse(response, allowPublicResultUrls, requestSignal);
  };
}
