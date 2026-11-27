#!/usr/bin/env node
/* ============================================================
 * 零依赖自测跑分器
 *   1. 用 Node 内置 http 在空闲端口静态服务项目根
 *   2. 用系统 Chrome（headless）打开 tests/selftest.html，等待页面报告测试完成
 *   3. 从 <pre id="result"> 解析 JSON，打印通过/失败明细；失败退出码 1
 * 不安装任何依赖，端口由系统分配，路径全部相对项目根拼接。
 * ============================================================ */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, stat, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PAGE = '/tests/selftest.html';
const RESULT_TIMEOUT_MS = 30000;  // 与 selftest.html 内部 15s 等待上限留余量

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function skip(reason){
  console.log('SKIP: ' + reason);
  process.exit(0);
}

if (!existsSync(CHROME)) skip('未找到 Chrome（' + CHROME + '），跳过自测');

/* ---------------- 静态服务（只读，防路径穿越） ---------------- */
function serve(){
  return new Promise((ok, bad) => {
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        let rel = decodeURIComponent(url.pathname);
        if (rel.endsWith('/')) rel += 'index.html';
        const file = resolve(join(ROOT, rel));
        const inside = file === ROOT || file.startsWith(ROOT + sep);
        if (!inside || !isAbsolute(file)) { res.writeHead(403); return res.end('forbidden'); }
        const st = await stat(file);
        if (!st.isFile()) { res.writeHead(404); return res.end('not found'); }
        const body = await readFile(file);
        res.writeHead(200, {
          'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
          'content-length': body.length,
          'cache-control': 'no-store',
        });
        res.end(body);
      } catch (e) {
        res.writeHead(404); res.end('not found');
      }
    });
    server.once('error', bad);
    server.listen(0, '127.0.0.1', () => ok(server));   // 端口 0 = 由系统分配空闲端口
  });
}

/* ---------------- Chrome 结果 ---------------- */
async function runChrome(url, profileDir){
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--mute-audio', '--user-data-dir=' + profileDir,
    '--remote-debugging-pipe', 'about:blank',
  ], {stdio:['ignore', 'ignore', 'pipe', 'pipe', 'pipe']});
  const [, , stderr, input, output] = chrome.stdio;
  const exited = new Promise(resolve => chrome.once('close', resolve));
  let id = 0, buffer = '', log = '', failure;
  const pending = new Map();

  function fail(error){
    failure ||= error;
    for (const {reject} of pending.values()) reject(failure);
    pending.clear();
  }
  chrome.once('error', fail);
  chrome.once('exit', (code, signal) => fail(new Error('Chrome 提前退出 ' + (signal || code))));
  input.on('error', fail);
  output.on('error', fail);
  stderr.setEncoding('utf8').on('data', part => { log = (log + part).slice(-2000); });
  output.setEncoding('utf8').on('data', part => {
    const messages = (buffer + part).split('\0');
    buffer = messages.pop();
    for (const raw of messages){
      if (!raw) continue;
      let message;
      try { message = JSON.parse(raw); }
      catch (error){ fail(error); return; }
      const request = pending.get(message.id);
      if (!request) continue;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    }
  });
  function send(method, params, sessionId){
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      const next = ++id;
      pending.set(next, {resolve, reject});
      input.write(JSON.stringify({id:next, method, params, sessionId}) + '\0');
    });
  }

  const commandTimeout = setTimeout(() => fail(new Error('Chrome 自测超时')), RESULT_TIMEOUT_MS + 10000);
  try {
    const {targetId} = await send('Target.createTarget', {url:'about:blank'});
    const {sessionId} = await send('Target.attachToTarget', {targetId, flatten:true});
    const navigation = await send('Page.navigate', {url}, sessionId);
    if (navigation.errorText) throw new Error(navigation.errorText);
    const deadline = Date.now() + RESULT_TIMEOUT_MS;
    let latest;
    while (Date.now() < deadline){
      const response = await send('Runtime.evaluate', {
        expression:'document.querySelector("#result")?.textContent', returnByValue:true,
      }, sessionId);
      const raw = response.result?.value?.trim();
      if (raw){
        latest = JSON.parse(raw);
        if (!latest || !Array.isArray(latest.checks)) throw new Error('结果缺少 checks 数组');
        if (latest.done === true) return latest;
      }
      await delay(100);
    }
    if (!latest) throw new Error('自测未生成结果');
    return latest;
  } catch (error){
    if (log) console.error('Chrome stderr（末 2000 字）：\n' + log.trim());
    throw error;
  } finally {
    clearTimeout(commandTimeout);
    chrome.kill();
    const forceClose = setTimeout(() => chrome.kill('SIGKILL'), 2000);
    await exited;
    clearTimeout(forceClose);
  }
}

/* ---------------- 主流程 ---------------- */
let server = null;
let profileDir = null;
let exitCode = 0;

try {
  server = await serve();
  const port = server.address().port;
  const url = 'http://127.0.0.1:' + port + PAGE;
  profileDir = await mkdtemp(join(tmpdir(), 'studio-selftest-'));

  console.log('selftest: ' + url);
  const data = await runChrome(url, profileDir);
  const passed = data.checks.filter(c => c.ok).length;
  const failed = data.checks.length - passed;
  console.log('selftest: ' + passed + ' passed, ' + failed + ' failed');
  for (const c of data.checks) {
    const name = String(c && c.name || '(unnamed)');
    const detail = c && c.detail ? ' — ' + String(c.detail) : '';
    console.log('  ' + (c && c.ok ? 'PASS' : 'FAIL') + '  ' + name + detail);
  }
  if (data.done !== true) {
    console.error('FAIL: 自测未跑完（done != true），结果可能不完整');
    exitCode = 1;
  } else if (failed > 0 || passed === 0) {
    exitCode = 1;
  }
} catch (e) {
  console.error('FAIL: ' + ((e && e.stack) || e));
  exitCode = 1;
} finally {
  if (server) {
    server.closeAllConnections?.();                 // 断开 Chrome 的 keep-alive，避免 close 挂住
    await new Promise(r => server.close(r));
  }
  if (profileDir) { try { await rm(profileDir, { recursive: true, force: true }); } catch (e) {} }
}

process.exitCode = exitCode;
