import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { readRasterCurveEvidence } from '../lib/raster-curve-evidence.mjs';

const WIDTH = 400;
const HEIGHT = 320;
const SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');

function pngChunk(type, data) {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 4, 'ascii');
  data.copy(chunk, 8);
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, -4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  return chunk;
}

function png(pixels, channels = 1) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(WIDTH, 0);
  header.writeUInt32BE(HEIGHT, 4);
  header[8] = 8;
  header[9] = channels === 4 ? 6 : 0;
  const stride = WIDTH * channels;
  const rows = Buffer.alloc(HEIGHT * (stride + 1));
  for (let y = 0; y < HEIGHT; y++) {
    pixels.copy(rows, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function drawTraces(radii) {
  const pixels = Buffer.alloc(WIDTH * HEIGHT, 255);
  const ink = (x, y) => { pixels[Math.round(y) * WIDTH + Math.round(x)] = 0; };
  for (const [i, radius] of radii.entries()) {
    const corner = 60 + 3 * i;
    for (let sample = 0; sample <= 80; sample++) {
      const angle = sample * Math.PI / 160;
      ink(corner + radius * (1 - Math.cos(angle)), corner + radius * (1 - Math.sin(angle)));
    }
    for (let length = 0; length < 95; length++) {
      ink(corner + radius + length, corner);
      ink(corner, corner + radius + length);
    }
  }
  return pixels;
}

test('finds a rounded contour supported by multiple dark parallel raster traces', () => {
  const evidence = readRasterCurveEvidence(png(drawTraces([24, 21, 18])));
  assert.equal(evidence?.width, WIDTH);
  assert.equal(evidence?.height, HEIGHT);
  assert.equal(evidence.candidates.length, 1);
  const [candidate] = evidence.candidates;
  const [x, y] = candidate.corner;
  assert.ok(Math.hypot(x - 60, y - 60) <= 4);
  assert.ok(Math.abs(candidate.radius - 24) <= 4);
  assert.deepEqual(candidate.horizontalTangent, [x + candidate.radius, y]);
  assert.deepEqual(candidate.verticalTangent, [x, y + candidate.radius]);
  assert.ok(candidate.parallelTraces >= 2);
});

test('rejects straight corners and visible contours with only one trace', () => {
  assert.equal(readRasterCurveEvidence(png(drawTraces([0, 0, 0]))), null);
  assert.equal(readRasterCurveEvidence(png(drawTraces([24]))), null);
});

test('composites transparent black lines over white before looking for contours', () => {
  const grayscale = drawTraces([24, 21, 18]);
  const rgba = Buffer.alloc(grayscale.length * 4);
  for (const [i, intensity] of grayscale.entries()) {
    const start = 4 * i;
    rgba.fill(intensity, start, start + 3);
    rgba[start + 3] = 255;
  }
  assert.equal(readRasterCurveEvidence(png(rgba, 4))?.candidates.length, 1);
  for (const [i, intensity] of grayscale.entries()) rgba[4 * i + 3] = intensity;
  assert.equal(readRasterCurveEvidence(png(rgba, 4)), null);
});

test('returns no evidence for unsupported or truncated bytes', () => {
  const intact = png(drawTraces([24, 21, 18]));
  assert.equal(readRasterCurveEvidence(intact.subarray(0, -6)), null);
  assert.equal(readRasterCurveEvidence(Buffer.from([255,216,255,224])), null);
  assert.equal(readRasterCurveEvidence(null), null);
});
