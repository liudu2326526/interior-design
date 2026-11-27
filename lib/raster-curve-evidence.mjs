import { inflateSync } from 'node:zlib';

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const MAX_PIXELS = 8_000_000;
const MAX_RUNS = 18_000;
const MAX_END_CHECKS = 900_000;
const MAX_ARC_CHECKS = 20_000;
const MAX_CANDIDATES = 1_000;
const CHANNELS = { 0:1, 2:3, 4:2, 6:4 };

function paeth(left, above, diagonal) {
  const predicted = left + above - diagonal;
  const a = Math.abs(predicted - left);
  const b = Math.abs(predicted - above);
  const c = Math.abs(predicted - diagonal);
  if (a <= b && a <= c) return left;
  return b <= c ? above : diagonal;
}

function decodeDarkPixels(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 33 || buffer.length > 24 * 1024 * 1024 ||
      !buffer.subarray(0, 8).equals(PNG) || buffer.readUInt32BE(8) !== 13 ||
      buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const channels = CHANNELS[buffer[25]];
  if (width < 64 || height < 64 || width > 4096 || height > 4096 || width * height > MAX_PIXELS ||
      buffer[24] !== 8 || !channels || buffer[26] !== 0 || buffer[27] !== 0 || buffer[28] !== 0) return null;

  const chunks = [];
  let ended = false;
  let chunkCount = 0;
  for (let offset = 8; offset + 12 <= buffer.length;) {
    if (++chunkCount > 8192) return null;
    const size = buffer.readUInt32BE(offset);
    const end = offset + 12 + size;
    if (end > buffer.length) return null;
    const kind = buffer.toString('ascii', offset + 4, offset + 8);
    if (kind === 'IDAT' && size) chunks.push(buffer.subarray(offset + 8, end - 4));
    if (kind === 'IEND') {
      ended = true;
      break;
    }
    offset = end;
  }
  if (!ended || !chunks.length) return null;
  const stride = width * channels;
  const expected = (stride + 1) * height;
  const raw = inflateSync(Buffer.concat(chunks), { maxOutputLength:expected });
  if (raw.length !== expected) return null;

  let above = new Uint8Array(stride);
  let row = new Uint8Array(stride);
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const offset = y * (stride + 1);
    const filter = raw[offset];
    if (filter > 4) return null;
    for (let i = 0; i < stride; i++) {
      const left = i < channels ? 0 : row[i - channels];
      const diagonal = i < channels ? 0 : above[i - channels];
      let correction = 0;
      if (filter === 1) correction = left;
      if (filter === 2) correction = above[i];
      if (filter === 3) correction = (left + above[i]) >>> 1;
      if (filter === 4) correction = paeth(left, above[i], diagonal);
      row[i] = raw[offset + i + 1] + correction;
    }
    for (let x = 0; x < width; x++) {
      const i = x * channels;
      const r = row[i], g = channels < 3 ? r : row[i + 1], b = channels < 3 ? r : row[i + 2];
      const alpha = channels % 2 ? 255 : row[i + channels - 1];
      const light = (r + g + b) / 3;
      pixels[y * width + x] = (255 - alpha) + light * alpha / 255 < 143 &&
        Math.max(r, g, b) - Math.min(r, g, b) < 48;
    }
    [row, above] = [above, row];
  }
  return { width, height, pixels };
}

function straightRuns({ width, height, pixels }, horizontal, minLength) {
  const count = horizontal ? height : width;
  const length = horizontal ? width : height;
  const stride = horizontal ? 1 : width;
  const runs = [];
  for (let line = 0; line < count; line++) {
    const offset = horizontal ? line * width : line;
    let start = -1;
    for (let i = 0; i <= length; i++) {
      if (i < length && pixels[offset + i * stride]) {
        if (start < 0) start = i;
      } else if (start >= 0) {
        if (i - start >= minLength) {
          runs.push({ line, start, end:i - 1, length:i - start });
          if (runs.length > MAX_RUNS) return null;
        }
        start = -1;
      }
    }
  }
  return runs;
}

const ARC_SAMPLES = Array.from({ length:11 }, (_, i) => {
  const angle = (14 + i * 6.2) * Math.PI / 180;
  return [Math.cos(angle), Math.sin(angle)];
});

function darkAt({ width, height, pixels }, x, y) {
  const ix = Math.round(x), iy = Math.round(y);
  return ix >= 0 && iy >= 0 && ix < width && iy < height && pixels[iy * width + ix];
}

