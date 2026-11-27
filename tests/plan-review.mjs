import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validatePlan } from '../lib/codex/plan.mjs';
import {
  buildReviewMessage,
  checkPlan,
  parseReviewReply,
  reviewDelta,
} from '../lib/plan-review.mjs';

const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];

function basePlan(overrides = {}) {
  return {
    version: 1,
    name: '测试方案',
    bounds: { x: 0, y: 0, w: 10000, h: 10000 },
    walls: [[0, 0, 10000, 200, 'e'], [0, 0, 200, 10000, 'e']],
    wins: [],
    doors: [],
    slides: [],
    rooms: [
      { id: 'living', name: '客厅', poly: rect(200, 200, 4600, 4600), mat: 'tile800' },
      { id: 'bed', name: '主卧', poly: rect(5000, 200, 4600, 4600), mat: 'wood' },
    ],
    materials: {},
    ...overrides,
  };
}

test('checkPlan reports doors and windows that sit away from every wall', () => {
  const plan = basePlan({
    doors: [
      { name: '入户门', rect: [5000, 5000, 5800, 5200], h: [5000, 5000], c: [1, 0], o: [0, -1], len: 800 },
      { name: '卧室门', rect: [1000, 0, 1800, 200], h: [1000, 0], c: [1, 0], o: [0, 1], len: 800 },
    ],
    wins: [
      [7000, 7000, 8000, 7200],
      [3000, 0, 4000, 200],
    ],
  });
  const issues = checkPlan(plan, []);
  assert.ok(issues.some(issue => issue.where.includes('入户门')), JSON.stringify(issues));
  assert.ok(!issues.some(issue => issue.where.includes('卧室门')));
  assert.ok(issues.some(issue => issue.where.includes('窗 1')), JSON.stringify(issues));
  assert.ok(!issues.some(issue => issue.where.includes('窗 2')));
  for (const issue of issues) {
    assert.equal(typeof issue.where, 'string');
    assert.equal(typeof issue.detail, 'string');
    assert.ok(issue.where.length <= 40);
    assert.ok(issue.detail.length <= 120);
  }
});

test('checkPlan flags only clearly overlapping counted rooms', () => {
  const overlapping = basePlan({
    rooms: [
      { id: 'a', name: '客厅', poly: rect(0, 0, 4000, 4000), mat: 'tile800' },
      { id: 'b', name: '餐厅', poly: rect(2000, 0, 4000, 4000), mat: 'tile800' },
    ],
  });
  const issues = checkPlan(overlapping, []);
  assert.ok(issues.some(issue => issue.where.includes('客厅') && issue.where.includes('餐厅')), JSON.stringify(issues));

  const barely = basePlan({
    rooms: [
      { id: 'a', name: '客厅', poly: rect(0, 0, 4000, 4000), mat: 'tile800' },
      { id: 'b', name: '储物', poly: rect(3990, 0, 1000, 4000), mat: 'tile800' },
    ],
  });
  assert.ok(!checkPlan(barely, []).some(issue => issue.where.includes('客厅') && issue.where.includes('储物')));

  const uncounted = basePlan({
    rooms: [
      { id: 'a', name: '客厅', poly: rect(0, 0, 4000, 4000), mat: 'tile800' },
      { id: 'b', name: '餐厅', poly: rect(2000, 0, 4000, 4000), mat: 'tile800', counted: false },
    ],
  });
  assert.ok(!checkPlan(uncounted, []).some(issue => issue.where.includes('客厅') && issue.where.includes('餐厅')));
});

test('checkPlan flags an implausible counted-area ratio and furniture outside the bounds', () => {
  const small = basePlan({
    rooms: [{ id: 'a', name: '客厅', poly: rect(0, 0, 2000, 2000), mat: 'tile800' }],
  });
  assert.ok(checkPlan(small, []).some(issue => issue.where.includes('面积')));

  const large = basePlan({
    rooms: [{ id: 'a', name: '客厅', poly: rect(0, 0, 4000, 29000), mat: 'tile800' }],
  });
  assert.ok(checkPlan(large, []).some(issue => issue.where.includes('面积')));

  const normal = basePlan();
  assert.ok(!checkPlan(normal, []).some(issue => issue.where.includes('面积')));

  const outside = checkPlan(normal, [
    { type: 'bed', name: '床', cx: 20000, cy: 3000, w: 1500, d: 2000, rot: 0 },
    { type: 'chair', name: '椅子', cx: 3000, cy: 3000, w: 450, d: 450, rot: 0 },
  ]);
  assert.ok(outside.some(issue => issue.where.includes('床')), JSON.stringify(outside));
  assert.ok(!outside.some(issue => issue.where.includes('椅子')));
});

