#!/usr/bin/env node
/* ============================================================
 * 验收样本粗检
 *   用法：node tests/fixtures/plans/check.mjs <样本目录> <识别结果 JSON>
 *   结果 JSON 可以是 {plan, furniture} 或直接是 plan。
 *   只做可机器判定的冒烟项；逐条尺寸对照仍需人工在原图上核对。
 * ============================================================ */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

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

/* ---------- 1. 总体尺寸 ---------- */
const bounds = plan.bounds || {};
ok('总宽 37200', near(bounds.w, expected.bounds.width, tol.bounds), `实际 ${bounds.w}`);
const h = bounds.h;
const hOk = near(h, expected.bounds.heightLeft, tol.bounds) || near(h, expected.bounds.heightRight, tol.bounds);
ok('总高 16950/15800', hOk, `实际 ${h}`);

/* ---------- 2. 尺寸链自洽 ---------- */
for (const [name, chain] of Object.entries(expected.chains)){
  const sum = chain.reduce((a, b) => a + b, 0);
  const total = name === 'left' ? expected.bounds.heightLeft
    : name === 'right' ? expected.bounds.heightRight : expected.bounds.width;
  ok(`尺寸链 ${name} 求和 = ${total}`, near(sum, total, tol.chain), `求和 ${sum}`);
}

/* ---------- 3. 弧与飘窗 ---------- */
const walls = (plan.walls || []).filter(Boolean);
const wins = (plan.wins || []).filter(Boolean);
const arcs = list => list.filter(w => !Array.isArray(w) && w.from && w.to && typeof w.sweep === 'number');
const arcWalls = arcs(walls), arcWins = arcs(wins);
ok(`弧墙 ≥ ${expected.features.arcWalls.min}`, arcWalls.length >= expected.features.arcWalls.min, `实际 ${arcWalls.length}`);
ok(`弧窗 ≥ ${expected.features.arcWins.min}`, arcWins.length >= expected.features.arcWins.min, `实际 ${arcWins.length}`);

const rooms = plan.rooms || [];
const bayRooms = rooms.filter(r => r && r.counted === false);
ok(`不计面积的飘窗房间 ≥ ${expected.features.bayWindows.min}`,
  bayRooms.length >= expected.features.bayWindows.min, `实际 ${bayRooms.length}`);

/* ---------- 4. 房间、楼梯、电梯 ---------- */
ok(`房间数 ≥ ${expected.features.rooms.min}`, rooms.length >= expected.features.rooms.min, `实际 ${rooms.length}`);
const parts = furniture.flatMap(f => Array.isArray(f.parts) ? f.parts : []);
const stairs = parts.filter(p => p && (p.shape === 'stairs' || p.shape === 'winder'));
ok(`楼梯部件 ≥ ${expected.features.stairs.min}`, stairs.length >= expected.features.stairs.min, `实际 ${stairs.length}`);
const hasElevator = rooms.some(r => /电梯/.test(String(r.name || ''))) ||
  furniture.some(f => /电梯/.test(String(f.name || '')));
ok('电梯 ≥ 2（按名称）', hasElevator, '未找到名称含「电梯」的房间或构件');

/* ---------- 5. 尺寸链数值能在边界几何里找到 ---------- */
// 只在靠近该条尺寸线的墙体节点上取坐标，再比较相邻节点间距；
// 不能用「任意两条坐标之差」，否则任何户型都会碰巧命中。
function nodesOnLine(axis, line, win){
  const set = new Set();
  for (const w of walls){
    let x0, y0, x1, y1;
    if (Array.isArray(w)){ [x0, y0, x1, y1] = w; }
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
const topNodes = nodesOnLine('x', bounds.y ?? 0, 700);
const leftNodes = nodesOnLine('y', bounds.x ?? 0, 700);
const topHits = consecutiveHits(expected.chains.top, topNodes);
const leftHits = consecutiveHits(expected.chains.left, leftNodes);
ok('顶部尺寸链落在顶边墙节点上 ≥ 6', topHits.length >= 6, `命中 ${topHits.length}/${expected.chains.top.length}: ${topHits.join(',')}`);
ok('左侧尺寸链落在左边墙节点上 ≥ 2', leftHits.length >= 2, `命中 ${leftHits.length}/${expected.chains.left.length}: ${leftHits.join(',')}`);

/* ---------- 输出 ---------- */
const failed = out.filter(r => !r.pass);
for (const r of out) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
console.log(`\n${out.length - failed.length}/${out.length} 通过`);
process.exit(failed.length ? 1 : 0);
