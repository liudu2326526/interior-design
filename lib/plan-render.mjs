/**
 * 把 Plan 渲染成一张 PNG，供图纸复核时与原图对照。
 * 零第三方依赖：只用 node:zlib 手写 PNG（8 位 RGB、filter 0）。
 * 画布按最长边约 1400px 等比缩放，2x 超采样后盒式降采样。
 */
import zlib from 'node:zlib';

const PAD = 24;
const LONG_SIDE = 1400;
const SUPERSAMPLE = 2;
const DEFAULT_WIDTH = 640;
const DEFAULT_HEIGHT = 480;
/** 圆弧折线近似：每 5 度一段。 */
const ARC_STEP_DEGREES = 5;

const COLOR = {
  background: [255, 255, 255],
  room: [0xf2, 0xec, 0xe2],
  roomEdge: [0xd9, 0xd1, 0xc3],
  wall: [0x2b, 0x28, 0x24],
  window: [0x2f, 0x5d, 0x62],
  door: [0xb5, 0x65, 0x3a],
  furniture: [0x8a, 0x81, 0x74],
};

/** 笔宽上限（设备像素半径）。模型给出离谱的墙厚时只画成粗略色块，不能拖垮渲染。 */
const MAX_PEN_RADIUS = 256;
const RGB = new Map(Object.values(COLOR).map(color => [color, Buffer.from(color)]));

const isNum = (value) => typeof value === 'number' && Number.isFinite(value);

// ---------------------------------------------------------------- 像素画布

