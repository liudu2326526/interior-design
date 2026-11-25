/**
 * Plan V2 契约自测（零依赖）：V1→V2 迁移、稳定 id、门窗字段保留、dims 校验、非法输入、幂等与 V1 视图。
 * 运行：node tests/plan-v2.mjs
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validatePlan, toV1Plan, isPlanV2 } from '../lib/codex/plan.mjs';

const livingPoly = [[200, 200], [4200, 200], [4200, 3600], [200, 3600]];

function v1Plan(overrides = {}) {
  return {
    version: 1,
    name: '测试户型',
    bounds: { x: 0, y: 0, w: 12000, h: 8000 },
    walls: [
      [0, 0, 8000, 200, 'e'],
      [0, 0, 200, 4000, 'n', 3000],
      { from: [8000, 2000], to: [8000, 4000], sweep: 90, thickness: 200, kind: 'e' },
    ],
    wins: [
      [1000, 0, 2200, 200],
      { from: [3000, 0], to: [4000, 1000], sweep: -90, thickness: 120 },
    ],
    doors: [
      { name: '入户门', rect: [4000, 0, 4900, 200], h: [4000, 0], c: [0, 1], o: [1, 0], len: 900, entry: true },
      { rect: [200, 2000, 400, 2900] },
    ],
    slides: [{ rect: [6000, 0, 7200, 200], v: true }],
    rooms: [{ id: 'living', name: '客厅', poly: livingPoly, mat: 'wood', at: [1000, 1000], counted: false }],
    materials: { wood: { name: '木地板', price: 300, sw: '#d8b88a' } },
    ...overrides,
  };
}

const migrated = () => validatePlan(v1Plan()).plan;

test('V1 元组迁移为 V2 对象：墙体、窗、门、推拉门、房间', () => {
  const result = validatePlan(v1Plan());
  assert.equal(result.ok, true);
  const plan = result.plan;
  assert.equal(plan.version, 2);
  assert.deepEqual(plan.walls[0].rect, [0, 0, 8000, 200]);
  assert.equal(plan.walls[0].kind, 'e');
  assert.equal(plan.walls[0].source, 'ai');
  assert.equal(typeof plan.walls[0].id, 'string');

  assert.equal(plan.walls[1].height, 3000);
  assert.equal(plan.walls[1].rect[2], 200);

  assert.deepEqual(plan.walls[2].from, [8000, 2000]);
  assert.deepEqual(plan.walls[2].to, [8000, 4000]);
  assert.equal(plan.walls[2].sweep, 90);
  assert.equal(plan.walls[2].thickness, 200);
  assert.equal(plan.walls[2].kind, 'e');

  assert.deepEqual(plan.wins[0].rect, [1000, 0, 2200, 200]);
  assert.equal(plan.wins[0].source, 'ai');
  assert.equal('sill' in plan.wins[0], false, '迁移期窗台高置空');
  assert.equal('h' in plan.wins[0], false, '迁移期窗高置空');
  assert.equal('style' in plan.wins[0], false, '迁移期样式置空');
  assert.equal(plan.wins[1].thickness, 120);
  assert.equal(plan.wins[1].sweep, -90);

  const [entry, inner] = plan.doors;
  assert.equal(entry.name, '入户门');
  assert.deepEqual(entry.rect, [4000, 0, 4900, 200]);
  assert.deepEqual(entry.h, [4000, 0]);
  assert.deepEqual(entry.c, [0, 1]);
  assert.deepEqual(entry.o, [1, 0]);
  assert.equal(entry.len, 900);
  assert.equal(entry.entry, true);
  assert.equal(typeof entry.id, 'string');
  assert.equal(entry.source, 'ai');

  assert.deepEqual(inner.h, [200, 2000], '缺省铰链沿用旧口径');
  assert.equal(inner.len, 900);
  assert.equal(inner.entry, undefined);

  assert.deepEqual(plan.slides[0].rect, [6000, 0, 7200, 200]);
  assert.equal(plan.slides[0].v, true);
  assert.equal(typeof plan.slides[0].id, 'string');

  assert.equal(plan.rooms[0].id, 'living');
  assert.equal(plan.rooms[0].name, '客厅');
  assert.equal(plan.rooms[0].counted, false);
  assert.deepEqual(plan.rooms[0].at, [1000, 1000]);
  assert.deepEqual(plan.dims, []);
});

test('迁移期 id 稳定：同一输入两次得到同一 id，几何不同则 id 不同', () => {
  const a = migrated();
  const b = migrated();
  assert.deepEqual(a, b);

  const ids = [...a.walls, ...a.wins, ...a.doors, ...a.slides].map(item => item.id);
  assert.equal(new Set(ids).size, ids.length, 'id 唯一');
  for (const id of ids) assert.match(id, /^[a-z]+[0-9]+-[0-9a-f]{6}$/);

  const shifted = validatePlan(v1Plan({ walls: [[0, 0, 8001, 200, 'e']] })).plan;
  const baseline = validatePlan(v1Plan({ walls: [[0, 0, 8000, 200, 'e']] })).plan;
  assert.notEqual(shifted.walls[0].id, baseline.walls[0].id, 'id 含坐标哈希');
});

test('幂等：V2 再校验一次结果不变，已有 id 与 source 保留', () => {
  const once = migrated();
  const twice = validatePlan(once);
  assert.equal(twice.ok, true);
  assert.deepEqual(twice.plan, once);

  const custom = validatePlan({
    ...v1Plan(),
    walls: [{ id: 'wall-a', rect: [0, 0, 8000, 200], kind: 'b', source: 'user' }],
  }).plan;
  assert.equal(custom.walls[0].id, 'wall-a');
  assert.equal(custom.walls[0].source, 'user');
});

test('source 枚举：非法值归一为 ai，合法值保留', () => {
  const plan = validatePlan({
    ...v1Plan(),
    walls: [{ id: 'w1', rect: [0, 0, 8000, 200], kind: 'e', source: 'robot' }],
    wins: [{ id: 'win1', rect: [1000, 0, 2200, 200], source: 'drawing', sill: 500, h: 1500, style: 'bay' }],
    rooms: [{ id: 'living', poly: livingPoly, mat: 'wood', source: 'user' }],
  }).plan;
  assert.equal(plan.walls[0].source, 'ai');
  assert.equal(plan.wins[0].source, 'drawing');
  assert.equal(plan.wins[0].sill, 500);
  assert.equal(plan.wins[0].h, 1500);
  assert.equal(plan.wins[0].style, 'bay');
  assert.equal(plan.rooms[0].source, 'user');
});

test('sweep 范围与厚度：不合法弧段被丢弃，其余照常', () => {
  const plan = validatePlan(v1Plan({
    walls: [
      [0, 0, 8000, 200, 'e'],
      { from: [0, 0], to: [1000, 0], sweep: 0, thickness: 100 },
      { from: [0, 0], to: [1000, 0], sweep: 181, thickness: 100 },
      { from: [0, 0], to: [100, 0], sweep: 90, thickness: 500 },
    ],
  })).plan;
  assert.equal(plan.walls.length, 1, 'sweep 0/181 与厚度 ≥ 直径的弧墙都被丢弃');

  const arcWins = validatePlan(v1Plan({
    wins: [
      [1000, 0, 2200, 200],
      { from: [0, 0], to: [1000, 0], sweep: 360, thickness: 100 },
    ],
  })).plan;
  assert.equal(arcWins.wins.length, 1);
});

test('sill/h 合理性：越界字段被忽略并给出提示', () => {
  const result = validatePlan({
    ...v1Plan(),
    wins: [
      { id: 'w-bad', rect: [1000, 0, 2200, 200], sill: -50 },
      { id: 'w-tall', rect: [3000, 0, 4000, 200], h: 99999 },
      { id: 'w-ok', rect: [5000, 0, 6000, 200], sill: 0, h: 2200 },
    ],
  });
  assert.equal(result.ok, true);
  const [bad, tall, ok] = result.plan.wins;
  assert.equal('sill' in bad, false);
  assert.equal('h' in tall, false);
  assert.equal(ok.sill, 0);
  assert.equal(ok.h, 2200);
  assert.ok(result.warnings.some(line => line.includes('w-bad') && line.includes('窗台高')));
  assert.ok(result.warnings.some(line => line.includes('w-tall') && line.includes('窗高')));
});

test('dims：合法锚点保留，字段默认值正确', () => {
  const base = migrated();
  const wallId = base.walls[0].id;
  const result = validatePlan({
    ...v1Plan(),
    dims: [{
      id: 'd1',
      source: 'drawing',
      from: { kind: 'wall', id: wallId, face: 'axis', point: [0, 100] },
      to: { kind: 'wall', id: wallId, face: 'right', point: [8000, 100] },
      offset: 400,
      drawingValue: 8000,
      axis: 'x',
      chain: 'total',
      locked: 'from',
      note: '外墙外沿',
    }, {
      id: 'd2',
      from: { kind: 'wall', id: wallId, face: 'left', point: [0, 100] },
      to: { kind: 'wall', id: wallId, face: 'axis', point: [0, 3900] },
    }, {
      id: 'd3',
      from: { kind: 'room', id: 'living', edge: 0, face: 'inner', point: [2200, 200] },
      to: { kind: 'room', id: 'living', edge: 2, face: 'inner', point: [2200, 3600] },
      axis: 'y',
      locked: 'to',
    }],
  });
  assert.equal(result.ok, true);
  const [d1, d2, d3] = result.plan.dims;
  assert.equal(d1.id, 'd1');
  assert.equal(d1.source, 'drawing');
  assert.deepEqual(d1.from, { kind: 'wall', id: wallId, face: 'axis', point: [0, 100] });
  assert.equal(d1.offset, 400);
  assert.equal(d1.drawingValue, 8000);
  assert.equal(d1.axis, 'x');
  assert.equal(d1.chain, 'total');
  assert.equal(d1.locked, 'from');
  assert.equal(d1.note, '外墙外沿');

  assert.equal(d2.axis, 'y', '缺 axis 时按两点推断');
  assert.equal(d2.offset, 0);
  assert.equal(d2.locked, 'none');
  assert.equal(d2.source, 'ai');
  assert.equal('chain' in d2, false);

  assert.equal(d3.from.kind, 'room');
  assert.equal(d3.from.edge, 0);
  assert.equal(d3.from.face, 'inner');
});

test('dims：锚点引用不存在的墙/房间时丢弃该尺寸并提示（不拒绝整个 Plan）', () => {
  const result = validatePlan({
    ...v1Plan(),
    dims: [
      { id: 'd-missing-wall', from: { kind: 'wall', id: 'nope', face: 'axis', point: [0, 0] }, to: { kind: 'room', id: 'living', edge: 0, point: [1, 1] } },
      { id: 'd-missing-room', from: { kind: 'room', id: 'nowhere', edge: 0, point: [1, 1] }, to: { kind: 'room', id: 'living', edge: 0, point: [2, 2] } },
      { id: 'd-bad-edge', from: { kind: 'room', id: 'living', edge: 9, point: [1, 1] }, to: { kind: 'room', id: 'living', edge: 0, point: [2, 2] } },
      { id: 'd-bad-kind', from: { kind: 'furniture', id: 'living' }, to: { kind: 'room', id: 'living', edge: 0, point: [2, 2] } },
    ],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.plan.dims, []);
  assert.ok(result.warnings.some(line => line.includes('nope')));
  assert.ok(result.warnings.some(line => line.includes('nowhere')));
  assert.ok(result.warnings.some(line => line.includes('房间边')));
  assert.ok(result.warnings.some(line => line.includes('锚点')));
});

test('dims：重复 id 去重，缺 id 时按顺序+锚点生成稳定 id', () => {
  const plan = validatePlan({
    ...v1Plan(),
    dims: [
      { id: 'dup', from: { kind: 'room', id: 'living', edge: 0, point: [1, 1] }, to: { kind: 'room', id: 'living', edge: 1, point: [2, 2] } },
      { id: 'dup', from: { kind: 'room', id: 'living', edge: 2, point: [3, 3] }, to: { kind: 'room', id: 'living', edge: 3, point: [4, 4] } },
      { from: { kind: 'room', id: 'living', edge: 0, point: [5, 5] }, to: { kind: 'room', id: 'living', edge: 2, point: [6, 6] } },
    ],
  }).plan;
  assert.deepEqual(plan.dims.map(dim => dim.id), ['dup', 'dup_2', plan.dims[2].id]);
  assert.match(plan.dims[2].id, /^dim3-[0-9a-f]{6}$/);

  const again = validatePlan({ ...v1Plan(), dims: [
    { from: { kind: 'room', id: 'living', edge: 0, point: [5, 5] }, to: { kind: 'room', id: 'living', edge: 2, point: [6, 6] } },
  ] }).plan;
  assert.equal(again.dims[0].id, 'dim1-' + plan.dims[2].id.split('-')[1], '同一锚点同一顺序得到同一 id');
});

test('dims：缺 point 时按锚点推导量测点', () => {
  const base = migrated();
  const plan = validatePlan({
    ...v1Plan(),
    dims: [
      { from: { kind: 'wall', id: base.walls[0].id, face: 'axis' }, to: { kind: 'wall', id: base.walls[0].id, face: 'right' } },
      { from: { kind: 'room', id: 'living', edge: 0 }, to: { kind: 'room', id: 'living', edge: 2 } },
    ],
  }).plan;
  assert.deepEqual(plan.dims[0].from.point, [4000, 100], '直墙轴线锚点取墙段中心');
  assert.deepEqual(plan.dims[0].to.point, [8000, 100], 'right 面取右端');
  assert.deepEqual(plan.dims[1].from.point, [2200, 200], '房间边锚点取边中点');
  assert.deepEqual(plan.dims[1].to.point, [2200, 3600]);
});

test('dims：房间锚点精确落在唯一相邻边时修正边号，保留图纸读数', () => {
  const plan = validatePlan(v1Plan({
    dims: [{
      id: 'width', axis: 'x', drawingValue: 4000,
      from: { kind: 'room', id: 'living', edge: 0, point: [200, 1700] },
      to: { kind: 'room', id: 'living', edge: 1, point: [4200, 1700] },
    }],
  }));
  assert.equal(plan.plan.dims[0].from.edge, 3);
  assert.deepEqual(plan.plan.dims[0].from.point, [200, 1700]);
  assert.equal(plan.plan.dims[0].drawingValue, 4000);
});

test('弧段端点衔接只提示不拒绝', () => {
  const dangling = validatePlan(v1Plan()).warnings;
  assert.ok(dangling.some(line => line.includes('衔接')), JSON.stringify(dangling));

  const connected = validatePlan(v1Plan({
    walls: [
      [8000, 0, 8200, 2000, 'e'],
      [8000, 4000, 8200, 6000, 'e'],
      { from: [8000, 2000], to: [8000, 4000], sweep: 90, thickness: 200, kind: 'e' },
    ],
  }));
  assert.equal(connected.ok, true, '衔接问题不阻止校验通过');
  assert.ok(!connected.warnings.some(line => line.includes('衔接')), JSON.stringify(connected.warnings));
});

test('非法输入：非对象、无房间直接失败', () => {
  for (const bad of [null, undefined, 42, 'plan', [], true]) {
    const result = validatePlan(bad);
    assert.equal(result.ok, false);
    assert.equal(typeof result.error, 'string');
  }
  assert.match(validatePlan(null).error, /JSON 对象/);
  const noRooms = validatePlan(v1Plan({ rooms: [] }));
  assert.equal(noRooms.ok, false);
  assert.match(noRooms.error, /房间/);
});

test('规模与边界：空数组字段、超长 id、未知字段不影响迁移', () => {
  const plan = validatePlan({
    version: 1,
    name: '  边界  ',
    walls: [],
    wins: [],
    doors: [],
    slides: [],
    rooms: [{ id: 'living', poly: livingPoly, mat: 'unknown-mat' }],
    materials: {},
    dims: 'not-an-array',
    extra: { anything: true },
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.plan.name, '边界');
  assert.deepEqual(plan.plan.walls, []);
  assert.deepEqual(plan.plan.dims, []);
  assert.ok(plan.plan.materials['unknown-mat'], '房间未知材质补默认项');
  assert.ok(plan.plan.materials.wood, '默认材料合并');
  assert.ok(plan.plan.bounds.w > 0);
  assert.equal('extra' in plan.plan, false);
});

test('房间：非法轮廓丢弃、重复 id 去重、ceiling 校验', () => {
  const plan = validatePlan(v1Plan({
    rooms: [
      { id: 'living', name: '客厅', poly: livingPoly, mat: 'wood', ceiling: { h: 2600, drops: [{ rect: [0, 0, 1000, 1000], depth: 120 }, { rect: [0, 0, 1, 1], depth: -5 }], cove: 'perimeter', box: true } },
      { id: 'living', name: '客厅副本', poly: livingPoly, mat: 'wood' },
      { id: 'broken', poly: [[1, 1], [2, 2]] },
    ],
  })).plan;
  assert.equal(plan.rooms.length, 2);
  assert.equal(plan.rooms[1].id, 'living_2');
  assert.deepEqual(plan.rooms[0].ceiling.h, 2600);
  assert.equal(plan.rooms[0].ceiling.drops.length, 1);
  assert.equal(plan.rooms[0].ceiling.cove, 'perimeter');
  assert.equal(plan.rooms[0].ceiling.box, true);

  const badCeiling = validatePlan(v1Plan({
    rooms: [{ id: 'living', poly: livingPoly, mat: 'wood', ceiling: { h: -1, cove: 'weird' } }],
  })).plan;
  assert.equal('ceiling' in badCeiling.rooms[0], false);
});

test('V1 视图：toV1Plan 还原元组、保留门窗字段并去掉 dims', () => {
  const v2 = migrated();
  const v1 = toV1Plan(v2);
  assert.equal(v1.version, 1);
  assert.equal(isPlanV2(v2), true);
  assert.equal(isPlanV2(v1), false);
  assert.deepEqual(v1.walls[0], [0, 0, 8000, 200, 'e']);
  assert.deepEqual(v1.walls[1], [0, 0, 200, 4000, 'n', 3000]);
  assert.deepEqual(v1.walls[2], { from: [8000, 2000], to: [8000, 4000], sweep: 90, thickness: 200, kind: 'e' });
  assert.deepEqual(v1.wins[0], [1000, 0, 2200, 200]);
  assert.equal(v1.wins[1].thickness, 120);
  assert.equal(v1.doors[0].id, undefined);
  assert.equal(v1.doors[0].entry, true);
  assert.deepEqual(v1.doors[0].h, [4000, 0]);
  assert.equal(v1.doors[0].len, 900);
  assert.equal(v1.slides[0].id, undefined);
  assert.equal(v1.slides[0].v, true);
  assert.equal(v1.rooms[0].id, 'living');
  assert.equal(v1.rooms[0].source, undefined);
  assert.equal('ceiling' in v1.rooms[0], false);
  assert.equal('dims' in v1, false);

  // 元组视图可以再次迁移回 V2，且 id 与几何一致（迁移可重复）
  const again = validatePlan(v1);
  assert.equal(again.ok, true);
  assert.deepEqual(again.plan.walls.map(wall => wall.rect ?? { from: wall.from, to: wall.to }),
    v2.walls.map(wall => wall.rect ?? { from: wall.from, to: wall.to }));
  assert.equal(again.plan.walls[0].id, v2.walls[0].id);
  assert.deepEqual(again.plan.doors.map(door => door.h), v2.doors.map(door => door.h));
});

test('toV1Plan 不改动传入的 V2 方案', () => {
  const v2 = migrated();
  const snapshot = JSON.parse(JSON.stringify(v2));
  toV1Plan(v2);
  assert.deepEqual(v2, snapshot);
});

test('JSON 往返：方案经 HTTP 序列化后再校验不变', () => {
  const v2 = migrated();
  const roundTrip = validatePlan(JSON.parse(JSON.stringify(v2)));
  assert.equal(roundTrip.ok, true);
  assert.deepEqual(roundTrip.plan, v2);
});

test('validatePlan 不改动传入的原始 Plan', () => {
  const raw = v1Plan();
  const snapshot = JSON.parse(JSON.stringify(raw));
  validatePlan(raw);
  assert.deepEqual(raw, snapshot);
});

test('规模上限：dims 超过 2000 条截断，墙段过多时跳过衔接提示', () => {
  const anchor = { kind: 'room', id: 'living', edge: 0, point: [0, 0] };
  const dims = Array.from({ length: 2005 }, (_, index) => ({
    id: `d${index}`, from: anchor, to: { ...anchor, edge: 1 },
  }));
  const plan = validatePlan({ ...v1Plan(), dims }).plan;
  assert.equal(plan.dims.length, 2000);

  const walls = Array.from({ length: 4001 }, (_, index) => [index, 0, index + 1, 100, 'e']);
  walls.push({ from: [0, 5000], to: [1000, 5000], sweep: 90, thickness: 100 });
  const huge = validatePlan({ ...v1Plan(), walls });
  assert.equal(huge.ok, true);
  assert.equal(huge.plan.walls.length, 4002);
  assert.ok(!huge.warnings.some(line => line.includes('弧墙')), '墙段过多时不再逐段提示');
  assert.ok(huge.warnings.some(line => line.includes('跳过')), '跳过一次并说明');
});
