import '../js/ceiling-model.js';

const model = globalThis.CeilingModel;
const groups = ['zones', 'edges', 'fixtures'];
const protectedIds = new Set(['__proto__', 'prototype', 'constructor']);
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const cleanText = value => typeof value === 'string' ? value.trim().slice(0, 1200) : '';
const closePoint = (a, b) => Array.isArray(a) && Array.isArray(b) && Math.hypot(a[0] - b[0], a[1] - b[1]) <= 25;

function sameOutline(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return false;
  return b.some((start, i) => closePoint(a[0], start) && [1,-1].some(direction =>
    a.every((p, j) => closePoint(p, b[(i + direction*j + b.length) % b.length]))));
}

function samePosition(group, a, b) {
  if (group === 'zones') {
    const ha = a.holes || [], hb = b.holes || [];
    return sameOutline(a.poly, b.poly) && ha.length === hb.length &&
      ha.every(hole => hb.some(ring => sameOutline(hole, ring)));
  }
  if (group === 'edges') return a.zoneId === b.zoneId && a.hole === b.hole && a.edge === b.edge && a.type === b.type;
  return a.type === b.type && closePoint([a.x, a.y], [b.x, b.y]);
}

// Missing objects are preserved. Explicit removals and their dependent changes enter review unchecked.
function prepareRemovals(edits, room, original, def, context, items) {
  const requested = edits.remove ?? [];
  if (!Array.isArray(requested) || requested.length > 200) throw new Error('删除候选数量无效。');
  const rows = new Map();
  const ref = (group, id) => JSON.stringify([group, id]);
  for (const remove of requested) {
    const {group, id, source} = remove ?? {};
    const reason = cleanText(remove?.reason);
    const old = groups.includes(group) && original?.[group]?.find(item => item.id === id);
    if (!old) throw new Error('删除候选必须引用当前房间中已有的对象。');
    if (!(reason && ((source === 'drawing' && context.mode === 'drawing') ||
        (source === 'request' && reason.length >= 2 && context.note?.includes(reason))))) {
      throw new Error('删除候选缺少明确的改图依据或用户指令原文。');
    }
    if (rows.has(ref(group,id)) || items.some(item => item.roomId === def.id && item.group === group && item.id === id)) {
      throw new Error('同一对象存在重复或冲突的修改和删除。');
    }
    rows.set(ref(group,id), {roomId:def.id, group, id, action:'remove', value:old, reason});
  }
  if (!rows.size) return [];
  const removedZones = new Set([...rows.values()].filter(r => r.group === 'zones').map(r => r.id));
  const remainingZones = room.zones.filter(zone => !removedZones.has(zone.id));
  for (const group of ['edges', 'fixtures']) {
    for (const item of room[group]) {
      if (!removedZones.has(item.zoneId)) continue;
      const existing = rows.get(ref(group,item.id));
      if (existing) { existing.parentZone = item.zoneId; continue; }
      if (items.some(row => row.roomId === def.id && row.group === group && row.id === item.id) &&
          JSON.stringify(original[group].find(old=>old.id===item.id)) !== JSON.stringify(item)) {
        throw new Error('修改的附属对象仍引用待删除的顶面，请明确其新挂载面。');
      }
      const host = original.zones.find(z=>z.id===item.zoneId).name;
      let action='remove', value=item, reason='收边依附于待删除的「'+host+'」。';
      if (group === 'fixtures') {
        const detached = {...item};
        delete detached.zoneId;
        // Indoors there is a base ceiling. On a terrace another authored ceiling must support the fixture.
        try {
          model.apply(context.ceiling,def,{...room,zones:remainingZones,edges:[],fixtures:[detached]});
          action='detach'; value=detached; reason='保留设备在原平面位置，随剩余顶面重新确定安装高度。';
        } catch {
          reason='删去「'+host+'」后，该设备没有可用的安装面或悬挂净高。';
        }
      }
      rows.set(ref(group,item.id), {roomId:def.id,group,id:item.id,value,action,reason,parentZone:item.zoneId});
    }
  }
  for (const row of rows.values()) {
    const index = room[row.group].findIndex(item => item.id === row.id);
    if (row.action === 'remove') room[row.group].splice(index,1);
    else room[row.group][index] = row.value;
  }
  return [...rows.values()];
}

