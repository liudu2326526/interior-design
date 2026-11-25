/**
 * 图纸复核的纯函数：规则初查、提示词拼装、复核结果解析、与识别结果的差异统计。
 * 不依赖 HTTP / codex，方便单元测试。
 */
import { arcGeometry, extractJson, polyArea, validateImportedFurniture, validatePlan } from './codex/plan.mjs';

const MAX_CHECK_ISSUES = 12;
const MAX_CHECK_WHERE = 40;
const MAX_CHECK_DETAIL = 120;
const MAX_REVIEW_ISSUES = 8;
const MAX_ISSUE_WHERE = 60;
const MAX_ISSUE_DETAIL = 200;
const MAX_SUMMARY = 120;
const WALL_TOLERANCE_MM = 60;
const MIN_AREA_RATIO = 0.25;
const MAX_AREA_RATIO = 1.05;
const OVERLAP_RATIO = 0.02;
const OVERLAP_GRID = 32;
/** 两两重叠检查是 O(N²)×1024；房间数超过上限时跳过，避免卡住事件循环。 */
const MAX_OVERLAP_ROOMS = 64;

const isNum = (value) => typeof value === 'number' && Number.isFinite(value);

function cut(value, max) {
  const text = String(value ?? '');
  return text.length > max ? text.slice(0, max) : text;
}

function pushIssue(list, where, detail) {
  if (list.length >= MAX_CHECK_ISSUES) return;
  list.push({
    where: cut(where, MAX_CHECK_WHERE),
    detail: cut(detail, MAX_CHECK_DETAIL),
  });
}

function polyPoints(value) {
  if (!Array.isArray(value)) return [];
  const points = [];
  for (const point of value) {
    if (!Array.isArray(point) || point.length < 2) continue;
    const x = Number(point[0]);
    const y = Number(point[1]);
    if (!isNum(x) || !isNum(y)) continue;
    points.push([x, y]);
  }
  return points.length >= 3 ? points : [];
}

/** 带圆弧边的房间面积（mm²）；口径与 lib/codex/plan.mjs 的 summarizePlan 一致。 */
function roomArea(points, arcs) {
  const area = polyArea(points, Array.isArray(arcs) ? arcs : []);
  return Number.isFinite(area) ? Math.abs(area) : 0;
}

function bbox(points) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return Number.isFinite(minX) ? { x0: minX, y0: minY, x1: maxX, y1: maxY } : null;
}

/** 射线法判断点是否在多边形内。 */
function pointInPolygon(points, x, y) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function wallRect(wall) {
  const rect = Array.isArray(wall) ? wall : wall?.rect;
  if (!Array.isArray(rect) || rect.length < 4) return null;
  const [x0, y0, x1, y1] = rect.slice(0, 4).map(Number);
  if (![x0, y0, x1, y1].every(isNum)) return null;
  return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
}

/** 圆弧墙的中心线、半径与半厚；无效的弧墙返回 null。 */
function wallArc(wall) {
  if (!wall || typeof wall !== 'object' || Array.isArray(wall)) return null;
  const arc = arcGeometry(wall.from, wall.to, wall.sweep);
  if (!arc) return null;
  const thickness = Number(wall.thickness);
  return { ...arc, half: Number.isFinite(thickness) && thickness > 0 ? thickness / 2 : 0 };
}

/** 点是否贴在这段弧墙上（中心线容差 = 半厚 + 60mm，端点按直线距离放宽）。 */
function nearArcWall(arc, x, y) {
  const tolerance = arc.half + WALL_TOLERANCE_MM;
  const distance = Math.hypot(x - arc.cx, y - arc.cy);
  if (Math.abs(distance - arc.radius) <= tolerance) {
    const bearing = Math.atan2(y - arc.cy, x - arc.cx);
    const full = Math.PI * 2;
    const delta = (bearing - arc.start) * Math.sign(arc.angle);
    const progress = ((delta % full) + full) % full;
    if (progress <= Math.abs(arc.angle) + 0.0001) return true;
  }
  const endAngle = arc.start + arc.angle;
  return [[arc.cx + arc.radius * Math.cos(arc.start), arc.cy + arc.radius * Math.sin(arc.start)],
    [arc.cx + arc.radius * Math.cos(endAngle), arc.cy + arc.radius * Math.sin(endAngle)]]
    .some(([ex, ey]) => Math.hypot(x - ex, y - ey) <= tolerance);
}

/**
 * 确定性规则初查，返回中文问题列表。
 * @returns {{where:string, detail:string}[]}
 */