class Raster {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.data = Buffer.alloc(width * height * 3, 255);
  }

  /** 填充一条水平扫描线（右端不包含）。 */
  fillSpan(y, x0, x1, color) {
    if (y < 0 || y >= this.height) return;
    const start = Math.max(0, Math.ceil(x0));
    const end = Math.min(this.width, Math.ceil(x1));
    if (start >= end) return;
    const row = y * this.width;
    this.data.fill(RGB.get(color), (row + start) * 3, (row + end) * 3);
  }

  fillRect(x0, y0, x1, y1, color) {
    if (![x0, y0, x1, y1].every(Number.isFinite)) return;
    const left = Math.min(x0, x1);
    const right = Math.max(x0, x1);
    const top = Math.max(0, Math.floor(y0));
    const bottom = Math.min(this.height - 1, Math.ceil(y1));
    for (let y = top; y <= bottom; y++) this.fillSpan(y, left, right, color);
  }

  /** 偶奇规则扫描线填充多边形。 */
  fillPolygon(points, color) {
    if (!Array.isArray(points) || points.length < 3) return;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const point of points) {
      if (!Array.isArray(point) || !Number.isFinite(point[1])) continue;
      minY = Math.min(minY, point[1]);
      maxY = Math.max(maxY, point[1]);
    }
    if (!Number.isFinite(minY) || !Number.isFinite(maxY)) return;
    const top = Math.max(0, Math.floor(minY));
    const bottom = Math.min(this.height - 1, Math.ceil(maxY));
    const crossings = [];
    for (let y = top; y <= bottom; y++) {
      crossings.length = 0;
      const scan = y + 0.5;
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const a = points[i];
        const b = points[j];
        if (!Array.isArray(a) || !Array.isArray(b)) continue;
        const [ax, ay] = a;
        const [bx, by] = b;
        if (![ax, ay, bx, by].every(Number.isFinite)) continue;
        if ((ay <= scan && by > scan) || (by <= scan && ay > scan)) {
          crossings.push(ax + (scan - ay) * (bx - ax) / (by - ay));
        }
      }
      if (crossings.length < 2) continue;
      crossings.sort((a, b) => a - b);
      for (let k = 0; k + 1 < crossings.length; k += 2) {
        this.fillSpan(y, crossings[k], crossings[k + 1], color);
      }
    }
  }

  /** 用一系列圆点画粗线；超采样 + 降采样后边缘足够平滑。 */
  line(x0, y0, x1, y1, color, width = 1.5) {
    if (![x0, y0, x1, y1].every(Number.isFinite)) return;
    const raw = Number(width) / 2;
    const radius = Math.min(MAX_PEN_RADIUS, Number.isFinite(raw) && raw > 0.5 ? raw : 0.5);
    // 先把线段裁剪到画布（含笔宽余量）：模型给的越界坐标不能变成按像素长度循环。
    const clipped = this.clipSegment(x0, y0, x1, y1, radius);
    if (!clipped) return;
    const [cx0, cy0, cx1, cy1] = clipped;
    const dx = cx1 - cx0;
    const dy = cy1 - cy0;
    const length = Math.hypot(dx, dy);
    if (!Number.isFinite(length)) return;
    if (length === 0) {
      this.disc(cx0, cy0, radius, color);
      return;
    }
    // 笔粗时按半径的一半取样：相邻圆点仍然重叠，但圆点数与笔宽脱钩。
    const steps = Math.max(1, Math.ceil(length / Math.max(1, radius / 2)));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      this.disc(cx0 + dx * t, cy0 + dy * t, radius, color);
    }
  }

  /** Liang–Barsky：把线段裁剪到画布内（外边距 margin）；完全在外时返回 null。 */
  clipSegment(x0, y0, x1, y1, margin = 0) {
    const xMin = -margin;
    const xMax = this.width - 1 + margin;
    const yMin = -margin;
    const yMax = this.height - 1 + margin;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const p = [-dx, dx, -dy, dy];
    const q = [x0 - xMin, xMax - x0, y0 - yMin, yMax - y0];
    let t0 = 0;
    let t1 = 1;
    for (let i = 0; i < 4; i++) {
      if (p[i] === 0) {
        if (q[i] < 0) return null;
        continue;
      }
      const ratio = q[i] / p[i];
      if (p[i] < 0) {
        if (ratio > t1) return null;
        if (ratio > t0) t0 = ratio;
      } else {
        if (ratio < t0) return null;
        if (ratio < t1) t1 = ratio;
      }
    }
    return [x0 + dx * t0, y0 + dy * t0, x0 + dx * t1, y0 + dy * t1];
  }

  disc(cx, cy, radius, color) {
    if (![cx, cy].every(Number.isFinite)) return;
    const top = Math.max(0, Math.floor(cy - radius));
    const bottom = Math.min(this.height - 1, Math.ceil(cy + radius));
    const limit = radius * radius;
    for (let y = top; y <= bottom; y++) {
      const oy = y + 0.5 - cy;
      const widthSquared = limit - oy * oy;
      if (widthSquared < 0) continue;
      const dx = Math.sqrt(widthSquared);
      this.fillSpan(y, cx - 0.5 - dx, Math.floor(cx - 0.5 + dx) + 1, color);
    }
  }

  strokePolygon(points, color, width) {
    if (!Array.isArray(points) || points.length < 2) return;
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      this.line(a[0], a[1], b[0], b[1], color, width);
    }
  }
}

// ---------------------------------------------------------------- 几何与变换

function readBounds(value) {
  if (!value || typeof value !== 'object') return null;
  const [x, y, w, h] = [value.x, value.y, value.w, value.h].map(Number);
  if (![x, y, w, h].every(Number.isFinite) || !(w > 0) || !(h > 0)) return null;
  return { x, y, w, h };
}

function hasGeometry(plan) {
  if (!plan || typeof plan !== 'object') return false;
  for (const key of ['rooms', 'walls', 'wins', 'doors', 'slides', 'furniture']) {
    if (Array.isArray(plan[key]) && plan[key].length > 0) return true;
  }
  return false;
}

function normRect(value) {
  if (!Array.isArray(value) || value.length < 4) return null;
  const [x0, y0, x1, y1] = value.slice(0, 4).map(Number);
  if (![x0, y0, x1, y1].every(Number.isFinite)) return null;
  return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
}

