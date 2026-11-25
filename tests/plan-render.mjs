import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { test } from 'node:test';
import { renderPlanPng } from '../lib/plan-render.mjs';

const SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');

/** 解析本模块写出的 PNG（8 位 RGB、filter 0）。 */
function decodePng(buffer) {
  assert.ok(Buffer.isBuffer(buffer), 'renderPlanPng 必须返回 Buffer');
  assert.ok(buffer.length > 0, 'PNG 不能为空');
  assert.deepEqual(buffer.subarray(0, 8), SIGNATURE);

  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = null;
  const idat = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.equal(data[8], 8, 'bit depth 必须是 8');
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  assert.equal(colorType, 2, '应为 RGB 真彩色');
  assert.ok(width > 0 && height > 0);

  const stride = width * 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  assert.equal(raw.length, (stride + 1) * height);
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1);
    assert.equal(raw[start], 0, '只应使用 filter 0');
    raw.copy(pixels, y * stride, start + 1, start + 1 + stride);
  }
  return {
    width,
    height,
    pixels,
    at(x, y) {
      const index = (y * width + x) * 3;
      return [pixels[index], pixels[index + 1], pixels[index + 2]];
    },
  };
}

function countPixels(image, predicate) {
  let found = 0;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (predicate(image.at(x, y))) found++;
    }
  }
  return found;
}

const isDark = ([r, g, b]) => r < 90 && g < 90 && b < 90;
const isLight = ([r, g, b]) => r > 240 && g > 240 && b > 240;
const isWall = ([r, g, b]) => Math.abs(r - 0x2b) < 12 && Math.abs(g - 0x28) < 12 && Math.abs(b - 0x24) < 12;

const sample = {
  version: 1,
  name: '测试户型',
  bounds: { x: 0, y: 0, w: 8000, h: 6000 },
  walls: [
    [0, 0, 8000, 200, 'e'],
    [0, 0, 200, 6000, 'e'],
    [7800, 0, 8000, 6000, 'e'],
    [0, 5800, 8000, 6000, 'e'],
    [4000, 200, 4200, 5800, 'n'],
  ],
  wins: [[1000, 0, 2200, 200], [5000, 0, 6200, 200]],
  doors: [{ name: '入户门', rect: [3600, 5800, 4500, 6000], h: [3600, 5900], c: [1, 0], o: [0, -1], len: 900, entry: true }],
  slides: [{ rect: [4000, 2000, 4200, 3000], v: true }],
  rooms: [
    { id: 'living', name: '客厅', poly: [[200, 200], [4000, 200], [4000, 5800], [200, 5800]], mat: 'tile800' },
    { id: 'bed', name: '主卧', poly: [[4200, 200], [7800, 200], [7800, 5800], [4200, 5800]], mat: 'wood' },
  ],
  furniture: [{ type: 'sofa', name: '沙发', cx: 2000, cy: 1200, w: 1800, d: 800, rot: 0 }],
};

test('renders a valid PNG with dark walls and a light background', () => {
  const image = decodePng(renderPlanPng(sample));
  const longest = Math.max(image.width, image.height);
  assert.ok(longest >= 1300 && longest <= 1420, `最长边应接近 1400px，实际 ${longest}`);
  assert.ok(image.width > 48 && image.height > 48);

  assert.ok(countPixels(image, isLight) > 1000, '应存在白色背景');
  assert.ok(countPixels(image, isDark) > 100, '应存在深色墙体');
  assert.ok(countPixels(image, isWall) > 50, '墙体应为 #2b2824');
  assert.ok(countPixels(image, ([r, g, b]) => Math.abs(r - 0xf2) < 14 && Math.abs(g - 0xec) < 14 && Math.abs(b - 0xe2) < 14) > 100,
    '房间应有浅色填充');
  assert.ok(countPixels(image, ([r, g, b]) => Math.abs(r - 0x2f) < 14 && Math.abs(g - 0x5d) < 14 && Math.abs(b - 0x62) < 14) > 10,
    '窗应为 #2f5d62');
  assert.ok(countPixels(image, ([r, g, b]) => Math.abs(r - 0xb5) < 14 && Math.abs(g - 0x65) < 14 && Math.abs(b - 0x3a) < 14) > 5,
    '门应为 #b5653a');
  assert.ok(countPixels(image, ([r, g, b]) => Math.abs(r - 0x8a) < 14 && Math.abs(g - 0x81) < 14 && Math.abs(b - 0x74) < 14) > 5,
    '家具应为 #8a8174');
});

