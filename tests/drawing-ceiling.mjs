import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDrawingCeiling, reviewDrawingCeiling, validateDrawingCeiling } from '../lib/drawing-ceiling.mjs';

const floor = (id, x, props = {}) => ({id, name: id, poly: [[x,0], [x+4000,0], [x+4000,3600], [x,3600]], ...props});
const living = floor('living', 0);
const terrace = floor('terrace', 4000, {outdoor:true});
const bay = floor('bay', 8000, {bay:{roomId:'living'}});
const plan = { rooms: [living, terrace, bay] };
const light = {id:'living-light', type:'downlight', x:3400, y:1800};
const roof = {id:'covered-zone', name:'雨棚', poly:[[4200,200],[6000,200],[6000,1600],[4200,1600]], drop:55};
const proposal = {rooms:{living:{baseHeight:2750, fixtures:[light]}}};
const found = {status:'found', alignment:'已按走廊转角与入口对齐。', ...proposal};
const absent = {status:'absent', rooms:{}};
const okay = {verdict:'match', summary:'尺寸和安装面可用。'};

function mock(...replies) {
  const calls = [];
  return {calls, run: async call => {
    const fixture = replies[calls.length];
    calls.push(call);
    assert.equal(call.input.stage, call.stage);
    assert.match(call.prompt, /天花/);
    assert.ok(fixture, 'unexpected model turn');
    return typeof fixture === 'function' ? fixture(call) : fixture;
  }};
}

test('paired ceiling drawing uses source recognition and reviews it independently', async () => {
  const {run,calls} = mock(found, okay);
  const inputs = {sources:[{name:'原户型.png',kind:'floor'},{name:'天花平面.pdf',kind:'ceiling'}]};
  const args = {plan, inputs, hasExplicitCeiling: true, run};
  const result = await buildDrawingCeiling(args);
  assert.equal(result.ceilingMeta.source, 'drawing');
  assert.equal(result.ceiling.rooms.living.baseHeight, 2750);
  assert.deepEqual(result.ceiling.rooms.living.fixtures, [light]);
  const review = await reviewDrawingCeiling({...result,...args});
  assert.equal(review.ceilingMeta.reviewState,'match');
  assert.equal(review.ceilingMeta.reviewSummary, okay.summary);
  assert.equal(calls[1].input.ceilingMeta.source, 'drawing');
  assert.deepEqual(calls[1].input.inputs.sources, inputs.sources);
  assert.deepEqual(calls.map(({stage}) => stage), ['recognize','review']);
});

test('a recognized fixture still discloses the default height when no source elevation is available', async () => {
  const noHeight = {...found, rooms:{living:{fixtures:[light]}}};
  const result = await buildDrawingCeiling({plan,run:mock(noHeight).run});
  assert.equal(result.ceilingMeta.source, 'drawing');
  assert.equal(result.ceilingMeta.estimated, true);
  assert.equal(result.ceiling.rooms.living.baseHeight, undefined);
  assert.match(result.ceilingMeta.warnings[0], /2800 mm/);
});

test('explicit and discovered but unaligned ceiling drawings never request substitute designs', async () => {
  for (const [recognition, hasExplicitCeiling] of [[absent,true],[{status:'unaligned',alignment:'缺少共同锚点。'},false]]) {
    const {run,calls} = mock(recognition);
    const result = await buildDrawingCeiling({plan, hasExplicitCeiling, run});
    assert.equal(result.ceiling,null);
    assert.equal(result.ceilingMeta.source,'unavailable');
    assert.equal(result.ceilingMeta.reason, 'unaligned');
    assert.deepEqual(calls.map(({stage})=>stage),['recognize']);
  }
});

test('uninspected sources are not proof of absence', async () => {
  const inputs = {sources:[{name:'整套图纸.pdf',kind:'floor',incomplete:true}]};
  const missed = mock(absent);
  const pending = await buildDrawingCeiling({plan,inputs,run:missed.run});
  assert.equal(pending.ceilingMeta.reason,'uncertain');
  assert.equal(missed.calls.length,1);
  const inspected = mock({...absent,sourceChecks:[{name:'整套图纸.pdf',evidence:'检查目录及全部 9 页，没有天花图及顶装标注。'}]},proposal);
  const result = await buildDrawingCeiling({plan,inputs,run:inspected.run});
  assert.equal(result.ceilingMeta.source,'generated');
  assert.equal(inspected.calls.length,2);
});

