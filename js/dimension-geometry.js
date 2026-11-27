/* 施工尺寸取自模型中的墙面和房间轮廓，单位 mm。依赖 App.geom。 */
(() => {
  'use strict';
  const App = globalThis.App;
  const EPSILON = 1e-6;
  const TAU = 2 * Math.PI;

  const validPoint = point => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]);
  const reference = (axis, point) => ({value:point[axis], across:point[1 - axis]});

  // 圆弧两端和沿弧扫过的四个轴向极点都可能是外尺寸的实际端点。
  function arcExtremes(curve, offsets){
    const fractions = [0, 1];
    for (let quadrant = 0; quadrant < 4; quadrant++){
      const angle = quadrant * Math.PI / 2;
      const delta = (angle - curve.start) * Math.sign(curve.sweep);
      const fraction = ((delta % TAU + TAU) % TAU) / Math.abs(curve.sweep);
      if (fraction > 0 && fraction < 1) fractions.push(fraction);
    }
    return offsets.flatMap(offset => fractions.map(fraction => App.geom.curvePoint(curve, fraction, offset)));
  }

  function wallExtremes(wall){
    const [x0, y0, x1, y1, , , curve] = wall;
    if (curve) return arcExtremes(curve, [-curve.thickness / 2, curve.thickness / 2]);
    return [[x0,y0], [x0,y1], [x1,y0], [x1,y1]];
  }

  function totalSpan(axis, exterior, footprint){
    let start, end;
    for (const group of [exterior, footprint]){
      let first, last;
      for (const point of group){
        const next = reference(axis, point);
        if (!first || next.value < first.value - EPSILON ||
            (Math.abs(next.value - first.value) <= EPSILON && next.across < first.across)) first = next;
        if (!last || next.value > last.value + EPSILON ||
            (Math.abs(next.value - last.value) <= EPSILON && next.across < last.across)) last = next;
      }
      if (first && (!start || first.value < start.value - EPSILON)) start = first;
      if (last && (!end || last.value > end.value + EPSILON)) end = last;
    }
    return start && end.value - start.value > EPSILON ? [start, end] : null;
  }

  function chainPoints(axis, walls, total){
    const across = 1 - axis;
    const [start, end] = total;
    const faces = [];
    for (const wall of walls){
      if (wall[6]) continue;
      const value = wall[axis], far = wall[axis + 2], thickness = far - value;
      const length = wall[across + 2] - wall[across];
      // 每个垂直于尺寸方向的墙段只取坐标较小的一面。
      if (length <= thickness) continue;
      faces.push({value, far, across:wall[across]});
    }
    faces.sort((a,b) => a.value - b.value || a.across - b.across);
    const bands = [];
    for (const face of faces){
      // 合并相接或交叠的墙位，再排除两端的围护墙及其内皮。
      const previous = bands.at(-1);
      if (previous && face.value <= previous.far + EPSILON) previous.far = Math.max(previous.far, face.far);
      else bands.push(face);
    }
    const interior = bands.filter(face => face.value > start.value + EPSILON && face.far < end.value - EPSILON);
    return [start, ...interior.map(({value, across}) => ({value, across})), end];
  }

  function layout({walls = [], rooms = [], demolished = []} = {}){
    const removed = new Set(demolished);
    const active = walls.filter((wall, index) => !removed.has('w' + index) &&
      Array.isArray(wall) && wall.length >= 4 && wall.slice(0, 4).every(Number.isFinite));
    const exterior = active.filter(wall => wall[4] === 'e');
    const outer = (exterior.length ? exterior : active).flatMap(wallExtremes);
    const footprint = [];
    for (const room of rooms){
      const vertices = (room?.vertices || room?.poly || []).filter(validPoint);
      footprint.push(...vertices);
      if (!room?.arcs?.length || vertices.length < 3) continue;
      App.geom.roomCurves(room).forEach(curve => {
        if (curve) footprint.push(...arcExtremes(curve, [0]));
      });
    }
    const x = totalSpan(0, outer, footprint), y = totalSpan(1, outer, footprint);
    if (!x || !y) return null;
    return {x:{total:x, points:chainPoints(0, active, x)}, y:{total:y, points:chainPoints(1, active, y)}};
  }

  function intersections(poly, axis, across){
    const other = 1 - axis;
    const hits = [];
    for (let i = 0; i < poly.length; i++){
      const a = poly[i], b = poly[(i + 1) % poly.length];
      // 半开区间使共享端点只参与一次交点计数。
      if ((a[other] > across) === (b[other] > across)) continue;
      const t = (across - a[other]) / (b[other] - a[other]);
      hits.push(a[axis] + t * (b[axis] - a[axis]));
    }
    hits.sort((a,b) => a - b);
    const spans = [];
    for (let i = 0; i + 1 < hits.length; i += 2){
      if (hits[i + 1] - hits[i] > EPSILON) spans.push([hits[i], hits[i + 1]]);
    }
    return spans;
  }

  function roomSpans(room, hint){
    if (!Array.isArray(room?.poly)) return null;
    // 已安装的弧形房间带有按绘制弧线采样过的 poly。
    const poly = (room.vertices ? room.poly : App.geom.roomOutline(room)).filter(validPoint);
    if (poly.length < 3) return null;

    const atPoint = point => {
      if (!validPoint(point)) return null;
      const span = axis => {
        const across = point[1 - axis];
        const section = intersections(poly, axis, across)
          .find(([lo, hi]) => point[axis] > lo + EPSILON && point[axis] < hi - EPSILON);
        return section?.map(value => ({value, across}));
      };
      const x = span(0), y = span(1);
      return x && y ? {x, y} : null;
    };
    const preferred = atPoint(hint) || atPoint(room.at);
    if (preferred) return preferred;

    // 标签位置可能落到凹区外。找一个穿过室内的截面，再用同一点测另一个方向。
    const levels = [...new Set(poly.map(point => point[1]))].sort((a,b) => a - b);
    if (levels.length < 2) return null;
    const horizontalCenter = (levels[0] + levels.at(-1)) / 2;
    let widestBand = [levels[0], levels[1]];
    for (let i = 1; i + 1 < levels.length; i++){
      if (levels[i + 1] - levels[i] > widestBand[1] - widestBand[0]) widestBand = [levels[i], levels[i + 1]];
    }
    for (const y of [horizontalCenter, (widestBand[0] + widestBand[1]) / 2]){
      const sections = intersections(poly, 0, y).sort((a,b) => (b[1] - b[0]) - (a[1] - a[0]));
      for (const [lo, hi] of sections){
        const found = atPoint([(lo + hi) / 2, y]);
        if (found) return found;
      }
    }
    return null;
  }

  Object.assign(App.dimensionGeometry, {layout, roomSpans});
})();