test('checkPlan survives malformed plans and checks doors against arc walls', () => {
  assert.deepEqual(checkPlan(null, null), []);
  assert.deepEqual(checkPlan({}, []), []);
  // 弧墙上的门（圆心 (0,4000)、半径 4000，门洞中心在 -45° 的弧线上）
  const onArc = basePlan({
    walls: [{ from: [0, 0], to: [4000, 4000], sweep: 90, thickness: 240 }],
    doors: [{ name: '弧墙门', rect: [2728, 1072, 2928, 1272], h: [2728, 1172], c: [1, 0], o: [0, 1], len: 200 }],
  });
  assert.ok(!checkPlan(onArc, []).some(issue => issue.where.includes('弧墙门')), JSON.stringify(checkPlan(onArc, [])));

  // 端点附近的门也算贴墙
  const atEnd = basePlan({
    walls: [{ from: [0, 0], to: [4000, 4000], sweep: 90, thickness: 240 }],
    doors: [{ name: '端点门', rect: [-100, -20, 100, 80], h: [0, 0], c: [1, 0], o: [0, 1], len: 200 }],
  });
  assert.ok(!checkPlan(atEnd, []).some(issue => issue.where.includes('端点门')), JSON.stringify(checkPlan(atEnd, [])));

  // 明显离开弧线 780mm 的门仍应报出
  const offArc = basePlan({
    walls: [{ from: [0, 0], to: [4000, 4000], sweep: 90, thickness: 240 }],
    doors: [{ name: '偏门', rect: [1000, 1000, 1800, 1200], h: [1000, 1100], c: [1, 0], o: [0, 1], len: 800 }],
  });
  assert.ok(checkPlan(offArc, []).some(issue => issue.where.includes('偏门')), JSON.stringify(checkPlan(offArc, [])));
});

test('keeps room boundary glazing and distinguishes raised bays from open terraces', () => {
  const raw = basePlan({
    wins:[[9600,1000,9680,3000]],
    rooms:[
      ...basePlan().rooms,
      { id:'bay',name:'飘窗',poly:rect(9600,1000,1000,2000),bay:{roomId:'bed',openingEdges:[3,3,20],sillHeight:620} },
      { id:'out',name:'露台',poly:rect(9600,3500,1000,2500),outdoor:true,counted:false,bay:{sillHeight:700} },
    ],
  });
  const result = validatePlan(raw);
  assert.ok(result.ok);
  assert.deepEqual(result.plan.rooms[2].bay,{roomId:'bed',openingEdges:[3],sillHeight:620});
  assert.equal(result.plan.rooms[2].counted,false);
  assert.equal(result.plan.rooms[3].outdoor,true);
  assert.equal(result.plan.rooms[3].bay,undefined);
  assert.ok(!checkPlan(result.plan,[]).some(issue => issue.where === '窗 1'));
});
test('checkPlan caps the pairwise room overlap scan for implausible room counts', () => {
  const rooms = Array.from({ length: 300 }, (_, index) => ({
    id: `room${index}`, name: `房间 ${index + 1}`, poly: rect(0, 0, 4000, 4000), mat: 'tile800',
  }));
  const started = Date.now();
  const issues = checkPlan(basePlan({ rooms }), []);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `300 个房间应在 2s 内完成，实际 ${elapsed}ms`);
  assert.ok(issues.some(issue => issue.where.includes('重叠检查')), JSON.stringify(issues));
  assert.ok(issues.length <= 12);
});

test('buildReviewMessage contains every required section and the output contract', () => {
  const message = buildReviewMessage({
    plan: { name: '示例', rooms: [{ id: 'living', name: '客厅' }] },
    furniture: [{ type: 'bed', name: '床', cx: 1, cy: 2, w: 3, d: 4, rot: 0 }],
    explanation: '这是识别说明',
    note: '这是用户备注',
    check: [{ where: '门', detail: '位置不对' }],
    fileNames: ['a.png', 'b.pdf'],
  });
  assert.match(message, /识别说明（仅供参考，不作为修改依据）/);
  assert.match(message, /"name": "示例"/);
  assert.match(message, /"type": "bed"/);
  assert.match(message, /这是识别说明/);
  assert.match(message, /这是用户备注/);
  assert.match(message, /门：位置不对/);
  assert.match(message, /a\.png/);
  assert.match(message, /b\.pdf/);
  assert.match(message, /"verdict"/);
  assert.match(message, /"fixed"/);
  assert.ok(message.length > 200);
});

