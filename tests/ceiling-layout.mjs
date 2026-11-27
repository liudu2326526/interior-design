import assert from 'node:assert/strict';
import { test } from 'node:test';
import '../js/ceiling-model.js';

const model = globalThis.CeilingModel;
const room = {id:'master',poly:[[6600,0],[10270,0],[10270,3370],[6600,3370]]};
const edit = (design, patch) => model.apply(design, room, patch, {checkGeometry:true});
const line = {id:'linear',type:'linear',x:6690,y:1983,length:1200,width:45};
const zone = (id, x0, x1, drop=180) => ({
  id, name:id, drop, poly:[[x0,400],[x1,400],[x1,2800],[x0,2800]],
});

test('uses the full rotated fixture outline and snaps its edge inside the room', () => {
  assert.throws(() => edit(null,{fixtures:[line]}), /完整轮廓超出房间边界/);
  const [x,y] = model.snapFixture(null,room,line,180);
  assert.deepEqual([x,y],[7200,line.y]);
  assert.equal(edit(null,{fixtures:[{...line,x,y}]}).rooms.master.fixtures[0].x,7200);
  const vertical = {...line,rotation:90};
  assert.doesNotThrow(() => edit(null,{fixtures:[vertical]}));
  const snapped = model.snapFixture(null,room,vertical,180);
  assert.ok(Math.abs(snapped[0]-6622.5)<.00001);
  assert.doesNotThrow(() => edit(null,{fixtures:[{...vertical,x:snapped[0],y:snapped[1]}]}));
});

test('keeps automatic and explicit placement on one installation surface', () => {
  const base = zone('layer',7500,10000);
  const opening = [[8500,1500],[9000,1500],[9000,2300],[8500,2300]];
  const existing = edit(null,{zones:[{...base,holes:[opening]}]});
  const overHole = {...line,x:8250,zoneId:base.id};
  assert.throws(() => edit(existing,{fixtures:[overHole]}), /同一安装面.*镂空/);
  assert.throws(() => edit(existing,{fixtures:[{...line,x:7300}]}), /不同标高/);
  assert.doesNotThrow(() => edit(existing,{fixtures:[{...line,x:8000,length:550,zoneId:base.id}]}));
});

test('allows touching edges and different heights while preventing same-height overlap', () => {
  const left = zone('left',6800,8200);
  const right = zone('right',8200,9600);
  const crossing = zone('crossing',8100,9800);
  const design = edit(null,{zones:[left,right]});
  assert.throws(() => edit(design,{zones:[left,right,crossing]}), /同标高重叠/);
  assert.throws(() => edit(design,{zones:[left,{...left,id:'same'}]}), /同标高重叠/);
  assert.doesNotThrow(() => edit(design,{zones:[left,right,{...crossing,drop:250}]}));
  assert.doesNotThrow(() => edit(design,{zones:[left,right,{...crossing,poly:[[6850,500],[8000,500],[8000,700],[6850,700]],drop:250}]}));
  const inset={id:'inset',poly:[[7300,700],[9300,700],[9300,2400],[7300,2400]],drop:180};
  assert.doesNotThrow(() => edit(null,{zones:[{...zone('ring',6800,9800),holes:[inset.poly]},inset]}));
});

test('preserves legacy geometry on load and supports unrelated edits or corrections', () => {
  const left = zone('left',7000,8400);
  const crossing = zone('crossing',8000,10000);
  const legacy = {rooms:{master:{zones:[left,crossing],fixtures:[line]}}};
  const design = model.normalize(legacy,[room]);
  assert.equal(design.rooms.master.zones.length,2);
  assert.equal(design.rooms.master.fixtures[0].x,line.x);
  assert.doesNotThrow(() => edit(design,{fixtures:[{...line,kelvin:4100}]}));
  assert.doesNotThrow(() => edit(design,{zones:[{...left,name:'主卧边吊'},crossing]}));
  assert.throws(() => edit(design,{fixtures:[{...line,width:70}]}), /完整轮廓超出房间边界/);
  assert.doesNotThrow(() => edit(design,{fixtures:[{...line,x:7600}]}));
});