/** 等比缩放：把 bounds 的最长边放进 LONG_SIDE - 2 * PAD 的内容区。 */
function canvasSize(bounds) {
  const inner = LONG_SIDE - PAD * 2;
  const ratio = bounds.w / bounds.h;
  let contentWidth = inner;
  let contentHeight = inner / ratio;
  if (ratio < 1) {
    contentHeight = inner;
    contentWidth = inner * ratio;
  }
  const width = Math.max(2 * PAD + 2, Math.round(contentWidth) + PAD * 2);
  const height = Math.max(2 * PAD + 2, Math.round(contentHeight) + PAD * 2);
  return { width, height };
}

function createTransform(bounds, scale) {
  const offsetX = PAD - bounds.x * scale;
  const offsetY = PAD - bounds.y * scale;
  const x = (value) => (offsetX + value * scale) * SUPERSAMPLE;
  const y = (value) => (offsetY + value * scale) * SUPERSAMPLE;
  return {
    scale,
    x,
    y,
    point: (point) => (Array.isArray(point) ? [x(Number(point[0])), y(Number(point[1]))] : null),
  };
}

const isArcBand = (value) => value && typeof value === 'object' && !Array.isArray(value) &&
  ['from', 'to', 'sweep', 'thickness'].some((key) => Object.hasOwn(value, key));

/** 圆弧中心线采样点（与 lib/codex/plan.mjs 的圆弧约定一致）。 */
function arcPolyline(band) {
  const from = band?.from;
  const to = band?.to;
  const sweep = Number(band?.sweep);
  if (!Array.isArray(from) || !Array.isArray(to) || !isNum(sweep)) return null;
  const [fx, fy] = from.map(Number);
  const [tx, ty] = to.map(Number);
  if (![fx, fy, tx, ty].every(Number.isFinite)) return null;
  const absolute = Math.abs(sweep);
  if (absolute < 0.5 || absolute > 180) return null;
  const angle = sweep * Math.PI / 180;
  const dx = tx - fx;
  const dy = ty - fy;
  const radius = Math.hypot(dx, dy) / (2 * Math.sin(absolute * Math.PI / 360));
  const offset = absolute === 180 ? 0 : 0.5 / Math.tan(angle / 2);
  const cx = (fx + tx) / 2 - dy * offset;
  const cy = (fy + ty) / 2 + dx * offset;
  if (![cx, cy, radius].every(Number.isFinite) || radius <= 0) return null;
  const start = Math.atan2(fy - cy, fx - cx);
  const segments = Math.max(2, Math.ceil(absolute / ARC_STEP_DEGREES));
  const points = [];
  for (let i = 0; i <= segments; i++) {
    const bearing = start + angle * i / segments;
    points.push([cx + radius * Math.cos(bearing), cy + radius * Math.sin(bearing)]);
  }
  return points;
}

function drawArcBand(raster, band, color, transform) {
  const points = arcPolyline(band);
  if (!points) return;
  const thickness = Number(band?.thickness);
  const width = Number.isFinite(thickness) && thickness > 0
    ? thickness * transform.scale * SUPERSAMPLE
    : 1.5 * SUPERSAMPLE;
  const device = points.map(transform.point);
  for (let i = 1; i < device.length; i++) {
    const a = device[i - 1];
    const b = device[i];
    if (!a || !b) continue;
    raster.line(a[0], a[1], b[0], b[1], color, Math.max(1.5, width));
  }
}