export function checkPlan(plan, furniture) {
  const issues = [];
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return issues;

  const walls = Array.isArray(plan.walls) ? plan.walls : [];
  const wallRects = walls.map(wallRect).filter(Boolean);
  const wallArcs = walls.map(wallArc).filter(Boolean);
  // 直墙与圆弧墙都参与贴墙判断；两样都没有时跳过，避免误报。
  const canCheckProximity = wallRects.length > 0 || wallArcs.length > 0;

  const insideWall = ([x, y]) => wallRects.some(([x0, y0, x1, y1]) =>
    x >= x0 - WALL_TOLERANCE_MM && x <= x1 + WALL_TOLERANCE_MM &&
    y >= y0 - WALL_TOLERANCE_MM && y <= y1 + WALL_TOLERANCE_MM) ||
    wallArcs.some(arc => nearArcWall(arc, x, y));
  const alongsideWalls = ([x0, y0, x1, y1]) => {
    const x = (x0 + x1) / 2, y = (y0 + y1) / 2;
    if (insideWall([x, y])) return true;
    const ends = x1 - x0 >= y1 - y0 ? [[x0, y], [x1, y]] : [[x, y0], [x, y1]];
    return ends.every(insideWall);
  };

  if (canCheckProximity) {
    const doors = Array.isArray(plan.doors) ? plan.doors : [];
    doors.forEach((door, index) => {
      const rect = wallRect(door);
      if (!rect || alongsideWalls(rect)) return;
      pushIssue(issues, `门「${door?.name || `第 ${index + 1} 扇`}」`,
        '门洞未对齐墙线或洞口两侧接缝（60mm 容差），请核对门的位置。');
    });

    const wins = Array.isArray(plan.wins) ? plan.wins : [];
    wins.forEach((win, index) => {
      const rect = wallRect(win);
      if (!rect || alongsideWalls(rect)) return; // 弧窗可直接构成围护边界，交给场景校核。
      pushIssue(issues, `窗 ${index + 1}`,
        '窗洞未对齐墙线或洞口两侧接缝（60mm 容差），请核对窗的位置。');
    });
  }

  const rooms = (Array.isArray(plan.rooms) ? plan.rooms : [])
    .map(room => ({ room, points: polyPoints(room?.poly) }))
    .filter(({ room, points }) => room && points.length >= 3 && room.counted !== false);
  const boxes = rooms.map(({ points }) => bbox(points));

  // 两两检查房间多边形是否明显重叠：先 bbox，再用网格点粗估重叠面积。
  // 每个相交房间对固定做 32×32 次点在多边形内判断，房间过多时必须跳过以免阻塞事件循环。
  if (rooms.length > MAX_OVERLAP_ROOMS) {
    pushIssue(issues, '房间重叠检查',
      `房间数量为 ${rooms.length}，超过 ${MAX_OVERLAP_ROOMS} 个，已跳过两两重叠检查。`);
  } else {
    for (let i = 0; i < rooms.length; i++) {
      for (let j = i + 1; j < rooms.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        if (!a || !b) continue;
        const x0 = Math.max(a.x0, b.x0);
        const y0 = Math.max(a.y0, b.y0);
        const x1 = Math.min(a.x1, b.x1);
        const y1 = Math.min(a.y1, b.y1);
        if (x1 <= x0 || y1 <= y0) continue;

        let hits = 0;
        for (let gy = 0; gy < OVERLAP_GRID; gy++) {
          const y = y0 + (gy + 0.5) * (y1 - y0) / OVERLAP_GRID;
          for (let gx = 0; gx < OVERLAP_GRID; gx++) {
            const x = x0 + (gx + 0.5) * (x1 - x0) / OVERLAP_GRID;
            if (pointInPolygon(rooms[i].points, x, y) && pointInPolygon(rooms[j].points, x, y)) hits++;
          }
        }
        if (hits === 0) continue;
        const overlap = hits * ((x1 - x0) * (y1 - y0)) / (OVERLAP_GRID * OVERLAP_GRID);
        const smaller = Math.min(
          roomArea(rooms[i].points, rooms[i].room?.arcs),
          roomArea(rooms[j].points, rooms[j].room?.arcs));
        if (smaller <= 0 || overlap <= smaller * OVERLAP_RATIO) continue;
        const nameA = rooms[i].room?.name || rooms[i].room?.id || `房间 ${i + 1}`;
        const nameB = rooms[j].room?.name || rooms[j].room?.id || `房间 ${j + 1}`;
        pushIssue(issues, `房间「${nameA}」「${nameB}」`,
          `两个房间的多边形明显重叠（约 ${(overlap / 1_000_000).toFixed(1)} ㎡，占较小房间 ${Math.round(overlap / smaller * 100)}%）。`);
      }
    }
  }

  // 计入面积的房间总面积应与图幅范围大致相符。
  const bounds = plan.bounds && typeof plan.bounds === 'object'
    ? [plan.bounds.x, plan.bounds.y, plan.bounds.w, plan.bounds.h].map(Number)
    : null;
  const boundsArea = bounds && bounds.every(isNum) && bounds[2] > 0 && bounds[3] > 0
    ? bounds[2] * bounds[3]
    : 0;
  const usableBounds = Number.isFinite(boundsArea) && boundsArea > 0;
  if (usableBounds && rooms.length) {
    const sum = rooms.reduce((total, { room, points }) => total + roomArea(points, room?.arcs), 0);
    const total = Number.isFinite(sum) ? sum : 0;
    const ratio = total / boundsArea;
    if (ratio < MIN_AREA_RATIO || ratio > MAX_AREA_RATIO) {
      pushIssue(issues, '房间面积',
        `计入面积的房间共 ${(total / 1_000_000).toFixed(1)} ㎡，占图纸范围 ${Math.round(ratio * 100)}%（合理区间 25%–105%）。`);
    }
  }

  // 家具中心必须落在图纸范围内。
  if (usableBounds) {
    const items = Array.isArray(furniture) ? furniture : [];
    items.forEach((item, index) => {
      const cx = Number(item?.cx);
      const cy = Number(item?.cy);
      if (!isNum(cx) || !isNum(cy)) return;
      const inBounds = cx >= bounds[0] && cx <= bounds[0] + bounds[2] &&
        cy >= bounds[1] && cy <= bounds[1] + bounds[3];
      if (inBounds) return;
      pushIssue(issues, `家具「${item?.name || item?.type || `第 ${index + 1} 件`}」`,
        '家具中心在图纸范围之外，请核对坐标。');
    });
  }

  return issues;
}

