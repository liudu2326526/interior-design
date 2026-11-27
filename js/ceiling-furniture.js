/* Mounting data for furniture. The ceiling geometry and recognition APIs consume a room projection. */
(() => {
  'use strict';
  const App = globalThis.App;
  const model = App.ceilingModel;
  const profiles = {
    downlight:{name:'筒灯',w:90,d:90,color:'#f8f9f7'},
    spot:{name:'射灯',w:100,d:100,color:'#303437',hang:40},
    pendant:{name:'吊灯',w:400,d:400,color:'#f8f9f7',hang:600},
    linear:{name:'线性灯',w:1200,d:45,color:'#f8f9f7'},
    track:{name:'磁吸轨道',w:1500,d:55,color:'#303437'},
    vent:{name:'条形风口',w:1000,d:120,color:'#f8f9f7'},
    access:{name:'检修口',w:450,d:450,color:'#f8f9f7'},
    curtain:{name:'窗帘盒',w:1600,d:180,color:'#f8f9f7'},
    ceilingac:{name:'嵌入式四面出风空调',w:840,d:840,color:'#f8f9f7'},
    ductac:{name:'风管机',w:1200,d:500,color:'#f8f9f7'},
  };
  const types = Object.keys(profiles);
  const is = item => Boolean(item && Object.hasOwn(profiles,item.type));
  const defaults = type => Object.hasOwn(profiles,type) ? profiles[type] : null;
  const mountLimits = {hang:[0,30000],kelvin:[1800,10000],intensity:[0,100],tilt:[-85,85]};
  const namedId = id => typeof id==='string' && id.trim() && id.length<=120 &&
    !['__proto__','constructor','prototype'].includes(id) ? id : undefined;

  function normalizeMount(item) {
    const source = item.ceiling || {}, mount = {};
    for (const key of ['roomId','zoneId']) {
      const id = namedId(source[key]);
      if (id) mount[key] = id;
    }
    for (const [key,[min,max]] of Object.entries(mountLimits)) {
      const value = source[key];
      if (Number.isFinite(value) && value>=min && value<=max) mount[key] = value;
    }
    return mount;
  }

  function toFixture(item) {
    const {roomId, ...mount} = normalizeMount(item);
    let color = item.color;
    if (/^#[0-9a-f]{3}$/i.test(color || '')) color = '#' + color.slice(1).split('').map(c=>c+c).join('');
    return {
      id:item.id,type:item.type,x:item.cx,y:item.cy,length:item.w,width:item.d,rotation:item.rot || 0,
      ...(/^#[0-9a-f]{6}$/i.test(color || '') ? {color} : {}), ...mount,
    };
  }

  function toItem(fixture, roomId, previous) {
    const profile = defaults(fixture.type);
    if (!profile) return null;
    const {id,type,x,y,length,width,rotation,color, ...metadata} = fixture;
    return App.geom.normalizeFurn({
      id,type,name:(previous?.type===type && previous.name) || profile.name,cx:x,cy:y,w:length??profile.w,d:width??profile.d,
      rot:rotation??0,color:color??previous?.color??profile.color,ceiling:{roomId,...metadata},
    });
  }

  function matchingRoom(item, roomDefs) {
    const point = [item.cx,item.cy];
    const contains = room => namedId(room.id) && !room.bay && model.pointIn(model.outline(room),point);
    const preferred = roomDefs.find(room => room.id===item.ceiling?.roomId);
    if (preferred && contains(preferred)) return preferred;
    return roomDefs.find(room => !room.outdoor && contains(room)) || roomDefs.find(contains);
  }

  function zoneAt(ceiling, room, fixture) {
    const point = [fixture.x,fixture.y];
    return model.shapes(ceiling,room).filter(zone =>
      model.pointIn(zone.poly,point) && !zone.holes.some(hole => model.pointIn(hole,point,false)));
  }

  function place(item, ceiling=App.store.state.ceiling, roomDefs=App.store.ROOMS) {
    if (!is(item)) return item;
    if (![item.w,item.d].every(value=>Number.isFinite(value) && value>=1 && value<=30000)) return null;
    const room = matchingRoom(item,roomDefs);
    if (!room) return null;
    const mount = {...normalizeMount(item), roomId:room.id};
    const fixture = toFixture({...item,ceiling:mount});
    const zones = mount.zoneId || room.outdoor || mount.hang!==undefined ? zoneAt(ceiling,room,fixture) : [];
    if (room.outdoor && !zones.length) return null;
    const pairedZone = zones.find(zone => zone.id===mount.zoneId);
    if (mount.zoneId && (!pairedZone || zones.some(zone=>zone.height<pairedZone.height))) delete mount.zoneId;
    if (mount.hang!==undefined){
      const height = mount.zoneId ? zones.find(zone=>zone.id===mount.zoneId).height
        : zones.reduce((min,zone)=>Math.min(min,zone.height),model.baseHeight(ceiling,room.id));
      mount.hang = Math.min(mount.hang,Math.max(0,height-1));
    }
    return {...item,ceiling:mount};
  }

  function placeEdited(item, {snap=false, ceiling=App.store.state.ceiling, roomDefs=App.store.ROOMS}={}) {
    if (!is(item)) return item;
    let mounted=place(item,ceiling,roomDefs);
    if (!mounted) return null;
    const room=roomDefs.find(def=>def.id===mounted.ceiling.roomId);
    if (snap && App.store.ui.layers.wallSnap){
      const [cx,cy]=model.snapFixture(ceiling,room,toFixture(mounted),8/App.store.view.s);
      mounted=place({...mounted,cx,cy},ceiling,roomDefs);
      if (!mounted) return null;
    }
    return model.fixturePlacementProblem(ceiling,room,toFixture(mounted)) ? null : mounted;
  }

  function project(ceiling, furniture, roomDefs=App.store.ROOMS) {
    const rooms = Object.fromEntries(Object.entries(ceiling.rooms).map(([id, room]) => [id,{...room,fixtures:[]}]));
    for (const item of furniture) {
      if (!is(item)) continue;
      const mounted = place(item,ceiling,roomDefs);
      if (!mounted) continue;
      const roomId = mounted.ceiling.roomId;
      if (!Object.hasOwn(rooms,roomId)) rooms[roomId] = {zones:[],edges:[],fixtures:[]};
      rooms[roomId].fixtures.push(toFixture(mounted));
    }
    return {...ceiling,rooms};
  }

  // Projects predating the unified library stored fixture definitions inside each room.
  // Bring them into the same furniture list, using a new id only for an existing collision.
  function split(ceiling, furniture, replace=false, prior=null) {
    const existing = new Map(furniture.map(item=>[item.id,item]));
    const used = new Set(furniture.map(item=>item.id));
    const rooms = {}, replacements = new Map(), additions = [], survivingIds = new Set();
    const priorIds = new Set(Object.values(prior?.rooms || {}).flatMap(room=>room.fixtures.map(f=>f.id)));
    for (const [roomId,{fixtures=[],...design}] of Object.entries(ceiling.rooms)) {
      rooms[roomId] = design;
      for (const fixture of fixtures) {
        survivingIds.add(fixture.id);
        const before = model.room(prior,roomId).fixtures.find(item=>item.id===fixture.id);
        if (before && Object.keys(before).length===Object.keys(fixture).length &&
            Object.entries(before).every(([key,value])=>fixture[key]===value)) continue;
        const item = existing.get(fixture.id);
        const same = is(item) && (!item.ceiling?.roomId || item.ceiling.roomId===roomId) && !replacements.has(item.id);
        if (same) {
          replacements.set(item.id,replace ? toItem(fixture,roomId,item) : item);
          continue;
        }
        let id = fixture.id;
        let sequence = 1;
        while (used.has(id)) {
          id = 'ceiling-' + fixture.id.slice(0,90) + '-' + sequence++;
        }
        used.add(id);
        additions.push(toItem({...fixture,id},roomId));
      }
    }
    const retained = !replace ? furniture : furniture.flatMap(item=>{
      if (replacements.has(item.id)) return [replacements.get(item.id)];
      if (!is(item) || (prior && (!priorIds.has(item.id) || survivingIds.has(item.id)))) return [item];
      return [];
    });
    return {ceiling:{...ceiling,rooms},furniture:[...retained,...additions]};
  }

  const current = () => project(App.store.state.ceiling,App.store.state.furniture);
  const view = () => App.store.ui.ceilingPreview || current();
  const room = id => model.room(current(),id);

  function applyRoom(id, patch) {
    const def = App.plan.roomDef(id);
    if (!def) throw new Error(App.core.tr('找不到房间', 'Room is unavailable'));
    const before = current(), projected = model.apply(before,def,patch,{checkGeometry:true});
    const data = split(projected,App.store.state.furniture,true,before);
    App.store.mutate(()=>Object.assign(App.store.state,data));
    return true;
  }

  function update(item) {
    const mounted = place(item);
    const previous = App.store.getF(item.id);
    if (!mounted || !previous ||
        (item.ceiling?.zoneId && mounted.ceiling.zoneId!==item.ceiling.zoneId)) {
      throw new Error(App.core.tr('顶装家具需要位于可安装的室内顶面', 'Place the item on a valid ceiling surface'));
    }
    const projected = current(), id = mounted.ceiling.roomId, def = App.plan.roomDef(id);
    const fixtures = model.room(projected,id).fixtures.filter(f=>f.id!==item.id);
    model.apply(projected,def,{fixtures:[...fixtures,toFixture(mounted)]},{checkGeometry:true});
    App.store.mutate(()=>Object.assign(previous,mounted));
    return true;
  }

  App.ceilingFurniture = {types,is,defaults,normalizeMount,toFixture,toItem,place,placeEdited,project,split,current,view,room,applyRoom,update};
})();
