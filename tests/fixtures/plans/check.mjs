#!/usr/bin/env node
/* ============================================================
 * 验收样本粗检
 *   用法：node tests/fixtures/plans/check.mjs <样本目录> <识别结果 JSON>
 *   结果 JSON 可以是 {plan, furniture} 或直接是 plan。
 *   只做可机器判定的冒烟项；逐条尺寸对照仍需人工在原图上核对。
 * ============================================================ */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { arcGeometry } from '../../../lib/codex/plan.mjs';

const [dirArg, resultArg] = process.argv.slice(2);
if (!dirArg || !resultArg){
  console.error('用法：node check.mjs <样本目录> <识别结果 JSON>');
  process.exit(2);
}
const dir = resolve(dirArg);
const expected = JSON.parse(await readFile(join(dir, 'expected.json'), 'utf8'));
const raw = JSON.parse(await readFile(resolve(resultArg), 'utf8'));
const plan = raw.plan || raw;
const furniture = Array.isArray(raw.furniture) ? raw.furniture : (Array.isArray(raw.plan?.furniture) ? raw.plan.furniture : []);
const tol = expected.tolerances;

const out = [];
const ok = (name, pass, detail = '') => out.push({ name, pass, detail });
const near = (a, b, t) => Math.abs(a - b) <= t;

const bounds = plan.bounds || {};
/* ---------- 弧与飘窗 ---------- */
const walls = (plan.walls || []).filter(Boolean);
const wins = (plan.wins || []).filter(Boolean);
const arcs = list => list.filter(w => !Array.isArray(w) && w.from && w.to && typeof w.sweep === 'number');
const arcWalls = arcs(walls), arcWins = arcs(wins);
if (expected.features.arcWalls){
  ok(`弧墙 ≥ ${expected.features.arcWalls.min}`, arcWalls.length >= expected.features.arcWalls.min, `实际 ${arcWalls.length}`);
}
ok(`弧窗 ≥ ${expected.features.arcWins.min}`, arcWins.length >= expected.features.arcWins.min, `实际 ${arcWins.length}`);

const rooms = plan.rooms || [];
const bayRooms = rooms.filter(r => r && r.counted === false);
ok(`不计面积的飘窗房间 ≥ ${expected.features.bayWindows.min}`,
  bayRooms.length >= expected.features.bayWindows.min, `实际 ${bayRooms.length}`);

/* ---------- 房间、楼梯、电梯 ---------- */
ok(`房间数 ≥ ${expected.features.rooms.min}`, rooms.length >= expected.features.rooms.min, `实际 ${rooms.length}`);
const parts = furniture.flatMap(f => Array.isArray(f.parts) ? f.parts : []);
const stairs = parts.filter(p => p && (p.shape === 'stairs' || p.shape === 'winder'));
ok(`楼梯部件 ≥ ${expected.features.stairs.min}`, stairs.length >= expected.features.stairs.min, `实际 ${stairs.length}`);
const elevatorPattern = /电梯(?!厅|前室|间)|elevator/i;
const elevators = Math.max(
  rooms.filter(r => elevatorPattern.test(String(r.name || ''))).length,
  furniture.filter(f => elevatorPattern.test(String(f.name || ''))).length,
);
ok(`电梯 ≥ ${expected.features.elevators.min}（按名称）`, elevators >= expected.features.elevators.min, `实际 ${elevators}`);

/* ---------- 总尺寸与几何锚点 ---------- */
// 只在靠近该条尺寸线的墙体节点上取坐标，再比较相邻节点间距；
// 不能用「任意两条坐标之差」，否则任何户型都会碰巧命中。
function nodesOnLine(axis, line, win){
  const set = new Set();
  for (const w of walls){
    let x0, y0, x1, y1;
    if (Array.isArray(w) || Array.isArray(w.rect)){ [x0, y0, x1, y1] = w.rect || w; }
    else if (w.from){ [x0, y0] = w.from; [x1, y1] = w.to; }
    else continue;
    const lo = axis === 'x' ? Math.min(y0, y1) : Math.min(x0, x1);
    const hi = axis === 'x' ? Math.max(y0, y1) : Math.max(x0, x1);
    if (hi < line - win || lo > line + win) continue;
    if (axis === 'x'){ set.add(x0); set.add(x1); } else { set.add(y0); set.add(y1); }
  }
  return [...set].sort((a, b) => a - b);
}
function consecutiveHits(vals, coords){
  return vals.filter(v => coords.some((a, i) => i < coords.length - 1 && near(coords[i + 1] - a, v, tol.chain)));
}
function onSegment(p, a, b){
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((p[0]-a[0])*dx + (p[1]-a[1])*dy) / (dx*dx + dy*dy || 1)));
  return Math.hypot(p[0]-a[0]-t*dx, p[1]-a[1]-t*dy) <= tol.chain;
}

function onArc(p, a, b, sweep, halfWidth = 0){
  const curve = arcGeometry(a, b, sweep);
  if (!curve) return false;
  const x = p[0] - curve.cx, y = p[1] - curve.cy;
  const turn = (Math.atan2(y, x) - curve.start) * Math.sign(curve.angle);
  const span = (turn + 2*Math.PI) % (2*Math.PI);
  const angleTolerance = tol.chain / curve.radius;
  return Math.abs(Math.hypot(x, y) - curve.radius) <= tol.chain + halfWidth &&
    (span <= Math.abs(curve.angle) + angleTolerance || span >= 2*Math.PI - angleTolerance);
}

