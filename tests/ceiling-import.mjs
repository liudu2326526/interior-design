import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewCeiling } from '../lib/ceiling-recognition.mjs';

const plan = {rooms:[
  {id:'living', poly:[[0,0],[8000,0],[8000,6000],[0,6000]]},
  {id:'kitchen', poly:[[8000,0],[12000,0],[12000,4000],[8000,4000]]},
]};
const zone = {id:'north', name:'北侧边吊', poly:[[0,0],[8000,0],[8000,500],[0,500]],drop:150,color:'#f0f0f0'};
const fixture = {id:'f1', type:'downlight', zoneId:'north', x:2000, y:250, width:100};
const ceiling = globalThis.CeilingModel.validate({rooms:{living:{zones:[zone], fixtures:[fixture]}}}, plan.rooms);
const context = {plan, ceiling, roomId:'living', mode:'drawing'};

test('ceiling recognition matches existing geometry, retains manual properties and suppresses duplicate imports', () => {
  const renamedZone = {...zone, id:'identified-1'};
  const renamedFixture = {...fixture, id:'identified-2', zoneId:renamedZone.id};
  delete renamedFixture.width;
  const proposal = {aligned:true, rooms:{living:{baseHeight:2800, zones:[renamedZone],fixtures:[renamedFixture]}}};
  assert.deepEqual(reviewCeiling(proposal, context).items, []);
  renamedZone.drop = 170;
  const edited = reviewCeiling(proposal,context).items;
  assert.equal(edited.length,1);
  assert.equal(edited[0].group,'zones');
  assert.equal(edited[0].id,zone.id);
  assert.equal(edited[0].value.drop,170);
  assert.equal(ceiling.rooms.living.zones[0].drop,150);
});

test('ceiling recognition confines suggestions to the project and returns no proposal when alignment fails', () => {
  const raw={aligned:true, alignment:'无法可靠配准', rooms:{kitchen:{fixtures:[]}}};
  assert.throws(()=>reviewCeiling(raw,context), /范围外/);
  assert.deepEqual(reviewCeiling({...raw, aligned:false},context).items, []);
  assert.throws(()=>reviewCeiling({aligned:true, rooms:{living:{fixtures:[{...fixture, x:10000}]}}},context));
  const photo=reviewCeiling({aligned:true, rooms:{living:{baseHeight:2650}}},{...context,mode:'photo'});
  assert.equal(photo.estimated,true);
  assert.equal(photo.items[0].value,2650);
});

test('explicit removals require evidence and preserve hosted fixtures through a reviewed attachment change', () => {
  const original=globalThis.CeilingModel.validate({rooms:{living:{zones:[zone],fixtures:[fixture],
    edges:[{id:'trim',zoneId:zone.id,edge:0,type:'trim',width:30,depth:25,color:'#333333'}]}}},plan.rooms);
  const options={...context,ceiling:original};
  const removal={group:'zones',id:zone.id,source:'drawing',reason:'北边带标注拆除'};
  const result = entry=>reviewCeiling({aligned:true,rooms:{living:{remove:[entry]}}},options).items;
  assert.deepEqual(result(removal).map(r=>[r.group,r.action]),[['zones','remove'],['edges','remove'],['fixtures','detach']]);
  const detach=result(removal).at(-1);
  assert.equal(detach.parentZone,zone.id);
  assert.deepEqual(detach.value,{id:'f1',type:'downlight',x:2000,y:250,width:100});
  assert.equal(original.rooms.living.fixtures[0].zoneId,'north');
  assert.throws(()=>result({...removal,id:'unknown'}),/已有/);
  assert.throws(()=>result({...removal,source:'request'}),/依据/);
  assert.throws(()=>result({...removal,reason:''}),/依据/);
  assert.equal(reviewCeiling({aligned:true,rooms:{living:{remove:[{...removal,source:'request',reason:'删除北侧边吊'}]}}},
    {...options,mode:'photo',note:'请删除北侧边吊'}).items.length,3);
  assert.deepEqual(reviewCeiling({aligned:true,rooms:{living:{zones:[],edges:[],fixtures:[]}}},options).items,[]);
});
