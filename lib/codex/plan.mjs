/**
 * 方案相关的纯函数：从 codex 回复里抠 JSON、解析对话补丁（契约 §4）、校验 Plan（契约 §1）。
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

/**
 * 校验并规整 Plan（契约 §1）。
 * 宽容：能修的字段就地修（矩形反序、缺 kind、缺材料），结构性错误返回 {ok:false,error}。
 * @returns {{ok:true, plan:object} | {ok:false, error:string}}
 */
export function validatePlan(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'Plan 必须是 JSON 对象' };
  }

  const walls = [];
  if (Array.isArray(raw.walls)) {
    for (const w of raw.walls) {
      if (isArcBand(w)) {
        const arc = normalizeArcBand(w);
        if (!arc) continue;
        arc.kind = WALL_KINDS.has(w.kind) ? w.kind : 'n';
        if (isNum(w.height) && w.height > 0) arc.height = w.height;
        walls.push(arc);
        continue;
      }
      const tuple = Array.isArray(w);
      const rect = rect4(tuple ? w : w?.rect);
      if (!rect) continue;
      const kind = tuple ? w[4] : w.kind;
      const height = tuple ? w[5] : w.height;
      const wall = [...rect, WALL_KINDS.has(kind) ? kind : 'n'];
      if (isNum(height) && height > 0) wall.push(height);
      walls.push(wall);
    }
  }

  const wins = [];
  if (Array.isArray(raw.wins)) {
    for (const w of raw.wins) {
      const window = isArcBand(w) ? normalizeArcBand(w) : rect4(Array.isArray(w) ? w : w?.rect);
      if (window) wins.push(window);
    }
  }

  const doors = [];
  if (Array.isArray(raw.doors)) {
    for (const d of raw.doors) {
      if (!d || typeof d !== 'object') continue;
      const rect = rect4(d.rect);
      if (!rect) continue;
      const hinge = point(d.h) ?? [rect[0], rect[1]];
      const close = point(d.c) ?? [0, -1];
      const open = point(d.o) ?? [1, 0];
      const len = isFiniteNumber(d.len) && d.len > 0 ? d.len : Math.max(rect[2] - rect[0], rect[3] - rect[1]);
      const door = {
        name: typeof d.name === 'string' && d.name ? d.name : '门',
        rect,
        h: hinge,
        c: close,
        o: open,
        len,
      };
      if (d.entry === true) door.entry = true;
      doors.push(door);
    }
  }

  const slides = [];
  if (Array.isArray(raw.slides)) {
    for (const s of raw.slides) {
      if (!s || typeof s !== 'object') continue;
      const rect = rect4(s.rect);
      if (!rect) continue;
      slides.push({ rect, v: s.v === true });
    }
  }

  const rooms = [];
  const usedIds = new Set();
  if (Array.isArray(raw.rooms)) {
    for (const r of raw.rooms) {
      if (!r || typeof r !== 'object') continue;
      const points = poly(r.poly);
      if (!points) continue;
      let id = typeof r.id === 'string' && r.id.trim() ? r.id.trim() : `room${rooms.length + 1}`;
      while (usedIds.has(id)) id = `${id}_2`;
      usedIds.add(id);
      const mat = typeof r.mat === 'string' && r.mat ? r.mat : 'tile800';
      const room = {
        id,
        name: typeof r.name === 'string' && r.name ? r.name : `房间 ${rooms.length + 1}`,
        poly: points,
        mat,
        at: point(r.at) ?? centroid(points),
      };
      if (Array.isArray(r.arcs)) room.arcs = normalizeRoomArcs(r.arcs, r.poly, points);
      if (r.counted === false) room.counted = false;
      rooms.push(room);
    }
  }

  // 与 index.html 的 sanitizePlan 口径一致：方案至少要有一个房间，墙体可以后续再补。
  if (rooms.length === 0) {
    return { ok: false, error: '没有识别到房间（no rooms found）：方案至少需要一个房间' };
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
      if (Array.isArray(wall)) {
        grow(wall[0], wall[1]);
        grow(wall[2], wall[3]);
      } else {
        growArcBounds(grow, wall.from, wall.to, wall.sweep, wall.thickness);
      }
    }
    for (const window of wins) {
      if (!Array.isArray(window)) growArcBounds(grow, window.from, window.to, window.sweep, window.thickness);
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

  return {
    ok: true,
    plan: {
      version: 1,
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : '导入方案',
      bounds,
      walls,
      wins,
      doors,
      slides,
      rooms,
      materials,
    },
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