function anchorFits(anchor){
  const p = anchor?.point;
  if (!Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite)) return false;
  if (anchor.kind === 'room'){
    const room = rooms.find(r => r.id === anchor.id);
    const a = room?.poly?.[anchor.edge], b = room?.poly?.[(anchor.edge + 1) % room.poly.length];
    if (!a || !b) return false;
    const curve = room.arcs?.find(item => item.edge === anchor.edge);
    return curve ? onArc(p, a, b, curve.sweep) : onSegment(p, a, b);
  }
  const wall = anchor.kind === 'wall' && walls.find(w => w.id === anchor.id);
  if (!wall) return false;
  if (!wall.rect) return onArc(p, wall.from, wall.to, wall.sweep, anchor.face === 'axis' ? 0 : wall.thickness / 2);
  const [x0, y0, x1, y1] = wall.rect;
  if (anchor.face === 'axis'){
    const x = (x0+x1)/2, y = (y0+y1)/2;
    return x1-x0 >= y1-y0 ? onSegment(p, [x0,y], [x1,y]) : onSegment(p, [x,y0], [x,y1]);
  }
  const corners = [[x0,y0],[x1,y0],[x1,y1],[x0,y1]];
  return corners.some((corner, i) => onSegment(p, corner, corners[(i+1)%4]));
}

if (plan.version === 2){
  const dimFits = (dim, coord) => anchorFits(dim.from) && anchorFits(dim.to) &&
    near(Math.abs(dim.to.point[coord] - dim.from.point[coord]), dim.drawingValue, tol.chain);
  for (const [label, axis, total, required] of [
    ['总宽', 'x', expected.bounds.width, 2],
    ['左侧总高', 'y', expected.bounds.heightLeft, 1],
    ['右侧总高', 'y', expected.bounds.heightRight, 1],
  ]){
    const totals = (plan.dims || []).filter(dim => dim.axis === axis && near(dim.drawingValue, total, tol.chain));
    const passed = totals.filter(dim => dimFits(dim, axis === 'x' ? 0 : 1)).length;
    ok(`${label} ${total} 绑定几何`, passed >= required, `通过 ${passed}/${totals.length} 条同值标注`);
  }

  const groups = new Map();
  for (const dim of plan.dims || []){
    if (!dim.chain || !Number.isFinite(dim.drawingValue) || !Array.isArray(dim.from?.point) || !Array.isArray(dim.to?.point)) continue;
    const key = `${dim.axis}:${dim.chain}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(dim);
  }
  for (const [side, values] of Object.entries(expected.chains)){
    const axis = side === 'top' || side === 'bottom' ? 'x' : 'y';
    const coord = axis === 'x' ? 0 : 1;
    const total = values.reduce((sum, value) => sum + value, 0);
    const sorted = [...groups.entries()].filter(([key]) => key.startsWith(axis + ':')).map(([,list]) =>
      list.filter(dim => !near(dim.drawingValue, total, tol.chain)).sort((a,b) =>
        Math.min(a.from.point[coord], a.to.point[coord]) - Math.min(b.from.point[coord], b.to.point[coord])));
    const chain = sorted.find(list => list.length === values.length && list.every((dim,i) => near(dim.drawingValue, values[i], tol.chain)));
    ok(`尺寸链 ${side} 来自识别结果`, !!chain, chain ? `求和 ${chain.reduce((sum, dim) => sum + dim.drawingValue, 0)}` : '未找到同顺序的原图读数');
    const mismatch = chain?.filter(dim => !dimFits(dim, coord)).map(dim => dim.drawingValue) || [];
    const count = chain ? chain.length - mismatch.length : 0;
    ok(`尺寸链 ${side} 绑定几何`, count === values.length,
      `命中 ${count}/${values.length}${mismatch.length ? '，需复核 ' + mismatch.join(' / ') : ''}`);
  }
} else {
  ok('画布宽度接近原图总宽', near(bounds.w, expected.bounds.width, tol.bounds), `实际 ${bounds.w}，可能含留白`);
  ok('画布高度接近原图总高', near(bounds.h, expected.bounds.heightLeft, tol.bounds) ||
    near(bounds.h, expected.bounds.heightRight, tol.bounds), `实际 ${bounds.h}，可能含留白`);
  ok('尺寸链来自识别结果', false, 'V1 结果没有 dims，无法从结果验证读数');
  const topHits = consecutiveHits(expected.chains.top, nodesOnLine('x', bounds.y ?? 0, 700));
  const leftHits = consecutiveHits(expected.chains.left, nodesOnLine('y', bounds.x ?? 0, 700));
  ok('顶部尺寸链在墙节点上 ≥ 6', topHits.length >= 6, `命中 ${topHits.length}/${expected.chains.top.length}`);
  ok('左侧尺寸链在墙节点上 ≥ 2', leftHits.length >= 2, `命中 ${leftHits.length}/${expected.chains.left.length}`);
}

/* ---------- 输出 ---------- */
const failed = out.filter(r => !r.pass);
for (const r of out) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
console.log(`\n${out.length - failed.length}/${out.length} 通过`);
process.exit(failed.length ? 1 : 0);