function drawSwing(raster, door, rect, transform) {
  const hinge = Array.isArray(door?.h) && door.h.length >= 2 ? door.h.map(Number) : [rect[0], rect[1]];
  if (!hinge.every(Number.isFinite)) return;
  const closed = Array.isArray(door?.c) ? door.c.map(Number) : [1, 0];
  const open = Array.isArray(door?.o) ? door.o.map(Number) : [0, 1];
  let length = Number(door?.len);
  if (!Number.isFinite(length) || length <= 0) length = Math.max(rect[2] - rect[0], rect[3] - rect[1]);
  if (!Number.isFinite(length) || length <= 0) return;
  if (![closed[0], closed[1], open[0], open[1]].every(Number.isFinite)) return;

  const width = 1.2 * SUPERSAMPLE;
  // 门扇（关门状态）
  const leafEnd = [hinge[0] + closed[0] * length, hinge[1] + closed[1] * length];
  const leafA = transform.point(hinge);
  const leafB = transform.point(leafEnd);
  if (leafA && leafB) raster.line(leafA[0], leafA[1], leafB[0], leafB[1], COLOR.door, width);

  // 开启弧线：从 c 转到 o 的最短方向。
  const startAngle = Math.atan2(closed[1], closed[0]);
  const endAngle = Math.atan2(open[1], open[0]);
  let delta = endAngle - startAngle;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  const segments = 16;
  let previous = null;
  for (let i = 0; i <= segments; i++) {
    const bearing = startAngle + delta * i / segments;
    const point = transform.point([hinge[0] + Math.cos(bearing) * length, hinge[1] + Math.sin(bearing) * length]);
    if (previous && point) raster.line(previous[0], previous[1], point[0], point[1], COLOR.door, width);
    previous = point;
  }
}

function drawPlan(raster, plan, transform) {
  const strokeWidth = 1.2 * SUPERSAMPLE;

  // 房间边界与墙窗使用相同的圆弧约定。
  for (const room of plan.rooms || []) {
    if (!Array.isArray(room?.poly) || room.poly.length < 3) continue;
    const arcs = new Map((Array.isArray(room.arcs) ? room.arcs : []).map(arc => [arc?.edge, arc?.sweep]));
    const outline = room.poly.flatMap((from, i) => {
      if (!arcs.has(i)) return [from];
      const arc = arcPolyline({ from, to:room.poly[(i+1) % room.poly.length], sweep:arcs.get(i) });
      return arc ? arc.slice(0, -1) : [from];
    });
    const points = outline.map(transform.point).filter(Boolean);
    if (points.length < 3) continue;
    raster.fillPolygon(points, COLOR.room);
    raster.strokePolygon(points, COLOR.roomEdge, strokeWidth);
  }

  // 家具：按 (cx, cy, w, d, rot) 画旋转矩形
  for (const item of plan.furniture || []) {
    const cx = Number(item?.cx);
    const cy = Number(item?.cy);
    const w = Number(item?.w);
    const d = Number(item?.d);
    const rot = Number(item?.rot) || 0;
    if (![cx, cy, w, d, rot].every(Number.isFinite) || w <= 0 || d <= 0) continue;
    const radians = rot * Math.PI / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const corners = [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]]
      .map(([x, y]) => transform.point([cx + x * cos - y * sin, cy + x * sin + y * cos]))
      .filter(Boolean);
    if (corners.length === 4) raster.strokePolygon(corners, COLOR.furniture, strokeWidth);
  }

  // 墙体
  for (const wall of plan.walls || []) {
    const rect = normRect(wall?.rect ?? wall);
    if (rect) {
      raster.fillRect(transform.x(rect[0]), transform.y(rect[1]), transform.x(rect[2]), transform.y(rect[3]), COLOR.wall);
    } else if (isArcBand(wall)) {
      drawArcBand(raster, wall, COLOR.wall, transform);
    }
  }

  // 窗
  for (const win of plan.wins || []) {
    const rect = normRect(win?.rect ?? win);
    if (rect) {
      raster.fillRect(transform.x(rect[0]), transform.y(rect[1]), transform.x(rect[2]), transform.y(rect[3]), COLOR.window);
    } else if (isArcBand(win)) {
      drawArcBand(raster, win, COLOR.window, transform);
    }
  }

  // 平开门：门洞 + 门扇 + 开启弧线
  for (const door of plan.doors || []) {
    const rect = normRect(door?.rect);
    if (!rect) continue;
    raster.fillRect(transform.x(rect[0]), transform.y(rect[1]), transform.x(rect[2]), transform.y(rect[3]), COLOR.background);
    const corners = [
      transform.point([rect[0], rect[1]]),
      transform.point([rect[2], rect[1]]),
      transform.point([rect[2], rect[3]]),
      transform.point([rect[0], rect[3]]),
    ].filter(Boolean);
    if (corners.length === 4) raster.strokePolygon(corners, COLOR.door, strokeWidth);
    drawSwing(raster, door, rect, transform);
  }

  // 推拉门：门洞轮廓 + 两扇门板示意
  for (const slide of plan.slides || []) {
    const rect = normRect(slide?.rect);
    if (!rect) continue;
    raster.fillRect(transform.x(rect[0]), transform.y(rect[1]), transform.x(rect[2]), transform.y(rect[3]), COLOR.background);
    const corners = [
      transform.point([rect[0], rect[1]]),
      transform.point([rect[2], rect[1]]),
      transform.point([rect[2], rect[3]]),
      transform.point([rect[0], rect[3]]),
    ].filter(Boolean);
    if (corners.length === 4) raster.strokePolygon(corners, COLOR.door, strokeWidth);
    if (slide?.v === true) {
      const quarter = (rect[2] - rect[0]) / 4;
      const top = transform.point([rect[0] + quarter, rect[1]]);
      const bottom = transform.point([rect[0] + quarter, rect[3]]);
      const top2 = transform.point([rect[2] - quarter, rect[1]]);
      const bottom2 = transform.point([rect[2] - quarter, rect[3]]);
      if (top && bottom) raster.line(top[0], top[1], bottom[0], bottom[1], COLOR.door, strokeWidth);
      if (top2 && bottom2) raster.line(top2[0], top2[1], bottom2[0], bottom2[1], COLOR.door, strokeWidth);
    } else {
      const quarter = (rect[3] - rect[1]) / 4;
      const left = transform.point([rect[0], rect[1] + quarter]);
      const right = transform.point([rect[2], rect[1] + quarter]);
      const left2 = transform.point([rect[0], rect[3] - quarter]);
      const right2 = transform.point([rect[2], rect[3] - quarter]);
      if (left && right) raster.line(left[0], left[1], right[0], right[1], COLOR.door, strokeWidth);
      if (left2 && right2) raster.line(left2[0], left2[1], right2[0], right2[1], COLOR.door, strokeWidth);
    }
  }
}