test('parseReviewReply keeps a valid fixed plan and normalises issues', () => {
  const plan = basePlan();
  const next = basePlan({ name: '修正方案' });
  const reply = parseReviewReply(JSON.stringify({
    verdict: 'differ',
    summary: '入户门位置有偏差。',
    issues: [{ where: '门', detail: '入户门向东偏了 200mm' }, '窗洞数量不符'],
    fixed: { plan: next, furniture: [{ type: 'bed', name: '床', cx: 2000, cy: 2000, w: 1500, d: 2000, rot: 0 }] },
  }), { plan, furniture: [] });

  assert.equal(reply.verdict, 'differ');
  assert.equal(reply.summary, '入户门位置有偏差。');
  assert.equal(reply.issues.length, 2);
  assert.deepEqual(reply.issues[0], { where: '门', detail: '入户门向东偏了 200mm' });
  assert.equal(reply.issues[1].where, '');
  assert.equal(reply.issues[1].detail, '窗洞数量不符');
  assert.equal(reply.fixed.plan.name, '修正方案');
  assert.equal(reply.fixed.furniture.length, 1);
  assert.equal(reply.fixed.furniture[0].type, 'bed');
});

test('parseReviewReply drops fixed on match, drops invalid fixed, truncates summary and caps issues', () => {
  const plan = basePlan();
  const matched = parseReviewReply(JSON.stringify({
    verdict: 'match', summary: '一致', issues: [{ where: '门', detail: '不应保留' }], fixed: { plan: basePlan() },
  }), { plan, furniture: [] });
  assert.equal(matched.verdict, 'match');
  assert.deepEqual(matched.issues, [], 'match 时不应带 issues');
  assert.equal(matched.fixed, null);

  const invalid = parseReviewReply(JSON.stringify({
    verdict: 'differ', summary: 'x', issues: [{ where: '门', detail: '偏了' }],
    fixed: { plan: { name: '没有房间' } },
  }), { plan, furniture: [] });
  assert.equal(invalid.fixed, null);
  assert.equal(invalid.verdict, 'differ');
  assert.equal(invalid.issues.length, 1);

  // differ 但既没有 issues 也没有可用 fixed：无法展示任何差异，按不可用处理
  assert.throws(
    () => parseReviewReply(JSON.stringify({ verdict: 'differ', summary: 'x', issues: [] }), { plan, furniture: [] }),
    error => error.name === 'ReviewParseError',
  );

  // 有可用的 fixed 时允许 issues 为空
  const fixedOnly = parseReviewReply(JSON.stringify({
    verdict: 'differ', summary: '已按图修正', issues: [], fixed: { plan: basePlan({ name: '修正方案' }) },
  }), { plan, furniture: [] });
  assert.equal(fixedOnly.verdict, 'differ');
  assert.equal(fixedOnly.issues.length, 0);
  assert.ok(fixedOnly.fixed?.plan);

  const long = parseReviewReply(JSON.stringify({
    verdict: 'differ',
    summary: '字'.repeat(300),
    issues: Array.from({ length: 20 }, (_, index) => ({ where: 'w'.repeat(100), detail: 'd'.repeat(500) })),
    fixed: null,
  }), { plan, furniture: [] });
  assert.equal(long.summary.length, 120);
  assert.equal(long.issues.length, 8);
  for (const issue of long.issues) {
    assert.ok(issue.where.length <= 60);
    assert.ok(issue.detail.length <= 200);
  }
});

test('parseReviewReply raises a named error when no JSON can be read', () => {
  assert.throws(
    () => parseReviewReply('这里没有 JSON', { plan: basePlan(), furniture: [] }),
    error => error instanceof Error && error.name === 'ReviewParseError',
  );
  assert.throws(
    () => parseReviewReply('', { plan: basePlan(), furniture: [] }),
    error => error instanceof Error && error.name === 'ReviewParseError',
  );
});