function arcSupport(image, x, y, sx, sy, radius) {
  let hits = 0, narrow = 0, exact = 0;
  const separation = Math.max(3, radius * .19);
  for (const [cos, sin] of ARC_SAMPLES) {
    const px = x + sx * radius * (1 - cos), py = y + sy * radius * (1 - sin);
    const dx = sx * cos, dy = sy * sin;
    const onLine = darkAt(image, px, py);
    if (!onLine && !darkAt(image, px - dx, py - dy) && !darkAt(image, px + dx, py + dy)) continue;
    hits++;
    if (onLine) exact++;
    if (!darkAt(image, px - dx * separation, py - dy * separation) ||
        !darkAt(image, px + dx * separation, py + dy * separation)) narrow++;
  }
  return hits >= 9 && narrow >= 7 ? hits * 2 + exact : 0;
}

function verticalEnds(runs, width) {
  const columns = Array.from({ length:width }, () => []);
  for (const run of runs) {
    columns[run.line].push([run.start, 1, run.length], [run.end, -1, run.length]);
  }
  return columns;
}

function collectCandidates(image) {
  const shorter = Math.min(image.width, image.height);
  const minimumRun = Math.max(18, Math.round(shorter * .024));
  const shortestRadius = Math.max(8, Math.round(shorter * .007));
  const longestRadius = Math.min(160, Math.round(shorter * .105));
  const horizontal = straightRuns(image, true, minimumRun);
  const vertical = straightRuns(image, false, minimumRun);
  if (!horizontal || !vertical || shortestRadius >= longestRadius) return [];
  const columns = verticalEnds(vertical, image.width);
  const possible = [];
  let checked = 0, visited = 0;
  for (const segment of horizontal) {
    for (const [endpoint, sx] of [[segment.start, 1], [segment.end, -1]]) {
      const y = segment.line;
      for (let dx = shortestRadius; dx <= longestRadius; dx++) {
        const x = endpoint - sx * dx;
        if (x < 0 || x >= image.width) break;
        const tolerance = Math.max(3, dx * .23);
        for (const [end, sy, length] of columns[x]) {
          if (++visited > MAX_END_CHECKS) return [];
          const dy = (end - y) * sy;
          if (dy < shortestRadius || Math.abs(dx - dy) > tolerance ||
              Math.min(segment.length, length) < dx * 1.05) continue;
          if (++checked > MAX_ARC_CHECKS) return [];
          const rough = Math.round((dx + dy) / 2);
          const radiusSlack = Math.min(10, Math.max(3, Math.round(rough * .24)));
          let fit = null;
          for (let radius = Math.max(shortestRadius, rough - 2); radius <= rough + radiusSlack; radius++) {
            const score = arcSupport(image, x, y, sx, sy, radius);
            if (!score) continue;
            const rank = score + Math.min(segment.length, length, 160) / 30 -
              Math.abs(radius - rough) * .13;
            if (!fit || rank > fit.rank) fit = {x,y,sx,sy,radius,rank};
          }
          if (fit) {
            possible.push(fit);
            if (possible.length > MAX_CANDIDATES) return [];
          }
        }
      }
    }
  }
  return possible;
}

function groupParallel(candidates) {
  const groups = [];
  candidates.sort((a,b) => b.rank - a.rank);
  for (const arc of candidates) {
    const group = groups.find(({ example }) => {
      if (example.sx !== arc.sx || example.sy !== arc.sy) return false;
      const dx = (arc.x - example.x) * arc.sx, dy = (arc.y - example.y) * arc.sy;
      return Math.abs(dx) <= 10 && Math.abs(dy) <= 10 &&
        Math.abs(example.radius - arc.radius) <= 12;
    });
    if (!group) groups.push({ example:arc, traces:[arc] });
    else if (group.traces.every(other => {
      const dx = (arc.x - other.x) * arc.sx, dy = (arc.y - other.y) * arc.sy;
      return Math.abs(dx) >= 2 && Math.abs(dy) >= 2 && dx * dy > 0 && Math.abs(dx - dy) <= 4;
    })) group.traces.push(arc);
  }
  return groups;
}

/**
 * Approximate raster geometry, in image pixels. May include non-architectural strokes;
 * no interpretation as wall, window or measured CAD dimensions is implied.
 */
export function readRasterCurveEvidence(buffer) {
  try {
    const image = decodeDarkPixels(buffer);
    if (!image) return null;
    const candidates = groupParallel(collectCandidates(image))
      .filter(group => group.traces.length >= 2)
      .sort((a,b) => b.traces.length - a.traces.length || b.example.rank - a.example.rank)
      .slice(0, 12)
      .map(({ traces }) => {
        traces.sort((a,b) => (a.x - b.x) * a.sx + (a.y - b.y) * a.sy);
        const { x, y, sx, sy, radius } = traces[0];
        return {
          corner:[x,y],
          horizontalTangent:[x + sx * radius,y],
          verticalTangent:[x,y + sy * radius],
          radius,
          parallelTraces:traces.length,
        };
      });
    return candidates.length ? { width:image.width,height:image.height,candidates } : null;
  } catch {
    return null;
  }
}
