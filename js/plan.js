/* Plan 数据适配、几何范围与对象查找。
 * 依赖 App.core、App.store、App.geom。
 */
(() => {
  'use strict';
  const App = globalThis.App;

  /* ============================================================
   *  户型方案 Plan（单位 mm，2D 的 y 轴向下；契约见 docs/contract.md §1）
   *  原点 = 左侧外墙内皮 / 顶部外墙内皮。
   *  运行时所有几何都由 PLAN 驱动：WALLS / WINS / DOORS / SLIDES / ROOMS / MATS
   *  只是 PLAN 各字段的别名，installPlan() 在换方案时整体重新赋值，
   *  因此下面既有的渲染 / 交互函数无需关心数据来自哪里。
   *  默认加载 data/empty-plan.json；125-C 示例见 data/125c-plan.json。
   * ============================================================ */

  const DEFAULT_ROOM_MAT = 'tile800';

  const DEFAULT_MATERIALS = {
    wood:    {name:'橡木地板', price:320, sw:'#d8b88a'},
    walnut:  {name:'胡桃木地板', price:380, sw:'#9b7250'},
    tile800: {name:'800 地砖', price:220, sw:'#ebe6dc'},
    tile600: {name:'600 地砖', price:160, sw:'#dfe3e1'},
    marble:  {name:'大理石', price:650, sw:'#f1eee8'},
    antislip:{name:'300 防滑砖', price:140, sw:'#d3d8d4'},
    terrazzo:{name:'水磨石', price:280, sw:'#e6dfd3'},
    carpet:  {name:'满铺地毯', price:200, sw:'#c9c3d3'},
  };

  // 内置兜底空方案：file:// 打开（fetch 不可用）或服务不可用时用它启动，与 data/empty-plan.json 一致
  const FALLBACK_PLAN = {
    version: 1,
    name: '空户型',
    bounds: {x:-1000, y:-1000, w:10240, h:8240},
    walls: [
      [0,-240,8240,0,'e'], [8000,0,8240,6000,'e'], [0,6000,8240,6240,'e'], [-240,0,0,6000,'e'],
    ],
    wins: [], doors: [], slides: [],
    rooms: [
      {id:'room1', name:'客厅', poly:[[0,0],[8000,0],[8000,6000],[0,6000]], mat:DEFAULT_ROOM_MAT, at:[4000,3000]},
    ],
    materials: App.core.deepCopy(DEFAULT_MATERIALS),
  };

  // 方案范围：墙体 / 窗 / 房间的外接矩形，四边留白
  function planExtentOf(plan){
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const grow = (x, y) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
    const growRect = ([x0,y0,x1,y1]) => { grow(x0, y0); grow(x1, y1); };
    [...plan.walls, ...plan.wins].forEach(w => growRect(Array.isArray(w) ? w : App.geom.curveBounds(App.geom.curvedSpan(w))));
    plan.rooms.forEach(room => {
      room.poly.forEach(p => grow(...p));
      App.geom.roomCurves(room).forEach(curve => growRect(App.geom.curveBounds(curve)));
    });
    if (!Number.isFinite(x0)) return {x:-4000, y:-4000, w:8000, h:8000};
    const pad = Math.max(600, Math.max(x1 - x0, y1 - y0) * .12);
    return {x:x0 - pad, y:y0 - pad, w:Math.round(x1 - x0 + pad*2), h:Math.round(y1 - y0 + pad*2)};
  }

  /* ---------- Plan 校验 / 安装（与 lib/codex/plan.mjs 的 validatePlan 口径一致） ---------- */
  const WALL_KINDS = ['e', 'b', 'n', 'low'];
  const DEFAULT_WALL_HEIGHT = 2800, DEFAULT_LOW_WALL_HEIGHT = 1000;
  const wallHeight = wall => wall[5] ?? (wall[4] === 'low' ? DEFAULT_LOW_WALL_HEIGHT : DEFAULT_WALL_HEIGHT);

  /**
   * 校验并规整 Plan（契约 §1）。宽容：能修的字段就地修，没有房间视为无效。
   * @returns {{ok:boolean, plan:object|null, errors:string[]}}
   */
  function sanitizePlan(input){
    const errors = [];
    let raw = input;
    if (typeof raw === 'string'){ try { raw = JSON.parse(raw); } catch(e){ return {ok:false, plan:null, errors:['不是有效的 JSON']}; } }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {ok:false, plan:null, errors:['Plan 必须是 JSON 对象']};

    const materials = {};
    if (raw.materials && typeof raw.materials === 'object' && !Array.isArray(raw.materials)){
      for (const [key, m] of Object.entries(raw.materials)){
        if (!key || !m || typeof m !== 'object') continue;
        materials[key] = {
          name: typeof m.name === 'string' && m.name ? m.name : key,
          price: App.core.numOr(m.price),
          sw: /^#[0-9a-f]{3,8}$/i.test(m.sw || '') ? m.sw : '#e5e0d6',
        };
      }
    }
    for (const [k, v] of Object.entries(DEFAULT_MATERIALS)) if (!materials[k]) materials[k] = {...v};
    const matKeys = Object.keys(materials);
    const pickMat = k => materials[k] ? k : matKeys[0];

    const walls = [];
    if (Array.isArray(raw.walls)) raw.walls.forEach((w, i) => {
      if (App.geom.isCurvedSpan(w)){
        if (!App.geom.curvedSpan(w)){ errors.push(App.core.tr(`弧形墙体 ${i} 数据无效`, `Curved wall ${i} is invalid`)); return; }
        const wall = {...App.geom.arcFields(w), kind:WALL_KINDS.includes(w.kind) ? w.kind : 'n'};
        if (Number.isFinite(w.height) && w.height > 0) wall.height = w.height;
        walls.push(wall);
        return;
      }
      const r = Array.isArray(w) ? App.geom.normRect(w) : w && typeof w === 'object' ? App.geom.normRect(w.rect) : null;
      if (!r){ errors.push(App.core.tr(`墙体 ${i} 数据无效`, `Wall ${i} is invalid`)); return; }
      const kind = Array.isArray(w) ? w[4] : w.kind;
      const height = Array.isArray(w) ? w[5] : w.height;
      const wall = [...r, WALL_KINDS.includes(kind) ? kind : 'n'];
      if (Number.isFinite(height) && height > 0) wall.push(height);
      walls.push(wall);
    });

    const wins = [];
    if (Array.isArray(raw.wins)) raw.wins.forEach((w, i) => {
      if (App.geom.isCurvedSpan(w)){
        if (App.geom.curvedSpan(w)) wins.push(App.geom.arcFields(w));
        else errors.push(App.core.tr(`弧形窗 ${i} 数据无效`, `Curved window ${i} is invalid`));
        return;
      }
      const r = App.geom.normRect(Array.isArray(w) ? w : w && w.rect);
      if (r) wins.push(r);
    });

    const doors = [];
    if (Array.isArray(raw.doors)) raw.doors.forEach(d => {
      if (!d || typeof d !== 'object') return;
      const r = App.geom.normRect(d.rect); if (!r) return;
      const door = {
        name: typeof d.name === 'string' && d.name ? d.name : App.core.tr('门', 'Door'),
        rect: r,
        h: App.geom.normPoint(d.h) || [r[0], r[1]],
        c: App.geom.normPoint(d.c) || [0, -1],
        o: App.geom.normPoint(d.o) || [1, 0],
        len: Number.isFinite(+d.len) && +d.len > 0 ? +d.len : Math.max(r[2] - r[0], r[3] - r[1]),
      };
      if (d.entry === true) door.entry = true;
      doors.push(door);
    });

    const slides = [];
    if (Array.isArray(raw.slides)) raw.slides.forEach(s => {
      if (!s || typeof s !== 'object') return;
      const r = App.geom.normRect(s.rect);
      if (r) slides.push({rect:r, v:s.v === true});
    });

    const rooms = [], ids = new Set();
    if (Array.isArray(raw.rooms)) raw.rooms.forEach((r, i) => {
      if (!r || typeof r !== 'object') return;
      let poly = App.geom.normPoly(r.poly);
      if (!poly){ const q = App.geom.normRect(r.rect); if (q) poly = [[q[0],q[1]],[q[2],q[1]],[q[2],q[3]],[q[0],q[3]]]; }
      if (!poly){ errors.push(App.core.tr(`房间 ${i} 缺少有效轮廓`, `Room ${i} has no valid outline`)); return; }
      let id = String(r.id ?? 'room' + (i + 1)).trim() || 'room' + (i + 1);
      while (ids.has(id)) id += '_2';
      ids.add(id);
      const room = {
        id,
        name: typeof r.name === 'string' && r.name.trim() ? r.name.trim() : App.core.tr('房间', 'Room') + ' ' + (rooms.length + 1),
        poly,
        mat: pickMat(typeof r.mat === 'string' ? r.mat : DEFAULT_ROOM_MAT),
      };
      room.at = App.geom.normPoint(r.at) || App.geom.polyCenter(poly);
      if (r.counted === false) room.counted = false;
      if (r.outdoor === true){
        room.outdoor = true;
      } else if (r.bay && typeof r.bay === 'object' && !Array.isArray(r.bay)){
        const {roomId, openingEdges, sillHeight} = r.bay;
        room.bay = {};
        room.counted = false;
        if (typeof roomId === 'string' && roomId.trim() && roomId.trim() !== id) room.bay.roomId = roomId.trim().slice(0, 120);
        if (Array.isArray(openingEdges) && Array.isArray(r.poly) && r.poly.every(p => App.geom.normPoint(p))){
          const valid = openingEdges.filter(edge => Number.isInteger(edge) && edge >= 0 && edge < poly.length);
          if (valid.length) room.bay.openingEdges = [...new Set(valid)];
        }
        if (Number.isFinite(sillHeight) && sillHeight > 0 && sillHeight <= 2500) room.bay.sillHeight = sillHeight;
      }
      if (r.arcs !== undefined){
        const edges = new Set(), arcs = [];
        if (!Array.isArray(r.arcs) || !Array.isArray(r.poly) || !r.poly.every(p => App.geom.normPoint(p))){
          errors.push(App.core.tr(`房间 ${id} 圆弧轮廓无效`, `Room ${id} has an invalid curved outline`));
        } else for (const arc of r.arcs){
          const {edge, sweep} = arc || {};
          if (!Number.isInteger(edge) || edge < 0 || edge >= poly.length || edges.has(edge) ||
              !App.geom.arcGeometry(poly[edge], poly[(edge + 1) % poly.length], sweep)){
            errors.push(App.core.tr(`房间 ${id} 圆弧边无效`, `Room ${id} has an invalid curved edge`));
            continue;
          }
          edges.add(edge); arcs.push({edge, sweep});
        }
        if (Array.isArray(r.arcs)) room.arcs = arcs;
      }
      rooms.push(room);
    });
    if (!rooms.length) return {ok:false, plan:null, errors:errors.concat(App.core.tr('方案至少需要一个房间', 'A plan needs at least one room'))};

    let bounds = null;
    if (raw.bounds && typeof raw.bounds === 'object'){
      const b = [raw.bounds.x, raw.bounds.y, raw.bounds.w, raw.bounds.h].map(Number);
      if (b.every(Number.isFinite) && b[2] > 0 && b[3] > 0) bounds = {x:b[0], y:b[1], w:b[2], h:b[3]};
    }

    const plan = {
      version: 1,
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : App.core.tr('未命名方案', 'Untitled plan'),
      bounds: bounds || planExtentOf({walls, wins, rooms}),
      walls, wins, doors, slides, rooms, materials,
    };
    return {ok:true, plan, errors};
  }

  // 同一门洞的左右门扇可能分别保存为半幅门洞，也可能各自带完整门洞。
  function groupSwingDoors(doors){
    const tolerance = 20; // mm，容纳图纸识别误差。
    const near = (a, b) => Math.abs(a - b) <= tolerance;
    const spans = doors.map(({rect, h, c, o, len}) => {
      const axis = rect[2] - rect[0] >= rect[3] - rect[1] ? 0 : 1;
      const across = 1 - axis;
      const direction = Math.sign(c[axis]), opens = Math.sign(o[across]);
      if (!direction || !opens || Math.abs(c[across]) > Math.abs(c[axis]) * .05 ||
          Math.abs(o[axis]) > Math.abs(o[across]) * .05 ||
          !near(h[axis], rect[axis + (direction > 0 ? 0 : 2)]) ||
          h[across] < rect[across] - tolerance || h[across] > rect[across + 2] + tolerance) return null;
      return {axis, across, direction, opens, rect, pivot:h[across], tip:h[axis] + len * direction};
    });
    const matches = doors.map(() => []);
    spans.forEach((left, i) => {
      if (left?.direction !== 1) return;
      const {axis, across} = left;
      spans.forEach((right, j) => {
        if (right?.direction !== -1 || right.axis !== axis || right.opens !== left.opens ||
            !near(left.pivot, right.pivot) || !near(left.tip, right.tip) ||
            !near(left.rect[across], right.rect[across]) ||
            !near(left.rect[across + 2], right.rect[across + 2])) return;
        const shared = near(left.rect[axis], right.rect[axis]) && near(left.rect[axis + 2], right.rect[axis + 2]);
        const split = near(left.rect[axis + 2], right.rect[axis]) &&
          near(left.tip, left.rect[axis + 2]) && near(right.tip, right.rect[axis]);
        if (shared || split){ matches[i].push(j); matches[j].push(i); }
      });
    });
    return doors.flatMap((door, index) => {
      const candidates = matches[index], [other] = candidates;
      if (candidates.length !== 1 || matches[other].length !== 1){
        return [{index, rect:door.rect, leaves:[door]}];
      }
      if (other < index) return [];
      const partner = doors[other], [x0, y0, x1, y1] = door.rect, [a0, b0, a1, b1] = partner.rect;
      const rect = [Math.min(x0, a0), Math.min(y0, b0), Math.max(x1, a1), Math.max(y1, b1)];
      return [{index, rect, leaves:[door, partner]}];
    });
  }

  /* ---------- 房间 / 墙体查找（Plan 与 state 的桥） ---------- */
  const validWallId = id => typeof id === 'string' && /^w\d+$/.test(id) && +id.slice(1) < App.store.WALLS.length;
  const matKey = k => (App.store.MATS && App.store.MATS[k]) ? k : (Object.keys(App.store.MATS || {})[0] || DEFAULT_ROOM_MAT);
  const matInfo = k => (App.store.MATS && App.store.MATS[k]) || {name: String(k || '—'), price: 0, sw: '#e5e0d6'};
  const roomDef = id => App.store.ROOMS.find(r => r.id === id) || null;
  const wallOf = id => validWallId(id) ? App.store.WALLS[+id.slice(1)] : null;

  Object.assign(App.plan, {
    FALLBACK_PLAN, DEFAULT_WALL_HEIGHT, wallHeight, sanitizePlan, validWallId, matKey, matInfo,
    roomDef, wallOf, groupSwingDoors,
  });
})();