/**
 * 拼装复核回合的文本输入。
 * @returns {string}
 */
export function buildReviewMessage({ plan, furniture, explanation, note, check, fileNames } = {}) {
  const items = Array.isArray(check) ? check : [];
  const findings = items.length
    ? items.map((item, index) => `${index + 1}. ${item.where}：${item.detail}`).join('\n')
    : '（规则初查没有发现问题。）';
  const names = (Array.isArray(fileNames) ? fileNames : []).filter(name => typeof name === 'string' && name);
  const files = names.length ? names.map(name => `- ${name}`).join('\n') : '（工作目录中没有其他文件。）';

  return [
    '请复核下面这份户型识别结果，并只在图面明确可见的差异上给出修正。',
    '',
    '## 任务说明',
    '你是独立校对员，没有参与这次识别。请对照原图和 review-plan.png，检查 Plan 与家具是否与图纸一致。',
    '只修图面明确可见的差异；无关内容逐字保持不变（房间名、id、材质、家具参数、坐标风格）。',
    '整体旋转、镜像或朝向差异只写进 issues，不要逐件重排。拿不准就不改，并写进 issues。',
    '家具符号、尺寸线、图例不算差异。',
    '',
    '## Plan JSON（待复核）',
    '```json',
    JSON.stringify(plan ?? null, null, 2),
    '```',
    '',
    '## 家具 furniture（待复核）',
    '```json',
    JSON.stringify(Array.isArray(furniture) ? furniture : [], null, 2),
    '```',
    '',
    '## 识别说明（仅供参考，不作为修改依据）',
    typeof explanation === 'string' && explanation.trim() ? cut(explanation.trim(), 4000) : '（无识别说明）',
    '',
    '## 用户备注',
    typeof note === 'string' && note.trim() ? cut(note.trim(), 1000) : '（无用户备注）',
    '',
    '## 规则初查发现',
    findings,
    '',
    '## 工作目录文件',
    files,
    '',
    '## 输出要求',
    '严格输出一个 JSON 对象（不要 markdown 代码块，不要多余文字）：',
    '{"verdict":"match"|"differ","summary":"不超过80字","issues":[{"where":"","detail":""}],"fixed":{"plan":{...},"furniture":[...]}|null}',
    'fixed 必须是完整、能被 validatePlan 接受的 Plan（schema 同 plan-import.md §2，至少一个房间）。',
    '没有需要修正的内容时 verdict 用 match，fixed 用 null。',
  ].join('\n');
}

/**
 * 解析复核回复。
 * @returns {{verdict:'match'|'differ', summary:string, issues:{where:string, detail:string}[], fixed:{plan:object, furniture:object[]}|null}}
 * @throws {Error} 名称固定为 ReviewParseError，调用方据此标记 refuses/unavailable。
 */
