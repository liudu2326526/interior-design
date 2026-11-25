import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CodexSession } from '../lib/codex/session.mjs';

const tool = {
  type: 'function',
  name: 'image_gen',
  description: 'Prepare a render',
  inputSchema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] },
};

async function fixture(t, { dynamic = true, ...options } = {}) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'studio-tool-protocol-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const runner = path.join(cwd, 'codex.cjs');
  await writeFile(runner, `#!/usr/bin/env node
    const readline = require('node:readline');
    const assert = require('node:assert/strict');
    const dynamic = ${JSON.stringify(dynamic)};
    const send = (value) => console.log(JSON.stringify(value));
    const answer = (id, result) => send({ id, result });
    let turnRequest;
    const endTurn = status => send({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status } } });
    readline.createInterface({ input: process.stdin }).on('line', line => {
      const { id, method, params, result } = JSON.parse(line);
      switch (method) {
        case 'initialize':
          assert.deepEqual(params.capabilities, dynamic ? { experimentalApi: true } : null);
          answer(id, {});
          break;
        case 'thread/start':
          assert.deepEqual(params.dynamicTools, dynamic ? [${JSON.stringify(tool)}] : undefined);
          answer(id, { thread: { id: 'thread' } });
          break;
        case 'turn/start':
          if (!dynamic) {
            answer(id, { turn: { id: 'turn', status: 'completed' } });
            break;
          }
          turnRequest = id;
          send({ id: 'foreign', method: 'item/tool/call', params: {
            threadId: 'foreign', turnId: 'turn', callId: 'foreign-call', tool: 'image_gen', arguments: { prompt: 'wrong' },
          } });
          send({ id: 'tool', method: 'item/tool/call', params: {
            threadId: 'thread', turnId: 'turn', callId: 'call', tool: 'image_gen', arguments: { prompt: 'known' },
          } });
          break;
        case 'turn/interrupt':
          assert.equal(params.turnId, 'turn');
          answer(id, {});
          answer(turnRequest, { turn: { id: 'turn', status: 'inProgress' } });
          endTurn('interrupted');
          break;
        default:
          if (id === 'foreign') assert.equal(result.success, false);
          if (id === 'tool' && result.success) {
            assert.deepEqual(result.contentItems, [{ type: 'inputText', text: 'saved' }]);
            answer(turnRequest, { turn: { id: 'turn', status: 'inProgress' } });
            endTurn('completed');
          }
      }
    });
  `, { mode: 0o700 });
  const session = await CodexSession.start({
    cwd,
    install: { path: runner },
    ...(dynamic ? { dynamicTools: [tool] } : {}),
    ...options,
  });
  t.after(() => session.dispose());
  return session;
}

test('negotiates tools and accepts only the correct tool call before turn/start responds', async (t) => {
  const calls = [];
  const session = await fixture(t, {
    onToolCall: async ({ tool, arguments: args, threadId, turnId, callId, signal }) => {
      calls.push({ tool, args, threadId, turnId, callId, aborted: signal.aborted });
      return { success: true, contentItems: [{ type: 'inputText', text: 'saved' }] };
    },
  });
  assert.equal((await session.runTurn({ input: [], timeoutMs: 2500 })).outcome, 'completed');
  assert.deepEqual(calls, [{
    tool: 'image_gen', args: { prompt: 'known' }, threadId: 'thread', turnId: 'turn', callId: 'call', aborted: false,
  }]);
});

test('aborts an in-flight tool when interrupting the current turn', async (t) => {
  let observeSignal;
  const toolStarted = new Promise((resolve) => { observeSignal = resolve; });
  const session = await fixture(t, {
    onToolCall: ({ signal }) => {
      observeSignal(signal);
      return new Promise((resolve) => signal.addEventListener('abort', () => {
        resolve({ success: true, contentItems: [{ type: 'inputText', text: 'saved' }] });
      }, { once: true }));
    },
  });
  const turn = session.runTurn({ input: [], timeoutMs: 2500 });
  const signal = await Promise.race([toolStarted, turn.then(() => assert.fail('turn ended before tool call'))]);
  await session.interrupt();
  assert.equal(signal.aborted, true);
  assert.equal((await turn).outcome, 'interrupted');
});

test('keeps the standard non-experimental handshake without tools', async (t) => {
  const session = await fixture(t, { dynamic: false });
  assert.equal((await session.runTurn({ input: [], timeoutMs: 2500 })).outcome, 'completed');
});
