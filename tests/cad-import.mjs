import assert from 'node:assert/strict';
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readCadCurveEvidence } from '../lib/cad-import.mjs';
import { convertDxfToDwg } from '../lib/cad-dwg.mjs';
import { buildCadDxf } from '../lib/cad-dxf.mjs';
import { validatePlan } from '../lib/codex/plan.mjs';

const dxf = (...groups) => groups.join('\n') + '\n';
const arc = (handle, ...metadata) =>
  [0,'ARC',5,handle,8,'弧窗',...metadata,10,0,20,0,40,10,50,0,51,90];
const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
const nearPoint = (actual, [x, y]) => { closeTo(actual[0], x); closeTo(actual[1], y); };

async function workdir(t) {
  const directory = await mkdtemp(join(tmpdir(), 'studio-cad-evidence-test-'));
  t.after(() => rm(directory, {recursive:true, force:true}));
  return directory;
}

test('DXF report retains native curves and adjacent segments in model space', async t => {
  const file = join(await workdir(t), 'source.dxf');
  await writeFile(file, dxf(
    0,'SECTION',2,'HEADER',9,'$ACADVER',1,'AC1021',9,'$INSUNITS',70,5,0,'ENDSEC',
    0,'SECTION',2,'TABLES',
    0,'BLOCK_RECORD',5,'1F',2,'*Model_Space',
    0,'BLOCK_RECORD',5,'1B',2,'*Paper_Space',
    0,'ENDSEC',
    0,'SECTION',2,'BLOCKS',...arc('A0'),0,'ENDSEC',
    0,'SECTION',2,'ENTITIES',
    ...arc('A1',102,'{ACAD_REACTORS',330,'FF',102,'}',330,'1F',410,'Model'),
    0,'LWPOLYLINE',5,'A2',330,'1F',8,'弧窗',90,3,70,0,43,1.4,
    10,0,20,10,42,Math.tan(Math.PI / 8),10,-10,20,0,10,-20,20,0,
    0,'ARC',5,'A3',8,'负法向',10,30,20,0,30,3,40,10,50,0,51,90,210,0,220,0,230,-1,
    0,'ELLIPSE',5,'A4',8,'椭圆窗',10,50,20,0,11,20,21,0,40,.5,41,0,42,Math.PI / 2,
    ...arc('A5',67,1),
    ...arc('A6',410,'Sheet1'),
    ...arc('A7',330,'1B'),
    ...arc('A8',210,0,220,.707,230,.707),
    0,'INSERT',5,'A9',2,'Apartment',
    0,'ENDSEC',0,'EOF',
  ));
  const result = await readCadCurveEvidence(file, '上传的原图.DXF');
  assert.equal(result.format, 'DXF');
  assert.deepEqual(result.units, { code:5, name:'cm', mmPerUnit:10 });
  assert.equal(result.joinTolerance, .05);
  assert.equal(result.curves.length, 4);
  assert.deepEqual(result.omitted, { paperSpace:3, inserts:1, unsupportedCurves:0, tilted:1, invalid:0, scanLimited:false, additionalCurves:0 });

  const get = handle => result.curves.find(curve => curve.handle === handle);
  const start = get('A1'), continuation = get('A2'), negative = get('A3'), ellipse = get('A4');
  assert.equal(start.layer, '弧窗');
  nearPoint(start.from, [10,0]); nearPoint(start.to, [0,10]);
  assert.equal(start.sweepDeg, 90);
  nearPoint(continuation.center, [0,0]); nearPoint(continuation.to, [-10,0]);
  closeTo(continuation.radius, 10); closeTo(continuation.sweepDeg, 90);
  assert.deepEqual(continuation.width, [1.4,1.4]);
  assert.ok(start.links[1].includes(continuation.id));
  assert.ok(continuation.links[0].includes(start.id));
  const straight = result.adjacentSegments.find(line => line.handle === 'A2');
  assert.ok(continuation.links[1].includes(straight.id));
  assert.deepEqual(straight.to, [-20,0]);
  assert.equal(negative.sweepDeg, -90);
  assert.equal(negative.elevation, -3);
  nearPoint(negative.from, [-40,0]); nearPoint(negative.to, [-30,10]);
  assert.equal(ellipse.kind, 'ellipse');
  assert.equal(ellipse.circular, false);
  nearPoint(ellipse.from, [70,0]); nearPoint(ellipse.to, [50,10]);
});

test('CAD reader declines incomplete, non-CAD and oversized inputs and observes aborts', async t => {
  const directory = await workdir(t);
  const broken = join(directory, 'broken.dxf'), big = join(directory, 'big.dxf');
  await writeFile(broken, dxf(0,'SECTION',2,'ENTITIES',...arc('FF')));
  assert.equal(await readCadCurveEvidence(broken, 'image.png'), null);
  assert.equal(await readCadCurveEvidence(broken, 'broken.dxf'), null);
  assert.equal(await readCadCurveEvidence(broken, 'broken.dwg'), null);
  await writeFile(big, '');
  await truncate(big, 17 * 1024 * 1024);
  assert.equal(await readCadCurveEvidence(big, 'big.dxf'), null);
  const reason = new Error('cancelled by test');
  await assert.rejects(readCadCurveEvidence(big, 'big.dxf', { signal:AbortSignal.abort(reason) }), { message:reason.message });
});

test('native DWG round-trip keeps curved window evidence and declared units', async t => {
  const directory = await workdir(t);
  const { plan } = validatePlan({
    walls:[[0,0,1000,150,'e']],
    wins:[{from:[1000,0],to:[2000,1000],sweep:90,thickness:140}],
    rooms:[{id:'room1',poly:[[0,0],[1000,0],[2000,1000],[0,1000]],arcs:[{edge:1,sweep:90}]}],
  });
  const drawing = buildCadDxf({plan});
  let dwg;
  try { dwg = await convertDxfToDwg(drawing); }
  catch (error) {
    if (error.status === 503) return t.skip('LibreDWG dxf2dwg unavailable');
    throw error;
  }
  const file = join(directory, 'source.dwg');
  await writeFile(file, dwg);
  const source = join(directory, 'source.dxf');
  await writeFile(source, drawing);
  const ascii = await readCadCurveEvidence(source, 'source.dxf');
  const native = await readCadCurveEvidence(file, 'source.dwg');
  assert.equal(native?.format, 'DWG');
  assert.deepEqual(native.units, {code:4,name:'mm',mmPerUnit:1});
  assert.equal(native.curves.length, 5);
  assert.deepEqual(native.curves.map(({handle, ...geometry}) => geometry),
    ascii.curves.map(({handle, ...geometry}) => geometry));
});