export function parseReviewReply(text, { plan, furniture } = {}) {
  const parsed = extractJson(typeof text === 'string' ? text : '');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const error = new Error('复核结果无法解析（no review JSON）');
    error.name = 'ReviewParseError';
    throw error;
  }

  // verdict 只认契约里的两个值：缺失或未知值按模型输出不合契约处理（复核静默不可用）。
  if (parsed.verdict !== 'match' && parsed.verdict !== 'differ') {
    const error = new Error('复核结果缺少合法的 verdict（invalid review verdict）');
    error.name = 'ReviewParseError';
    throw error;
  }
  const verdict = parsed.verdict;
  const summary = cut(typeof parsed.summary === 'string' ? parsed.summary.trim() : '', MAX_SUMMARY);

  const issues = [];
  const rawIssues = verdict === 'match' ? [] : (Array.isArray(parsed.issues) ? parsed.issues : []);
  for (const item of rawIssues) {
    if (issues.length >= MAX_REVIEW_ISSUES) break;
    let where = '';
    let detail = '';
    if (typeof item === 'string') {
      detail = item;
    } else if (item && typeof item === 'object') {
      where = item.where ?? item.title ?? '';
      detail = item.detail ?? item.message ?? item.text ?? '';
    } else {
      continue;
    }
    if (!String(where).trim() && !String(detail).trim()) continue;
    issues.push({
      where: cut(String(where).trim(), MAX_ISSUE_WHERE),
      detail: cut(String(detail).trim(), MAX_ISSUE_DETAIL),
    });
  }

  let fixed = null;
  if (verdict === 'differ' && parsed.fixed && typeof parsed.fixed === 'object' && !Array.isArray(parsed.fixed)) {
    const validated = validatePlan(parsed.fixed.plan);
    if (validated.ok) {
      const fallback = Array.isArray(furniture) ? furniture : [];
      fixed = {
        plan: validated.plan,
        furniture: validateImportedFurniture(parsed.fixed.furniture ?? fallback, validated.plan.bounds),
      };
    }
  }

  // differ 却既没有问题说明也没有可用修正时，展示出来就是「发现 0 处差异」的自相矛盾卡片。
  if (verdict === 'differ' && issues.length === 0 && !fixed) {
    const error = new Error('复核结果没有可展示的差异（empty review）');
    error.name = 'ReviewParseError';
    throw error;
  }

  return { verdict, summary, issues, fixed };
}

function countOf(value) {
  return Array.isArray(value) ? value.length : 0;
}

function roomsOf(plan) {
  return Array.isArray(plan?.rooms) ? plan.rooms.filter(room => room && typeof room === 'object') : [];
}

function round1(value) {
  const number = Number.isFinite(value) ? value : 0;
  return Math.round(number * 10) / 10;
}

function countedArea(plan) {
  let total = 0;
  for (const room of roomsOf(plan)) {
    if (room.counted === false) continue;
    total += roomArea(polyPoints(room.poly), room.arcs);
  }
  return total;
}

/**
 * 复核前后的结构差异（契约里的 delta）。
 */
export function reviewDelta(beforePlan, beforeFurniture, afterPlan, afterFurniture) {
  const beforeRooms = roomsOf(beforePlan);
  const afterRooms = roomsOf(afterPlan);
  const changedRooms = [];

  for (const room of afterRooms) {
    const id = String(room.id ?? '');
    const old = beforeRooms.find(candidate => String(candidate.id ?? '') === id);
    if (!old) {
      if (id) changedRooms.push(id);
      continue;
    }
    if (String(old.name ?? '') !== String(room.name ?? '')) {
      changedRooms.push(id);
      continue;
    }
    const beforeArea = roomArea(polyPoints(old.poly), old.arcs);
    const afterArea = roomArea(polyPoints(room.poly), room.arcs);
    if (Math.abs(afterArea - beforeArea) / (beforeArea || 1) > 0.05) changedRooms.push(id);
  }

  return {
    rooms: { before: beforeRooms.length, after: afterRooms.length },
    area: {
      before: round1(countedArea(beforePlan) / 1_000_000),
      after: round1(countedArea(afterPlan) / 1_000_000),
    },
    walls: { before: countOf(beforePlan?.walls), after: countOf(afterPlan?.walls) },
    wins: { before: countOf(beforePlan?.wins), after: countOf(afterPlan?.wins) },
    doors: { before: countOf(beforePlan?.doors), after: countOf(afterPlan?.doors) },
    furniture: { before: countOf(beforeFurniture), after: countOf(afterFurniture) },
    changedRooms,
  };
}
