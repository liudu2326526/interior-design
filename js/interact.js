/* 平面视图、指针交互、快捷键和家具库。
 * 依赖 App.core、App.store、App.geom、App.plan、App.draw2d、App.panel、App.io。
 */
(() => {
  'use strict';
  const App = globalThis.App;

  /* ======================= 操作 ======================= */
  const mounted = item => Boolean(App.ceilingFurniture?.is(item));
  function placementHint(){
    App.core.toast(App.core.tr('顶装家具的完整轮廓需落在可安装的顶面内', 'The full item needs to fit on a valid ceiling surface'));
  }
  function select(sel){
    App.store.ui.sel = App.store.selOk(sel) ? {kind:sel.kind, id:sel.id} : null;
    App.store.ui.dimensionRoomPoint = App.store.ui.sel?.kind === 'room' ? sel.point : null;
    if(App.store.ui.sel?.kind==='furn'){
      const f=App.store.getF(sel.id);
      if(mounted(f)) App.ceilingEditor?.selectFurniture(f);
    }
    App.draw2d.renderSel(); App.panel.renderPanel();
  }
  function updateFurniture(item,patch){
    const candidate={...item,...patch};
    const placed=mounted(candidate)?App.ceilingFurniture.placeEdited(candidate):candidate;
    if (!placed){ placementHint(); App.panel.renderPanel(); return false; }
    App.store.mutate(()=>Object.assign(item,placed));
    if(mounted(placed)&&App.ceilingEditor?.active()) select({kind:'furn',id:item.id});
    return true;
  }
  function rotateSel(d){
    const f=App.store.ui.sel?.kind==='furn' && App.store.getF(App.store.ui.sel.id);
    if(f)updateFurniture(f,{rot:App.geom.norm(f.rot+d)});
  }
  function deleteSel(){ if (App.store.ui.sel?.kind==='furn'){ const id = App.store.ui.sel.id; App.store.ui.sel = null; App.store.mutate(() => App.store.state.furniture = App.store.state.furniture.filter(f => f.id !== id)); } }
  function duplicateSel(){
    if (App.store.ui.sel?.kind !== 'furn') return;
    const f = App.store.getF(App.store.ui.sel.id), n = {...f, id:App.geom.uid(), cx:f.cx+200, cy:f.cy+200};
    const copy = mounted(n) ? (App.ceilingFurniture.placeEdited(n) || App.ceilingFurniture.placeEdited({...n,cx:f.cx,cy:f.cy})) : n;
    if(!copy){placementHint();return;}
    App.store.ui.sel = {kind:'furn', id:copy.id}; App.store.mutate(() => App.store.state.furniture.push(copy));
    if(mounted(copy))select({kind:'furn',id:copy.id});
    reportPlacement(copy);
  }
  // 新放下的家具若压在墙 / 窗上，沿穿透较浅的方向推出来，刚好贴墙
  function pushOut(f){
    for (let n = 0; n < 4; n++){
      let moved = false;
      for (const r of App.geom.snapRects()){
        const {hw, hh} = App.geom.aabb(f), ox = Math.min(f.cx+hw, r[2]) - Math.max(f.cx-hw, r[0]), oy = Math.min(f.cy+hh, r[3]) - Math.max(f.cy-hh, r[1]);
        if (ox <= 0 || oy <= 0) continue;
        if (ox < oy) f.cx = f.cx < (r[0]+r[2])/2 ? r[0]-hw : r[2]+hw;
        else f.cy = f.cy < (r[1]+r[3])/2 ? r[1]-hh : r[3]+hh;
        moved = true;
      }
      if (!moved) return;
    }
  }
  function samePlane(f, other){
    const top = mounted(f);
    return top === mounted(other) && (!top ||
      f.ceiling?.roomId === other.ceiling?.roomId && f.ceiling?.zoneId === other.ceiling?.zoneId);
  }
  function samePlacement(f, other){
    return f.id !== other.id && samePlane(f, other) && f.type === other.type && f.w === other.w && f.d === other.d &&
      f.rot % 180 === other.rot % 180 && Math.hypot(f.cx - other.cx, f.cy - other.cy) < 1;
  }
  function insideFloor(f, rooms = App.store.ROOMS){
    if (!rooms.length) return true;
    const a = f.rot * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    // Inset samples slightly so a footprint placed flush on a room edge still fits.
    const w = Math.max(0, f.w / 2 - 2), d = Math.max(0, f.d / 2 - 2);
    const top = App.geom.tableTopType(f.type) && App.geom.tableTopShape(f);
    const samples = f.type === 'roundtable' || top === 'round' || top === 'oval'
      ? Array.from({length:8}, (_, i) => [w * Math.cos(i * Math.PI / 4), d * Math.sin(i * Math.PI / 4)])
      : [[-w,-d], [0,-d], [w,-d], [w,0], [w,d], [0,d], [-w,d], [-w,0]];
    return [[0, 0], ...samples].every(([u,v]) => rooms.some(room =>
      App.assistant.pointInPoly(f.cx + u*c - v*s, f.cy + u*s + v*c, room.poly)));
  }
  function furnitureWarnings(f){
    const { tr } = App.core, notes = [];
    const { w, h } = App.store.BOUNDS;
    if (Math.max(f.w, f.d) > Math.max(10000, w, h)){
      notes.push(tr('家具尺寸很大，请核对毫米单位', 'This item is unusually large. Check the dimensions in millimetres.'));
    }
    if (!mounted(f) && !insideFloor(f)){
      notes.push(tr('家具占地可能超出已绘制区域', 'Part of this footprint may be outside the drawn area.'));
    }
    if (App.store.state.furniture.some(other => samePlacement(f, other))){
      notes.push(tr('这里有一件同样的家具完全重叠', 'An identical item overlaps this one.'));
    }
    return notes;
  }
  function reportPlacement(f, message){
    const notes = furnitureWarnings(f);
    if (message || notes.length) App.core.toast([message, ...notes].filter(Boolean).join(' · '));
  }
  function separateRepeatedPlacement(f, room){
    const items = App.store.state.furniture.filter(other => samePlane(f, other));
    if (!items.some(other => samePlacement(f, other))) return false;
    const top = mounted(f);
    const { hw, hh } = App.geom.aabb(f);
    const x = hw*2 + 100, y = hh*2 + 100;
    const spots = [[x,0],[-x,0],[0,y],[0,-y],[x,y],[x,-y],[-x,y],[-x,-y]];
    for (const [dx,dy] of spots){
      let next = {...f, cx:f.cx+dx, cy:f.cy+dy};
      if (top){
        next = App.ceilingFurniture.placeEdited(next);
        if (!next || !samePlane(f, next)) continue;
      } else {
        pushOut(next);
        if (!insideFloor(next, room ? [room] : undefined)) continue;
      }
      const overlaps = items.some(other => {
        const size = App.geom.aabb(other);
        return Math.abs(next.cx-other.cx) < hw+size.hw && Math.abs(next.cy-other.cy) < hh+size.hh;
      });
      if (!overlaps){
        f.cx = next.cx; f.cy = next.cy;
        return true;
      }
    }
    return false;
  }
  function addItem(entry, x, y, { automatic = false, room, surface } = {}){
    const cx = Math.round(x/10)*10, cy = Math.round(y/10)*10;
    let f = App.geom.placeCatalogItem(entry, cx, cy);
    if (!f) return null;
    if (mounted(f)){
      if (App.store.ui.ceilingPreview){
        App.core.toast(App.core.tr('先应用或取消天花预览，再摆放家具', 'Apply or cancel the ceiling preview before placing furniture'));
        return null;
      }
      if (surface?.roomId) f.ceiling = {...f.ceiling, roomId:surface.roomId, ...(surface.zoneId ? {zoneId:surface.zoneId} : {})};
      f = App.ceilingFurniture.placeEdited(f, {snap:true});
      if (!f){ placementHint(); return null; }
    } else {
      pushOut(f);
    }
    const moved = automatic && separateRepeatedPlacement(f, room);
    App.store.ui.sel = {kind:'furn', id:f.id};
    const {type, name, w, d} = f;
    App.store.mutate(() => type === 'rug' ? App.store.state.furniture.unshift(f) : App.store.state.furniture.push(f));
    if (mounted(f)) select({kind:'furn', id:f.id});
    const message = App.core.tr(`已添加「${name}」${w}×${d}`, `Added "${App.core.nm(name)}" ${w}×${d}`);
    reportPlacement(f, moved ? message + App.core.tr(' · 已避开重叠', ' · Moved to avoid overlap') : message);
    return f;
  }
  function toggleWall(id){
    const w = App.plan.wallOf(id);
    if (!w) return App.core.toast(App.core.tr('墙体不存在', 'Wall not found'));
    if (w[4]==='b') return App.core.toast(App.core.tr('承重墙（黑色）不可拆除', 'Load-bearing walls (black) cannot be removed'));
    if (w[4]==='e') return App.core.toast(App.core.tr('外墙属于建筑外围护结构，不建议拆除', 'Exterior walls are part of the building envelope and should not be removed'));
    const on = App.store.state.demolished.includes(id);
    App.store.mutate(() => App.store.state.demolished = on ? App.store.state.demolished.filter(x => x!==id) : [...App.store.state.demolished, id]);
    const length = Math.round(App.geom.wallLength(w));
    App.core.toast(on ? App.core.tr('已恢复墙体', 'Wall restored') : App.core.tr(`已标记拆除 ${length} mm 墙体`, `Marked ${length} mm of wall for removal`));
  }

  function setTool(t){
    App.dimensions.toggleTool(t === 'dimension');
    App.store.ui.tool = t; App.store.ui.mA = null; App.store.ui.mCur = null;
    App.core.svg.setAttribute('class', 'tool-' + t);
    document.querySelectorAll('#tools .btn').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
    syncModeHint();
    App.draw2d.renderMeasure();
  }
  function syncModeHint(){
    const hints = {select:'',
      measure:App.core.COARSE ? App.core.tr('按住拖出测量线，或依次点两点 · 靠近墙面自动吸附 · 点「选择」退出', 'Hold and drag a line, or tap two points · snaps to walls · tap "Select" to exit')
        : App.core.tr('点击两点（或按住拖动）测量距离 · 靠近墙面自动吸附 · Shift 锁定水平/垂直 · Esc 取消', 'Click two points (or drag) to measure · snaps to walls · Shift locks horizontal/vertical · Esc cancels'),
      demolish:App.core.tr('点击灰色非承重墙标记拆除，再次点击恢复 · 黑色承重墙不可拆', 'Click a grey non-bearing wall to remove it, click again to restore · black bearing walls cannot be removed'),
      dimension:App.core.tr('依次点两处墙面或房间边缘，添加水平或竖直尺寸 · Esc 退出', 'Pick two wall faces or room edges to add a horizontal or vertical dimension · Esc to exit')};
    const h = App.core.$('#modehint'); h.textContent = hints[App.store.ui.tool]; h.classList.toggle('show', !!hints[App.store.ui.tool]);
  }

  /* ======================= 视图 ======================= */
  function applyView(){
    const W = App.core.svg.clientWidth, H = App.core.svg.clientHeight;
    App.core.svg.setAttribute('viewBox', `${App.store.view.x0} ${App.store.view.y0} ${W/App.store.view.s} ${H/App.store.view.s}`);
    const ratio = 1/(App.store.view.s*App.core.PX_MM);
    App.core.$('#ratio').textContent = '1:' + Math.round(ratio);
    const nice = [100,200,500,1000,2000,5000].find(v => v*App.store.view.s >= 60) || 5000;
    App.core.$('#sbBar').style.width = nice*App.store.view.s + 'px';
    App.core.$('#sbText').textContent = nice >= 1000 ? `${nice/1000} m` : `${nice} mm`;
    App.draw2d.renderSel(); App.draw2d.renderMeasure(); App.dimensions.updateView(); App.draw2d.resizeMountedSymbols(); App.ceilingEditor?.renderSketch();
  }
  function fitView(){
    const W = App.core.svg.clientWidth, H = App.core.svg.clientHeight;
    if (!W || !H) return;
    const bounds = App.dimensions.frameBounds();
    App.store.view.s = Math.min(W/bounds.w, H/bounds.h);
    App.store.view.x0 = bounds.x - (W/App.store.view.s - bounds.w)/2; App.store.view.y0 = bounds.y - (H/App.store.view.s - bounds.h)/2;
    applyView();
  }
  function zoomAt(ns, mx, my){
    ns = Math.max(.012, Math.min(2, ns));
    const px = App.store.view.x0 + mx/App.store.view.s, py = App.store.view.y0 + my/App.store.view.s;
    App.store.view.s = ns; App.store.view.x0 = px - mx/ns; App.store.view.y0 = py - my/ns; applyView();
  }
  const zoomCenter = k => zoomAt(App.store.view.s*k, App.core.svg.clientWidth/2, App.core.svg.clientHeight/2);
  const setRatio = r => zoomAt(1/(r*App.core.PX_MM), App.core.svg.clientWidth/2, App.core.svg.clientHeight/2);

  function toMM(e){
    const pt = App.core.svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
    return pt.matrixTransform(App.core.svg.getScreenCTM().inverse());
  }

  /* ======================= 吸附 ======================= */
  const grid = () => 10;
  function snapMove(f, cx, cy){
    let nx = Math.round(cx/grid())*grid(), ny = Math.round(cy/grid())*grid();
    if (!App.store.ui.layers.wallSnap) return [nx, ny];
    const {hw, hh} = App.geom.aabb(f), tol = 10/App.store.view.s;
    let bx = tol, by = tol;
    for (const r of App.geom.snapRects()){
      if (!(r[3] < cy-hh-tol || r[1] > cy+hh+tol)) for (const ex of [r[0], r[2]]) for (const c of [ex+hw, ex-hw]) if (Math.abs(c-cx) < bx){ bx = Math.abs(c-cx); nx = c; }
      if (!(r[2] < cx-hw-tol || r[0] > cx+hw+tol)) for (const ey of [r[1], r[3]]) for (const c of [ey+hh, ey-hh]) if (Math.abs(c-cy) < by){ by = Math.abs(c-cy); ny = c; }
    }
    return [nx, ny];
  }
  function snapPoint(p, shift){
    let x = Math.round(p.x/10)*10, y = Math.round(p.y/10)*10;
    const tol = 8/App.store.view.s; let bx = tol, by = tol;
    for (const r of App.geom.snapRects()){
      for (const ex of [r[0], r[2]]) if (Math.abs(ex-p.x) < bx){ bx = Math.abs(ex-p.x); x = ex; }
      for (const ey of [r[1], r[3]]) if (Math.abs(ey-p.y) < by){ by = Math.abs(ey-p.y); y = ey; }
    }
    let curveTolerance = Math.min(bx, by);
    for (const curve of App.geom.snapCurves()) for (const offset of [-curve.thickness / 2, curve.thickness / 2]){
      const [px, py] = App.geom.closestCurvePoint(curve, p.x, p.y, offset);
      const distance = Math.hypot(px - p.x, py - p.y);
      if (distance < curveTolerance){ x = px; y = py; curveTolerance = distance; }
    }
    if (shift && App.store.ui.mA){ if (Math.abs(x-App.store.ui.mA.x) > Math.abs(y-App.store.ui.mA.y)) y = App.store.ui.mA.y; else x = App.store.ui.mA.x; }
    return {x, y};
  }

  /* ======================= 指针交互 ======================= */
  let drag = null, pinch = null;
  const touches = new Map();                     // 当前按在平面图上的手指
  const svgXY = (x, y) => { const r = App.core.svg.getBoundingClientRect(); return [x - r.left, y - r.top]; };
  function pinchInfo(){
    const [a, b] = [...touches.values()];
    return {d:Math.max(1, Math.hypot(b.x-a.x, b.y-a.y)), c:svgXY((a.x+b.x)/2, (a.y+b.y)/2)};
  }
  // 结束当前拖动：移动过的家具记入撤销栈
  function endDrag(cancel){
    const d = drag; drag = null; App.core.svg.classList.remove('panning');
    if (!d) return;
    if (d.kind === 'ceiling'){ App.ceilingEditor.endPointer(d, cancel); return; }
    if (d.kind === 'measure'){
      if (cancel){ App.store.ui.mA = App.store.ui.mCur = null; App.draw2d.renderMeasure(); return; }
      if (d.moved && App.store.ui.mA && App.store.ui.mCur && Math.hypot(App.store.ui.mCur.x-App.store.ui.mA.x, App.store.ui.mCur.y-App.store.ui.mA.y) > 20){
        const a = App.store.ui.mA, b = App.store.ui.mCur; App.store.ui.mA = App.store.ui.mCur = null; App.store.mutate(() => App.store.state.measures.push({a, b}));
      }
      App.draw2d.renderMeasure(); return;                   // 没拖动：保留起点，等第二次点击
    }
    if (d.kind === 'pan'){
      if (!cancel && !d.moved && App.store.ui.tool === 'select') select(d.room ? {kind:'room', id:d.room, point:d.roomPoint} : null);
      return;
    }
    if (d.kind === 'dimension'){
      if (!cancel && !d.moved) App.dimensions.addPoint(d.point);
      return;
    }
    if(cancel && d.original){
      const item=App.store.getF(d.id);
      if(item)Object.assign(item,d.original);
      App.draw2d.renderAll();return;
    }
    if (d.moved){
      App.store.commit(d.before); App.draw2d.renderAll();
      const f=App.store.getF(d.id);
      if(mounted(f)&&App.ceilingEditor?.active())select({kind:'furn',id:f.id});
      if (!cancel && !d.invalid && f) reportPlacement(f);
    }
    if (!cancel && d.invalid) placementHint();
  }

  App.core.svg.addEventListener('pointerdown', e => {
    if (e.button === 1 || e.button === 2 || e.target.closest('[data-dim-mark]')) return;
    App.panel.closeDrawers(); App.core.$('details.menu').open = false;
    if (e.pointerType !== 'mouse'){
      touches.set(e.pointerId, {x:e.clientX, y:e.clientY});
      App.core.svg.setPointerCapture(e.pointerId);
      if (touches.size >= 2){                    // 第二根手指落下：取消单指操作，进入双指缩放 / 平移
        endDrag(!!drag?.original || ['measure','pan','dimension','ceiling'].includes(drag?.kind));
        const {d, c} = pinchInfo();
        pinch = {d, c, s:App.store.view.s, px:App.store.view.x0 + c[0]/App.store.view.s, py:App.store.view.y0 + c[1]/App.store.view.s};
        return;
      }
    }
    if (pinch) return;
    const p = toMM(e), t = e.target;
    const handle=t.closest('[data-handle]'), hit=t.closest('[data-fid]');
    const editingMounted=App.ceilingEditor?.context()?.tool==='select' &&
      !App.store.ui.ceilingPreview && mounted(App.store.getF(hit?.dataset.fid || (handle && App.store.ui.sel?.id)));
    if (App.ceilingEditor?.active() && !editingMounted){
      drag = App.ceilingEditor.startPointer(e, p);
      App.core.svg.setPointerCapture(e.pointerId);
      return;
    }
    if (App.store.ui.tool === 'dimension'){
      drag = {kind:'dimension', point:[p.x,p.y], sx:e.clientX, sy:e.clientY, moved:false};
      App.core.svg.setPointerCapture(e.pointerId);
      return;
    }
    if (App.store.ui.tool === 'measure'){
      const q = snapPoint(p, e.shiftKey);
      if (!App.store.ui.mA){ App.store.ui.mA = q; App.store.ui.mCur = q; drag = {kind:'measure', sx:e.clientX, sy:e.clientY, moved:false}; App.core.svg.setPointerCapture(e.pointerId); }
      else { const a = App.store.ui.mA; App.store.ui.mA = null; App.store.ui.mCur = null; if (Math.hypot(q.x-a.x, q.y-a.y) > 20) App.store.mutate(() => App.store.state.measures.push({a, b:q})); }
      App.draw2d.renderMeasure(); return;
    }
    const h = handle;
    if (h && App.store.ui.sel?.kind === 'furn'){
      drag = {kind:h.dataset.handle, id:App.store.ui.sel.id, sx:e.clientX, sy:e.clientY, start:p, before:App.store.snap(), moved:false};
    } else if (App.store.ui.tool === 'demolish' && t.closest('[data-wall]')){
      toggleWall(t.closest('[data-wall]').dataset.wall); return;
    } else if (App.store.ui.tool === 'select' && t.closest('[data-fid]')){
      const f = App.store.getF(t.closest('[data-fid]').dataset.fid);
      if (App.store.ui.sel?.id !== f.id) select({kind:'furn', id:f.id});
      drag = {kind:'move', id:f.id, sx:e.clientX, sy:e.clientY, ox:p.x-f.cx, oy:p.y-f.cy, before:App.store.snap(), moved:false};
    } else {
      const room = t.closest('[data-room]');
      drag = {kind:'pan', sx:e.clientX, sy:e.clientY, x0:App.store.view.x0, y0:App.store.view.y0, room:room && room.dataset.room, roomPoint:[p.x,p.y], moved:false};
    }
    if(drag?.id){
      const f=App.store.getF(drag.id);
      if(mounted(f))drag.original={...f,ceiling:{...f.ceiling}};
    }
    App.core.svg.setPointerCapture(e.pointerId);
  });

  App.core.svg.addEventListener('pointermove', e => {
    if (touches.has(e.pointerId)) touches.set(e.pointerId, {x:e.clientX, y:e.clientY});
    if (pinch){
      if (touches.size < 2) return;
      const {d, c} = pinchInfo(), ns = Math.max(.012, Math.min(2, pinch.s * d / pinch.d));
      App.store.view.s = ns; App.store.view.x0 = pinch.px - c[0]/ns; App.store.view.y0 = pinch.py - c[1]/ns; applyView();
      return;
    }
    const p = toMM(e);
    App.core.$('#cx').textContent = Math.round(p.x) + ' mm'; App.core.$('#cy').textContent = Math.round(p.y) + ' mm';
    if (!drag){
      if (App.ceilingEditor?.active()){ App.ceilingEditor.hover(p); return; }
      const room = e.target.closest && e.target.closest('[data-room]'), def = room && App.plan.roomDef(room.dataset.room);
      App.core.$('#hover').innerHTML = def ? `<b>${App.core.esc(App.core.nm(App.store.roomState(def.id).name))}</b> ${App.geom.fmt(App.geom.roomArea(def))} m²` : '';
      if (App.store.ui.tool === 'measure' && App.store.ui.mA){ App.store.ui.mCur = snapPoint(p, e.shiftKey); App.draw2d.renderMeasure(); }
      if (App.store.ui.tool === 'dimension') App.dimensions.preview([p.x,p.y]);
      return;
    }
    const far = Math.hypot(e.clientX-drag.sx, e.clientY-drag.sy) >= App.core.TAP;
    if (drag.kind === 'ceiling'){ App.ceilingEditor.movePointer(drag,e,p,far); return; }
    if (drag.kind === 'measure'){
      if (far) drag.moved = true;
      App.store.ui.mCur = snapPoint(p, e.shiftKey); App.draw2d.renderMeasure(); return;
    }
    if (drag.kind === 'dimension'){
      if (far) drag.moved = true;
      App.dimensions.preview([p.x,p.y]);
      return;
    }
    if (drag.kind === 'pan'){
      if (!drag.moved && !far) return;
      drag.moved = true; App.core.svg.classList.add('panning');
      App.store.view.x0 = drag.x0 - (e.clientX-drag.sx)/App.store.view.s; App.store.view.y0 = drag.y0 - (e.clientY-drag.sy)/App.store.view.s; applyView(); return;
    }
    const target = App.store.getF(drag.id); if (!target) return;
    if (!drag.moved && !far) return;             // 轻点家具不应让它抖动一下
    const f=drag.original?{...target}:target;
    if (drag.kind === 'move'){
      if (drag.original){
        f.cx = p.x - drag.ox;
        f.cy = p.y - drag.oy;
      } else {
        [f.cx, f.cy] = snapMove(f, p.x-drag.ox, p.y-drag.oy);
      }
    } else if (drag.kind === 'rot'){
      let a = Math.atan2(p.y-f.cy, p.x-f.cx)*180/Math.PI + 90;
      f.rot = App.geom.norm(e.shiftKey ? a : Math.round(a/15)*15);
    } else if (drag.kind === 'size'){
      const a=f.rot*Math.PI/180, c=Math.cos(a), s=Math.sin(a);
      if(drag.original){
        const from=drag.original, dx=p.x-drag.start.x, dy=p.y-drag.start.y;
        const quantize=(initial,delta)=>Math.max(1,Math.min(30000,initial+Math.round(delta/10)*10));
        f.w=quantize(from.w,dx*c+dy*s);f.d=quantize(from.d,-dx*s+dy*c);
        const mx=(f.w-from.w)/2,my=(f.d-from.d)/2;
        f.cx=from.cx+mx*c-my*s;f.cy=from.cy+mx*s+my*c;
      }else{
        const dx=p.x-f.cx,dy=p.y-f.cy,lx=dx*c+dy*s,ly=-dx*s+dy*c;
        const ax=-f.w/2,ay=-f.d/2;
        const nw=Math.max(100,Math.round((lx-ax)/10)*10),nd=Math.max(100,Math.round((ly-ay)/10)*10);
        const mx=ax+nw/2,my=ay+nd/2;
        f.cx+=mx*c-my*s;f.cy+=mx*s+my*c;f.w=nw;f.d=nd;
      }
    }
    if(drag.original){
      const placed = App.ceilingFurniture.placeEdited(f, {snap:drag.kind === 'move'});
      drag.invalid = !placed;
      if(!placed)return;
      Object.assign(target,placed);
    }
    drag.moved = true;
    App.draw2d.renderFurn(); App.draw2d.renderSel();
  });

  function onPointerEnd(e){
    touches.delete(e.pointerId);
    if (pinch){ if (touches.size < 2) pinch = null; return; }   // 双指结束后，剩下的手指不再触发操作
    endDrag(e.type === 'pointercancel');
  }
  App.core.svg.addEventListener('pointerup', onPointerEnd);
  App.core.svg.addEventListener('pointercancel', onPointerEnd);
  App.core.svg.addEventListener('pointerleave', () => { if (App.store.ui.tool === 'dimension') App.dimensions.preview(null); });
  // 阻止 iPad Safari 把双指手势当成整页缩放
  ['gesturestart','gesturechange','gestureend'].forEach(t => document.addEventListener(t, e => e.preventDefault()));

  App.core.svg.addEventListener('wheel', e => {
    e.preventDefault();
    const r = App.core.svg.getBoundingClientRect();
    zoomAt(App.store.view.s*Math.exp(-e.deltaY*(e.ctrlKey ? .01 : .0015)), e.clientX-r.left, e.clientY-r.top);
  }, {passive:false});
  App.core.svg.addEventListener('dblclick', e => { if (App.store.ui.tool==='select' && e.target.closest('[data-fid]')) rotateSel(90); });
  App.core.svg.addEventListener('contextmenu', e => { if (App.store.ui.tool==='measure'){ e.preventDefault(); App.store.ui.mA = null; App.draw2d.renderMeasure(); } });


  /* ======================= 键盘 ======================= */
  document.addEventListener('keydown', e => {
    if (e.defaultPrevented || e.target.closest?.('input,select,textarea,[contenteditable],dialog[open]')) return;
    if (App.view3d?.walking()) return;
    const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
    if (mod && k === 'z'){ e.preventDefault(); e.shiftKey ? App.store.redo() : App.store.undo(); return; }
    if (mod && k === 'y'){ e.preventDefault(); App.store.redo(); return; }
    if (App.ceilingEditor?.active() && App.ceilingEditor.key(e)) return;
    if (mod && k === 'd'){ e.preventDefault(); duplicateSel(); return; }
    if (mod) return;
    if (k === '[' || k === ']'){ App.panel.drawer(k === '[' ? 'lib' : 'panel'); return; }
    if (k === 'f' && e.shiftKey){ App.io.toggleFullscreen(); return; }
    if (k === 't') App.io.setView(App.io.is3D() ? '2d' : '3d');
    else if (App.io.is3D() && ['v','m','d','x','f','+','=','-'].includes(k)) return;
    else if (k === 'v') setTool('select');
    else if (k === 'm') setTool('measure');
    else if (k === 'd') setTool('dimension');
    else if (k === 'x') setTool('demolish');
    else if (k === 'f') fitView();
    else if (k === 'r') rotateSel(e.shiftKey ? -90 : 90);
    else if (k === 'delete' || k === 'backspace'){ e.preventDefault(); deleteSel(); }
    else if (k === 'escape'){
      // 室内视角优先退出：清除裁切、回到鸟瞰；其次才是测量 / 选择
      if (App.view3d?.roomViewing?.()) App.view3d.exitRoom();
      else if (App.store.ui.mA){ App.store.ui.mA = null; App.draw2d.renderMeasure(); }
      else { App.dimensions.closeEditor(); if (App.store.ui.tool !== 'select') setTool('select'); select(null); }
    }
    else if (k.startsWith('arrow') && App.store.ui.sel?.kind === 'furn'){
      e.preventDefault(); const st = e.shiftKey ? 100 : 10;
      const f=App.store.getF(App.store.ui.sel.id), offsets={arrowleft:[-st,0],arrowright:[st,0],arrowup:[0,-st],arrowdown:[0,st]};
      if(f && offsets[k])updateFurniture(f,{cx:f.cx+offsets[k][0],cy:f.cy+offsets[k][1]});
    }
    else if (k === '+' || k === '=') zoomCenter(1.25);
    else if (k === '-') zoomCenter(.8);
  });

  /* ======================= 家具库 ======================= */
  const library = App.core.$('#lib'), librarySearch = App.core.$('#libSearch');
  const categoryMenu = App.core.$('#libCategoryMenu'), groupMenu = App.core.$('#libGroupMenu');
  const categoryCurrent = App.core.$('#libCategoryCurrent'), groupCurrent = App.core.$('#libGroupCurrent');
  const categories = App.core.$('#libCategories'), groups = App.core.$('#libGroups');
  const libraryCards = App.core.$('#libItems');
  let libraryCategory = '', libraryGroup = '', libraryEntries = [];

  const libraryMenus = [categoryMenu, groupMenu].filter(Boolean);
  const LIB_MENUS_KEY = 'huxing-lib-menus';
  try {
    const open = JSON.parse(localStorage.getItem(LIB_MENUS_KEY));
    for (const menu of libraryMenus) if (open?.[menu.id] === false) menu.open = false;
  } catch(e) {}
  for (const menu of libraryMenus) menu.addEventListener('toggle', () => {
    try {
      const open = Object.fromEntries(libraryMenus.map(item => [item.id, item.open]));
      localStorage.setItem(LIB_MENUS_KEY, JSON.stringify(open));
    } catch(e) {}
  });

  function libraryShape(details){
    const {type,w,d,color} = details;
    return type === 'component' ? App.geom.componentSVG(details) : App.geom.furnSVG(type, w, d, color, details);
  }

  function libraryFilter(kind, id, name, selected){
    return `<button type="button" class="btn${selected ? ' on' : ''}" data-lib-${kind}="${App.core.esc(id)}" aria-controls="libItems" aria-pressed="${selected}">${App.core.esc(name)}</button>`;
  }

  function buildLib(){
    const { $, esc, nm, tr } = App.core;
    const assets = App.customFurniture?.list?.() || [];
    const catalog = [...App.geom.FURNITURE_CATALOG, {id:'my-assets',name:'我的素材',en:'My assets',
      groups:[{id:'assets',name:'素材',en:'Assets',items:assets}]}];
    const category = catalog.find(item => item.id === libraryCategory) || catalog[0];
    const selectedGroup = category.groups.find(group => group.id === libraryGroup);
    libraryCategory = category.id;
    if (!selectedGroup) libraryGroup = '';
    const query = librarySearch.value.normalize('NFKC').toLowerCase().match(/\S+/gu) || [];
    const active = document.activeElement?.dataset;
    librarySearch.placeholder = tr('搜索全部家具', 'Search all furniture');
    librarySearch.setAttribute('aria-label', librarySearch.placeholder);
    categories.setAttribute('aria-label', tr('家具大类', 'Furniture categories'));
    groups.setAttribute('aria-label', tr('家具子类', 'Furniture subcategories'));
    if (categoryCurrent) categoryCurrent.textContent = query.length ? '' : tr(category.name, category.en);
    if (groupCurrent) groupCurrent.textContent = selectedGroup ? tr(selectedGroup.name, selectedGroup.en) : tr('全部', 'All');
    categories.innerHTML = catalog.map(item =>
      libraryFilter('category', item.id, tr(item.name, item.en), !query.length && item.id === libraryCategory)).join('');
    // Whether subcategories apply is separate from whether the user prefers to see their panel.
    const hideGroups = query.length > 0 || category.groups.length <= 1;
    if (groupMenu) groupMenu.hidden = hideGroups;
    else groups.hidden = hideGroups;
    groups.innerHTML = hideGroups ? '' : libraryFilter('group', '', tr('全部', 'All'), !libraryGroup) +
      category.groups.map(group => libraryFilter('group', group.id, tr(group.name, group.en), group.id === libraryGroup)).join('');

    libraryEntries = [];
    for (const item of query.length ? catalog : [category]){
      for (const group of item.groups){
        if (!query.length && libraryGroup && group.id !== libraryGroup) continue;
        for (const entry of group.items){
          const detail = App.geom.catalogItemDetails(entry);
          if (!detail) continue;
          const name = Array.isArray(entry) ? tr(detail.name, detail.en || nm(detail.name)) : detail.name;
          const matches = [detail.name, detail.en, name, detail.type, item.name, item.en, group.name, group.en]
            .join(' ').normalize('NFKC').toLowerCase();
          if (query.every(word => matches.includes(word))) libraryEntries.push({entry, detail, name});
        }
      }
    }
    const description = $('#libStatus');
    description.textContent = query.length ? tr(`搜索结果 · ${libraryEntries.length} 件`, `Search results · ${libraryEntries.length}`) : '';
    $('#libHint').hidden = !libraryEntries.length;
    if (libraryEntries.length){
      const hint = esc(tr('点击添加，或拖到平面图中摆放', 'Click to add, or drag to a position on the plan'));
      libraryCards.innerHTML = `<div class="lib-grid">${libraryEntries.map(({detail, name}, i) => {
        const {w,d} = detail, pad = Math.max(w,d)*.08;
        return `<button class="item" type="button" data-key="${i}" title="${hint}">
          ${mounted(detail)?App.ceilingEditor.toolThumbnail(detail.type):`<svg viewBox="${-w/2-pad} ${-d/2-pad} ${w+2*pad} ${d+2*pad}" aria-hidden="true">${libraryShape(detail)}</svg>`}
          <b>${esc(name)}</b><small>${w}×${d} mm</small></button>`;
      }).join('')}</div>`;
    } else {
      const emptyAssets = !query.length && category.id === 'my-assets';
      const message = emptyAssets ? tr('还没有保存的素材。', 'No saved assets yet.') : tr('没有找到家具。', 'No matching furniture.');
      const create = emptyAssets && App.core.PUBLIC_ACCESS !== 'guest' && App.assistant.startFurnitureCreation
        ? `<button class="btn chip" id="libCreateAsset" type="button">${tr('在助手创建', 'Create with Assistant')}</button>` : '';
      libraryCards.innerHTML = `<div class="lib-empty"><p>${message}</p>${create}</div>`;
    }
    if (active?.libCategory !== undefined) categories.querySelector(`[data-lib-category="${CSS.escape(active.libCategory)}"]`)?.focus({preventScroll:true});
    if (active?.libGroup !== undefined) groups.querySelector(`[data-lib-group="${CSS.escape(active.libGroup)}"]`)?.focus({preventScroll:true});
  }

  function openCeilingLibrary(){
    libraryCategory='ceiling';libraryGroup='';librarySearch.value='';
    buildLib();App.panel.drawer('lib',true);
    library.scrollIntoView({block:'start'});
    const focus = categoryMenu?.open === false ? App.core.$('#libCategoryToggle') : categories.querySelector('[data-lib-category="ceiling"]');
    focus?.focus({preventScroll:true});
  }
  librarySearch.addEventListener('input', buildLib);
  library.addEventListener('click', e => {
    const button = e.target.closest('button');
    if (!button) return;
    if (button.dataset.libCategory !== undefined){
      libraryCategory = button.dataset.libCategory;
      libraryGroup = ''; librarySearch.value = '';
      buildLib();
    } else if (button.dataset.libGroup !== undefined){
      libraryGroup = button.dataset.libGroup;
      buildLib();
    } else if (button.id === 'libCreateAsset') {
      App.assistant.startFurnitureCreation?.();
    } else if (e.detail === 0 && button.dataset.key !== undefined) {
      // 指针轻点已在 pointerup 放置，保留按钮的键盘和辅助技术激活。
      placeLibraryAsset(libraryEntries[Number(button.dataset.key)]?.entry);
    }
  });

  // 家具库拖放：用 pointer 事件实现（iPad 上 HTML5 拖放不可靠）。
  // 列表设置了 touch-action:pan-y，竖向滑动交给浏览器滚动（会触发 pointercancel），横向拖动才开始拖放。
  let libDrag = null;
  library.addEventListener('pointerdown', e => {
    const el = e.target.closest('.item[data-key]');
    if (!el || e.button || libDrag) return;
    const item = libraryEntries[Number(el.dataset.key)];
    if (item) libDrag = {el, entry:item.entry, detail:item.detail, id:e.pointerId, sx:e.clientX, sy:e.clientY, ghost:null};
  });
  // 屏幕坐标 → 户型坐标（mm）。室内视角读实际安装面，鸟瞰取地面投影。
  function dropPoint(x, y, item){
    const r = App.core.$('#stage').getBoundingClientRect();
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) return null;
    if (document.elementFromPoint(x, y)?.closest('aside.open,#fab,#walkOverlay,#joy,#walkExit')) return null;
    if (App.io.is3D()){
      const surface=mounted(item) && App.view3d?.ceilingAt?.(x,y);
      return surface || App.view3d?.groundAt(x,y) || null;
    }
    const p = toMM({clientX:x, clientY:y}); return {x:p.x, y:p.y, s:App.store.view.s};
  }
  addEventListener('pointermove', e => {
    if (!libDrag || e.pointerId !== libDrag.id) return;
    const {detail} = libDrag, {w,d} = detail;
    if (!libDrag.ghost){
      if (Math.hypot(e.clientX-libDrag.sx, e.clientY-libDrag.sy) < App.core.TAP) return;
      const g = libDrag.ghost = document.createElement('div'); g.id = 'ghost';
      g.innerHTML = `<svg viewBox="${-w/2} ${-d/2} ${w} ${d}">${libraryShape(detail)}</svg>`;
      document.body.appendChild(g); libDrag.el.classList.add('dragging');
    }
    // 幽灵图按落点处的比例显示真实大小（3D 中近大远小）
    const g = libDrag.ghost, s = Math.max(dropPoint(e.clientX, e.clientY, detail)?.s || (App.io.is3D() ? .05 : App.store.view.s), .02);
    Object.assign(g.style, {width:Math.max(28, w*s)+'px', height:Math.max(20, d*s)+'px', left:e.clientX+'px', top:e.clientY+'px'});
    const lib = App.core.$('aside.lib');
    if (App.core.narrow() && lib.classList.contains('open') && e.clientX > lib.getBoundingClientRect().right) App.panel.drawer(null);   // 拖出抽屉后自动收起
  });
  function endLibDrag(e, ok){
    if (!libDrag || e.pointerId !== libDrag.id) return;
    const d = libDrag; libDrag = null;
    d.el.classList.remove('dragging');
    if (d.ghost){
      d.ghost.remove();
      if (!ok) return;
      const p = dropPoint(e.clientX, e.clientY, d.detail);
      if (p) addItem(d.entry, p.x, p.y, {surface:p});
      else if(mounted(d.detail))placementHint();
      else if (App.io.is3D() && e.clientX > App.core.$('#stage').getBoundingClientRect().left) App.core.toast(App.core.tr('请拖到地面上', 'Drop it on the floor'));
      return;
    }
    if (ok) placeLibraryAsset(d.entry);
  }
  function placeLibraryAsset(entry){
    if (!entry) return null;
    // 轻点：放到选中房间中心，否则放到画面中心（3D 取屏幕中心对应的地面位置）
    const detail=App.geom.catalogItemDetails(entry),isMounted=mounted(detail),sel=App.store.ui.sel;
    const selectedRoom=sel?.kind==='room'?sel.id:null;
    const roomId=isMounted?(App.ceilingEditor?.context()?.roomId || (App.io.is3D()&&App.view3d?.roomId?.()) || selectedRoom):selectedRoom;
    const def=roomId && App.plan.roomDef(roomId);
    let p=null;
    if(def){
      if(isMounted){
        const spans=App.dimensionGeometry.roomSpans(def);
        if(spans)p={x:spans.y[0].across,y:spans.x[0].across,roomId};
      }else{
        const bounds=App.geom.bbox(def.poly);
        p={x:(bounds[0]+bounds[2])/2,y:(bounds[1]+bounds[3])/2};
      }
    }else if(App.io.is3D()){
      const r=App.core.$('#stage').getBoundingClientRect();
      p=dropPoint(r.left+r.width/2,r.top+r.height/2,detail);
    }
    if(!p)p={x:App.store.view.x0+App.core.svg.clientWidth/2/App.store.view.s,y:App.store.view.y0+App.core.svg.clientHeight/2/App.store.view.s};
    // A whole-home view can be centred over a stairwell or between rooms.
    if(isMounted&&!def&&!p.roomId&&!App.store.ROOMS.some(r=>!r.bay&&!r.outdoor&&App.ceilingModel.pointIn(r.poly,[p.x,p.y]))){
      const indoor=App.store.ROOMS.filter(r=>!r.outdoor&&!r.bay).map(r=>({id:r.id,span:App.dimensionGeometry.roomSpans(r)})).filter(t=>t.span)
        .map(({id,span})=>({x:span.y[0].across,y:span.x[0].across,roomId:id}));
      const nearest=indoor.sort((a,b)=>Math.hypot(a.x-p.x,a.y-p.y)-Math.hypot(b.x-p.x,b.y-p.y))[0];
      if(nearest)p=nearest;
    }
    const added = addItem(entry, p.x, p.y, {automatic:true, room:def, surface:p});
    if (added) App.panel.closeDrawers();
    return added;
  }
  addEventListener('pointerup', e => endLibDrag(e, true));
  addEventListener('pointercancel', e => endLibDrag(e, false));

  Object.assign(App.interact, {
    select, updateFurniture, rotateSel, deleteSel, duplicateSel, pushOut, furnitureWarnings, toggleWall, setTool, syncModeHint, applyView,
    fitView, zoomCenter, setRatio, snapMove, snapPoint, buildLib, openCeilingLibrary, placeLibraryAsset,
  });
})();
