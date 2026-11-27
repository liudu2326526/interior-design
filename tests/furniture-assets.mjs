import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePatch, validateImportedFurniture } from '../lib/codex/plan.mjs';

const seat = {shape:'cylinder', x:0, z:0, w:1, d:1, y:425, h:35};
const asset = {type:'component', name:' 浅木圆凳 ', w:420, d:410, color:'#cfad84', parts:[seat]};

test('chat returns validated furniture geometry without placement or identifiers', () => {
  const result = parsePatch(JSON.stringify({
    reply:'已生成浅木圆凳素材。', ops:[], furniture:[{...asset, id:'model-id', cx:3000, cy:1200, url:'https://example.invalid/a'}],
  }));
  assert.deepEqual(result, {
    reply:'已生成浅木圆凳素材。', ops:[],
    furniture:[{...asset, name:'浅木圆凳', rot:0}],
  });
});

test('ordinary scene operations and standard furniture options pass through', () => {
  const ops = [{op:'moveFurniture', id:'f12', dx:200, dy:0}];
  assert.deepEqual(parsePatch(JSON.stringify({reply:'已移动。', ops})), {reply:'已移动。', ops});
  const table = {type:'coffeetable', name:'圆茶几', w:600, d:600, rot:-45, topShape:'round', height:430};
  const generated = parsePatch(JSON.stringify({reply:'已生成。', ops, furniture:[table]}));
  assert.deepEqual(generated.ops, ops);
  assert.deepEqual(generated.furniture, [{...table, rot:315}]);
});

test('invalid furniture geometry does not pass through as a partial result', () => {
  const generate = furniture => parsePatch(JSON.stringify({ops:[], furniture}));
  assert.throws(() => generate([{...asset, parts:[]}]), /部件数据无效/);
  assert.throws(() => generate([{...asset, parts:[seat,{...seat,h:-1}]}]), /部件数据无效/);
  assert.throws(() => generate([{...asset, w:10001}]), /尺寸/);
  assert.throws(() => generate(Array(9).fill(asset)), /最多生成 8 件/);
});

test('drawing import still validates placement and preserves supported geometry', () => {
  const bounds = {x:0, y:0, w:5000, h:5000};
  const placed = {...asset, cx:399.5, cy:500, rot:90};
  assert.deepEqual(validateImportedFurniture([placed, {...placed, cx:5001}], bounds), [
    {...placed, name:'浅木圆凳', cx:400},
  ]);
});
