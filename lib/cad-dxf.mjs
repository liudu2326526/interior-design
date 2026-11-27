import { arcGeometry } from './codex/plan.mjs';

const LAYERS = {
  '0':7,
  'A-WALL-EXTERIOR':7,
  'A-WALL-BEARING':7,
  'A-WALL-PARTITION':7,
  'A-WALL-LOW':8,
  'A-WALL-DEMO':1,
  'A-GLAZING':4,
  'A-DOOR':3,
  'A-DOOR-SLIDING':3,
  'A-ROOM':9,
  'A-ROOM-NAME':7,
  'A-FURN':6,
  'A-FURN-NAME':6,
  'A-DIMS-OVERALL':2,
  'A-DIMS-CHAIN':2,
  'A-DIMS-MANUAL':5,
  'A-DIMS-REFERENCE':8,
};
const WALL_LAYERS = { e:'A-WALL-EXTERIOR', b:'A-WALL-BEARING', n:'A-WALL-PARTITION', low:'A-WALL-LOW' };
const DIMENSION_LAYERS = { overall:'A-DIMS-OVERALL', chain:'A-DIMS-CHAIN', manual:'A-DIMS-MANUAL' };
const MAX_COORDINATE = 1e9;
const MAX_COLLECTION = 10000;
const MAX_VERTICES = 100000;
const MAX_ENTITIES = 50000;
const TAU = 2 * Math.PI;
const RAD = Math.PI / 180;

const isRecord = value => value && typeof value === 'object' && !Array.isArray(value);
const finite = value => Number.isFinite(value) && Math.abs(value) <= MAX_COORDINATE;
const isPoint = value => Array.isArray(value) && value.length === 2 && value.every(finite);
const isRect = value => Array.isArray(value) && value.length >= 4 && value.slice(0, 4).every(finite) &&
  value[2] >= value[0] && value[3] >= value[1];
const angle360 = value => ((value % 360) + 360) % 360;

function requireCad(condition, message) {
  if (!condition) throw new TypeError(message);
}

function records(value, name, limit = MAX_COLLECTION) {
  requireCad(Array.isArray(value) && value.length <= limit, `Invalid CAD ${name} collection.`);
  return value;
}

function cadText(value) {
  // DXF 2000 group values are ASCII lines. Neutralize text control syntax before Unicode encoding.
  const input = String(value ?? '').slice(0, 255)
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ').replaceAll('\\', '＼').replaceAll('%', '％').trim();
  let output = '';
  for (const char of input) {
    const code = char.codePointAt(0);
    const encoded = code > 0xffff || (code >= 0xd800 && code <= 0xdfff) ? '?'
      : code > 126 ? '\\U+' + code.toString(16).toUpperCase().padStart(4, '0') : char;
    if (output.length + encoded.length > 250) break;
    output += encoded;
  }
  return output;
}