test('keeps rooms, windows, doors and rotated furniture inside reasonable bounds', () => {
  const image = decodePng(renderPlanPng({
    ...sample,
    furniture: [
      { type: 'bed', name: '床', cx: 2000, cy: 3000, w: 1500, d: 2000, rot: 45 },
      { type: 'chair', name: '椅子', cx: 6000, cy: 3000, w: 450, d: 450, rot: 270 },
    ],
  }));
  assert.ok(image.width > 0 && image.height > 0);
  assert.ok(countPixels(image, isLight) > 1000);
  assert.ok(countPixels(image, isDark) > 100);
});

test('renders arc walls, arc windows and small rooms without crashing', () => {
  const image = decodePng(renderPlanPng({
    version: 1,
    name: '弧墙',
    bounds: { x: -500, y: -500, w: 9000, h: 9000 },
    walls: [
      [-240, -240, 8000, 0, 'e'],
      { from: [6000, 1000], to: [7000, 2000], sweep: 90, thickness: 240, kind: 'e' },
    ],
    wins: [{ from: [3000, 0], to: [4000, 1000], sweep: -90, thickness: 120 }],
    doors: [],
    slides: [],
    rooms: [
      { id: 'tiny', name: '储物', poly: [[100, 100], [400, 100], [400, 400], [100, 400]], mat: 'tile800' },
      { id: 'round', name: '圆角厅', poly: [[0, 0], [4000, 0], [4000, 4000], [0, 4000]], arcs: [{ edge: 0, sweep: 90 }], mat: 'wood' },
    ],
    furniture: [],
  }));
  assert.ok(image.width > 0);
  assert.ok(countPixels(image, isDark) > 100);
  assert.ok(countPixels(image, isLight) > 1000);
});

test('stays fast when model geometry lands far outside the canvas', () => {
  const started = Date.now();
  const image = decodePng(renderPlanPng({
    version: 1,
    name: '越界坐标',
    bounds: { x: 0, y: 0, w: 10000, h: 10000 },
    walls: [[0, 0, 1e9, 1e9], { from: [0, 0], to: [4000, 4000], sweep: 90, thickness: 1e9 }],
    wins: [[0, 0, 1e9, 1e9]],
    doors: [{ rect: [0, 0, 1e9, 1e9], h: [1e9, 1e9], c: [1, 0], o: [0, 1], len: 1e9 }],
    slides: [],
    rooms: [{ id: 'a', name: '客厅', poly: [[0, 0], [1e9, 0], [1e9, 1e9], [0, 1e9]], mat: 'tile800' }],
    furniture: [{ type: 'bed', name: '床', cx: 1e9, cy: 1e9, w: 1e9, d: 1e9, rot: 0 }],
  }));
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 3000, `越界坐标应在 3s 内完成，实际 ${elapsed}ms`);
  assert.ok(image.width > 0 && image.height > 0);
});

test('returns a plain white image for empty, invalid and extreme input', () => {
  for (const plan of [
    null,
    undefined,
    {},
    { bounds: { x: 0, y: 0, w: 0, h: 0 } },
    { bounds: { x: 0, y: 0, w: -10, h: 20 } },
    { bounds: { x: 0, y: 0, w: NaN, h: 20 } },
    { bounds: { x: 0, y: 0, w: 1e12, h: 1e-3 } },
    { bounds: { x: 0, y: 0, w: 100, h: 100 }, rooms: [], walls: [] },
  ]) {
    const image = decodePng(renderPlanPng(plan));
    assert.ok(image.width >= 1 && image.height >= 1);
    assert.equal(countPixels(image, p => !isLight(p)), 0, '默认图应为纯白');
  }

  const extreme = decodePng(renderPlanPng({
    bounds: { x: -1e12, y: -1e12, w: 2e12, h: 2e12 },
    walls: [[-1e12, -1e12, 1e12, -1e12 + 10]],
    rooms: [{ id: 'a', name: '房间', poly: [[-1e12, -1e12], [1e12, -1e12], [1e12, 1e12], [-1e12, 1e12]] }],
  }));
  assert.ok(extreme.width >= 1 && extreme.height >= 1);
});
