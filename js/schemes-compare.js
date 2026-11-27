/* 从独立快照生成只读平面图，坐标与编辑器一致，单位 mm。 */
(() => {
  'use strict';
  const App = globalThis.App;
  const {esc, nm} = App.core;
  const validBounds = value => value && [value.x, value.y, value.w, value.h].every(Number.isFinite) &&
    value.w > 0 && value.h > 0;

  function drawWall(wall){
    if (Array.isArray(wall)) return wall;
    const arc = App.geom.curvedSpan(wall);
    return [...App.geom.curveBounds(arc), wall.kind, wall.height, arc];
  }

  function drawWindow(opening){
    if (Array.isArray(opening)) return opening;
    const arc = App.geom.curvedSpan(opening);
    return [...App.geom.curveBounds(arc), arc];
  }

  function comparisonScene(snapshot){
    const {ok, plan} = App.plan.sanitizePlan(snapshot?.plan);
    if (!ok) return null;
    const state = snapshot.state || {};
    const walls = plan.walls.map(drawWall);
    const demolished = new Set(Array.isArray(state.demolished) ? state.demolished : []);
    const axes = App.dimensionGeometry.layout({walls, rooms:plan.rooms, demolished});
    return {plan, state, walls, demolished, axes};
  }

  function dimensionGap(axes){
    const span = Math.max(...['x','y'].map(axis => {
      const [start, end] = axes[axis].total;
      return end.value - start.value;
    }));
    return Math.max(230, span * .043);
  }

  function bounds(snapshots){
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const snapshot of snapshots){
      const scene = comparisonScene(snapshot);
      if (!scene) continue;
      const {x, y, w, h} = scene.plan.bounds;
      const pad = Math.max(120, Math.max(w, h) * .015);
      left = Math.min(left, x - pad);
      top = Math.min(top, y - pad);
      right = Math.max(right, x + w + pad);
      bottom = Math.max(bottom, y + h + pad);
      if (!scene.axes) continue;
      const margin = dimensionGap(scene.axes) * 2.75;
      left = Math.min(left, scene.axes.x.total[0].value - margin);
      top = Math.min(top, scene.axes.y.total[0].value - margin);
      right = Math.max(right, scene.axes.x.total[1].value + pad);
      bottom = Math.max(bottom, scene.axes.y.total[1].value + pad);
    }
    return Number.isFinite(left) ? {x:left, y:top, w:right - left, h:bottom - top} :
      {...App.plan.FALLBACK_PLAN.bounds};
  }

  function roomMarkup(plan, state){
    const roomStyle = room => state.rooms && Object.hasOwn(state.rooms, room.id) ? state.rooms[room.id] : null;
    const rooms = [...plan.rooms].sort((a, b) => Number(Boolean(b.outdoor)) - Number(Boolean(a.outdoor)));
    const shapes = rooms.map(room => {
      const roomProps = roomStyle(room);
      const finish = typeof roomProps?.mat === 'string' && Object.hasOwn(plan.materials, roomProps.mat) ? roomProps.mat : room.mat;
      const mat = plan.materials[finish]?.sw || '#e5e0d6';
      const fill = room.outdoor ? '#d3e2c9' : mat;
      const name = esc(nm(typeof roomProps?.name === 'string' && roomProps.name ? roomProps.name : room.name));
      const title = `${name} · ${App.geom.fmt(App.geom.roomArea(room))} m²`;
      const shape = App.draw2d.roomShape(room,
        `fill="${esc(fill)}" stroke="#d5cbbf" stroke-width=".55" vector-effect="non-scaling-stroke"`);
      return `<g data-room="${esc(room.id)}"><title>${title}</title>${shape}</g>`;
    }).join('');

    const labels = plan.rooms.filter(room => room.counted !== false).map(room => {
      const spans = App.dimensionGeometry.roomSpans(room, room.at);
      if (!spans) return '';
      const roomProps = roomStyle(room);
      const name = nm(typeof roomProps?.name === 'string' && roomProps.name ? roomProps.name : room.name);
      const width = spans.x[1].value - spans.x[0].value - 90;
      const height = spans.y[1].value - spans.y[0].value - 90;
      const size = Math.min(320, Math.max(200, Math.max(plan.bounds.w, plan.bounds.h) * .013), height);
      if (size < 130) return '';
      const fitted = App.draw2d.fitLabel(name, width, size, 650);
      if (!fitted) return '';
      const x = Math.min(spans.x[1].value - fitted.width/2 - 45,
        Math.max(spans.x[0].value + fitted.width/2 + 45, spans.y[0].across));
      const y = Math.min(spans.y[1].value - size/2 - 45,
        Math.max(spans.y[0].value + size/2 + 45, spans.x[0].across));
      return `<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="central" fill="#332c24" font-weight="650"
        font-size="${size}" stroke="#fbf8f0" stroke-width="${size * .18}" stroke-linejoin="round"
        paint-order="stroke" data-room-label="${esc(room.id)}">${esc(fitted.text)}</text>`;
    }).join('');
    return {shapes, labels};
  }

  function furnitureMarkup(state){
    const list = Array.isArray(state.furniture) ? state.furniture : [];
    const furniture = list.map((item, i) => item && App.geom.normalizeFurn({...item, id:item.id || `preview-${i}`}))
      .filter(item => item && !App.ceilingFurniture.is(item));
    const order = ({type}) => type === 'rug' ? 0 : type === 'component' ? 1 : 2;
    return furniture.sort((a, b) => order(a) - order(b)).map(item => {
      const {cx, cy, rot, id, name} = item;
      const shape = App.draw2d.furnitureShape(item);
      return `<g data-furniture="${esc(id)}" transform="translate(${cx} ${cy}) rotate(${rot})"><title>${esc(nm(name))}</title>${shape}</g>`;
    }).join('');
  }

  function dimensionsMarkup(axes){
    if (!axes) return '';
    const gap = dimensionGap(axes);
    return ['x', 'y'].map((axis, i) => {
      const [start, end] = axes[axis].total;
      const cross = axes[axis === 'x' ? 'y' : 'x'].total[0].value;
      const at = cross - gap * 1.5;
      const tick = gap * .13;
      const coord = (value, across) => i === 0 ? [value, across] : [across, value];
      const line = (from, to, opacity = 1) => `<line x1="${from[0]}" y1="${from[1]}" x2="${to[0]}" y2="${to[1]}"
        stroke="#827564" stroke-width=".75" opacity="${opacity}" vector-effect="non-scaling-stroke"/>`;
      const rule = line(coord(start.value, at), coord(end.value, at));
      const ends = [start, end].map(({value, across}) =>
        line(coord(value, across), coord(value, at - tick * 1.3), .55) +
        line(coord(value - tick, at + tick), coord(value + tick, at - tick))).join('');
      const [x, y] = coord((start.value + end.value)/2, at - tick * 1.75);
      const rotation = i === 0 ? '' : `transform="rotate(-90 ${x} ${y})"`;
      const label = `${Math.round(end.value - start.value)} mm`;
      return `<g data-dimension-axis="${axis}">${rule}${ends}
        <text x="${x}" y="${y}" ${rotation} text-anchor="middle" dominant-baseline="central" fill="#675747"
          font-size="${gap * .54}" font-weight="550" font-variant-numeric="tabular-nums">${label}</text></g>`;
    }).join('');
  }

  function render(svg, snapshot, viewBox){
    const scene = comparisonScene(snapshot);
    if (!scene){
      svg.replaceChildren();
      return false;
    }
    if (!validBounds(viewBox)) viewBox = bounds([snapshot]);
    const {plan, state, walls, demolished, axes} = scene;
    const {x, y, w, h} = viewBox;
    const rooms = roomMarkup(plan, state);
    const wallMarkup = walls.map((wall, i) => {
      const id = 'w' + i;
      return App.draw2d.wallShape(wall, `data-wall="${id}" ${App.draw2d.wallPaint(wall[4], demolished.has(id))}`);
    }).join('');
    const openings = App.draw2d.openingsMarkup(plan.wins.map(drawWindow), plan.doors, plan.slides, plan.bounds, false);
    svg.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
    svg.innerHTML = `<g data-comparison-layer="rooms">${rooms.shapes}</g>
      <g data-comparison-layer="furniture">${furnitureMarkup(state)}</g>
      <g data-comparison-layer="walls">${wallMarkup}</g>
      <g data-comparison-layer="openings">${openings}</g>
      <g data-comparison-layer="labels" aria-hidden="true">${rooms.labels}</g>
      <g data-comparison-layer="dimensions">${dimensionsMarkup(axes)}</g>`;
    return true;
  }

  App.schemesCompare = {bounds, render};
})();
