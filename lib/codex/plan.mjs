/**
 * 方案相关的纯函数：从 codex 回复里抠 JSON、解析对话补丁（契约 §4）、校验 Plan（契约 §1，V2，读 V1 时迁移）。
 * 不依赖 HTTP，方便单独测试。
 */

/** 允许的对话操作（契约 §4）。 */
export const PATCH_OPS = new Set([
  'moveFurniture',
  'rotateFurniture',
  'resizeFurniture',
  'addFurniture',
  'deleteFurniture',
  'setRoom',
  'demolishWall',
  'restoreWall',
  'setPlan',
  'editScene',
]);

/** 默认材料表（与 data/empty-plan.json 一致）。 */
export const DEFAULT_MATERIALS = {
  wood: { name: '橡木地板', price: 320, sw: '#d8b88a' },
  walnut: { name: '胡桃木地板', price: 380, sw: '#9b7250' },
  tile800: { name: '800 地砖', price: 220, sw: '#ebe6dc' },
  tile600: { name: '600 地砖', price: 160, sw: '#dfe3e1' },
  marble: { name: '大理石', price: 650, sw: '#f1eee8' },
  antislip: { name: '300 防滑砖', price: 140, sw: '#d3d8d4' },
  terrazzo: { name: '水磨石', price: 280, sw: '#e6dfd3' },
  carpet: { name: '满铺地毯', price: 200, sw: '#c9c3d3' },
};

const WALL_KINDS = new Set(['e', 'b', 'n', 'low']);
// Plan V2（契约 §1）：读 V1 时迁移，写出始终是 V2。
const PLAN_VERSION = 2;
const SOURCES = new Set(['drawing', 'ai', 'user']);
const DIM_FACES = new Set(['axis', 'outer', 'inner', 'left', 'right']);
const DIM_AXES = new Set(['x', 'y']);
const DIM_LOCKS = new Set(['from', 'to', 'none']);
const WINDOW_STYLES = new Set(['casement', 'sliding', 'fixed', 'floor', 'bay']);
const MAX_ID_LENGTH = 64;
const SILL_MAX = 3000;
const WIN_HEIGHT_MIN = 200;
const WIN_HEIGHT_MAX = 6000;
const CEILING_HEIGHT_MAX = 6000;
const CEILING_DROP_MAX = 2000;
const MAX_CEILING_DROPS = 64;
const MAX_DIMS = 2000;
const ARC_JOIN_TOLERANCE = 1;
const ARC_JOIN_MAX_WALLS = 4000;   // 超过后跳过 O(n²) 的弧段衔接提示
const MAX_OPS = 200;
const SCENE_FIELDS = {
  plan: new Set(['name', 'bounds', 'walls', 'wins', 'doors', 'slides', 'rooms', 'materials']),
  state: new Set(['furniture', 'rooms', 'demolished', 'measures']),
};
const SCENE_ACTIONS = new Set(['add', 'replace', 'remove']);
const UNSAFE_SCENE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
// 与 index.html 的家具库类型一致。
const FURNITURE_TYPES = new Set([
  'bed', 'crib', 'nightstand', 'wardrobe', 'dresser', 'desk', 'chair', 'bookshelf', 'baycushion',
  'sofa', 'cornersofa', 'armchair', 'beanbag', 'coffeetable', 'sidetable', 'tvstand', 'rug', 'shoecab',
  'floorlamp', 'plant', 'table', 'roundtable', 'island', 'barstool', 'counter', 'stove', 'ksink',
  'fridge', 'cabinet', 'toilet', 'vanity', 'shower', 'bathtub', 'washer', 'waterheater', 'tv',
  'aircon', 'acwall', 'dishwasher', 'ovencol', 'dryer', 'purifier', 'officechair', 'piano', 'treadmill',
]);
const COMPONENT_PART_SHAPES = new Set(['box', 'cylinder', 'stairs', 'winder']);
const TABLE_TOP_SHAPES = new Set(['rect', 'round', 'oval']);
const MAX_COMPONENT_PARTS = 48;
const MAX_COMPONENT_HEIGHT = 10_000;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isFiniteNumber = (v) => isNum(v);
const normalizeDegrees = (value) => ((value % 360) + 360) % 360;
const isFurnitureColor = (value) => typeof value === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value);

