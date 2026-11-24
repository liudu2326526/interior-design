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

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isFiniteNumber = (v) => isNum(v);

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

function normalizeOps(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value.slice(0, MAX_OPS)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    if (typeof item.op !== 'string' || !PATCH_OPS.has(item.op)) continue;
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
 * 解析失败时按契约降级为 `{reply: 原文, ops: []}`；ops 中不认识的操作会被丢掉。
 */
export function parsePatch(text) {
  const raw = typeof text === 'string' ? text : '';
  const parsed = extractJson(raw);

  if (Array.isArray(parsed)) {
    const ops = normalizeOps(parsed);
    return { reply: ops.length ? '已更新方案。' : raw.trim(), ops };
  }

  if (parsed && typeof parsed === 'object') {
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
      const rect = rect4(w);
      if (!rect) continue;
      const kind = WALL_KINDS.has(w[4]) ? w[4] : 'n';
      walls.push([rect[0], rect[1], rect[2], rect[3], kind]);
    }
  }

  const wins = [];
  if (Array.isArray(raw.wins)) {
    for (const w of raw.wins) {
      const rect = rect4(w);
      if (rect) wins.push(rect);
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
    for (const [x0, y0, x1, y1] of walls) {
      grow(x0, y0);
      grow(x1, y1);
    }
    for (const room of rooms) for (const [x, y] of room.poly) grow(x, y);
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

/** 生成一句中文摘要，codex 没给说明时兜底。 */
export function summarizePlan(plan) {
  const rooms = plan?.rooms?.length ?? 0;
  const walls = plan?.walls?.length ?? 0;
  const wins = plan?.wins?.length ?? 0;
  const doors = plan?.doors?.length ?? 0;
  const area = (plan?.rooms ?? [])
    .filter((r) => r.counted !== false)
    .reduce((sum, r) => sum + Math.abs(polyArea(r.poly)), 0);
  const areaText = area > 0 ? `，约 ${(area / 1_000_000).toFixed(1)} ㎡` : '';
  return `识别到 ${rooms} 个房间、${walls} 面墙、${wins} 扇窗、${doors} 扇门${areaText}。`;
}

function polyArea(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}