test('confirmed absence generates a bounded, editable draft and independently reviews design feasibility', async () => {
  const {run,calls} = mock(absent, proposal, okay);
  const generated = await buildDrawingCeiling({plan, note:'客厅均匀布灯', run});
  assert.equal(generated.ceilingMeta.source, 'generated');
  assert.equal(generated.ceilingMeta.estimated, true);
  assert.match(generated.ceilingMeta.warnings[0], /现场核对/);
  assert.deepEqual(Object.keys(generated.ceiling.rooms), ['living']);
  const review = await reviewDrawingCeiling({plan, ...generated, run});
  assert.equal(review.ceilingMeta.source, 'generated');
  assert.equal(review.ceilingMeta.reviewState, 'match');
  assert.deepEqual(calls.map(({stage})=>stage), ['recognize','generate','review']);
  assert.equal(calls[1].input.note,'客厅均匀布灯');
  assert.equal(calls[2].input.ceilingMeta.estimated,true);
});

test('ineligible outdoor and bay areas never get a generated design; invalid geometry gets one repair', async () => {
  const invalid = {rooms:{...proposal.rooms,terrace:{zones:[roof]}}};
  const {run,calls} = mock(absent,invalid,call=>{
    assert.match(call.input.validationError,/没有可确认的顶面/);
    assert.deepEqual(call.input.previousDraft,invalid);
    return proposal;
  });
  const repaired = await buildDrawingCeiling({plan,run});
  assert.deepEqual(Object.keys(repaired.ceiling.rooms), ['living']);
  assert.deepEqual(calls.map(({stage})=>stage), ['recognize','generate','generate']);
  const impossible = mock(absent,invalid,invalid);
  await assert.rejects(buildDrawingCeiling({plan,run:impossible.run}), /没有可确认的顶面/);
  assert.equal(impossible.calls.length,3);
  assert.throws(()=>validateDrawingCeiling(plan,{rooms:{bay:{baseHeight:2400}}}), /没有可确认的顶面/);
});

test('generation requires a meaningful design for every indoor room, including a room retaining its original ceiling', async () => {
  const utility = floor('utility', 12000);
  const multiRoom = {rooms:[...plan.rooms,utility]};
  const {run,calls} = mock(absent,proposal,call=>{
    assert.match(call.input.validationError,/utility.*缺少天花方案/);
    return {rooms:{...proposal.rooms,utility:{finish:'保留原顶'}}};
  });
  const draft = await buildDrawingCeiling({plan:multiRoom,run});
  assert.deepEqual(Object.keys(draft.ceiling.rooms), ['living','utility']);
  assert.equal(draft.ceiling.rooms.utility.finish, '保留原顶');
  assert.equal(calls.length, 3);
  const drawn = await buildDrawingCeiling({plan:multiRoom,run:mock(found).run});
  assert.deepEqual(Object.keys(drawn.ceiling.rooms), ['living']);
});

test('a clearly drawn outdoor cover is confined to its actual footprint and needs drawing evidence', async () => {
  const onlyRoof = {...found,rooms:{terrace:{zones:[roof]}}};
  await assert.rejects(buildDrawingCeiling({plan,run:mock(onlyRoof).run}), /没有可确认的顶面/);
  const coveredOutdoorRooms = [{roomId:'terrace', evidence:'图纸 T03 上标出露台西侧雨棚。'}];
  const result = await buildDrawingCeiling({plan,run:mock({...onlyRoof,coveredOutdoorRooms}).run});
  assert.deepEqual(result.ceilingMeta.coveredOutdoorRooms,coveredOutdoorRooms);
  assert.deepEqual(result.ceiling.rooms.terrace.zones[0].poly,roof.poly);
});