function createWriter() {
  const body = [], preamble = [];
  const write = (...groups) => body.push(...groups);
  const header = (...groups) => preamble.push(...groups);
  const modelSpace = '1F', paperSpace = '1B';
  let nextHandle = 0x100, entityCount = 0, vertexCount = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const handle = () => (nextHandle++).toString(16).toUpperCase();

  function grow([x, y]) {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  const coordinate = value => {
    requireCad(finite(value), 'CAD coordinate is outside the supported range.');
    return Number(value.toFixed(8));
  };
  const point = (code, p) => write(code, coordinate(p[0]), code + 10, coordinate(-p[1]), code + 20, 0);
  function entity(type, layer, className) {
    requireCad(++entityCount <= MAX_ENTITIES, 'Too many entities in the CAD export.');
    write(0, type, 5, handle(), 330, modelSpace, 100, 'AcDbEntity', 8, layer, 100, className);
  }
  function polyline(layer, points, bulges = []) {
    vertexCount += points.length;
    requireCad(vertexCount <= MAX_VERTICES, 'Too many vertices in the CAD export.');
    entity('LWPOLYLINE', layer, 'AcDbPolyline');
    write(90, points.length, 70, 1);
    for (let i = 0; i < points.length; i++) {
      grow(points[i]);
      write(10, coordinate(points[i][0]), 20, coordinate(-points[i][1]));
      if (bulges[i]) write(42, coordinate(bulges[i]));
    }
  }
  function line(layer, start, end) {
    if (start[0] === end[0] && start[1] === end[1]) return;
    grow(start); grow(end);
    entity('LINE', layer, 'AcDbLine');
    point(10, start);
    point(11, end);
  }
  function arc(layer, center, radius, start, sweep) {
    if (!sweep || !radius) return;
    entity('ARC', layer, 'AcDbCircle');
    point(10, center);
    write(40, coordinate(radius), 100, 'AcDbArc');
    const cadAngle = angle => coordinate(angle360(-angle / RAD));
    const end = start + sweep;
    const bearings = [start, end];
    for (const cardinal of [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2]) {
      const offset = (cardinal - start) * Math.sign(sweep);
      if (((offset % TAU) + TAU) % TAU <= Math.abs(sweep)) bearings.push(cardinal);
    }
    for (const bearing of bearings) grow([center[0] + radius * Math.cos(bearing), center[1] + radius * Math.sin(bearing)]);
    write(50, cadAngle(sweep > 0 ? end : start), 51, cadAngle(sweep > 0 ? start : end));
  }
  function ellipse(layer, center, w, d, rotation) {
    const major = w >= d ? w : d;
    const cos = Math.cos(rotation), sin = Math.sin(rotation);
    const halfX = Math.hypot(w * cos, d * sin) / 2, halfY = Math.hypot(w * sin, d * cos) / 2;
    grow([center[0] - halfX, center[1] - halfY]); grow([center[0] + halfX, center[1] + halfY]);
    if (w === d) {
      entity('CIRCLE', layer, 'AcDbCircle');
      point(10, center);
      write(40, coordinate(major / 2));
      return;
    }
    const angle = rotation + (w >= d ? 0 : Math.PI / 2);
    entity('ELLIPSE', layer, 'AcDbEllipse');
    point(10, center);
    point(11, [Math.cos(angle) * major / 2, Math.sin(angle) * major / 2]);
    write(210, 0, 220, 0, 230, 1, 40, Math.min(w, d) / major, 41, 0, 42, TAU);
  }
  function text(layer, position, value, height, rotation = 0) {
    const label = cadText(value);
    if (!label) return;
    grow(position);
    entity('TEXT', layer, 'AcDbText');
    point(10, position);
    write(40, coordinate(height), 1, label, 50, rotation, 7, 'Standard', 72, 1);
    point(11, position);
    write(100, 'AcDbText', 73, 2);
  }

  function table(name, id, length, writeRecords) {
    header(0, 'TABLE', 2, name, 5, id, 330, '0', 100, 'AcDbSymbolTable', 70, length);
    writeRecords();
    header(0, 'ENDTAB');
  }
  function record(type, id, tableId, className, name, ...groups) {
    header(0, type, 5, id, 330, tableId, 100, 'AcDbSymbolTableRecord', 100, className, 2, name, 70, 0, ...groups);
  }
  function finish(bounds) {
    grow([bounds.x, bounds.y]);
    grow([bounds.x + bounds.w, bounds.y + bounds.h]);
    header(0, 'SECTION', 2, 'HEADER',
      9, '$ACADVER', 1, 'AC1015', 9, '$DWGCODEPAGE', 3, 'ANSI_1252',
      9, '$INSUNITS', 70, 4, 9, '$MEASUREMENT', 70, 1,
      9, '$LUNITS', 70, 2, 9, '$LUPREC', 70, 2,
      9, '$EXTMIN', 10, coordinate(minX), 20, coordinate(-maxY), 30, 0,
      9, '$EXTMAX', 10, coordinate(maxX), 20, coordinate(-minY), 30, 0,
      9, '$HANDSEED', 5, '100000', 0, 'ENDSEC',
      0, 'SECTION', 2, 'TABLES');
    table('LTYPE', '2', 1, () => {
      record('LTYPE', '14', '2', 'AcDbLinetypeTableRecord', 'Continuous', 3, 'Solid line', 72, 65, 73, 0, 40, 0);
    });
    table('LAYER', '3', Object.keys(LAYERS).length, () => {
      for (const [name, color] of Object.entries(LAYERS)) {
        record('LAYER', handle(), '3', 'AcDbLayerTableRecord', name, 62, color, 6, 'Continuous');
      }
    });
    table('STYLE', '5', 1, () => {
      record('STYLE', '11', '5', 'AcDbTextStyleTableRecord', 'Standard',
        40, 0, 41, 1, 50, 0, 71, 0, 42, 2.5, 3, 'arial.ttf', 4, '');
    });
    table('BLOCK_RECORD', '1', 2, () => {
      for (const [name, id] of [['*Model_Space', modelSpace], ['*Paper_Space', paperSpace]]) {
        header(0, 'BLOCK_RECORD', 5, id, 330, '1', 100, 'AcDbSymbolTableRecord', 100, 'AcDbBlockTableRecord', 2, name);
      }
    });
    header(0, 'ENDSEC', 0, 'SECTION', 2, 'BLOCKS');
    for (const [name, id] of [['*Model_Space', modelSpace], ['*Paper_Space', paperSpace]]) {
      header(0, 'BLOCK', 5, handle(), 330, id, 100, 'AcDbEntity', 8, '0',
        100, 'AcDbBlockBegin', 2, name, 70, 0, 10, 0, 20, 0, 30, 0, 3, name, 1, '',
        0, 'ENDBLK', 5, handle(), 330, id, 100, 'AcDbEntity', 8, '0', 100, 'AcDbBlockEnd');
    }
    header(0, 'ENDSEC', 0, 'SECTION', 2, 'ENTITIES');
    return preamble.join('\r\n') + '\r\n' + body.join('\r\n') + '\r\n0\r\nENDSEC\r\n0\r\nEOF\r\n';
  }
  return { polyline, line, arc, ellipse, text, finish };
}

function rectPoints([x0, y0, x1, y1]) {
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}

function span(writer, layer, item, glazing = false) {
  if (Array.isArray(item)) {
    requireCad(isRect(item), 'Invalid CAD wall or window rectangle.');
    writer.polyline(layer, rectPoints(item));
    if (glazing) {
      const [x0, y0, x1, y1] = item;
      for (const fraction of [1/3, 2/3]) {
        if (x1 - x0 >= y1 - y0) {
          const y = y0 + (y1 - y0) * fraction;
          writer.line(layer, [x0, y], [x1, y]);
        } else {
          const x = x0 + (x1 - x0) * fraction;
          writer.line(layer, [x, y0], [x, y1]);
        }
      }
    }
    return;
  }
  requireCad(isRecord(item) && isPoint(item.from) && isPoint(item.to) && finite(item.thickness) && item.thickness > 0,
    'Invalid CAD curved wall or window.');
  const curve = arcGeometry(item.from, item.to, item.sweep);
  requireCad(curve && item.thickness < 2 * curve.radius, 'Invalid CAD arc sweep or thickness.');
  const {cx, cy, radius, start, angle} = curve;
  const end = start + angle;
  const half = item.thickness / 2;
  const at = (r, bearing) => [cx + r * Math.cos(bearing), cy + r * Math.sin(bearing)];
  const bulge = Math.tan(-angle / 4);
  writer.polyline(layer, [
    at(radius + half, start), at(radius + half, end),
    at(radius - half, end), at(radius - half, start),
  ], [bulge, 0, -bulge, 0]);
  if (glazing) {
    writer.arc(layer, [cx, cy], radius - half / 3, start, angle);
    writer.arc(layer, [cx, cy], radius + half / 3, start, angle);
  }
}

function drawDoor(writer, door) {
  requireCad(isRecord(door) && isRect(door.rect) && isPoint(door.h) && isPoint(door.c) &&
    isPoint(door.o) && finite(door.len) && door.len >= 0, 'Invalid CAD door.');
  const layer = 'A-DOOR';
  writer.polyline(layer, rectPoints(door.rect));
  if (!door.len || !Math.hypot(...door.o)) return;
  const opening = Math.atan2(door.o[1], door.o[0]);
  const closing = Math.atan2(door.c[1], door.c[0]);
  const [x, y] = door.h;
  const leaf = [x + Math.cos(opening) * door.len, y + Math.sin(opening) * door.len];
  writer.line(layer, door.h, leaf);
  if (Math.hypot(...door.c)) {
    const sweep = ((closing - opening + 3 * Math.PI) % TAU) - Math.PI;
    writer.arc(layer, door.h, door.len, opening, sweep);
  }
}

function drawSlide(writer, slide) {
  requireCad(isRecord(slide) && isRect(slide.rect), 'Invalid CAD sliding door.');
  const layer = 'A-DOOR-SLIDING';
  const [x0, y0, x1, y1] = slide.rect;
  writer.polyline(layer, rectPoints(slide.rect));
  const lo = slide.v ? y0 : x0, hi = slide.v ? y1 : x1;
  const near = slide.v ? x0 : y0, far = slide.v ? x1 : y1;
  const coord = (value, across) => slide.v ? [across, value] : [value, across];
  const first = near + (far - near) / 3, second = far - (far - near) / 3;
  writer.line(layer, coord(lo, first), coord(lo + (hi - lo) * .55, first));
  writer.line(layer, coord(hi - (hi - lo) * .55, second), coord(hi, second));
}

function drawRoom(writer, room, roomState) {
  requireCad(isRecord(room) && typeof room.id === 'string' && isPoint(room.at), 'Invalid CAD room.');
  const points = records(room.poly, 'room vertices');
  requireCad(points.length >= 3 && points.every(isPoint), 'Invalid CAD room polygon.');
  const bulges = [];
  for (const arc of records(room.arcs ?? [], 'room arcs')) {
    requireCad(isRecord(arc) && Number.isInteger(arc.edge) && arc.edge >= 0 && arc.edge < points.length &&
      arcGeometry(points[arc.edge], points[(arc.edge + 1) % points.length], arc.sweep), 'Invalid CAD room arc.');
    bulges[arc.edge] = Math.tan(-arc.sweep * RAD / 4);
  }
  writer.polyline('A-ROOM', points, bulges);
  const override = Object.hasOwn(roomState, room.id) ? roomState[room.id]?.name : null;
  writer.text('A-ROOM-NAME', room.at, typeof override === 'string' && override.trim() ? override : room.name, 180);
}

const localRect = (w, d) => rectPoints([-w / 2, -d / 2, w / 2, d / 2]);
function transform(origin, angle, point) {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  return [origin[0] + point[0] * cos - point[1] * sin, origin[1] + point[0] * sin + point[1] * cos];
}

function drawComponent(writer, item, center, rotation) {
  const layer = 'A-FURN';
  const parts = records(item.parts, 'component parts', 48);
  requireCad(parts.length > 0, 'CAD component has no parts.');
  for (const part of parts) {
    requireCad(isRecord(part) && ['box', 'cylinder', 'stairs', 'winder'].includes(part.shape) &&
      [part.x, part.z, part.w, part.d, part.rot ?? 0].every(finite) &&
      Math.abs(part.x) <= .5 && Math.abs(part.z) <= .5 &&
      part.w > 0 && part.w <= 1 && part.d > 0 && part.d <= 1, 'Invalid CAD component part.');
    const w = item.w * part.w, d = item.d * part.d;
    const origin = transform(center, rotation, [item.w * part.x, item.d * part.z]);
    const angle = rotation + angle360(part.rot ?? 0) * RAD;
    const toWorld = point => transform(origin, angle, point);
    if (part.shape === 'cylinder') {
      writer.ellipse(layer, origin, w, d, angle);
      continue;
    }
    if (part.shape === 'winder' || part.shape === 'stairs') {
      requireCad(Number.isInteger(part.steps) && part.steps >= 1 && part.steps <= 32, 'Invalid CAD stair count.');
    }
    if (part.shape === 'winder') {
      const points = [part.pivot, ...records(part.edges, 'winder edges', 33)];
      requireCad(points.length === part.steps + 2 &&
        points.every(point => isPoint(point) && point.every(value => Math.abs(value) <= .5)), 'Invalid CAD winder.');
      const [pivot, ...treads] = points.map(([x, y]) => toWorld([x * w, y * d]));
      writer.polyline(layer, [pivot, ...treads]);
      for (const end of treads.slice(1, -1)) writer.line(layer, pivot, end);
      continue;
    }
    writer.polyline(layer, localRect(w, d).map(toWorld));
    if (part.shape === 'stairs') {
      for (let i = 1; i < part.steps; i++) {
        const y = d * (i / part.steps - .5);
        writer.line(layer, toWorld([-w / 2, y]), toWorld([w / 2, y]));
      }
    }
  }
}

function drawFurniture(writer, item) {
  requireCad(isRecord(item) && [item.cx, item.cy, item.w, item.d, item.rot].every(finite) &&
    item.w > 0 && item.d > 0 && typeof item.type === 'string', 'Invalid CAD furniture.');
  const { cx, cy, w, d, type } = item;
  const layer = 'A-FURN', center = [cx, cy], rotation = angle360(item.rot) * RAD;
  const placed = point => transform(center, rotation, point);
  if (type === 'component') drawComponent(writer, item, center, rotation);
  else if (type === 'cornersofa') {
    const x = -w / 2, y = -d / 2, k = Math.min(950, d * .56, w * .4);
    const shape = [[x,y], [x+w,y], [x+w,y+k], [x+k,y+k], [x+k,y+d], [x,y+d]];
    const mirror = item.handedness === 'right' ? -1 : 1;
    writer.polyline(layer, shape.map(([px, py]) => placed([px * mirror, py])));
  } else if (['roundtable', 'beanbag'].includes(type) ||
    (type === 'sidetable' && item.topShape !== 'rect') ||
    (type === 'coffeetable' && ['round', 'oval'].includes(item.topShape))) {
    writer.ellipse(layer, center, w, d, rotation);
  } else if (['floorlamp', 'plant', 'barstool'].includes(type)) {
    const size = Math.min(w, d);
    writer.ellipse(layer, center, size, size, rotation);
  } else {
    writer.polyline(layer, localRect(w, d).map(placed));
  }
  const name = typeof item.name === 'string' && item.name.trim() ? item.name : type;
  writer.text('A-FURN-NAME', center, name, Math.max(50, Math.min(125, Math.min(w, d) * .2)));
}

function drawDimensions(writer, rows, labelHeight) {
  let pointCount = 0;
  for (const row of rows) {
    requireCad(isRecord(row) && (row.axis === 'x' || row.axis === 'y') &&
      Object.hasOwn(DIMENSION_LAYERS, row.kind) && finite(row.at), 'Invalid CAD dimension row.');
    const points = records(row.points, 'dimension points');
    pointCount += points.length;
    requireCad(points.length >= 2 && pointCount <= 20000 &&
      points.every(point => isRecord(point) && finite(point.value) && finite(point.across)), 'Invalid CAD dimension points.');
    const ordered = [...points].sort((a, b) => a.value - b.value);
    const layer = DIMENSION_LAYERS[row.kind], tick = labelHeight * .38;
    const at = row.at;
    const coord = (value, across) => row.axis === 'x' ? [value, across] : [across, value];
    const labelRotation = row.axis === 'x' ? 0 : 90;
    writer.line(layer, coord(ordered[0].value, at), coord(ordered.at(-1).value, at));
    for (const {value, across} of ordered) {
      const side = across < at ? 1 : -1;
      writer.line(layer, coord(value, across), coord(value, at + side * tick));
      writer.line(layer, coord(value - tick, at + tick), coord(value + tick, at - tick));
    }
    for (let i = 1; i < ordered.length; i++) {
      const a = ordered[i - 1].value, b = ordered[i].value, total = b - a;
      requireCad(total > 0, 'CAD dimension points repeat the same position.');
      const caption = Number(total.toFixed(2)) + ' mm';
      writer.text(layer, coord((a + b) / 2, at - labelHeight * .75), caption, labelHeight, labelRotation);
    }
    if (row.original !== undefined) {
      requireCad(ordered.length === 2 && finite(row.original) && row.original > 0, 'Invalid CAD drawing reference dimension.');
      const midpoint = (ordered[0].value + ordered[1].value) / 2;
      writer.text('A-DIMS-REFERENCE', coord(midpoint, at - labelHeight * 1.9),
        '原图 ' + Number(row.original.toFixed(2)) + ' mm', labelHeight * .78, labelRotation);
    }
  }
}

/** Convert a normalized Plan V1 and editor snapshot into editable model-space DXF in millimetres. */
export function buildCadDxf({ plan, state = {}, dimensions = [] } = {}) {
  requireCad(isRecord(plan) && plan.version === 1 && isRecord(plan.bounds) && isRecord(state), 'Invalid CAD plan or state.');
  const {x, y, w, h} = plan.bounds;
  requireCad([x, y, w, h, x + w, y + h].every(finite) && w > 0 && h > 0, 'Invalid CAD plan bounds.');
  const writer = createWriter();
  const walls = records(plan.walls, 'walls');
  const demolished = new Set();
  for (const id of records(state.demolished ?? [], 'demolished walls')) {
    requireCad(typeof id === 'string' && /^w\d{1,5}$/.test(id) && Number(id.slice(1)) < walls.length, 'Invalid CAD demolition wall reference.');
    demolished.add(Number(id.slice(1)));
  }
  const roomState = state.rooms ?? {};
  requireCad(isRecord(roomState), 'Invalid CAD room state.');
  walls.forEach((wall, i) => {
    const kind = Array.isArray(wall) ? wall[4] : wall?.kind;
    const activeLayer = Object.hasOwn(WALL_LAYERS, kind) ? WALL_LAYERS[kind] : 'A-WALL-PARTITION';
    span(writer, demolished.has(i) ? 'A-WALL-DEMO' : activeLayer, wall);
  });
  for (const win of records(plan.wins, 'windows')) span(writer, 'A-GLAZING', win, true);
  for (const door of records(plan.doors, 'doors')) drawDoor(writer, door);
  for (const slide of records(plan.slides, 'sliding doors')) drawSlide(writer, slide);
  const rooms = records(plan.rooms, 'rooms');
  requireCad(rooms.length > 0, 'CAD plan has no rooms.');
  for (const room of rooms) drawRoom(writer, room, roomState);
  for (const item of records(state.furniture ?? [], 'furniture')) drawFurniture(writer, item);
  const labelHeight = Math.max(100, Math.min(260, Math.max(w, h) * .011));
  drawDimensions(writer, records(dimensions, 'dimension rows', 2000), labelHeight);
  return writer.finish(plan.bounds);
}
