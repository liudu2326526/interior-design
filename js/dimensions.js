/* 尺寸标注、几何吸附和人工复核。跨次保存的是几何引用和原图值。 */
(() => {
  'use strict';
  const App = globalThis.App;
  const { $, tr, esc, nm } = App.core;
  const group = $('#gDims');
  const editor = $('#dimensionEditor');
  const input = $('#dimensionOriginal');
  const status = $('#dimensionEditorStatus');
  const format = value => String(Math.round(value * 10) / 10);
  let first = null, hovered = null, activeId = null;
  let geometry = null, geometryRevision = -1, demolitionKey = '';
  let drawnAxes = null, drawnScale = 0;

  function normalizeMarks(raw){
    const marks = [], ids = new Set();
    const anchor = value => value && ['room','wall'].includes(value.kind) && typeof value.id === 'string' &&
      value.id && Number.isInteger(value.edge) && value.edge >= 0 && Number.isFinite(value.t) && value.t >= 0 && value.t <= 1
      ? {kind:value.kind, id:value.id, edge:value.edge, t:value.t} : null;
    for (const item of (Array.isArray(raw) ? raw : []).slice(0, 100)){
      const a = anchor(item?.a), b = anchor(item?.b);
      if (!a || !b || !['x','y'].includes(item.axis) || typeof item.id !== 'string' || !item.id || ids.has(item.id)) continue;
      const mark = {id:item.id, axis:item.axis, a, b};
      if (Number.isFinite(item.original) && item.original > 0) mark.original = item.original;
      marks.push(mark);
      ids.add(mark.id);
    }
    return marks;
  }

  function remapMarks(marks, mapWall){
    return marks.flatMap(mark => {
      const map = anchor => {
        if (anchor.kind === 'room') return anchor;
        const id = mapWall(anchor.id);
        return id ? {...anchor, id} : null;
      };
      const a = map(mark.a), b = map(mark.b);
      return a && b ? [{...mark, a, b}] : [];
    });
  }

  function straight(a, b){
    return {from:a, to:b};
  }

  function loopEdges(points, curves = new Map()){
    return points.map((from, i) => {
      const curve = curves.get(i);
      return curve ? {curve, offset:0} : straight(from, points[(i + 1) % points.length]);
    });
  }

  function wallEdges(wall){
    const [x0,y0,x1,y1,,,curve] = wall;
    if (!curve) return loopEdges([[x0,y0],[x1,y0],[x1,y1],[x0,y1]]);
    const half = curve.thickness / 2;
    const {curvePoint} = App.geom;
    return [
      {curve, offset:-half}, {curve, offset:half},
      straight(curvePoint(curve, 0, -half), curvePoint(curve, 0, half)),
      straight(curvePoint(curve, 1, -half), curvePoint(curve, 1, half)),
    ];
  }

  const roomEdges = room => loopEdges(room.vertices || room.poly, App.geom.roomCurves(room));

  function pointOn(edge, t){
    if (edge.curve) return App.geom.curvePoint(edge.curve, t, edge.offset);
    const {from, to} = edge;
    return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
  }

  function resolve(anchor){
    if (anchor.kind === 'wall'){
      const wall = App.plan.wallOf(anchor.id);
      if (wall && !App.store.state.demolished.includes(anchor.id)){
        const edge = wallEdges(wall)[anchor.edge];
        return edge ? pointOn(edge, anchor.t) : null;
      }
    } else {
      const room = App.plan.roomDef(anchor.id);
      const edge = room && roomEdges(room)[anchor.edge];
      if (edge) return pointOn(edge, anchor.t);
    }
    return null;
  }

  function fractionAt(edge, point){
    if (edge.curve){
      const {curve, offset} = edge;
      const snapped = App.geom.closestCurvePoint(curve, ...point, offset);
      const angle = Math.atan2(snapped[1] - curve.cy, snapped[0] - curve.cx);
      const fraction = App.geom.curveFraction(curve, angle);
      if (fraction !== null) return fraction;
      const start = pointOn(edge, 0);
      return Math.hypot(snapped[0] - start[0], snapped[1] - start[1]) < 1e-5 ? 0 : 1;
    }
    const {from, to} = edge;
    const dx = to[0] - from[0], dy = to[1] - from[1];
    const length2 = dx * dx + dy * dy;
    return length2 ? Math.max(0, Math.min(1, ((point[0]-from[0])*dx + (point[1]-from[1])*dy) / length2)) : 0;
  }

  function findAnchor(point){
    let best = Math.min(400, (App.core.COARSE ? 22 : 14) / App.store.view.s), result = null;
    const test = (kind, id, edges) => edges.forEach((edge, i) => {
      const t = fractionAt(edge, point), snapped = pointOn(edge, t);
      const distance = Math.hypot(point[0]-snapped[0], point[1]-snapped[1]);
      if (distance >= best - 1e-6) return;
      best = distance;
      result = {kind, id, edge:i, t};
    });
    App.store.WALLS.forEach((wall, i) => {
      const id = 'w' + i;
      if (!App.store.state.demolished.includes(id)) test('wall', id, wallEdges(wall));
    });
    App.store.ROOMS.forEach(room => test('room', room.id, roomEdges(room)));
    return result;
  }

  function getGeometry(){
    const {planRev, WALLS, ROOMS, state} = App.store;
    const key = state.demolished.join(',');
    if (geometryRevision !== planRev || demolitionKey !== key){
      geometryRevision = planRev;
      demolitionKey = key;
      geometry = App.dimensionGeometry.layout({walls:WALLS, rooms:ROOMS, demolished:state.demolished});
    }
    return geometry;
  }

  const axisIndex = axis => axis === 'x' ? 0 : 1;
  const reference = (axis, point) => ({value:point[axisIndex(axis)], across:point[1-axisIndex(axis)]});
  const coord = (axis, value, across) => axis === 'x' ? [value, across] : [across, value];
  const line = (from, to, cls) => '<line class="' + cls + '" x1="' + from[0] + '" y1="' + from[1] +
    '" x2="' + to[0] + '" y2="' + to[1] + '"/>';
  const modelLength = (a, b) => Math.abs(b.value - a.value);

  function manualRows(axis){
    const list = App.store.state.dimensionMarks.flatMap(mark => {
      if (mark.axis !== axis) return [];
      const a = resolve(mark.a), b = resolve(mark.b);
      if (!a || !b) return [];
      const ends = [reference(axis, a), reference(axis, b)].sort((u,v) => u.value - v.value);
      return modelLength(...ends) >= 1 ? [{mark, ends}] : [];
    }).sort((a,b) => a.ends[0].value - b.ends[0].value);
    const rowEnds = [];
    list.forEach(item => {
      const [from, to] = item.ends;
      const freeRow = rowEnds.findIndex(end => end <= from.value);
      item.row = freeRow < 0 ? rowEnds.length : freeRow;
      rowEnds[item.row] = to.value;
    });
    return {list, count:rowEnds.length};
  }

  function layout(){
    const model = getGeometry();
    if (!model) return null;
    const span = Math.max(modelLength(...model.x.total), modelLength(...model.y.total));
    const gap = Math.max(230, span * .043);
    const axes = {};
    for (const axis of ['x','y']){
      const manual = manualRows(axis);
      const edge = model[axis === 'x' ? 'y' : 'x'].total[0].value;
      for (const item of manual.list) item.at = edge - gap * (2 + item.row);
      axes[axis] = {...model[axis], gap, manual,
        outer:edge - gap * (3 + manual.count),
        chain:edge - gap * (2 + manual.count),
        selected:edge - gap,
      };
    }
    return axes;
  }

  function forCad(){
    const axes = layout();
    if (!axes) return [];
    const rows = [];
    for (const axis of ['x','y']){
      const {total, points, outer, chain, manual} = axes[axis];
      rows.push({axis, at:outer, points:total, kind:'overall'});
      if (points.length > 2) rows.push({axis, at:chain, points, kind:'chain'});
      for (const {mark, ends, at} of manual.list){
        const row = {axis, at, points:ends, kind:'manual'};
        if (mark.original !== undefined) row.original = mark.original;
        rows.push(row);
      }
    }
    return rows;
  }

  function frameBounds(){
    const base = App.store.BOUNDS;
    const axes = App.store.ui.layers.dims && layout();
    if (!axes) return base;
    const margin = App.core.svg.clientWidth < 600 ? 1.4 : 1;
    const x = Math.min(base.x, axes.y.outer - axes.y.gap * margin);
    const y = Math.min(base.y, axes.x.outer - axes.x.gap * margin);
    const right = Math.max(base.x + base.w, axes.x.total[1].value + axes.x.gap);
    const bottom = Math.max(base.y + base.h, axes.y.total[1].value + axes.y.gap);
    return {x, y, w:right-x, h:bottom-y};
  }

  function label(axis, pos, at, text, size){
    const [x,y] = coord(axis, pos, at);
    const rotate = axis === 'y' ? ' transform="rotate(-90 ' + x + ' ' + y + ')"' : '';
    return '<text class="dim-label" x="' + x + '" y="' + y + '" font-size="' + size + '"' + rotate + '>' + esc(text) + '</text>';
  }

  function dimensionRow(axis, points, at, gap, className, options = {}){
    if (points.length < 2) return '';
    const tick = gap * .115;
    const begin = points[0].value, end = points.at(-1).value;
    const id = options.id ? ' data-dim-mark="' + esc(options.id) + '" tabindex="0" role="button" aria-pressed="' + (activeId === options.id) + '"' : '';
    let markup = '<g class="' + className + '" data-axis="' + axis + '"' + id + '>';
    if (options.caption) markup += '<title>' + esc(options.caption) + '</title>';
    markup += line(coord(axis, begin, at), coord(axis, end, at), 'dim-rule');
    if (options.id) markup += line(coord(axis, begin, at), coord(axis, end, at), 'dim-hit');
    for (const {value, across} of points){
      if (options.extensions !== false){
        markup += line(coord(axis, value, across), coord(axis, value, at), 'dim-extension');
      }
      const direction = axis === 'x' ? 1 : -1;
      markup += line(coord(axis, value-tick, at+direction*tick), coord(axis, value+tick, at-direction*tick), 'dim-tick');
    }
    const labelEdges = [-Infinity, -Infinity];
    for (let i = 1; i < points.length; i++){
      const a = points[i-1].value, b = points[i].value;
      const distance = options.roundChain ? Math.round(b) - Math.round(a) : modelLength(points[i-1], points[i]);
      const text = options.text || format(distance);
      const total = className === 'dim-total';
      const size = Math.max(gap * (total ? .54 : .4),
        Math.min(gap * .79, (total ? 11 : 9) / App.store.view.s));
      const mid = (a+b) / 2;
      const halfWidth = text.length * size * .28;
      const openLane = labelEdges.findIndex(edge => mid - halfWidth >= edge + gap * .09);
      const lane = openLane < 0 ? (labelEdges[0] <= labelEdges[1] ? 0 : 1) : openLane;
      const offset = gap * .17 + lane * Math.max(gap * .49, size * .95);
      const title = text.endsWith(' mm') ? text : text + ' mm';
      markup += '<g data-dimension-value="' + format(distance) + '"><title>' + esc(title) + '</title>' +
        label(axis, mid, at - offset, text, size) + '</g>';
      labelEdges[lane] = mid + halfWidth;
    }
    return markup + '</g>';
  }

  const selectionGroup = () => group.querySelector('#dimensionSelection');
  const snapGroup = () => group.querySelector('#dimensionSnap');
  function renderSelection(axes = drawnAxes){
    const target = selectionGroup();
    if (!axes || !target) return;
    const sel = App.store.ui.sel;
    let s = '';
    if (sel?.kind === 'room'){
      const room = App.plan.roomDef(sel.id);
      const spans = App.dimensionGeometry.roomSpans(room, App.store.ui.dimensionRoomPoint);
      for (const axis of ['x','y']){
        if (!spans?.[axis]) continue;
        const {selected, gap} = axes[axis];
        const length = format(modelLength(...spans[axis]));
        const text = (axis === 'x' ? tr('净宽 ', 'Clear W ') : tr('净深 ', 'Clear D ')) + length;
        s += dimensionRow(axis, spans[axis], selected, gap, 'dim-selection', {text,
          caption:nm(App.store.roomState(sel.id).name) + ' · ' + tr('当前截面', 'Current section')});
      }
    } else if (sel?.kind === 'furn' && App.store.ui.layers.furn){
      const item = App.store.getF(sel.id);
      if (item){
        const {hw, hh} = App.geom.aabb(item);
        const actual = format(item.w) + ' × ' + format(item.d) + ' mm';
        const rotated = Math.abs(item.rot % 90) > 1e-6;
        const spans = {
          x:[{value:item.cx-hw, across:item.cy}, {value:item.cx+hw, across:item.cy}],
          y:[{value:item.cy-hh, across:item.cx}, {value:item.cy+hh, across:item.cx}],
        };
        for (const axis of ['x','y']){
          const {selected, gap} = axes[axis];
          const txt = rotated
            ? axis === 'x' ? tr('实际 ', 'Actual ') + actual : tr('投影 ', 'Proj. ') + format(hh*2)
            : (axis === 'x' ? tr('横向 ', 'X ') : tr('纵向 ', 'Y ')) + format(modelLength(...spans[axis]));
          s += dimensionRow(axis, spans[axis], selected, gap, 'dim-selection', {text:txt,
            caption:nm(item.name) + ' · ' + tr('实际宽 × 深 ', 'Actual width × depth ') + actual});
        }
      }
    }
    target.innerHTML = s;
  }

  function renderSnap(){
    const target = snapGroup();
    if (!target) return;
    const radius = 5 / App.store.view.s;
    target.innerHTML = [first, hovered].filter(Boolean).flatMap(anchor => {
      const p = resolve(anchor);
      return p ? ['<circle cx="' + p[0] + '" cy="' + p[1] + '" r="' + radius +
        '" fill="#fff" stroke="#2c6267" stroke-width="2" vector-effect="non-scaling-stroke"/>'] : [];
    }).join('');
  }

  function render(){
    const axes = layout();
    const visible = App.store.ui.layers.dims && axes;
    drawnAxes = visible ? axes : null;
    drawnScale = App.store.view.s;
    group.setAttribute('display', visible ? 'inline' : 'none');
    if (!visible){
      closeEditor();
      return;
    }
    let s = '';
    for (const axis of ['x','y']){
      const {gap, outer, chain, total, points, manual} = axes[axis];
      s += dimensionRow(axis, total, outer, gap, 'dim-total', {roundChain:true,
        caption:axis === 'x' ? tr('模型外包总宽', 'Model overall width') : tr('模型外包总深', 'Model overall depth')});
      if (points.length > 2) s += dimensionRow(axis, points, chain, gap, 'dim-chain', {roundChain:true});
      for (const {mark, ends, at} of manual.list){
        const caption = mark.original ? tr('原图 ', 'Drawing ') + format(mark.original) + ' mm' : tr('点击复核分段尺寸', 'Select to review the dimension');
        s += dimensionRow(axis, ends, at, gap, 'dim-manual', {id:mark.id, caption});
      }
    }
    group.innerHTML = s + '<g id="dimensionSelection"></g><g id="dimensionSnap"></g>';
    renderSelection(axes);
    renderSnap();
    syncEditor();
  }

  function updateView(){
    if (drawnAxes && drawnScale !== App.store.view.s) render();
    else renderSnap();
  }

  function clearDraft(){
    first = null;
    hovered = null;
    renderSnap();
  }

  function toggleTool(active){
    clearDraft();
    if (!active) return;
    if (!App.store.ui.layers.dims){
      App.store.ui.layers.dims = true;
      $('#layers [data-layer="dims"]').classList.add('on');
      render();
    }
  }

  function preview(point){
    hovered = point ? findAnchor(point) : null;
    renderSnap();
  }

  function addPoint(point){
    const next = findAnchor(point);
    if (!next) return App.core.toast(tr('请点靠近墙面或房间边界的位置', 'Pick near a wall face or room boundary'));
    if (!first){
      first = next;
      renderSnap();
      return App.core.toast(tr('再选第二个尺寸端点', 'Pick the second dimension endpoint'));
    }
    const a = resolve(first), b = resolve(next);
    if (!a || !b){ clearDraft(); return; }
    const dx = Math.abs(b[0]-a[0]), dy = Math.abs(b[1]-a[1]);
    if (Math.max(dx,dy) < 1) return App.core.toast(tr('请选择不同的端点', 'Pick a different endpoint'));
    const marks = App.store.state.dimensionMarks;
    if (marks.length >= 100) return App.core.toast(tr('分段尺寸已达到上限，请先删除不用的标注', 'Remove an unused dimension before adding more'));
    const mark = {id:App.geom.uid(), axis:dx >= dy ? 'x' : 'y', a:first, b:next};
    clearDraft();
    activeId = mark.id;
    input.value = '';
    status.textContent = '';
    App.store.mutate(() => marks.push(mark));
    App.interact.setTool('select');
    // 新增标注可能需要为额外的尺寸行留出空间。
    App.interact.fitView();
  }

  const currentMark = () => App.store.state.dimensionMarks.find(mark => mark.id === activeId);

  function closeEditor(){
    activeId = null;
    editor.hidden = true;
    status.textContent = '';
    group.querySelectorAll('[data-dim-mark][aria-pressed="true"]').forEach(node => node.setAttribute('aria-pressed','false'));
  }

  function syncEditor(){
    const mark = currentMark();
    const a = mark && resolve(mark.a), b = mark && resolve(mark.b);
    if (!mark || !a || !b) return closeEditor();
    const i = axisIndex(mark.axis), value = Math.abs(b[i]-a[i]);
    const diff = mark.original ? ' · ' + tr('差 ', 'Difference ') + format(value-mark.original) + ' mm' : '';
    $('#dimensionModel').textContent = tr('模型 ', 'Model ') + format(value) + ' mm' + diff;
    const supported = mark.b.kind === 'wall' && (mark.axis === 'x' ? [1,3] : [0,2]).includes(mark.b.edge) &&
      !App.plan.wallOf(mark.b.id)?.[6] && typeof App.dimensionCalibration.moveWall === 'function';
    $('#dimensionMove').hidden = !supported;
    editor.hidden = false;
  }

  function openMark(id){
    activeId = id;
    status.textContent = '';
    input.value = currentMark()?.original ?? '';
    render();
  }

  function updateOriginal(event){
    event.preventDefault();
    const mark = currentMark();
    if (!mark || !input.reportValidity()) return;
    const value = input.valueAsNumber;
    if (value !== mark.original) App.store.mutate(() => { mark.original = value; });
    status.textContent = tr('已记录原图尺寸', 'Drawing dimension recorded');
  }

  function calibrate(move){
    const mark = currentMark();
    if (!mark || !input.reportValidity()) return;
    const a = resolve(mark.a), b = resolve(mark.b);
    if (!a || !b) return closeEditor();
    if (move && mark.a.kind === 'wall' && mark.a.id === mark.b.id){
      status.textContent = tr('两个端点在同一面墙上，请选不同的墙面', 'Pick faces on different walls');
      return;
    }
    const action = App.dimensionCalibration[move ? 'moveWall' : 'resize'];
    const result = action(mark.axis, a, b, input.valueAsNumber, Number(mark.b.id.slice(1)));
    if (result.ok) App.io.refit();
    status.textContent = result.ok ? tr('模型已校准，可撤销', 'Model calibrated. Undo is available.') : result.error;
  }

  group.addEventListener('click', e => {
    const target = e.target.closest('[data-dim-mark]');
    if (target) openMark(target.dataset.dimMark);
  });
  group.addEventListener('keydown', e => {
    const target = e.target.closest('[data-dim-mark]');
    if (target && ['Enter',' '].includes(e.key)){
      e.preventDefault();
      e.stopPropagation();
      openMark(target.dataset.dimMark);
      input.focus();
    }
  });
  $('#dimensionClose').onclick = closeEditor;
  $('#dimensionForm').onsubmit = updateOriginal;
  $('#dimensionMove').onclick = () => calibrate(true);
  $('#dimensionScale').onclick = () => calibrate(false);
  $('#dimensionDelete').onclick = () => {
    const mark = currentMark();
    if (!mark) return;
    closeEditor();
    App.store.mutate(() => {
      App.store.state.dimensionMarks = App.store.state.dimensionMarks.filter(item => item.id !== mark.id);
    });
  };
  Object.assign(App.dimensions, {
    normalizeMarks, remapMarks, forCad, frameBounds, render, renderSelection, updateView,
    toggleTool, clearDraft, preview, addPoint, closeEditor,
  });
})();
