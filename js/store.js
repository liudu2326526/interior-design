/* 当前方案、状态、存储与撤销历史。
 * 依赖 App.core、App.plan、App.geom、App.draw2d。
 */
(() => {
  'use strict';
  const App = globalThis.App;

  const PLAN_KEY = 'interior-plan-v1' + App.core.projectScope;
  const STATE_KEY = 'interior-state-v1' + App.core.projectScope;
  const RENDERS_KEY = 'interior-renders-v1' + App.core.projectScope;   // 效果图记录单独存：撤销家具 / 方案时不连带回退
  let PLAN = null;
  let WALLS = [], WINS = [], DOORS = [], SLIDES = [], ROOMS = [], MATS = {};
  let BOUNDS = App.plan.FALLBACK_PLAN.bounds;
  let planRev = 0;                     // 每次换方案 +1：3D 用它判断顶层几何要不要重建
  // PLAN 各字段同步成模块级别名；planRev 变化会让 3D 顶层重建
  function installPlan(plan){
    PLAN = plan; planRev++;
    WALLS = plan.walls.map(w => {
      if (Array.isArray(w)) return w;
      const curve = App.geom.curvedSpan(w);
      return [...App.geom.curveBounds(curve), w.kind, w.height, curve];
    });
    WINS = plan.wins.map(w => {
      if (Array.isArray(w)) return w;
      const curve = App.geom.curvedSpan(w);
      return [...App.geom.curveBounds(curve), curve];
    });
    DOORS = plan.doors; SLIDES = plan.slides;
    ROOMS = plan.rooms.map(r => r.arcs?.length ? {...r, vertices:r.poly, poly:App.geom.roomOutline(r)} : r);
    MATS = plan.materials; BOUNDS = plan.bounds;
    App.geom.clearMaterialPatterns();
  }

  function readStoredPlan(){
    try {
      const raw = localStorage.getItem(PLAN_KEY);
      if (!raw) return null;
      const res = App.plan.sanitizePlan(JSON.parse(raw));
      return res.ok ? res.plan : null;
    } catch(e){ return null; }
  }


  // 房间的当前状态（名称 / 地面），缺失时按 Plan 补上
  function roomState(id){
    const def = App.plan.roomDef(id);
    let st = state.rooms[id];
    if (!st || typeof st !== 'object') st = state.rooms[id] = {name: def ? def.name : String(id), mat: App.plan.matKey(def && def.mat)};
    if (!MATS[st.mat]) st.mat = App.plan.matKey(def && def.mat);
    return st;
  }
  // 换方案后按新 ROOMS 重建 state.rooms：房间名与地面尽量沿用，消失的房间丢弃
  function reconcileRooms(old){
    const src = old && typeof old === 'object' ? old : {}, out = {};
    ROOMS.forEach(r => { const o = src[r.id] || {}; out[r.id] = {name: String(o.name || r.name), mat: App.plan.matKey(o.mat || r.mat)}; });
    return out;
  }
  function defaultState(){
    return {furniture:[], rooms:reconcileRooms({}), demolished:[], measures:[], dimensionMarks:[], walk:{recent:[], views:[]}};
  }
  function normalizeWalk(walk){
    const pose = item => {
      if (!item || ![item.x, item.y, item.height, item.yaw, item.pitch].every(Number.isFinite) ||
          Math.max(Math.abs(item.x), Math.abs(item.y)) > 1e8 || item.height < .3 || item.height > 3 ||
          Math.abs(item.yaw) > Math.PI + .001 || Math.abs(item.pitch) > Math.PI/2 + .001) return null;
      const {x, y, height, yaw, pitch} = item;
      const roomId = typeof item.roomId === 'string' && item.roomId ? item.roomId.slice(0, 120) : null;
      return {x, y, height, yaw, pitch, roomId};
    };
    const recent = [], views = [], scopes = new Set(), ids = new Set();
    for (const item of (Array.isArray(walk?.recent) ? walk.recent : []).slice(0, 30)){
      const point = pose(item);
      if (!point || scopes.has(point.roomId)) continue;
      scopes.add(point.roomId); recent.push(point);
    }
    for (const item of (Array.isArray(walk?.views) ? walk.views : []).slice(0, 30)){
      const point = pose(item?.pose);
      const name = typeof item?.name === 'string' ? item.name.trim().slice(0, 60) : '';
      const id = typeof item?.id === 'string' ? item.id.slice(0,120) : '';
      if (!point || !name || !id || ids.has(id)) continue;
      const view = {id, name, pose:point};
      if (Number.isFinite(item.scene?.hour) && typeof item.scene.night === 'boolean' && typeof item.scene.furn === 'boolean'){
        view.scene = {hour:Math.max(7, Math.min(18, item.scene.hour)), night:item.scene.night, furn:item.scene.furn};
      }
      ids.add(id); views.push(view);
    }
    return {recent, views};
  }
  function readRenders(){
    try {
      const list = JSON.parse(localStorage.getItem(RENDERS_KEY) || '[]');
      return Array.isArray(list) ? list.filter(r => r && typeof r.url === 'string') : [];
    } catch(e){ return []; }
  }
  function fixState(s){
    s = (s && typeof s === 'object') ? s : {};
    s.furniture = (Array.isArray(s.furniture) ? s.furniture : []).map(App.geom.normalizeFurn).filter(Boolean);
    s.rooms = reconcileRooms(s.rooms);
    s.demolished = (Array.isArray(s.demolished) ? s.demolished : []).map(String).filter(App.plan.validWallId);
    s.measures = (Array.isArray(s.measures) ? s.measures : []).filter(m => m && m.a && m.b && [m.a.x, m.a.y, m.b.x, m.b.y].every(Number.isFinite));
    s.dimensionMarks = App.dimensions.normalizeMarks(s.dimensionMarks);
    s.walk = normalizeWalk(s.walk);
    s.renders = (Array.isArray(s.renders) ? s.renders : readRenders()).filter(r => r && typeof r.url === 'string').slice(-30);
    return s;
  }
  function load(){
    try { const s = JSON.parse(localStorage.getItem(STATE_KEY)); if (s && Array.isArray(s.furniture)) return fixState(s); } catch(e) {}
    return null;
  }

  /* ======================= 状态 / 历史 / 存储 ======================= */
  let state;
  const ui = {tool:'select', sel:null, mA:null, mCur:null,
    layers:{dims:true, labels:true, furn:true, grid:false, bearing:false, wallSnap:true}};
  const view = {x0:0, y0:0, s:.06};
  const undoStack = [], redoStack = [];
  let onProjectSave = () => {};

  // 方案与状态一起存：撤销一步也能连户型一起回退
  function save(){
    try {
      localStorage.setItem(PLAN_KEY, JSON.stringify(PLAN));
      const {renders, ...rest} = state;            // 效果图记录单独存，撤销不连带回退
      localStorage.setItem(STATE_KEY, JSON.stringify(rest));
      localStorage.setItem(RENDERS_KEY, JSON.stringify(renders || []));
    } catch(e) {}
    onProjectSave();
  }
  const snap = () => JSON.stringify({plan: PLAN, state: {...state, renders: undefined, walk: undefined}});
  function restore(snapshot){
    let o; try { o = JSON.parse(snapshot); } catch(e){ return; }
    if (o && o.plan && o.state){ const r = App.plan.sanitizePlan(o.plan); if (r.ok) installPlan(r.plan); state = fixState({...o.state, renders: state.renders, walk:state.walk}); }
    else if (o && Array.isArray(o.furniture)) state = fixState({...o, renders: state.renders, walk:state.walk});   // 兼容旧格式快照
  }
  function commit(before){ undoStack.push(before); if (undoStack.length > 150) undoStack.shift(); redoStack.length = 0; save(); }
  function mutate(fn){ const b = snap(); fn(); commit(b); App.draw2d.renderAll(); }
  // 撤销 / 重做 / 换方案后：除状态外，材质图案、尺寸标注、门窗也都可能变
  function afterHistory(){ validateSel(); App.geom.buildDefs(); App.draw2d.renderDims(); App.draw2d.renderOpenings(); save(); App.draw2d.renderAll(); }
  function undo(){ if (!undoStack.length) return App.core.toast(App.core.tr('没有可撤销的操作', 'Nothing to undo')); redoStack.push(snap()); restore(undoStack.pop()); afterHistory(); }
  function redo(){ if (!redoStack.length) return; undoStack.push(snap()); restore(redoStack.pop()); afterHistory(); }
  function selOk(sel){
    if (!sel || !sel.kind) return false;
    if (sel.kind === 'furn') return !!getF(sel.id);
    if (sel.kind === 'room') return !!App.plan.roomDef(sel.id);
    if (sel.kind === 'wall') return !!App.plan.wallOf(sel.id);
    return false;
  }
  function validateSel(){ if (ui.sel && !selOk(ui.sel)) ui.sel = null; }
  const getF = id => state.furniture.find(f => f.id === id);

  Object.assign(App.store, {
    PLAN_KEY, installPlan, roomState, defaultState, fixState, ui, view, undoStack, redoStack, save, snap,
    commit, mutate, afterHistory, undo, redo, selOk, validateSel, getF,
  });
  Object.defineProperties(App.store, {
    PLAN: {get: () => PLAN},
    WALLS: {get: () => WALLS},
    WINS: {get: () => WINS},
    DOORS: {get: () => DOORS},
    SLIDES: {get: () => SLIDES},
    ROOMS: {get: () => ROOMS},
    MATS: {get: () => MATS},
    BOUNDS: {get: () => BOUNDS},
    planRev: {get: () => planRev},
    state: {get: () => state, set: value => { state = value; }},
    onProjectSave: {get: () => onProjectSave, set: value => { onProjectSave = value; }},
  });

  // 先公开当前方案的读取接口，状态恢复时才能按当前的墙体和材质校对旧数据。
  installPlan(readStoredPlan() || App.plan.sanitizePlan(App.plan.FALLBACK_PLAN).plan);
  state = load() || fixState(defaultState());
})();
