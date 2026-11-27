/* 平面图、尺寸标注和选择状态的绘制。
 * 依赖 App.core、App.store、App.geom、App.plan、App.panel。
 */
(() => {
  'use strict';
  const App = globalThis.App;

  /* ======================= 渲染 ======================= */
  const NOLABEL = ['plant','floorlamp','sidetable','barstool','beanbag'];
  function svgArc(curve, end, offset = 0, reverse = false){
    const radius = curve.radius + offset, direction = (curve.sweep > 0) !== reverse ? 1 : 0;
    return `A${radius} ${radius} 0 0 ${direction} ${end.join(' ')}`;
  }
  function curveLinePath(curve, offset){
    return `M${App.geom.curvePoint(curve, 0, offset).join(' ')}${svgArc(curve, App.geom.curvePoint(curve, 1, offset), offset)}`;
  }
  function curveBandPath(curve){
    const half = curve.thickness / 2;
    return `${curveLinePath(curve, half)}L${App.geom.curvePoint(curve, 1, -half).join(' ')}${svgArc(curve, App.geom.curvePoint(curve, 0, -half), -half, true)}Z`;
  }
  function roomShape(room, attrs){
    if (!room.arcs?.length) return `<polygon points="${room.poly.map(p => p.join(',')).join(' ')}" ${attrs}/>`;
    const vertices = room.vertices || room.poly, curves = App.geom.roomCurves(room);
    let path = `M${vertices[0].join(' ')}`;
    vertices.forEach((_, i) => {
      const end = vertices[(i + 1) % vertices.length], curve = curves.get(i);
      path += curve ? svgArc(curve, end) : `L${end.join(' ')}`;
    });
    return `<path d="${path}Z" ${attrs}/>`;
  }
  function wallShape([x0,y0,x1,y1,,,curve], attrs){
    return curve ? `<path d="${curveBandPath(curve)}" ${attrs}/>`
      : `<rect x="${x0}" y="${y0}" width="${x1-x0}" height="${y1-y0}" ${attrs}/>`;
  }
  function renderRooms(){
    let s = '';
    const rooms = App.store.ROOMS;
    [...rooms.filter(room => room.outdoor), ...rooms.filter(room => !room.outdoor)].forEach(r => {
      const fill = r.outdoor ? '#d3e2c9' : App.geom.patURL(App.store.roomState(r.id).mat);
      s += roomShape(r, `class="room" data-room="${App.core.esc(r.id)}" fill="${fill}"`);
    });
    const sill = ([a,b,c,d]) => `<rect x="${a}" y="${b}" width="${c-a}" height="${d-b}" fill="#e2dacb" stroke="#b9b0a0" stroke-width="1" vector-effect="non-scaling-stroke" pointer-events="none"/>`;
    App.store.DOORS.forEach(d => s += sill(d.rect)); App.store.SLIDES.forEach(d => s += sill(d.rect));
    App.core.$('#gRooms').innerHTML = s;
  }

  function furnitureShape(f){ return f.type === 'component' ? App.geom.componentSVG(f) : App.geom.furnSVG(f.type,f.w,f.d,f.color,f); }
  function renderFurn(){
    const g = App.core.$('#gFurn');
    g.setAttribute('display', App.store.ui.layers.furn ? 'inline' : 'none');
    g.innerHTML = App.store.state.furniture.map(f => {
      const component = f.type === 'component';
      const fs = Math.max(80, Math.min(170, Math.min(f.w,f.d)*.2));
      const label = Math.min(f.w,f.d) >= 380 && !NOLABEL.includes(f.type)
        ? `<text transform="rotate(${-f.rot})" font-size="${fs}" text-anchor="middle" dominant-baseline="central" fill="#4a443c" opacity=".8" pointer-events="none">${App.core.esc(App.core.nm(f.name))}</text>` : '';
      const title = component ? `<title>${App.core.esc(App.core.nm(f.name))}</title>` : '';
      const shape = furnitureShape(f);
      return `<g class="furn" data-fid="${App.core.esc(f.id)}" transform="translate(${f.cx} ${f.cy}) rotate(${f.rot})">${title}${shape}${label}</g>`;
    }).join('');
  }

  function renderWalls(){
    App.core.$('#gWalls').innerHTML = App.store.WALLS.map((w,i) => {
      const k = w[4], id = 'w'+i, dem = App.store.state.demolished.includes(id);
      let fill = k==='b' ? (App.store.ui.layers.bearing ? '#b8412c' : '#26241f') : k==='low' ? '#e9e3d8' : k==='e' ? '#8f897d' : '#a7a195';
      let ex = k==='low' ? 'stroke="#8f897d" stroke-width="1" vector-effect="non-scaling-stroke"' : '';
      if (dem){ fill = 'rgba(198,91,58,.12)'; ex = 'stroke="#c65b3a" stroke-width="1.2" stroke-dasharray="5 3" vector-effect="non-scaling-stroke"'; }
      return wallShape(w, `class="wall" data-wall="${id}" fill="${fill}" ${ex}`);
    }).join('');
  }

  function renderOpenings(){
    const WS = 'stroke="#4f7394" stroke-width="1" vector-effect="non-scaling-stroke"';
    let s = '';
    App.store.WINS.forEach(([x0,y0,x1,y1,curve]) => {
      if (curve){
        s += `<path d="${curveBandPath(curve)}" fill="#f7fbfd" ${WS}/>`;
        for (const t of [-1/6, 1/6]) s += `<path d="${curveLinePath(curve, curve.thickness * t)}" fill="none" ${WS}/>`;
        return;
      }
      const w = x1-x0, h = y1-y0;
      s += `<rect x="${x0}" y="${y0}" width="${w}" height="${h}" fill="#f7fbfd" ${WS}/>`;
      if (w >= h) [1/3,2/3].forEach(t => s += `<line x1="${x0}" y1="${y0+h*t}" x2="${x1}" y2="${y0+h*t}" ${WS}/>`);
      else [1/3,2/3].forEach(t => s += `<line x1="${x0+w*t}" y1="${y0}" x2="${x0+w*t}" y2="${y1}" ${WS}/>`);
    });
    const DS = 'stroke="#3d3a34" stroke-width="1" vector-effect="non-scaling-stroke"';
    App.store.DOORS.forEach(d => {
      const [hx,hy] = d.h, L = d.len, T = 40;
      const ox = hx + d.o[0]*L, oy = hy + d.o[1]*L, cx = hx + d.c[0]*L, cy = hy + d.c[1]*L;
      const sweep = d.o[0]*d.c[1] - d.o[1]*d.c[0] > 0 ? 1 : 0;
      const col = d.entry ? '#b5653a' : '#3d3a34';
      s += `<polygon points="${hx},${hy} ${ox},${oy} ${ox+d.c[0]*T},${oy+d.c[1]*T} ${hx+d.c[0]*T},${hy+d.c[1]*T}" fill="#fff" stroke="${col}" stroke-width="${d.entry?1.8:1}" vector-effect="non-scaling-stroke"/>`;
      s += `<path d="M${ox} ${oy}A${L} ${L} 0 0 ${sweep} ${cx} ${cy}" fill="none" ${DS} stroke-dasharray="5 3" opacity=".7"/>`;
    });
    App.store.SLIDES.forEach(({rect:[x0,y0,x1,y1],v}) => {
      if (v){ const L = y1-y0, m = (x0+x1)/2; s += `<rect x="${m-45}" y="${y0}" width="40" height="${L*.55}" fill="#fff" ${DS}/><rect x="${m+5}" y="${y1-L*.55}" width="40" height="${L*.55}" fill="#fff" ${DS}/>`; }
      else { const L = x1-x0, m = (y0+y1)/2; s += `<rect x="${x0}" y="${m-45}" width="${L*.55}" height="40" fill="#fff" ${DS}/><rect x="${x1-L*.55}" y="${m+5}" width="${L*.55}" height="40" fill="#fff" ${DS}/>`; }
    });
    // 入户标识：由带 entry 标记的门推导（门外 900mm 处画箭头与文字）
    const entry = App.store.DOORS.find(d => d.entry);
    if (entry){
      const [x0,y0,x1,y1] = entry.rect, ex = (x0+x1)/2, ey = (y0+y1)/2;
      const thinX = (x1-x0) <= (y1-y0);                         // 门洞在竖墙里 → 法线沿 x
      const sgn = thinX ? (ex <= App.store.BOUNDS.x + App.store.BOUNDS.w/2 ? -1 : 1) : (ey <= App.store.BOUNDS.y + App.store.BOUNDS.h/2 ? -1 : 1);
      const dx = thinX ? sgn : 0, dy = thinX ? 0 : sgn, px = -dy, py = dx;
      const ax = ex + dx*900, ay = ey + dy*900, bx = ex + dx*200, by = ey + dy*200;
      s += `<path d="M${ax} ${ay}L${bx} ${by}M${bx+dx*220+px*150} ${by+dy*220+py*150}L${bx} ${by}L${bx+dx*220-px*150} ${by+dy*220-py*150}"
            fill="none" stroke="#b5653a" stroke-width="2" vector-effect="non-scaling-stroke"/>
          <text x="${ax+px*260}" y="${ay+py*260-60}" font-size="200" fill="#b5653a" text-anchor="middle">${App.core.tr('入户','Entry')}</text>`;
    }
    App.core.$('#gOpen').innerHTML = s;
  }

  function renderLabels(){
    const g = App.core.$('#gLabels');
    g.setAttribute('display', App.store.ui.layers.labels ? 'inline' : 'none');
    g.innerHTML = App.store.ROOMS.filter(r => r.at).map(r => {
      const [x,y] = r.at, halo = 'stroke="#fbf9f4" stroke-width="45" paint-order="stroke" stroke-linejoin="round"';
      return `<text x="${x}" y="${y}" font-size="250" font-weight="600" text-anchor="middle" fill="#2b2824" ${halo}>${App.core.esc(App.core.nm(App.store.roomState(r.id).name))}</text>
      <text x="${x}" y="${y+260}" font-size="175" text-anchor="middle" fill="#7d7366" ${halo}>${App.geom.fmt(App.geom.roomArea(r))} m²</text>`;
    }).join('');
  }

  function renderDims(){ App.dimensions.render(); }

  function renderGrid(){
    const b = App.store.BOUNDS;
    App.core.$('#gGrid').innerHTML = `<rect x="${b.x-8000}" y="${b.y-8000}" width="${b.w+16000}" height="${b.h+16000}" fill="${App.store.ui.layers.grid ? 'url(#grid)' : 'transparent'}" data-bg="1"/>`;
  }

  function renderMeasure(){
    const k = 1/App.store.view.s, fs = 12*k;
    const one = (a,b,tmp) => {
      const L = Math.hypot(b.x-a.x, b.y-a.y); if (L < 1) return '';
      let ang = Math.atan2(b.y-a.y, b.x-a.x)*180/Math.PI; if (ang > 90 || ang < -90) ang += 180;
      const mx = (a.x+b.x)/2, my = (a.y+b.y)/2, nx = -(b.y-a.y)/L*5*k, ny = (b.x-a.x)/L*5*k;
      const col = tmp ? '#2f5d62' : '#b5653a', S = `stroke="${col}" stroke-width="1.5" vector-effect="non-scaling-stroke"`;
      return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" ${S}/>
      <line x1="${a.x-nx}" y1="${a.y-ny}" x2="${a.x+nx}" y2="${a.y+ny}" ${S}/><line x1="${b.x-nx}" y1="${b.y-ny}" x2="${b.x+nx}" y2="${b.y+ny}" ${S}/>
      <text x="${mx}" y="${my-5*k}" font-size="${fs}" text-anchor="middle" fill="${col}" font-weight="600" transform="rotate(${ang} ${mx} ${my})"
        stroke="#fff" stroke-width="${3.5*k}" paint-order="stroke">${Math.round(L)} mm</text>`;
    };
    let s = App.store.state.measures.map(m => one(m.a,m.b)).join('');
    if (App.store.ui.mA && App.store.ui.mCur) s += one(App.store.ui.mA, App.store.ui.mCur, true);
    if (App.store.ui.mA) s += `<circle cx="${App.store.ui.mA.x}" cy="${App.store.ui.mA.y}" r="${3*k}" fill="#2f5d62"/>`;
    App.core.$('#gMeasure').innerHTML = s;
  }

  function renderSel(){
    const k = 1/App.store.view.s; let s = '';
    if (App.store.ui.sel?.kind === 'furn'){
      const f = App.store.getF(App.store.ui.sel.id);
      if (f){
        // 触屏上手柄更大、离家具更远，并各带一圈透明的大热区
        const p = 5*k, A = 'stroke="#b5653a" vector-effect="non-scaling-stroke"', hs = App.core.COARSE ? 1.7 : 1, ro = (App.core.COARSE ? 40 : 26)*k, hit = (App.core.COARSE ? 24 : 11)*k;
        const sx = f.w/2+p, sy = f.d/2+p;
        s += `<g transform="translate(${f.cx} ${f.cy}) rotate(${f.rot})">
        <rect x="${-f.w/2-p}" y="${-f.d/2-p}" width="${f.w+2*p}" height="${f.d+2*p}" fill="none" ${A} stroke-width="1.5" stroke-dasharray="5 3" pointer-events="none"/>
        <line x1="0" y1="${-f.d/2-p}" x2="0" y2="${-f.d/2-ro}" ${A} stroke-width="1" pointer-events="none"/>
        <circle data-handle="rot" cx="0" cy="${-f.d/2-ro}" r="${hit}" fill="transparent"/>
        <circle data-handle="rot" cx="0" cy="${-f.d/2-ro}" r="${6*hs*k}" fill="#fff" ${A} stroke-width="1.5"><title>${App.core.tr('拖动旋转（Shift 自由角度）','Drag to rotate (Shift for free angle)')}</title></circle>
        <circle data-handle="size" cx="${sx}" cy="${sy}" r="${hit}" fill="transparent"/>
        <rect data-handle="size" x="${sx-5*hs*k}" y="${sy-5*hs*k}" width="${10*hs*k}" height="${10*hs*k}" fill="#b5653a"><title>${App.core.tr('拖动调整尺寸','Drag to resize')}</title></rect></g>`;

      }
    } else if (App.store.ui.sel?.kind === 'room'){
      const r = App.plan.roomDef(App.store.ui.sel.id);
      if (r) s += roomShape(r, 'fill="rgba(181,101,58,.08)" stroke="#b5653a" stroke-width="2" vector-effect="non-scaling-stroke" pointer-events="none"');
    } else if (App.store.ui.sel?.kind === 'wall'){
      const w = App.plan.wallOf(App.store.ui.sel.id);
      if (w) s += wallShape(w, 'fill="none" stroke="#b5653a" stroke-width="2" stroke-dasharray="6 4" vector-effect="non-scaling-stroke" pointer-events="none"');
    }
    App.core.$('#gSel').innerHTML = s;
    App.dimensions.renderSelection();
  }

  function renderAll(){
    App.ceilingShowcase?.sync();
    renderGrid(); renderRooms(); renderFurn(); renderWalls(); renderLabels(); renderMeasure(); renderSel(); renderDims(); App.ceilingEditor?.render(); App.panel.renderPanel(); updateHeader();
    App.view3d?.sync();
  }

  let renaming = false;                 // 顶栏方案名就地编辑中：暂不覆写 #brandName
  function updateHeader(){
    const tot = App.store.ROOMS.filter(r => r.counted !== false).reduce((a,r) => a + App.geom.roomArea(r), 0);
    if (!renaming) App.core.$('#brandName').textContent = `${App.store.PLAN.name} · ${App.core.tr('装修设计', 'Interior Design')}`;
    App.core.$('#subtitle').textContent = App.core.tr(`套内使用面积约 ${App.geom.fmt(tot)} m² · 尺寸单位 mm · 原图比例 1:60`, `Net floor area ≈ ${App.geom.fmt(tot)} m² · Units: mm · Original scale 1:60`);
    const components = App.geom.componentCount(App.store.state.furniture) > 0;
    const layoutLabel = components ? App.core.tr('家具 / 构件', 'Furniture / Components') : App.core.tr('家具', 'Furniture');
    document.querySelectorAll('[data-layer="furn"], [data-t="furn"]').forEach(b => { b.textContent = layoutLabel; });
    App.core.$('#clearAll').title = components ? App.core.tr('清空所有家具、家电和构件（可撤销）', 'Remove all furniture, appliances and components (undoable)')
      : App.core.tr('清空所有家具家电（可撤销）', 'Remove all furniture and appliances (undoable)');
    App.core.$('#undo').disabled = !App.store.undoStack.length; App.core.$('#redo').disabled = !App.store.redoStack.length;
    App.core.$('#undo').style.opacity = App.store.undoStack.length ? 1 : .4; App.core.$('#redo').style.opacity = App.store.redoStack.length ? 1 : .4;
  }

  /* ---------- 顶栏方案名：点击就地重命名，写入 PLAN.name（可撤销） ---------- */
  function startRename(){
    if (renaming) return;
    renaming = true;
    const b = App.core.$('#brandName'), inp = App.core.$('#brandEdit');
    inp.value = App.store.PLAN.name || '';
    b.hidden = true; inp.hidden = false;
    inp.focus(); inp.select();
  }
  function endRename(save){
    if (!renaming) return;
    renaming = false;
    const b = App.core.$('#brandName'), inp = App.core.$('#brandEdit');
    const name = inp.value.trim();
    inp.hidden = true; b.hidden = false;
    if (save && name && name !== App.store.PLAN.name) App.store.mutate(() => { App.store.PLAN.name = name; });
    else updateHeader();
  }
  App.core.$('#brandName').onclick = startRename;
  App.core.$('#brandName').onkeydown = e => { if (e.key === 'Enter' || e.key === ' '){ e.preventDefault(); startRename(); } };
  App.core.$('#brandEdit').onkeydown = e => {
    if (e.key === 'Enter'){ e.preventDefault(); endRename(true); }
    else if (e.key === 'Escape'){ e.preventDefault(); endRename(false); }
  };
  App.core.$('#brandEdit').onblur = () => endRename(true);

  Object.assign(App.draw2d, {
    curveBandPath, roomShape, wallShape, furnitureShape, renderFurn, renderOpenings, renderDims,
    renderMeasure, renderSel, renderAll,
  });
})();
