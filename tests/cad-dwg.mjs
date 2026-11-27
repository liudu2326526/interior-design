import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { convertDxfToDwg } from '../lib/cad-dwg.mjs';

async function fixture(t) {
  const parent = await mkdtemp(join(tmpdir(), 'studio-dwg-test-'));
  const path = join(parent, 'converter');
  const previous = { TMPDIR:process.env.TMPDIR, STUDIO_DXF2DWG_PATH:process.env.STUDIO_DXF2DWG_PATH };
  process.env.TMPDIR = parent;
  process.env.STUDIO_DXF2DWG_PATH = path;
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(parent, { recursive:true, force:true });
  });
  async function prepare(script) {
    const program = '#!' + process.execPath + '\nconst fs = require("node:fs");\n' + script;
    await writeFile(path, program, { mode:0o700 });
  }
  return {parent, prepare};
}

test('converts a bounded DXF in a private directory and returns AC1015 bytes', async t => {
  const { parent, prepare } = await fixture(t);
  await prepare(`
    const assert = require('node:assert/strict');
    assert.deepEqual(process.argv.slice(2), ['--as', 'r2000', '-o', 'output.dwg', 'input.dxf']);
    assert.equal(fs.statSync('.').mode & 0o777, 0o700);
    assert.equal(fs.statSync('input.dxf').mode & 0o777, 0o600);
    assert.equal(fs.readFileSync('input.dxf', 'utf8'), 'generated DXF');
    fs.writeFileSync('output.dwg', 'AC1015 test');
  `);
  assert.deepEqual(await convertDxfToDwg(Buffer.from('generated DXF')), Buffer.from('AC1015 test'));
  assert.deepEqual(await readdir(parent), ['converter']);
});

test('rejects absent executables and invalid converter output', async t => {
  const { parent, prepare } = await fixture(t);
  await assert.rejects(convertDxfToDwg('DXF'), { status:503 });
  await prepare('fs.writeFileSync("output.dwg", "AC1018 wrong version");');
  await assert.rejects(convertDxfToDwg('DXF'), { status:502 });
  await prepare('fs.writeFileSync("output.dwg", "AC1015"); fs.truncateSync("output.dwg", 64 * 1024 * 1024 + 1);');
  await assert.rejects(convertDxfToDwg('DXF'), { status:502 });
  await prepare('fs.symlinkSync("input.dxf", "output.dwg");');
  await assert.rejects(convertDxfToDwg('AC1015 not an output file'), { status:502 });
  assert.deepEqual(await readdir(parent), ['converter']);
});

test('cancels or times out the converter and removes its temporary files', async t => {
  const { parent, prepare } = await fixture(t);
  await prepare('setInterval(() => {}, 1000);');
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  await assert.rejects(convertDxfToDwg('DXF', { signal:timeout(250) }), { status:499 });
  assert.deepEqual(await readdir(parent), ['converter']);
  t.mock.method(AbortSignal, 'timeout', () => timeout(100));
  await assert.rejects(convertDxfToDwg('DXF'), { status:504 });
  assert.deepEqual(await readdir(parent), ['converter']);
});