export function reviewCeiling(raw, context) {
  const {plan, ceiling, roomId, mode} = context;
  if (!record(raw) || typeof raw.aligned !== 'boolean' || !record(raw.rooms)) throw new Error('识别结果缺少对齐信息或房间数据。');
  const warnings = Array.isArray(raw.warnings) ? raw.warnings.map(cleanText).filter(Boolean).slice(0, 24) : [];
  const result = {aligned:raw.aligned, alignment:cleanText(raw.alignment), warnings, estimated:mode === 'photo', items:[]};
  if (!raw.aligned) return result;
  const draft = structuredClone(ceiling), removals=[];
  const allowedRooms = new Set(plan.rooms.filter(r => !roomId || r.id === roomId).map(r => r.id));
  for (const [id, edits] of Object.entries(raw.rooms)) {
    if (protectedIds.has(id) || !allowedRooms.has(id) || !record(edits)) throw new Error('天花识别结果指向范围外的房间。');
    if (!Object.hasOwn(draft.rooms,id)) draft.rooms[id] = {zones:[], edges:[], fixtures:[]};
    const room = draft.rooms[id];
    if (edits.baseHeight !== undefined && edits.baseHeight !== model.baseHeight(ceiling, id)) {
      room.baseHeight = edits.baseHeight;
      result.items.push({roomId:id, group:'baseHeight', value:room.baseHeight});
    }
    const zoneIds = new Map();
    for (const group of groups) {
      const patch = edits[group] ?? [];
      if (!Array.isArray(patch) || patch.length > 200 || result.items.length + patch.length > 400) throw new Error('天花识别对象数量无效。');
      const seen = new Set();
      for (const item of patch) {
        if (!record(item) || typeof item.id !== 'string' || !item.id || protectedIds.has(item.id)) throw new Error('天花对象缺少有效编号。');
        const value = structuredClone(item);
        if (zoneIds.has(value.zoneId)) value.zoneId = zoneIds.get(value.zoneId);
        let index = room[group].findIndex(old => old.id === value.id);
        if (index < 0) {
          const matches = room[group].filter(old => samePosition(group, value, old));
          if (matches.length === 1) index = room[group].indexOf(matches[0]);
        }
        if (index >= 0) value.id = room[group][index].id;
        if (seen.has(value.id)) throw new Error('同一个天花对象被重复识别，请分房间重试。');
        seen.add(value.id);
        if (group === 'zones') zoneIds.set(item.id, value.id);
        if (index >= 0) room[group][index] = {...room[group][index], ...value};
        else room[group].push(value);
        result.items.push({roomId:id, group, id:value.id, value});
      }
    }
    const def=plan.rooms.find(r=>r.id===id);
    removals.push(...prepareRemovals(edits,room,ceiling.rooms[id],def,context,result.items));
  }
  const normalized = model.validate(draft, plan.rooms);
  result.items = result.items.flatMap(row => {
    if (removals.some(item=>item.roomId===row.roomId && item.group===row.group && item.id===row.id)) return [];
    const room = normalized.rooms[row.roomId];
    const old = ceiling.rooms[row.roomId];
    const value = row.group === 'baseHeight' ? room.baseHeight : room[row.group].find(item => item.id === row.id);
    const previous = row.group === 'baseHeight' ? old?.baseHeight : old?.[row.group]?.find(item => item.id === row.id);
    if (value === undefined) throw new Error('识别对象无法转换成可编辑的天花模型。');
    return JSON.stringify(value) === JSON.stringify(previous) ? [] : [{...row, value}];
  });
  result.items.push(...removals);
  return result;
}
