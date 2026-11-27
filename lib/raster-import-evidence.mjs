import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { readRasterCurveEvidence } from './raster-curve-evidence.mjs';

const exec = promisify(execFile);
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const MAX_INPUT = 16 * 1024 * 1024;
const MAX_OUTPUT = 24 * 1024 * 1024;
const MAX_SOURCE_PIXELS = 40_000_000;
const MAX_SIDE = 2400;
const TIMEOUT_MS = 7000;

async function readBounded(file, limit, signal) {
  if (typeof file !== 'string' || !file) return null;
  const info = await stat(file);
  if (!info.isFile() || !info.size || info.size > limit) return null;
  const chunks = [];
  let total = 0;
  for await (const chunk of createReadStream(file, { end:limit, signal })) {
    total += chunk.length;
    if (total > limit) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

function imageFormat(buffer) {
  if (buffer.subarray(0, 8).equals(PNG)) return 'png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

async function convertToPng(buffer, format, signal) {
  if (process.platform !== 'darwin') return null;
  const directory = await mkdtemp(join(tmpdir(), 'studio-raster-evidence-'));
  try {
    const deadline = AbortSignal.timeout(TIMEOUT_MS);
    const active = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const input = 'input.' + format;
    const output = 'output.png';
    await writeFile(join(directory, input), buffer, { flag:'wx', mode:0o600, signal:active });
    const options = {
      cwd:directory, signal:active, killSignal:'SIGKILL', maxBuffer:64 * 1024,
      env:{PATH:'/usr/bin:/bin', LANG:'C', LC_ALL:'C'},
    };
    // Inspect the dimensions before decoding a compressed image to a full raster.
    const { stdout } = await exec('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', input], options);
    const width = Number(/^\s*pixelWidth:\s*(\d+)\s*$/m.exec(stdout)?.[1]);
    const height = Number(/^\s*pixelHeight:\s*(\d+)\s*$/m.exec(stdout)?.[1]);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
        width <= 0 || height <= 0 || width * height > MAX_SOURCE_PIXELS) return null;
    const conversion = ['-s', 'format', 'png'];
    if (Math.max(width, height) > MAX_SIDE) conversion.push('-Z', String(MAX_SIDE));
    await exec('/usr/bin/sips', [...conversion, input, '--out', output], options);
    const png = await readBounded(join(directory, output), MAX_OUTPUT, active);
    if (!png || png.length < 24 || imageFormat(png) !== 'png' ||
        png.readUInt32BE(16) > MAX_SIDE || png.readUInt32BE(20) > MAX_SIDE) return null;
    return png;
  } finally {
    await rm(directory, { recursive:true, force:true, maxRetries:2 }).catch(() => {});
  }
}

/** Optional curve candidates measured in pixels of the analyzed raster. */
export async function readImageCurveEvidence(buffer, file, extension, { signal } = {}) {
  signal?.throwIfAborted();
  if (typeof extension !== 'string' || !IMAGE_EXTENSIONS.has(extension.toLowerCase())) return null;
  try {
    const input = Buffer.isBuffer(buffer) ? buffer : await readBounded(file, MAX_INPUT, signal);
    if (!input?.length || input.length > MAX_INPUT) return null;
    const format = imageFormat(input);
    if (!format) return null;
    const png = format === 'png' ? input : await convertToPng(input, format, signal);
    signal?.throwIfAborted();
    return png ? readRasterCurveEvidence(png) : null;
  } catch {
    signal?.throwIfAborted();
    return null;
  }
}
