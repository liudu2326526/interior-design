import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { extname, isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_LINES = 50000;
const MAX_SCANNED_CURVES = 5000;
const MAX_CURVES = 48;
const MAX_NEIGHBORS = 80;
const MAX_GROUPS = 32000;
const TAU = 2 * Math.PI;
const DEG = 180 / Math.PI;
const EPS = 1e-10;
const UNITS = [
  ['unspecified', null], ['in', 25.4], ['ft', 304.8], ['mi', 1609344],
  ['mm', 1], ['cm', 10], ['m', 1000], ['km', 1000000], ['microin', .0000254],
  ['mil', .0254], ['yd', 914.4], ['angstrom', 1e-7], ['nm', 1e-6], ['micron', .001],
  ['dm', 100], ['dam', 10000], ['hm', 100000], ['Gm', 1e12],
  ['au', 149597870700000], ['light-year', 9460730472580800000], ['parsec', 3.0856775814913673e19],
  ['US survey ft', 1200000 / 3937], ['US survey in', 100000 / 3937],
  ['US survey yd', 3600000 / 3937], ['US survey mi', 6336000000 / 3937],
];
const ENCODINGS = {
  ANSI_936:'gbk', ANSI_950:'big5', ANSI_932:'shift_jis', ANSI_949:'euc-kr',
  ANSI_1250:'windows-1250', ANSI_1251:'windows-1251', ANSI_1252:'windows-1252',
  ANSI_1253:'windows-1253', ANSI_1254:'windows-1254', ANSI_1255:'windows-1255',
  ANSI_1256:'windows-1256', ANSI_1257:'windows-1257', ANSI_1258:'windows-1258',
};
const TYPES = new Set(['LINE', 'ARC', 'LWPOLYLINE', 'ELLIPSE']);
const finite = value => Number.isFinite(value) && Math.abs(value) <= 1e12;
const number = text => text == null || text === '' ? NaN : Number(text);
const round = value => Number(value.toPrecision(13));
const point = (x, y) => [round(x), round(y)];
const mod = (value, divisor) => ((value % divisor) + divisor) % divisor;

async function readBounded(path, signal) {
  const chunks = [];
  let size = 0;
  for await (const chunk of createReadStream(path, { end:MAX_BYTES, signal })) {
    size += chunk.length;
    if (size > MAX_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

async function dwgToDxf(path, signal) {
  const handle = await open(path, 'r');
  try {
    const prefix = Buffer.alloc(6);
    const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
    if (bytesRead !== prefix.length || !/^AC10\d{2}$/.test(prefix.toString('ascii'))) return null;
  } finally {
    await handle.close();
  }
  const configured = process.env.STUDIO_DWGREAD_PATH;
  if (configured && !isAbsolute(configured)) return null;
  const candidates = configured ? [configured] : ['dwgread', '/opt/homebrew/bin/dwgread', '/usr/local/bin/dwgread', '/usr/bin/dwgread'];
  for (const binary of candidates) {
    signal?.throwIfAborted();
    try {
      // Keep the converter output in bounded memory and give it only the environment it needs.
      const { stdout } = await exec(binary, ['-O', 'DXF', path], {
        encoding:'buffer', maxBuffer:MAX_BYTES, timeout:12000, killSignal:'SIGKILL', signal,
        env:{ PATH:process.env.PATH ?? '/usr/bin:/bin', LANG:'C', LC_ALL:'C' },
      });
      return stdout;
    } catch (error) {
      signal?.throwIfAborted();
      if (error.code !== 'ENOENT' && error.code !== 'EACCES') return null;
    }
  }
  return null;
}

function decodeDxf(buffer) {
  if (buffer.subarray(0, 32).includes(0) || buffer.subarray(0, 22).toString('ascii').startsWith('AutoCAD Binary DXF')) return null;
  const header = buffer.subarray(0, 65536).toString('latin1');
  const version = /\$ACADVER\s+1\s+AC(\d+)/i.exec(header)?.[1];
  const codepage = /\$DWGCODEPAGE\s+3\s+([\w]+)/i.exec(header)?.[1]?.toUpperCase();
  const encoding = (!version || Number(version) < 1021) && ENCODINGS[codepage];
  const text = new TextDecoder(encoding || 'utf-8').decode(buffer);
  return text.includes('\n') ? text : text.replaceAll('\r', '\n');
}

function* pairs(text) {
  let offset = 0;
  const line = () => {
    const start = offset;
    const end = text.indexOf('\n', start);
    offset = end < 0 ? text.length : end + 1;
    return text.slice(start, end < 0 ? text.length : end).trim();
  };
  while (offset < text.length) {
    const code = line();
    if (!/^[+-]?\d{1,4}$/.test(code) || offset === text.length) return;
    yield [Number(code), line()];
  }
}

const layerName = (value = '0') => value.slice(0, 640)
  .replace(/\\U\+([\da-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
  .replace(/[^\p{L}\p{N}\p{M} ._()$-]/gu, '_')
  .trim().slice(0, 80) || '0';

function horizontalDirection(read) {
  const x = number(read(210, '0')), y = number(read(220, '0')), z = number(read(230, '1'));
  if (![x, y, z].every(finite) || Math.abs(z) <= EPS || Math.hypot(x, y) > Math.abs(z) * 1e-9) return 0;
  return Math.sign(z);
}

function polylineSegments(rows, read, base, direction, omitted) {
  const vertices = [];
  const constantWidth = number(read(43, '0'));
  let vertex;
  for (const [code, value] of rows) {
    if (code === 10) {
      vertex = { x:number(value), y:NaN, bulge:0, startWidth:null, endWidth:null };
      vertices.push(vertex);
    } else if (vertex && code === 20) vertex.y = number(value);
    else if (vertex && code === 42) vertex.bulge = number(value);
    else if (vertex && code === 40) vertex.startWidth = number(value);
    else if (vertex && code === 41) vertex.endWidth = number(value);
  }
  const declared = number(read(90));
  if (vertices.length < 2 || (Number.isFinite(declared) && declared !== vertices.length) ||
      vertices.some(v => ![v.x, v.y, v.bulge].every(finite))) {
    omitted.invalid++;
    return [];
  }
  const closed = (number(read(70, '0')) & 1) !== 0;
  const elevation = number(read(38, '0')) * direction;
  if (!finite(elevation)) {
    omitted.invalid++;
    return [];
  }
  const out = [];
  for (let i = 0; i < vertices.length - (closed ? 0 : 1); i++) {
    const first = vertices[i], second = vertices[(i + 1) % vertices.length];
    const x = first.x * direction, y = first.y;
    const dx = (second.x - first.x) * direction, dy = second.y - first.y, chord = Math.hypot(dx, dy);
    if (chord <= EPS) continue;
    const from = point(x, y), to = point(second.x * direction, second.y);
    const row = { ...base, id:base.id + '.' + i, segment:i, from, to, elevation:round(elevation) };
    const width = [first.startWidth ?? constantWidth, first.endWidth ?? constantWidth];
    if (width.every(v => finite(v) && v >= 0) && width.some(v => v > 0)) row.width = width.map(round);
    const bulge = first.bulge * direction;
    if (!bulge) {
      out.push({ ...row, kind:'line' });
      continue;
    }
    const signed = 4 * Math.atan(bulge);
    const offset = (1 / bulge - bulge) / 4;
    const cx = x + dx / 2 - dy * offset, cy = y + dy / 2 + dx * offset;
    const radius = Math.hypot(x - cx, y - cy);
    if (![cx, cy, radius].every(finite) || radius <= EPS) {
      omitted.invalid++;
      continue;
    }
    out.push({ ...row, kind:'arc', center:point(cx, cy), radius:round(radius), sweepDeg:round(signed * DEG) });
  }
  return out;
}

function extractEntity(type, rows, id, omitted) {
  const fields = new Map();
  for (const [code, value] of rows) if (!fields.has(code)) fields.set(code, value);
  const read = (code, fallback) => fields.get(code) ?? fallback;
  if (number(read(67, '0')) !== 0 || (read(410) && read(410).toUpperCase() !== 'MODEL')) {
    omitted.paperSpace++;
    return [];
  }
  if (type === 'INSERT') {
    omitted.inserts++;
    return [];
  }
  if (!TYPES.has(type)) {
    if (type === 'POLYLINE' || type === 'SPLINE') omitted.unsupportedCurves++;
    return [];
  }
  const base = { id, source:type, layer:layerName(read(8)) };
  const handle = read(5);
  if (/^[0-9a-f]{1,16}$/i.test(handle ?? '')) base.handle = handle.toUpperCase();
  const direction = type === 'LINE' ? 1 : horizontalDirection(read);
  if (!direction) {
    omitted.tilted++;
    return [];
  }

  if (type === 'LWPOLYLINE') return polylineSegments(rows, read, base, direction, omitted);
  const x = number(read(10)), y = number(read(20)), z = number(read(30, '0'));
  if (![x, y, z].every(finite)) {
    omitted.invalid++;
    return [];
  }
  if (type === 'LINE') {
    const x2 = number(read(11)), y2 = number(read(21)), z2 = number(read(31, '0'));
    if (![x2, y2, z2].every(finite)) {
      omitted.invalid++;
      return [];
    }
    if (Math.abs(z - z2) > EPS || Math.hypot(x - x2, y - y2) <= EPS) return [];
    return [{ ...base, kind:'line', from:point(x, y), to:point(x2, y2), elevation:round(z) }];
  }
  if (type === 'ARC') {
    const radius = number(read(40)), start = number(read(50)), end = number(read(51));
    const sweep = mod(end - start, 360);
    if (![radius, start, end].every(finite) || radius <= EPS || sweep <= EPS) {
      omitted.invalid++;
      return [];
    }
    const getPoint = angle => {
      const rad = angle / DEG;
      return point((x + radius * Math.cos(rad)) * direction, y + radius * Math.sin(rad));
    };
    return [{
      ...base, kind:'arc', from:getPoint(start), to:getPoint(start + sweep),
      center:point(x * direction, y), elevation:round(z * direction), radius:round(radius), sweepDeg:round(sweep * direction),
    }];
  }

  // ELLIPSE center and major-axis vector are already in world coordinates.
  const mx = number(read(11)), my = number(read(21)), mz = number(read(31, '0'));
  const ratio = number(read(40)), start = number(read(41, '0')), end = number(read(42, String(TAU)));
  if (![mx, my, mz, ratio, start, end].every(finite) || Math.hypot(mx, my) <= EPS || ratio <= 0 || ratio > 1) {
    omitted.invalid++;
    return [];
  }
  if (Math.abs(mz) > EPS) {
    omitted.tilted++;
    return [];
  }
  const full = Math.abs(end - start) >= TAU - EPS;
  const sweep = full ? TAU : mod(end - start, TAU);
  if (sweep <= EPS) {
    omitted.invalid++;
    return [];
  }
  const getPoint = t => point(x + mx * Math.cos(t) - direction * my * ratio * Math.sin(t),
    y + my * Math.cos(t) + direction * mx * ratio * Math.sin(t));
  return [{
    ...base, kind:'ellipse', circular:ratio === 1, full,
    from:getPoint(start), to:getPoint(start + sweep), center:point(x, y), elevation:round(z),
    majorAxis:point(mx, my), ratio:round(ratio), startParam:round(mod(start, TAU)), parameterSweep:round(sweep),
    normalZ:direction,
  }];
}

function parseModel(text) {
  const omitted = { paperSpace:0, inserts:0, unsupportedCurves:0, tilted:0, invalid:0, scanLimited:false };
  const segments = [];
  let section = '', expectSection = false, units = 0, readUnits = false, hasEntities = false, closedEntities = false, modelHandle;
  let index = 0, name = '', rows = [], oversized = false;
  let lines = 0, curves = 0, droppedCurves = 0;

  const flush = () => {
    if (section === 'TABLES' && name === 'BLOCK_RECORD') {
      const label = rows.find(([code]) => code === 2)?.[1];
      if (label?.toUpperCase() === '*MODEL_SPACE') modelHandle = rows.find(([code]) => code === 5)?.[1]?.toUpperCase();
    } else if (section === 'ENTITIES' && name) {
      if (oversized) omitted.scanLimited = true;
      else {
        let nested = 0, owner;
        for (const [code, value] of rows) {
          if (code === 102 && value.startsWith('{')) nested++;
          if (code === 102 && value === '}') nested = Math.max(0, nested - 1);
          if (code === 330 && nested === 0) {
            owner = value.toUpperCase();
            break;
          }
        }
        // Some DXFs mark paper space only through the layout's block record.
        if (modelHandle && owner && owner !== '0' && owner !== modelHandle) omitted.paperSpace++;
        else for (const segment of extractEntity(name, rows, (++index).toString(36), omitted)) {
          if (segment.kind === 'line' ? ++lines <= MAX_LINES : ++curves <= MAX_SCANNED_CURVES) {
            segments.push(segment);
          } else {
            omitted.scanLimited = true;
            if (segment.kind !== 'line') droppedCurves++;
          }
        }
      }
    }
    rows = [];
    name = '';
    oversized = false;
  };

  for (const [code, value] of pairs(text)) {
    if (expectSection) {
      if (code !== 2) return null;
      section = value.toUpperCase();
      hasEntities ||= section === 'ENTITIES';
      expectSection = false;
    } else if (code === 0) {
      flush();
      const marker = value.toUpperCase();
      if (marker === 'SECTION') expectSection = true;
      else if (marker === 'ENDSEC') {
        closedEntities ||= section === 'ENTITIES';
        section = '';
      }
      else if (section === 'ENTITIES' || (section === 'TABLES' && marker === 'BLOCK_RECORD')) name = marker;
    } else if (section === 'HEADER') {
      if (readUnits && code === 70) units = number(value);
      readUnits = code === 9 && value.toUpperCase() === '$INSUNITS';
    } else if (name) {
      if (rows.length < MAX_GROUPS) rows.push([code, value]);
      else oversized = true;
    }
  }
  flush();
  return hasEntities && (closedEntities || omitted.scanLimited)
    ? { segments, units, omitted, droppedCurves } : null;
}

function selectEvidence(segments, tolerance) {
  const curves = segments.filter(segment => segment.kind !== 'line');
  if (!curves.length) return { curves:[], adjacentSegments:[], omittedCurves:0 };
  const buckets = new Map();
  const bucket = ([x, y]) => [Math.floor(x / tolerance), Math.floor(y / tolerance)];
  for (const segment of [...curves, ...segments.filter(segment => segment.kind === 'line')]) {
    for (const p of [segment.from, segment.to]) {
      const key = bucket(p).join(',');
      const points = buckets.get(key) ?? [];
      if (!buckets.has(key)) buckets.set(key, points);
      if (points.length < 32) points.push({ p, segment });
    }
  }
  const linked = (row, p) => {
    const [x, y] = bucket(p);
    const hits = new Set();
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const { p:q, segment } of buckets.get((x + dx) + ',' + (y + dy)) ?? []) {
          if (segment.id !== row.id && Math.abs(segment.elevation - row.elevation) <= tolerance &&
              Math.hypot(p[0] - q[0], p[1] - q[1]) <= tolerance) hits.add(segment);
        }
      }
    }
    return [...hits].sort((a, b) =>
      Number(b.kind !== 'line') - Number(a.kind !== 'line') + Number(b.layer === row.layer) - Number(a.layer === row.layer)).slice(0, 4);
  };
  const scored = curves.map(row => {
    const links = row.full ? [[], []] : [linked(row, row.from), linked(row, row.to)];
    const span = row.kind === 'ellipse' ? 2 * Math.hypot(...row.majorAxis) : Math.hypot(row.to[0] - row.from[0], row.to[1] - row.from[1]);
    const connections = links.filter(list => list.some(item => item.kind === 'arc' && item.layer === row.layer)).length;
    const score = Math.log1p(span / tolerance) + connections * 2;
    return { row, links, score };
  }).sort((a, b) => b.score - a.score).slice(0, MAX_CURVES);
  const ids = new Set(scored.map(({ row }) => row.id));
  const adjacent = new Map();
  const selected = scored.map(({ row, links }) => ({
    ...row,
    links:links.map(list => list.filter(item => {
      if (ids.has(item.id) || adjacent.has(item.id)) return true;
      if (item.kind !== 'line' || adjacent.size >= MAX_NEIGHBORS) return false;
      adjacent.set(item.id, item);
      return true;
    }).map(item => item.id)),
  }));
  return { curves:selected, adjacentSegments:[...adjacent.values()], omittedCurves:curves.length - selected.length };
}

/** Read bounded, model-space CAD geometry as evidence. No CAD layer is assigned a structural meaning here. */
export async function readCadCurveEvidence(file, name, { signal } = {}) {
  signal?.throwIfAborted();
  const ext = extname(typeof name === 'string' && name ? name : file).toLowerCase();
  if (ext !== '.dxf' && ext !== '.dwg') return null;
  const path = resolve(file);
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size <= 0 || info.size > MAX_BYTES) return null;
    const buffer = ext === '.dwg' ? await dwgToDxf(path, signal) : await readBounded(path, signal);
    if (!buffer?.length) return null;
    const text = decodeDxf(buffer);
    const model = text && parseModel(text);
    if (!model) return null;
    signal?.throwIfAborted();
    const code = Number.isInteger(model.units) ? model.units : 0;
    const [unitName, mmPerUnit] = UNITS[code] ?? ['unknown', null];
    // Native endpoints normally coincide exactly. Permit a small gap without reordering the geometry.
    const joinTolerance = mmPerUnit ? Math.max(1e-9, .5 / mmPerUnit) : .01;
    const { curves, adjacentSegments, omittedCurves } = selectEvidence(model.segments, joinTolerance);
    return {
      format:ext === '.dwg' ? 'DWG' : 'DXF',
      sourceCoordinates:'CAD WCS XY, Y up, positive circular sweep counterclockwise',
      units:{ code, name:unitName, mmPerUnit },
      joinTolerance:round(joinTolerance),
      curves, adjacentSegments,
      omitted:{ ...model.omitted, additionalCurves:omittedCurves + model.droppedCurves },
    };
  } catch {
    signal?.throwIfAborted();
    return null;
  }
}
