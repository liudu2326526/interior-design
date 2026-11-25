import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { buildRenderPrompt } from '../lib/render-prompt.mjs';

const guide = await readFile(new URL('../prompts/render.md', import.meta.url), 'utf8');

test('render prompt uses the chosen style and leads with the supplied note', () => {
  const note = '傍晚暖光，突出木纹';
  const creamy = buildRenderPrompt(guide, {style:'奶油风', note, kind:'room', scene:{camera:{roomName:'客厅'}}});
  const nordic = buildRenderPrompt(guide, {style:'北欧', kind:'angle'});
  assert.ok(creamy.indexOf(note) < creamy.indexOf('保持机位'));
  assert.match(creamy, /室内视角 · 客厅/);
  assert.match(creamy, /3000–3500K/);
  assert.match(nordic, /偏冷 5000K/);
  assert.doesNotMatch(nordic, /本次补充描述|用户补充描述（优先于风格/);
  for (const prompt of [creamy, nordic]) {
    for (const label of ['配色', '材质', '照明', '家具轮廓', '负向约束']) assert.match(prompt, new RegExp(`^${label}：`, 'm'));
    assert.match(prompt, /保持机位/);
    assert.match(prompt, /弧形窗/);
  }
});

test('missing style guide sections are surfaced instead of silently sending generic instructions', () => {
  assert.throws(() => buildRenderPrompt('# Missing template', {}), /提示词模板缺少/);
});