/** 从第一个 `{` / `[` 开始做括号配对（跳过字符串里的括号），返回第一个完整 JSON 文本。 */
function firstBalanced(text) {
  const start = text.search(/[{[]/);
  if (start < 0) return null;
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * 从任意文本里取 JSON：先试整段，再试 ``` 围栏，最后从第一个括号做配对。
 * 解析不出来返回 null。
 */
export function extractJson(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const trimmed = text.trim();
  const candidates = [];

  const fence = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/g;
  let match;
  while ((match = fence.exec(trimmed))) {
    const body = match[1].trim();
    if (body) candidates.push(body);
  }
  candidates.push(trimmed);
  const balanced = firstBalanced(trimmed);
  if (balanced && balanced !== trimmed) candidates.push(balanced);

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      /* 下一个 */
    }
  }
  return null;
}

function cloneJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function validScenePath(path) {
  if (!Array.isArray(path) || path.length < 2 || typeof path[0] !== 'string' || !Object.hasOwn(SCENE_FIELDS, path[0])) return false;
  if (!SCENE_FIELDS[path[0]].has(path[1])) return false;
  return path.every(key => typeof key === 'string'
    ? key.length > 0 && !UNSAFE_SCENE_KEYS.has(key)
    : Number.isInteger(key) && key >= 0 && key < 2 ** 32 - 1);
}

function isSceneData(value) {
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || isNum(item)) continue;
    if (Array.isArray(item)) {
      for (const member of item) pending.push(member);
      continue;
    }
    if (typeof item !== 'object' || Object.getPrototypeOf(item) !== Object.prototype) return false;
    for (const [key, member] of Object.entries(item)) {
      if (UNSAFE_SCENE_KEYS.has(key)) return false;
      pending.push(member);
    }
  }
  return true;
}

function normalizeSceneEdit(op) {
  if (!Array.isArray(op.changes) || !op.changes.length || op.changes.length > MAX_OPS) {
    throw new Error(`方案编辑需要提供 1 至 ${MAX_OPS} 项改动，本次改动未应用。`);
  }
  const changes = op.changes.map((change, index) => {
    if (!change || !SCENE_ACTIONS.has(change.action) || !validScenePath(change.path)) {
      throw new Error(`方案编辑的第 ${index + 1} 项操作或路径无效，本次改动未应用。`);
    }
    const { action, path, value } = change;
    if (action === 'remove') return { action, path };
    if (!Object.hasOwn(change, 'value') || !isSceneData(value)) {
      throw new Error(`方案编辑的第 ${index + 1} 项缺少有效数据，本次改动未应用。`);
    }
    return { action, path, value };
  });
  return { op: 'editScene', changes };
}

function normalizeOps(value) {
  if (!Array.isArray(value)) return [];
  if (value.length > MAX_OPS && value.some(item => item?.op === 'editScene')) {
    throw new Error(`本次操作超过 ${MAX_OPS} 项，本次改动未应用。`);
  }
  const out = [];
  for (const item of value.slice(0, MAX_OPS)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    if (typeof item.op !== 'string' || !PATCH_OPS.has(item.op)) continue;
    if (item.op === 'editScene') {
      out.push(normalizeSceneEdit(item));
      continue;
    }
    const clean = cloneJson(item);
    if (clean) out.push(clean);
  }
  return out;
}

function sanitizeFocus(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const focus = {};
  if (typeof value.room === 'string' && value.room) focus.room = value.room;
  if (Array.isArray(value.furn)) focus.furn = value.furn.filter((id) => typeof id === 'string').slice(0, 50);
  return Object.keys(focus).length ? focus : null;
}

/**
 * 解析 codex 的最终回答（契约 §4）。
 * 解析失败时按契约降级为 `{reply: 原文, ops: []}`；无效的 editScene 报错，阻止提交同一回复中的其他操作。
 */
export function parsePatch(text) {
  const raw = typeof text === 'string' ? text : '';
  const parsed = extractJson(raw);

  if (Array.isArray(parsed)) {
    const ops = normalizeOps(parsed);
    return { reply: ops.length ? '已更新方案。' : raw.trim(), ops };
  }

  if (parsed && typeof parsed === 'object') {
    if (parsed.op === 'editScene' && !Array.isArray(parsed.ops)) {
      throw new Error('方案编辑缺少 ops 列表，本次改动未应用。');
    }
    const ops = normalizeOps(parsed.ops);
    const reply = typeof parsed.reply === 'string' && parsed.reply.trim()
      ? parsed.reply.trim()
      : ops.length
        ? '已更新方案。'
        : raw.trim();
    const result = { reply, ops };
    const focus = sanitizeFocus(parsed.focus);
    if (focus) result.focus = focus;
    return result;
  }

  return { reply: raw.trim(), ops: [] };
}

function rect4(value) {
  if (!Array.isArray(value) || value.length < 4) return null;
  const [x0, y0, x1, y1] = value.slice(0, 4).map(Number);
  if (![x0, y0, x1, y1].every(Number.isFinite)) return null;
  return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
}

function point(value) {
  if (!Array.isArray(value) || value.length < 2) return null;
  const [x, y] = value.slice(0, 2).map(Number);
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
}

function poly(value) {
  if (!Array.isArray(value)) return null;
  const points = [];
  for (const p of value) {
    const pt = point(p);
    if (pt) points.push(pt);
  }
  if (points.length >= 4 && points[0][0] === points[points.length - 1][0] && points[0][1] === points[points.length - 1][1]) {
    points.pop();
  }
  return points.length >= 3 ? points : null;
}

function centroid(points) {
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p[0];
    y += p[1];
  }
  return [Math.round(x / points.length), Math.round(y / points.length)];
}

// The left normal puts positive sweeps clockwise in the plan's y-down coordinates.
export function arcGeometry(from, to, sweep) {
  if (!from || !to || !isNum(sweep) || Math.abs(sweep) < 0.5 || Math.abs(sweep) > 180) return null;
  const angle = sweep * Math.PI / 180;
  const dx = to[0] - from[0], dy = to[1] - from[1];
  const radius = Math.hypot(dx, dy) / (2 * Math.sin(Math.abs(angle) / 2));
  const offset = Math.abs(sweep) === 180 ? 0 : 0.5 / Math.tan(angle / 2);
  const cx = from[0] / 2 + to[0] / 2 - dy * offset;
  const cy = from[1] / 2 + to[1] / 2 + dx * offset;
  if (!isNum(radius) || radius <= 0 || ![cx - radius, cx + radius, cy - radius, cy + radius].every(isNum)) return null;
  return { cx, cy, radius, start: Math.atan2(from[1] - cy, from[0] - cx), angle };
}

function normalizeArcBand(raw) {
  const { from, to, sweep, thickness } = raw ?? {};
  const isEndpoint = (p) => Array.isArray(p) && p.length === 2 && isNum(p[0]) && isNum(p[1]);
  if (!isEndpoint(from) || !isEndpoint(to) || !isNum(thickness) || thickness <= 0) return null;
  const arc = arcGeometry(from, to, sweep);
  if (!arc || thickness / 2 >= arc.radius) return null;
  const outer = arc.radius + thickness / 2;
  if (![arc.cx - outer, arc.cx + outer, arc.cy - outer, arc.cy + outer].every(isNum)) return null;
  return { from: [...from], to: [...to], sweep, thickness };
}

const isArcBand = (raw) => raw && typeof raw === 'object' && !Array.isArray(raw) &&
  ['from', 'to', 'sweep', 'thickness'].some(key => Object.hasOwn(raw, key));

function normalizeRoomArcs(rawArcs, original, points) {
  const arcs = [];
  // Filtering an invalid vertex would move the arc to a different edge.
  if (!original.every(p => point(p))) return arcs;
  const seen = new Set();
  for (const arc of rawArcs) {
    const { edge, sweep } = arc ?? {};
    if (!Number.isInteger(edge) || edge < 0 || edge >= points.length || seen.has(edge)) continue;
    if (!arcGeometry(points[edge], points[(edge + 1) % points.length], sweep)) continue;
    seen.add(edge);
    arcs.push({ edge, sweep });
  }
  return arcs;
}

function growArcBounds(grow, from, to, sweep, thickness = 0) {
  const { cx, cy, radius, start, angle } = arcGeometry(from, to, sweep);
  const fullTurn = 2 * Math.PI;
  const spans = [start, start + angle];
  for (const bearing of [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2]) {
    const delta = (bearing - start) * Math.sign(angle);
    const progress = ((delta % fullTurn) + fullTurn) % fullTurn;
    if (progress <= Math.abs(angle)) spans.push(bearing);
  }
  for (const bearing of spans) {
    for (const distance of thickness ? [radius - thickness / 2, radius + thickness / 2] : [radius]) {
      grow(cx + distance * Math.cos(bearing), cy + distance * Math.sin(bearing));
    }
  }
}

/* ---------------- Plan V2：稳定 id、迁移与校验（契约 §1） ---------------- */

/** FNV-1a 32 位哈希：迁移期稳定 id 的几何指纹，同一几何永远得到同一串。 */
function geometryHash(parts) {
  const text = JSON.stringify(parts);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0').slice(0, 6);
}

/** 迁移期 id = 前缀 + 顺序 + 坐标哈希；同一输入重复迁移得到同一 id。 */
function stablePlanId(prefix, index, parts) {
  return `${prefix}${index + 1}-${geometryHash(parts)}`;
}

function cleanPlanId(value) {
  if (typeof value !== 'string') return null;
  const id = value.trim().replace(/[\u0000-\u001f\u007f]/g, '');
  return id ? id.slice(0, MAX_ID_LENGTH) : null;
}

/** 登记 id；重复时按出现顺序追加 _2、_3，保证集合内唯一。 */
function claimPlanId(used, preferred) {
  let id = preferred;
  for (let suffix = 2; used.has(id); suffix++) id = `${preferred}_${suffix}`;
  used.add(id);
  return id;
}

function normalizeSource(value) {
  return SOURCES.has(value) ? value : 'ai';
}

function normalizeWall(raw, index, used) {
  if (!raw || typeof raw !== 'object') return null;
  if (isArcBand(raw)) {
    const arc = normalizeArcBand(raw);
    if (!arc) return null;
    const wall = {
      id: claimPlanId(used, cleanPlanId(raw.id) ?? stablePlanId('w', index, ['arc', arc.from, arc.to, arc.sweep, arc.thickness])),
      from: arc.from,
      to: arc.to,
      sweep: arc.sweep,
      thickness: arc.thickness,
      kind: WALL_KINDS.has(raw.kind) ? raw.kind : 'n',
      source: normalizeSource(raw.source),
    };
    if (isNum(raw.height) && raw.height > 0) wall.height = raw.height;
    return wall;
  }
  const tuple = Array.isArray(raw);
  const rect = rect4(tuple ? raw : raw.rect);
  if (!rect) return null;
  const kind = tuple ? raw[4] : raw.kind;
  const height = tuple ? raw[5] : raw.height;
  const wall = {
    id: claimPlanId(used, cleanPlanId(tuple ? null : raw.id) ?? stablePlanId('w', index, ['seg', ...rect])),
    rect,
    kind: WALL_KINDS.has(kind) ? kind : 'n',
    source: normalizeSource(tuple ? 'ai' : raw.source),
  };
  if (isNum(height) && height > 0) wall.height = height;
  return wall;
}

/** V1 直窗元组只有矩形；迁移期 sill/h/style 置空（契约 §1 迁移规则）。 */
function normalizeWin(raw, index, used, warnings) {
  if (!raw || typeof raw !== 'object') return null;
  const tuple = Array.isArray(raw);
  let win;
  if (isArcBand(raw)) {
    const arc = normalizeArcBand(raw);
    if (!arc) return null;
    win = {
      id: claimPlanId(used, cleanPlanId(raw.id) ?? stablePlanId('win', index, ['arc', arc.from, arc.to, arc.sweep, arc.thickness])),
      from: arc.from,
      to: arc.to,
      sweep: arc.sweep,
      thickness: arc.thickness,
      source: normalizeSource(raw.source),
    };
  } else {
    const rect = rect4(tuple ? raw : raw.rect);
    if (!rect) return null;
    win = {
      id: claimPlanId(used, cleanPlanId(tuple ? null : raw.id) ?? stablePlanId('win', index, ['seg', ...rect])),
      rect,
      source: normalizeSource(tuple ? 'ai' : raw.source),
    };
  }
  if (tuple) return win;
  if (raw.sill !== undefined) {
    if (isNum(raw.sill) && raw.sill >= 0 && raw.sill <= SILL_MAX) win.sill = raw.sill;
    else warnings.push(`窗 ${win.id} 的窗台高不在 0–${SILL_MAX} mm 内，已忽略该字段。`);
  }
  if (raw.h !== undefined) {
    if (isNum(raw.h) && raw.h >= WIN_HEIGHT_MIN && raw.h <= WIN_HEIGHT_MAX) win.h = raw.h;
    else warnings.push(`窗 ${win.id} 的窗高不在 ${WIN_HEIGHT_MIN}–${WIN_HEIGHT_MAX} mm 内，已忽略该字段。`);
  }
  if (WINDOW_STYLES.has(raw.style)) win.style = raw.style;
  return win;
}

function normalizeDoor(raw, index, used) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rect = rect4(raw.rect);
  if (!rect) return null;
  const hinge = point(raw.h) ?? [rect[0], rect[1]];
  const close = point(raw.c) ?? [0, -1];
  const open = point(raw.o) ?? [1, 0];
  const len = isFiniteNumber(raw.len) && raw.len > 0 ? raw.len : Math.max(rect[2] - rect[0], rect[3] - rect[1]);
  const door = {
    id: claimPlanId(used, cleanPlanId(raw.id) ?? stablePlanId('d', index, ['door', ...rect])),
    name: typeof raw.name === 'string' && raw.name ? raw.name : '门',
    rect,
    h: hinge,
    c: close,
    o: open,
    len,
    source: normalizeSource(raw.source),
  };
  if (raw.entry === true) door.entry = true;
  return door;
}

function normalizeSlide(raw, index, used) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rect = rect4(raw.rect);
  if (!rect) return null;
  return {
    id: claimPlanId(used, cleanPlanId(raw.id) ?? stablePlanId('s', index, ['slide', ...rect])),
    rect,
    v: raw.v === true,
    source: normalizeSource(raw.source),
  };
}

function normalizeCeiling(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const ceiling = {};
  if (isNum(raw.h) && raw.h > 0 && raw.h <= CEILING_HEIGHT_MAX) ceiling.h = raw.h;
  if (Array.isArray(raw.drops)) {
    const drops = [];
    for (const drop of raw.drops.slice(0, MAX_CEILING_DROPS)) {
      const rect = rect4(drop?.rect);
      if (!rect || !isNum(drop.depth) || drop.depth <= 0 || drop.depth > CEILING_DROP_MAX) continue;
      drops.push({ rect, depth: drop.depth });
    }
    if (drops.length) ceiling.drops = drops;
  }
  if (raw.cove === 'none' || raw.cove === 'perimeter') ceiling.cove = raw.cove;
  if (typeof raw.box === 'boolean') ceiling.box = raw.box;
  return Object.keys(ceiling).length ? ceiling : null;
}

/** 缺省 point 时的量测点：直墙按面取端点/中心，弧墙取起点，房间边取中点。 */
function wallAnchorPoint(wall, face) {
  if (Array.isArray(wall.rect)) {
    const [x0, y0, x1, y1] = wall.rect;
    const cy = (y0 + y1) / 2;
    if (face === 'left') return [x0, cy];
    if (face === 'right') return [x1, cy];
    // outer/inner 指向哪一面取决于墙的朝向；没有显式 point 时退回墙段中心，避免猜错。
    return [(x0 + x1) / 2, cy];
  }
  return Array.isArray(wall.from) ? [...wall.from] : null;
}

function edgeMidpoint(points, edge) {
  const from = points[edge];
  const to = points[(edge + 1) % points.length];
  return from && to ? [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2] : null;
}

function normalizeDimAnchor(raw, context, label, warnings) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push(`尺寸${label}缺少有效锚点，已忽略该尺寸。`);
    return null;
  }
  if (raw.kind === 'wall') {
    const id = cleanPlanId(raw.id);
    const wall = id ? context.wallsById.get(id) : null;
    if (!wall) {
      warnings.push(`尺寸${label}引用的墙体「${typeof raw.id === 'string' ? raw.id : ''}」不存在，已忽略该尺寸。`);
      return null;
    }
    const face = DIM_FACES.has(raw.face) ? raw.face : 'axis';
    const anchorPoint = point(raw.point) ?? wallAnchorPoint(wall, face);
    if (!anchorPoint) return null;
    return { kind: 'wall', id: wall.id, face, point: anchorPoint };
  }
  if (raw.kind === 'room') {
    const id = cleanPlanId(raw.id);
    const room = id ? context.roomsById.get(id) : null;
    if (!room) {
      warnings.push(`尺寸${label}引用的房间「${typeof raw.id === 'string' ? raw.id : ''}」不存在，已忽略该尺寸。`);
      return null;
    }
    if (raw.face !== undefined && raw.face !== 'inner') {
      warnings.push(`尺寸${label}的房间锚点 face 只能是 inner，已忽略该尺寸。`);
      return null;
    }
    const edge = Number.isInteger(raw.edge) ? raw.edge : -1;
    if (edge < 0 || edge >= room.poly.length) {
      warnings.push(`尺寸${label}引用的房间边无效，已忽略该尺寸。`);
      return null;
    }
    const anchorPoint = point(raw.point) ?? edgeMidpoint(room.poly, edge);
    if (!anchorPoint) return null;
    return { kind: 'room', id: room.id, edge, face: 'inner', point: anchorPoint };
  }
  warnings.push(`尺寸${label}缺少有效锚点，已忽略该尺寸。`);
  return null;
}

function inferDimAxis(from, to) {
  return Math.abs(to[0] - from[0]) >= Math.abs(to[1] - from[1]) ? 'x' : 'y';
}

function normalizeDim(raw, index, context, used, warnings) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const from = normalizeDimAnchor(raw.from, context, '起点', warnings);
  if (!from) return null;
  const to = normalizeDimAnchor(raw.to, context, '终点', warnings);
  if (!to) return null;
  const dim = {
    id: claimPlanId(used, cleanPlanId(raw.id) ?? stablePlanId('dim', index, [
      from.kind, from.id, from.face, from.edge ?? null,
      to.kind, to.id, to.face, to.edge ?? null,
    ])),
    source: normalizeSource(raw.source),
    from,
    to,
    offset: isNum(raw.offset) ? raw.offset : 0,
    axis: DIM_AXES.has(raw.axis) ? raw.axis : inferDimAxis(from.point, to.point),
    locked: DIM_LOCKS.has(raw.locked) ? raw.locked : 'none',
  };
  if (isNum(raw.drawingValue) && raw.drawingValue >= 0) dim.drawingValue = raw.drawingValue;
  if (typeof raw.chain === 'string' && raw.chain.trim()) dim.chain = raw.chain.trim().slice(0, 64);
  if (typeof raw.note === 'string' && raw.note.trim()) dim.note = raw.note.trim().slice(0, 200);
  return dim;
}

/**
 * 弧段端点衔接（契约 §1）：只做提示，不作为拒绝条件。
 * 判定为端点对端点的 1 mm 容差，与确定性检查口径一致；墙段过多时跳过以控制耗时。
 */
function arcJoinWarnings(walls) {
  if (walls.length > ARC_JOIN_MAX_WALLS) {
    return [`墙体数量为 ${walls.length}，超过 ${ARC_JOIN_MAX_WALLS} 段，已跳过弧段衔接提示。`];
  }
  const endpoints = [];
  walls.forEach((wall, owner) => {
    const points = Array.isArray(wall.rect)
      ? [[wall.rect[0], wall.rect[1]], [wall.rect[2], wall.rect[1]], [wall.rect[0], wall.rect[3]], [wall.rect[2], wall.rect[3]]]
      : [wall.from, wall.to];
    for (const [x, y] of points) endpoints.push({ x, y, owner });
  });
  const warnings = [];
  walls.forEach((wall, owner) => {
    if (Array.isArray(wall.rect)) return;
    for (const [label, end] of [['起点', wall.from], ['终点', wall.to]]) {
      const joined = endpoints.some(({ x, y, owner: other }) =>
        other !== owner && Math.hypot(x - end[0], y - end[1]) <= ARC_JOIN_TOLERANCE);
      if (!joined) {
        warnings.push(`弧墙 ${wall.id} 的${label}未与相邻墙段衔接（容差 ${ARC_JOIN_TOLERANCE} mm），仅作提示。`);
      }
    }
  });
  return warnings;
}

/**
 * 校验并规整 Plan（契约 §1，Plan V2）。
 * 读 V1（walls/wins 元组、doors/slides 旧形状）时迁移为带稳定 id 的 V2 对象；写出一律 V2。
 * 宽容：能修的字段就地修（矩形反序、缺 kind、缺材料、越界 sill/h 置空），
 * 结构性错误（不是对象、没有房间）返回 {ok:false,error}；弧段衔接等提示放在 warnings 里，不拒绝。
 * @returns {{ok:true, plan:object, warnings:string[]} | {ok:false, error:string}}
 */
export function validatePlan(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'Plan 必须是 JSON 对象' };
  }
  const warnings = [];

  const usedWallIds = new Set();
  const walls = [];
  if (Array.isArray(raw.walls)) {
    for (const w of raw.walls) {
      const wall = normalizeWall(w, walls.length, usedWallIds);
      if (wall) walls.push(wall);
    }
  }

  const usedWinIds = new Set();
  const wins = [];
  if (Array.isArray(raw.wins)) {
    for (const w of raw.wins) {
      const win = normalizeWin(w, wins.length, usedWinIds, warnings);
      if (win) wins.push(win);
    }
  }

  const usedDoorIds = new Set();
  const doors = [];
  if (Array.isArray(raw.doors)) {
    for (const d of raw.doors) {
      const door = normalizeDoor(d, doors.length, usedDoorIds);
      if (door) doors.push(door);
    }
  }

  const usedSlideIds = new Set();
  const slides = [];
  if (Array.isArray(raw.slides)) {
    for (const s of raw.slides) {
      const slide = normalizeSlide(s, slides.length, usedSlideIds);
      if (slide) slides.push(slide);
    }
  }

  const usedRoomIds = new Set();
  const rooms = [];
  if (Array.isArray(raw.rooms)) {
    for (const r of raw.rooms) {
      if (!r || typeof r !== 'object') continue;
      const points = poly(r.poly);
      if (!points) continue;
      const id = claimPlanId(usedRoomIds, cleanPlanId(r.id) ?? `room${rooms.length + 1}`);
      const mat = typeof r.mat === 'string' && r.mat ? r.mat : 'tile800';
      const room = {
        id,
        name: typeof r.name === 'string' && r.name ? r.name : `房间 ${rooms.length + 1}`,
        poly: points,
        mat,
        at: point(r.at) ?? centroid(points),
        source: normalizeSource(r.source),
      };
      if (Array.isArray(r.arcs)) room.arcs = normalizeRoomArcs(r.arcs, r.poly, points);
      if (r.counted === false) room.counted = false;
      const ceiling = normalizeCeiling(r.ceiling);
      if (ceiling) room.ceiling = ceiling;
      rooms.push(room);
    }
  }

  // 与 index.html 的 sanitizePlan 口径一致：方案至少要有一个房间，墙体可以后续再补。
  if (rooms.length === 0) {
    return { ok: false, error: '没有识别到房间（no rooms found）：方案至少需要一个房间' };
  }

  const dims = [];
  if (Array.isArray(raw.dims)) {
    const context = {
      wallsById: new Map(walls.map(wall => [wall.id, wall])),
      roomsById: new Map(rooms.map(room => [room.id, room])),
    };
    const usedDimIds = new Set();
    for (const d of raw.dims.slice(0, MAX_DIMS)) {
      const dim = normalizeDim(d, dims.length, context, usedDimIds, warnings);
      if (dim) dims.push(dim);
    }
  }

  const materials = {};
  if (raw.materials && typeof raw.materials === 'object' && !Array.isArray(raw.materials)) {
    for (const [key, value] of Object.entries(raw.materials)) {
      if (!key || !value || typeof value !== 'object') continue;
      materials[key] = {
        name: typeof value.name === 'string' && value.name ? value.name : key,
        price: isFiniteNumber(value.price) ? value.price : 0,
        sw: typeof value.sw === 'string' && value.sw ? value.sw : '#e5e0d6',
      };
    }
  }
  for (const [key, value] of Object.entries(DEFAULT_MATERIALS)) {
    if (!materials[key]) materials[key] = { ...value };
  }
  for (const room of rooms) {
    if (!materials[room.mat]) materials[room.mat] = { name: room.mat, price: 0, sw: '#e5e0d6' };
  }

  let bounds = null;
  if (raw.bounds && typeof raw.bounds === 'object') {
    const b = [raw.bounds.x, raw.bounds.y, raw.bounds.w, raw.bounds.h].map(Number);
    if (b.every(Number.isFinite) && b[2] > 0 && b[3] > 0) bounds = { x: b[0], y: b[1], w: b[2], h: b[3] };
  }
  if (!bounds) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const grow = (x, y) => {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    };
    for (const wall of walls) {
      if (Array.isArray(wall.rect)) {
        grow(wall.rect[0], wall.rect[1]);
        grow(wall.rect[2], wall.rect[3]);
      } else {
        growArcBounds(grow, wall.from, wall.to, wall.sweep, wall.thickness);
      }
    }
    for (const window of wins) {
      if (!Array.isArray(window.rect)) growArcBounds(grow, window.from, window.to, window.sweep, window.thickness);
    }
    for (const room of rooms) {
      for (const [x, y] of room.poly) grow(x, y);
      for (const { edge, sweep } of room.arcs ?? []) {
        growArcBounds(grow, room.poly[edge], room.poly[(edge + 1) % room.poly.length], sweep);
      }
    }
    const pad = 240;
    bounds = Number.isFinite(minX)
      ? { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 }
      : { x: 0, y: 0, w: 10000, h: 8000 };
  }

  warnings.push(...arcJoinWarnings(walls));

  return {
    ok: true,
    plan: {
      version: PLAN_VERSION,
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : '导入方案',
      bounds,
      walls,
      wins,
      doors,
      slides,
      rooms,
      materials,
      dims,
    },
    warnings,
  };
}

/** 是否为 Plan V2。 */
export function isPlanV2(plan) {
  return Boolean(plan && typeof plan === 'object' && !Array.isArray(plan) && plan.version === PLAN_VERSION);
}

/**
 * V1 视图（过渡期）：把 V2 方案还原成旧的元组形状，供仍按 V1 读取的调用方使用。
 * 直墙 → [...Rect, kind, height?]；弧墙/弧窗 → ArcBand；门窗去掉 id/source；删掉 dims。
 * 不改动传入的方案，返回新对象。
 */
export function toV1Plan(plan) {
  const source = cloneJson(plan);
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;

  const walls = (Array.isArray(source.walls) ? source.walls : []).map((wall) => {
    if (Array.isArray(wall)) return wall;
    if (!wall || typeof wall !== 'object') return null;
    if (Array.isArray(wall.rect)) {
      const out = [...wall.rect, WALL_KINDS.has(wall.kind) ? wall.kind : 'n'];
      if (isNum(wall.height) && wall.height > 0) out.push(wall.height);
      return out;
    }
    const out = {
      from: [...wall.from],
      to: [...wall.to],
      sweep: wall.sweep,
      thickness: wall.thickness,
      kind: WALL_KINDS.has(wall.kind) ? wall.kind : 'n',
    };
    if (isNum(wall.height) && wall.height > 0) out.height = wall.height;
    return out;
  }).filter(Boolean);

  const wins = (Array.isArray(source.wins) ? source.wins : []).map((win) => {
    if (Array.isArray(win)) return win;
    if (!win || typeof win !== 'object') return null;
    if (Array.isArray(win.rect)) return [...win.rect];
    return { from: [...win.from], to: [...win.to], sweep: win.sweep, thickness: win.thickness };
  }).filter(Boolean);

  const withoutKeys = (item, keys) => {
    if (!item || typeof item !== 'object') return item;
    for (const key of keys) delete item[key];
    return item;
  };

  return {
    version: 1,
    name: source.name,
    bounds: source.bounds,
    walls,
    wins,
    doors: (Array.isArray(source.doors) ? source.doors : []).map(door => withoutKeys(door, ['id', 'source'])),
    slides: (Array.isArray(source.slides) ? source.slides : []).map(slide => withoutKeys(slide, ['id', 'source'])),
    rooms: (Array.isArray(source.rooms) ? source.rooms : []).map(room => withoutKeys(room, ['source', 'ceiling'])),
    materials: source.materials && typeof source.materials === 'object' ? source.materials : {},
  };
}

function validWinderPoint(point) {
  return Array.isArray(point) && point.length === 2 && point.every(axis => isNum(axis) && Math.abs(axis) <= 0.5);
}

function validWinderFan({ steps, pivot, edges }) {
  if (!Number.isInteger(steps) || steps < 2 || steps > 32) return false;
  if (!validWinderPoint(pivot) || !Array.isArray(edges) || edges.length !== steps + 1 || !edges.every(validWinderPoint)) return false;

  let winding = 0;
  let sweep = 0;
  for (let index = 0; index < steps; index++) {
    const ax = edges[index][0] - pivot[0];
    const az = edges[index][1] - pivot[1];
    const bx = edges[index + 1][0] - pivot[0];
    const bz = edges[index + 1][1] - pivot[1];
    const cross = ax * bz - az * bx;
    if (Math.abs(cross) <= 1e-9) return false;
    const sign = Math.sign(cross);
    if (winding && winding !== sign) return false;
    winding = sign;
    sweep += Math.abs(Math.atan2(cross, ax * bx + az * bz));
  }
  // 同一方向的扇形也不能绕回原处并覆盖前面的踏步。
  return sweep < 2 * Math.PI - 1e-8;
}

function validateComponentParts(raw) {
  if (!Array.isArray(raw)) return [];

  const parts = [];
  for (const part of raw.slice(0, MAX_COMPONENT_PARTS)) {
    if (!part || !COMPONENT_PART_SHAPES.has(part.shape)) continue;
    const { shape, x, z, w, d, y, h, rot, color, steps } = part;
    if (![x, z, w, d, y, h].every(isNum)) continue;
    if (Math.abs(x) > 0.5 || Math.abs(z) > 0.5 || w <= 0 || w > 1 || d <= 0 || d > 1) continue;
    if (y < 0 || h <= 0 || y + h > MAX_COMPONENT_HEIGHT) continue;
    if (shape === 'stairs' && (!Number.isInteger(steps) || steps < 1 || steps > 32)) continue;
    if (shape === 'winder' && !validWinderFan(part)) continue;

    const clean = { shape, x, z, w, d, y, h };
    if (isNum(rot)) clean.rot = normalizeDegrees(rot);
    if (isFurnitureColor(color)) clean.color = color;
    if (shape === 'stairs' || shape === 'winder') clean.steps = steps;
    if (shape === 'winder') {
      clean.pivot = [...part.pivot];
      clean.edges = part.edges.map(edge => [...edge]);
    }
    parts.push(clean);
  }
  return parts;
}

/** 规整图片导入的家具。ID 由客户端生成，以免与画布已有家具冲突。 */
export function validateImportedFurniture(raw, bounds) {
  if (!Array.isArray(raw)) return [];

  const maxDimension = Math.hypot(bounds.w, bounds.h);
  const furniture = [];
  for (const item of raw) {
    if (!item || (item.type !== 'component' && !FURNITURE_TYPES.has(item.type))) continue;
    const { type, cx, cy, w, d, rot } = item;
    if (![cx, cy, w, d, rot].every(isNum)) continue;
    const width = Math.round(w);
    const depth = Math.round(d);
    if (width <= 0 || depth <= 0 || width > maxDimension || depth > maxDimension) continue;
    if (cx < bounds.x || cx > bounds.x + bounds.w || cy < bounds.y || cy > bounds.y + bounds.h) continue;

    const clean = {
      type,
      name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : type,
      cx: Math.round(cx),
      cy: Math.round(cy),
      w: width,
      d: depth,
      rot: normalizeDegrees(rot),
    };
    if (isFurnitureColor(item.color)) clean.color = item.color;
    if (type === 'cornersofa' && (item.handedness === 'left' || item.handedness === 'right')) {
      clean.handedness = item.handedness;
    }
    if (type === 'coffeetable' || type === 'sidetable') {
      if (TABLE_TOP_SHAPES.has(item.topShape)) clean.topShape = item.topShape;
      if (isNum(item.height) && item.height >= 200 && item.height <= 800) clean.height = item.height;
    }
    if (type === 'component') {
      const parts = validateComponentParts(item.parts);
      if (!parts.length) continue;
      clean.parts = parts;
    }
    furniture.push(clean);
  }
  return furniture;
}

/** 生成一句中文摘要，codex 没给说明时兜底。 */
export function summarizePlan(plan) {
  const rooms = plan?.rooms?.length ?? 0;
  const walls = plan?.walls?.length ?? 0;
  const wins = plan?.wins?.length ?? 0;
  const doors = plan?.doors?.length ?? 0;
  const area = (plan?.rooms ?? [])
    .filter((r) => r.counted !== false)
    .reduce((sum, r) => sum + Math.abs(polyArea(r.poly, r.arcs)), 0);
  const areaText = area > 0 ? `，约 ${(area / 1_000_000).toFixed(1)} ㎡` : '';
  return `识别到 ${rooms} 个房间、${walls} 面墙、${wins} 扇窗、${doors} 扇门${areaText}。`;
}

/**
 * 房间多边形面积（mm²）；arcs 为 room.arcs，圆弧边按对应弓形面积修正。
 * 与 summarizePlan 共用同一口径，供复核的差异统计复用。
 */
export function polyArea(points, arcs = []) {
  const [ox, oy] = points[0] ?? [0, 0];
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    sum += (x1 - ox) * (y2 - oy) - (x2 - ox) * (y1 - oy);
  }
  let area = sum / 2;
  for (const { edge, sweep } of arcs) {
    const arc = arcGeometry(points[edge], points[(edge + 1) % points.length], sweep);
    if (arc) area += arc.radius ** 2 * (arc.angle - Math.sin(arc.angle)) / 2;
  }
  return area;
}
