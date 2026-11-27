import assert from 'node:assert/strict';
import test from 'node:test';
import { validatePlan } from '../lib/codex/plan.mjs';
import { buildCadDxf } from '../lib/cad-dxf.mjs';

const result = validatePlan({
  name:'尺寸测试',
  bounds:{x:-400,y:-400,w:10400,h:6800},
  walls:[
    [-240,0,0,6000,'e'],
    [8000,0,8240,6000,'e'],
    {from:[1500,0],to:[4500,0],sweep:90,thickness:200,kind:'n'},
  ],
  wins:[{from:[1500,0],to:[4500,0],sweep:90,thickness:80}],
  doors:[{rect:[0,2000,150,2900],h:[0,2000],c:[0,1],o:[1,0],len:900}],
  rooms:[{id:'r1',name:'客厅',poly:[[0,0],[8000,0],[8000,6000],[0,6000]]}],
});
assert.equal(result.ok, true);
const plan = result.plan;

function tags(text) {
  const lines = text.trimEnd().split(/\r?\n/);
  const pairs = [];
  for (let i = 0; i < lines.length; i += 2) pairs.push([Number(lines[i]), lines[i + 1]]);
  return pairs;
}

function entities(dxf) {
  const pairs = tags(dxf);
  const start = pairs.findIndex(([code, value]) => code === 2 && value === 'ENTITIES');
  assert.notEqual(start, -1);
  const objects = [];
  for (const [code, value] of pairs.slice(start + 1)) {
    if (code === 0 && value === 'ENDSEC') break;
    if (code === 0) objects.push({type:value, groups:[]});
    else objects.at(-1).groups.push([code, value]);
  }
  return objects;
}

const values = (groups, code) => groups.filter(tag => tag[0] === code).map(tag => tag[1]);

test('CAD writer emits millimetre model-space shapes with walls, curves and dimension layers', () => {
  const points = [{value:-240,across:0},{value:8240,across:0}];
  const dxf = buildCadDxf({
    plan,
    state:{
      demolished:['w1'], rooms:{},
      furniture:[{id:'one',type:'sofa',name:'沙发',cx:2000,cy:4000,w:1800,d:850,rot:35}],
    },
    dimensions:[{axis:'x',at:-400,kind:'manual',points,original:8500}],
  });
  const header = tags(dxf);
  const index = header.findIndex(([code, value]) => code === 9 && value === '$INSUNITS');
  assert.deepEqual(header[index + 1], [70,'4']);
  const drawn = entities(dxf);
  const byLayer = name => drawn.filter(({groups}) => values(groups,8)[0] === name);
  assert.equal(byLayer('A-WALL-DEMO').length, 1);
  assert.equal(byLayer('A-ROOM')[0].type, 'LWPOLYLINE');
  assert.ok(values(byLayer('A-ROOM')[0].groups,20).includes('-6000'));
  assert.ok(byLayer('A-WALL-PARTITION').some(({groups}) => values(groups,42).some(Number)));
  assert.ok(byLayer('A-DOOR').some(({type}) => type === 'ARC'));
  assert.ok(byLayer('A-FURN').length);
  assert.ok(byLayer('A-DIMS-MANUAL').some(({groups}) => values(groups,1).includes('8480 mm')));
  assert.ok(byLayer('A-DIMS-REFERENCE').some(({groups}) => values(groups,1)[0].endsWith('8500 mm')));
});

test('CAD writer rejects repeated anchors and unexpected dimension layers', () => {
  const point = {value:500,across:0};
  for (const kind of ['manual','__proto__']) {
    assert.throws(() => buildCadDxf({plan,dimensions:[{kind,axis:'x',at:-250,points:[point,point]}]}), /CAD dimension/);
  }
});