// ---------------------------------------------------------------- 降采样与 PNG

function downsample(raster, factor) {
  const width = Math.floor(raster.width / factor);
  const height = Math.floor(raster.height / factor);
  const out = Buffer.alloc(width * height * 3);
  const count = factor * factor;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let dy = 0; dy < factor; dy++) {
        const row = ((y * factor + dy) * raster.width + x * factor) * 3;
        for (let dx = 0; dx < factor; dx++) {
          const index = row + dx * 3;
          r += raster.data[index];
          g += raster.data[index + 1];
          b += raster.data[index + 2];
        }
      }
      const offset = (y * width + x) * 3;
      out[offset] = Math.round(r / count);
      out[offset + 1] = Math.round(g / count);
      out[offset + 2] = Math.round(b / count);
    }
  }
  return out;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const name = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([length, name, data, crc]);
}

function encodePng(rgb, width, height) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type: truecolor
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function blankPng() {
  return encodePng(Buffer.alloc(DEFAULT_WIDTH * DEFAULT_HEIGHT * 3, 255), DEFAULT_WIDTH, DEFAULT_HEIGHT);
}

/**
 * 把 Plan 画成 PNG。
 * @param {object} plan 已校验或未校验的 Plan
 * @returns {Buffer} PNG 字节；输入异常时返回 640×480 白图，不抛错。
 */
export function renderPlanPng(plan) {
  try {
    const bounds = readBounds(plan?.bounds);
    if (!bounds || !hasGeometry(plan)) return blankPng();
    const { width, height } = canvasSize(bounds);
    const scale = Math.min((width - PAD * 2) / bounds.w, (height - PAD * 2) / bounds.h);
    if (!Number.isFinite(scale) || scale <= 0) return blankPng();
    const raster = new Raster(width * SUPERSAMPLE, height * SUPERSAMPLE);
    drawPlan(raster, plan, createTransform(bounds, scale));
    return encodePng(downsample(raster, SUPERSAMPLE), width, height);
  } catch {
    return blankPng();
  }
}
