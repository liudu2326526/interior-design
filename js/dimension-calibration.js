/* 户型平面坐标校准。
 * 依赖 App.core、App.plan、App.store、App.geom、App.draw2d。
 */
(() => {
  'use strict';
  const App = globalThis.App;
  const EPSILON = .001;
  const isPoint = point => Array.isArray(point) && point.length === 2 && Number.isFinite(point[0]) && Number.isFinite(point[1]);
  const invalidDimension = () => ({ok:false, error:App.core.tr(
    '标定需要两个在所选方向上分开的端点和大于 0 的实际长度。',
    'Calibration needs two points separated along the selected axis and a positive measured length.')});
  const invalidGeometry = () => ({ok:false, error:App.core.tr(
    '这个长度会使户型坐标或尺寸失效，请核对实际长度。',
    'This length would invalidate the plan geometry. Check the measured length.')});

  function validateGeometry(plan){
    const {x, y, w, h} = plan.bounds;
    if (![x, y, w, h, x + w, y + h, w * h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
    const result = App.plan.sanitizePlan(plan);
    if (!result.ok || result.errors.length ||
        ['walls', 'wins', 'doors', 'slides', 'rooms'].some(key => result.plan[key].length !== plan[key].length) ||
        result.plan.rooms.some((room, i) => room.poly.length !== plan.rooms[i].poly.length)) return null;
    return result.plan;
  }

  function applyGeometry(plan, updateState = () => {}){
    App.store.mutate(() => {
      App.store.installPlan(plan);
      updateState(App.store.state);
      App.geom.buildDefs();
      App.draw2d.renderDims();
      App.draw2d.renderOpenings();
    });
  }

  function resize(axis, a, b, target){
    if ((axis !== 'x' && axis !== 'y') || !isPoint(a) || !isPoint(b) ||
        !Number.isFinite(target) || target <= 0) return invalidDimension();
    const coordinate = axis === 'x' ? 0 : 1;
    const oldLength = Math.abs(b[coordinate] - a[coordinate]);
    if (!Number.isFinite(oldLength) || oldLength <= 0) return invalidDimension();
    const scale = target / oldLength;
    if (!Number.isFinite(scale) || scale <= 0) return invalidGeometry();
    if (scale === 1) return {ok:true};

    const point = ([x, y]) => {
      const next = [a[0] + (x - a[0]) * scale, a[1] + (y - a[1]) * scale];
      if (!isPoint(next)) throw new RangeError('Invalid scaled point');
      return next;
    };
    const length = value => {
      const next = value * scale;
      if (!Number.isFinite(next) || (value > 0 && next <= 0)) throw new RangeError('Invalid scaled length');
      return next;
    };
    const rectangle = ([x0, y0, x1, y1]) => {
      const start = point([x0, y0]);
      const end = point([x1, y1]);
      if ((x0 !== x1 && start[0] === end[0]) || (y0 !== y1 && start[1] === end[1])) {
        throw new RangeError('Collapsed rectangle');
      }
      return [...start, ...end];
    };
    const span = raw => Array.isArray(raw)
      ? [...rectangle(raw), ...raw.slice(4)]
      : {...raw, from:point(raw.from), to:point(raw.to), thickness:length(raw.thickness)};
    const measurePoint = raw => {
      const [x, y] = point([raw.x, raw.y]);
      return {...raw, x, y};
    };

    let nextPlan, furniture, measures, ceiling;
    try {
      const actual = Math.abs(point(b)[coordinate] - a[coordinate]);
      if (actual <= 0 || Math.abs(actual - target) > Math.max(1e-7, target * 1e-12)) return invalidGeometry();
      const current = App.store.PLAN;
      const bounds = current.bounds;
      const [x, y] = point([bounds.x, bounds.y]);
      const plan = {
        ...current,
        bounds:{x, y, w:length(bounds.w), h:length(bounds.h)},
        walls:current.walls.map(span),
        wins:current.wins.map(span),
        doors:current.doors.map(door => ({...door, rect:rectangle(door.rect), h:point(door.h), len:length(door.len)})),
        slides:current.slides.map(slide => ({...slide, rect:rectangle(slide.rect)})),
        rooms:current.rooms.map(room => ({...room, poly:room.poly.map(point), at:point(room.at)})),
      };
      nextPlan = validateGeometry(plan);
      if (!nextPlan) return invalidGeometry();

      // 家具和构件按实际尺寸保留，只调整它们在户型中的位置。
      furniture = App.store.state.furniture.map(item => {
        const [cx, cy] = point([item.cx, item.cy]);
        return {...item, cx, cy};
      });
      measures = App.store.state.measures.map(item => ({...item, a:measurePoint(item.a), b:measurePoint(item.b)}));
      const previousCeiling = App.store.state.ceiling;
      const ceilingRooms = Object.fromEntries(Object.entries(previousCeiling.rooms).map(([id, room]) => [id, {
        ...room,
        zones:room.zones.map(zone => ({
          ...zone, poly:zone.poly.map(point),
          ...(zone.holes ? {holes:zone.holes.map(hole => hole.map(point))} : {}),
          ...(zone.preset ? {preset:{...zone.preset, width:length(zone.preset.width)}} : {}),
        })),
      }]));
      ceiling = {...previousCeiling, rooms:ceilingRooms};
      App.ceilingModel.validate(App.ceilingFurniture.project(ceiling,furniture,nextPlan.rooms), nextPlan.rooms);
    } catch {
      return invalidGeometry();
    }

    applyGeometry(nextPlan, state => {
      state.furniture = furniture;
      state.measures = measures;
      state.ceiling = ceiling;
    });
    return {ok:true};
  }

  const near = (a, b) => Math.abs(a - b) <= EPSILON;
  const inside = (value, lo, hi) => value >= lo - EPSILON && value <= hi + EPSILON;
  const overlap = (a, b, axis) => Math.min(a[axis + 2], b[axis + 2]) - Math.max(a[axis], b[axis]);
  const touches = (a, b) => overlap(a, b, 0) >= -EPSILON && overlap(a, b, 1) >= -EPSILON;
  const intersects = (a, b) => overlap(a, b, 0) > EPSILON && overlap(a, b, 1) > EPSILON;
  const contains = (rect, point) => inside(point[0], rect[0], rect[2]) && inside(point[1], rect[1], rect[3]);
  class WallMoveError extends Error {}
  const error = (zh, en) => { throw new WallMoveError(App.core.tr(zh, en)); };

  // 只改能从矩形接缝明确判定的墙体连接，防止误改给定端点之外的结构。
  function moveWall(axis, a, b, target, wallIndex){
    if ((axis !== 'x' && axis !== 'y') || !isPoint(a) || !isPoint(b) ||
        !Number.isFinite(target) || target <= 0) return invalidDimension();
    const n = axis === 'x' ? 0 : 1, t = 1 - n;
    const distance = b[n] - a[n], delta = Math.sign(distance) * target - distance;
    if (!Number.isFinite(distance) || Math.abs(distance) <= EPSILON) return invalidDimension();
    const plan = App.store.PLAN;
    const wall = Number.isInteger(wallIndex) ? plan.walls[wallIndex] : null;
    const wrongWall = () => ({ok:false, error:App.core.tr(
      '请选择尺寸终点处、与尺寸方向垂直的一道直墙墙面。',
      'Pick the face of a straight wall perpendicular to the dimension at its end point.')});
    if (!Array.isArray(wall) || App.store.state.demolished.includes('w' + wallIndex) ||
        wall[n + 2] - wall[n] <= EPSILON || wall[t + 2] - wall[t] <= wall[n + 2] - wall[n] ||
        !(near(b[n], wall[n]) || near(b[n], wall[n + 2])) || !inside(b[t], wall[t], wall[t + 2])) return wrongWall();
    if (delta === 0) return {ok:true};
    if (!Number.isFinite(delta)) return invalidGeometry();

    const shift = (rect, ...faces) => rect.map((value, i) => faces.includes(i) ? value + delta : value);
    const inBand = value => inside(value, wall[n], wall[n + 2]);
    const withinWall = rect => inside(rect[t], wall[t], wall[t + 2]) && inside(rect[t + 2], wall[t], wall[t + 2]);
    const fixedStart = () => error('起点也会随这面墙移动，请重新选择固定端。',
      'The start point would also move with this wall. Choose a fixed start.');
    const ambiguousJoin = () => error('这段墙有弧线、交叉或分段连接，无法确定单墙移动范围。',
      'A curved, crossing or segmented connection makes this wall move ambiguous.');
    const collision = () => error('这次移动会跨过未随动的墙、门窗或房间边界。',
      'This move would cross a wall, opening or room boundary that is not attached to the selected wall.');
    const collapse = () => error('这次移动会压扁或反转相接的墙体或房间。',
      'This move would collapse or invert a connected wall or room.');
    const sweep = [];
    const arcBounds = item => App.geom.curveBounds(App.geom.curvedSpan(item));
    const movesThrough = rect => sweep.some(area => intersects(area, rect));
    const curvedJoin = rect => sweep.some(area => touches(area, rect));

    let nextPlan;
    try {
      const movedWall = shift(wall, n, n + 2);
      if (!movedWall.slice(0, 4).every(Number.isFinite) || movedWall[n + 2] - movedWall[n] <= EPSILON) collapse();
      const affectedWall = wall.slice(0, 4);
      affectedWall[n] = Math.min(wall[n], movedWall[n]);
      affectedWall[n + 2] = Math.max(wall[n + 2], movedWall[n + 2]);
      sweep.push(affectedWall);
      if (contains(wall, a) || contains(movedWall, a)) fixedStart();
      const face = near(b[n], wall[n]) ? n : n + 2;
      const movedFace = movedWall[face] + (b[n] - wall[face]);
      if (!near(Math.abs(movedFace - a[n]), target)) return invalidGeometry();
      const walls = plan.walls.map((item, index) => {
        if (index === wallIndex) return movedWall;
        if (!Array.isArray(item) || !touches(wall, item)) return item;
        const from = inBand(item[n]), to = inBand(item[n + 2]);
        const transverse = item[n + 2] - item[n] > item[t + 2] - item[t];
        if (!transverse || from === to) ambiguousJoin();
        const unchangedFace = from ? item[n + 2] : item[n];
        if (contains(item, a) && !near(a[n], unchangedFace)) fixedStart();
        const end = from ? n : n + 2;
        const moved = shift(item, end);
        // 只记录改动端在移动过程中扫过的区域。
        const affected = item.slice(0, 4);
        affected[n] = Math.min(item[end], moved[end]);
        affected[n + 2] = Math.max(item[end], moved[end]);
        if (!affected.every(Number.isFinite) || moved[n + 2] - moved[n] <= EPSILON) collapse();
        sweep.push(affected);
        return moved;
      });
      plan.walls.forEach((item, i) => {
        if (walls[i] !== item) return;
        if (!Array.isArray(item) && curvedJoin(arcBounds(item))) ambiguousJoin();
        if (Array.isArray(item) && movesThrough(item)) collision();
      });

      const opening = rect => {
        if (!touches(wall, rect)){
          if (movesThrough(rect)) collision();
          return rect;
        }
        if (!inBand(rect[n]) || !inBand(rect[n + 2]) || !withinWall(rect)) ambiguousJoin();
        return shift(rect, n, n + 2);
      };
      const wins = plan.wins.map(win => {
        if (Array.isArray(win)) return opening(win);
        if (curvedJoin(arcBounds(win))) ambiguousJoin();
        return win;
      });
      const doors = plan.doors.map(door => {
        const rect = opening(door.rect);
        if (rect === door.rect) return door;
        return {...door, rect, h:shift(door.h, n)};
      });
      const slides = plan.slides.map(slide => ({...slide, rect:opening(slide.rect)}));

      const rooms = plan.rooms.map(room => {
        const xs = room.poly.map(point => point[0]), ys = room.poly.map(point => point[1]);
        const rect = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
        for (const curve of App.geom.roomCurves(room).values()){
          if (curvedJoin(App.geom.curveBounds(curve))) ambiguousJoin();
        }
        if (overlap(wall, rect, t) <= EPSILON || overlap(wall, rect, n) < -EPSILON){
          if (movesThrough(rect)) collision();
          return room;
        }
        const from = inBand(rect[n]), to = inBand(rect[n + 2]);
        const orthogonal = room.poly.length === 4 && room.poly.every((point, i) => {
          const next = room.poly[(i + 1) % 4];
          return near(point[0], next[0]) !== near(point[1], next[1]);
        });
        if (room.arcs?.length || !orthogonal || from === to || !withinWall(rect)){
          error('相接的房间有弧线、凹角或净边跨出所选墙段，无法单独移动。',
            'A connected room is curved, nonrectangular or extends beyond the selected wall segment.');
        }
        const movingFace = from ? rect[n] : rect[n + 2], fixedFace = from ? rect[n + 2] : rect[n];
        if (contains(rect, a) && !near(a[n], fixedFace)) fixedStart();
        const movedFace = movingFace + delta;
        if ((fixedFace - movedFace) * Math.sign(fixedFace - movingFace) <= EPSILON) collapse();
        const poly = room.poly.map(point => near(point[n], movingFace) ? shift(point, n) : point);
        const at = [...room.at];
        const fraction = Math.max(0, Math.min(1, (at[n] - fixedFace) / (movingFace - fixedFace)));
        at[n] += fraction * delta;
        return {...room, poly, at};
      });

      const bounds = {...plan.bounds};
      const size = n === 0 ? 'w' : 'h';
      const low = Math.min(...sweep.map(rect => rect[n]));
      const high = Math.max(...sweep.map(rect => rect[n + 2]));
      const end = Math.max(bounds[axis] + bounds[size], high + 600);
      bounds[axis] = Math.min(bounds[axis], low - 600);
      bounds[size] = end - bounds[axis];
      nextPlan = validateGeometry({...plan, bounds, walls, wins, doors, slides, rooms});
      if (!nextPlan) return invalidGeometry();
    } catch (cause) {
      return cause instanceof WallMoveError ? {ok:false, error:cause.message} : invalidGeometry();
    }
    try {
      App.ceilingModel.validate(App.ceilingFurniture.current(), nextPlan.rooms);
    } catch (cause) {
      return {ok:false, error:App.core.tr('移动后的房间与天花设计冲突', 'The moved room conflicts with its ceiling design') + ' · ' + cause.message};
    }
    applyGeometry(nextPlan);
    return {ok:true};
  }

  Object.assign(App.dimensionCalibration, {resize, moveWall});
})();