test('reviewDelta counts structural changes and named/area-changed rooms in square metres', () => {
  const before = basePlan({
    walls: [[0, 0, 10000, 200], [0, 0, 200, 10000], [9800, 0, 10000, 10000], [0, 9800, 10000, 10000]],
    wins: [[1000, 0, 2000, 200], [3000, 0, 4000, 200]],
    doors: [{ name: '入户门', rect: [5000, 9800, 5800, 10000], h: [5000, 9800], c: [1, 0], o: [0, 1], len: 800 }],
    rooms: [
      { id: 'living', name: '客厅', poly: rect(0, 0, 4000, 3000), mat: 'tile800' },
      { id: 'bed', name: '主卧', poly: rect(0, 3000, 3000, 3000), mat: 'wood' },
      { id: 'bath', name: '卫生间', poly: rect(4000, 0, 2000, 2000), mat: 'tile600' },
      { id: 'balcony', name: '阳台', poly: rect(4000, 3000, 2000, 2000), mat: 'antislip', counted: false },
    ],
  });
  const after = basePlan({
    walls: [[0, 0, 10000, 200], [0, 0, 200, 10000], [9800, 0, 10000, 10000], [0, 9800, 10000, 10000], [5000, 0, 5200, 3000]],
    wins: [[1000, 0, 2000, 200]],
    doors: [],
    rooms: [
      { id: 'living', name: '客厅', poly: rect(0, 0, 4000, 3000), mat: 'tile800' },
      { id: 'bed', name: '次卧', poly: rect(0, 3000, 3000, 3000), mat: 'wood' },
      { id: 'bath', name: '卫生间', poly: rect(4000, 0, 2200, 2000), mat: 'tile600' },
      { id: 'kitchen', name: '厨房', poly: rect(6000, 6000, 2000, 2000), mat: 'tile800' },
      { id: 'balcony', name: '阳台', poly: rect(4000, 3000, 2000, 2000), mat: 'antislip', counted: false },
    ],
  });
  const beforeFurniture = [
    { type: 'sofa' }, { type: 'bed' }, { type: 'chair' },
  ];
  const afterFurniture = [
    { type: 'sofa' }, { type: 'bed' }, { type: 'chair' }, { type: 'table' },
  ];
  const delta = reviewDelta(before, beforeFurniture, after, afterFurniture);

  assert.deepEqual(Object.keys(delta).sort(),
    ['area', 'changedRooms', 'doors', 'furniture', 'rooms', 'walls', 'wins']);
  assert.deepEqual(delta.rooms, { before: 4, after: 5 });
  assert.equal(delta.area.before, 25.0); // 客厅 12 + 主卧 9 + 卫生间 4；阳台不计
  assert.equal(delta.area.after, 29.4);  // 12 + 9 + 4.4 + 厨房 4
  assert.deepEqual(delta.walls, { before: 4, after: 5 });
  assert.deepEqual(delta.wins, { before: 2, after: 1 });
  assert.deepEqual(delta.doors, { before: 1, after: 0 });
  assert.deepEqual(delta.furniture, { before: 3, after: 4 });
  assert.deepEqual(delta.changedRooms, ['bed', 'bath', 'kitchen']);
});

test('parseReviewReply rejects missing or unknown verdicts', () => {
  const plan = basePlan();
  for (const payload of [
    { summary: '缺 verdict' },
    { verdict: 'ok', summary: '未知 verdict', issues: [] },
    { verdict: 'DIFFER', issues: [{ where: '门', detail: '偏了' }] },
    { verdict: 1, issues: [{ where: '门', detail: '偏了' }] },
  ]) {
    assert.throws(
      () => parseReviewReply(JSON.stringify(payload), { plan, furniture: [] }),
      error => error.name === 'ReviewParseError',
      JSON.stringify(payload),
    );
  }
});

test('reviewDelta measures rooms with arcs like summarizePlan does', () => {
  const before = basePlan({
    rooms: [{ id: 'living', name: '客厅', poly: rect(0, 0, 4000, 4000), mat: 'tile800' }],
  });
  const after = basePlan({
    rooms: [{ id: 'living', name: '客厅', poly: rect(0, 0, 4000, 4000), arcs: [{ edge: 0, sweep: 90 }], mat: 'tile800' }],
  });
  const delta = reviewDelta(before, [], after, []);
  // 弧边向外凸出：16.0 ㎡ + 半径 4000、90° 的弓形 2.28 ㎡
  assert.equal(delta.area.before, 16.0);
  assert.equal(delta.area.after, 18.3);
  assert.ok(delta.changedRooms.includes('living'), JSON.stringify(delta));
});

test('reviewDelta tolerates missing plans and keeps one decimal place', () => {
  const empty = reviewDelta(null, null, null, null);
  assert.deepEqual(empty.rooms, { before: 0, after: 0 });
  assert.deepEqual(empty.area, { before: 0, after: 0 });
  assert.deepEqual(empty.changedRooms, []);

  const before = basePlan({
    rooms: [{ id: 'living', name: '客厅', poly: rect(0, 0, 1000, 1000), mat: 'tile800' }],
  });
  const after = basePlan({
    rooms: [{ id: 'living', name: '客厅', poly: rect(0, 0, 1000, 1050), mat: 'tile800' }],
  });
  const delta = reviewDelta(before, [], after, []);
  assert.equal(delta.area.before, 1.0);
  assert.equal(delta.area.after, 1.1);
  assert.deepEqual(delta.changedRooms, [], '5% 以内不算变化');
});