test('an all-outdoor plan requires no generated ceiling and has no false review difference', async () => {
  const {run,calls} = mock(absent);
  const outside = {rooms:[terrace,bay]};
  const result = await buildDrawingCeiling({plan:outside,run});
  assert.equal(result.ceiling,null);
  const reviewed = await reviewDrawingCeiling({plan:outside,...result,run});
  assert.equal(reviewed.ceilingMeta.reviewState,'match');
  assert.match(reviewed.ceilingMeta.reviewSummary,/无需复核/);
  assert.equal(calls.length,1);
});

test('manual rerun can recover missing model output without assuming source absence', async () => {
  const {run,calls} = mock(absent,proposal,okay);
  const result = await reviewDrawingCeiling({plan,ceiling:null,retryUnavailable:true,run});
  assert.equal(result.ceilingMeta.source,'generated');
  assert.equal(result.ceilingMeta.reviewState,'differ');
  assert.deepEqual(calls.map(({stage})=>stage),['recognize','generate','review']);
});

test('corrected openings allow a previously unaligned ceiling sheet to recover without generating a substitute', async () => {
  const unaligned = mock({status:'unaligned'});
  const original = {...plan,doors:[{rect:[0,10,100,100]}]};
  const changed = {...original,doors:[{rect:[0,100,100,190]}]};
  const result = await buildDrawingCeiling({plan:original,hasExplicitCeiling:true,run:unaligned.run});
  const {run,calls} = mock(found,okay);
  const review = await reviewDrawingCeiling({plan:changed,previousPlan:original,...result,hasExplicitCeiling:true,run});
  assert.equal(review.ceilingMeta.source,'drawing');
  assert.equal(review.ceilingMeta.reviewState,'differ');
  assert.deepEqual(calls.map(({stage})=>stage),['recognize','review']);
});

test('structural correction must revalidate mount footprints on the final plan before it can be adopted', async () => {
  const earlier = await buildDrawingCeiling({plan,run:mock(found).run});
  const smallerLiving = {...living,poly:[[0,0],[3100,0],[3100,3600],[0,3600]]};
  const adjusted = {rooms:[smallerLiving,terrace,bay]};
  await assert.rejects(reviewDrawingCeiling({plan:adjusted,previousPlan:plan,...earlier,run:mock(okay).run}), /超出房间/);
  const {run,calls} = mock({verdict:'differ',summary:'按复核后的东墙位置向内移动灯位。',rooms:{living:{fixtures:[{...light,x:3000}]}}});
  const review = await reviewDrawingCeiling({plan:adjusted,previousPlan:plan,...earlier,run});
  assert.equal(review.ceiling.rooms.living.baseHeight,2750);
  assert.equal(review.ceiling.rooms.living.fixtures[0].x,3000);
  assert.equal(earlier.ceiling.rooms.living.fixtures[0].x,3400);
  assert.deepEqual(calls[0].input.previousPlan,plan);
});

test('review may not silently omit a fixture when returning a full replacement', async () => {
  const before = await buildDrawingCeiling({plan,run:mock(found).run});
  const removal = {verdict:'differ',summary:'图例明确标示此灯位取消。',rooms:{living:{fixtures:[]}}};
  await assert.rejects(reviewDrawingCeiling({plan,...before,run:mock(removal).run}), /不能省略已有对象/);
  const removals = [{roomId:'living',group:'fixtures',id:light.id,reason:'L-3 灯位有取消标识。'}];
  const result = await reviewDrawingCeiling({plan,...before,run:mock({...removal,removals}).run});
  assert.deepEqual(result.ceiling.rooms.living.fixtures,[]);
  assert.deepEqual(before.ceiling.rooms.living.fixtures,[light]);
});

test('strict validation checks overlapping ceiling geometry and complete fixture footprints', () => {
  const first = {id:'left', poly:[[0,0],[2000,0],[2000,2000],[0,2000]],drop:150};
  const second = {...first,id:'duplicate'};
  assert.throws(()=>validateDrawingCeiling(plan,{rooms:{living:{zones:[first,second]}}}),/同标高重叠/);
  assert.throws(()=>validateDrawingCeiling(plan,{rooms:{living:{fixtures:[{...light,x:10}]}}}),/完整轮廓超出房间边界/);
});
