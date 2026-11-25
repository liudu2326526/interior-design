#!/usr/bin/env node
/* ============================================================
 * 零依赖自测跑分器
 *   1. 用 Node 内置 http 在空闲端口静态服务项目根
 *   2. 用系统 Chrome（headless）打开 tests/selftest.html，通过 DevTools 管道等待结果
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
const CHROME_TIMEOUT_MS = 120000;

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

async function browserSelftest(url, profile){
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--mute-audio', '--user-data-dir=' + profile,
    '--remote-debugging-pipe', 'about:blank',
  ], {stdio:['ignore', 'ignore', 'pipe', 'pipe', 'pipe']});
  const input = chrome.stdio[3], output = chrome.stdio[4], pending = new Map();
  let next = 0, buffer = '', stderr = '', failure, data;
  const rejectPending = error => {
    failure ||= error;
    for (const {reject} of pending.values()) reject(failure);
    pending.clear();
  };
  const closed = new Promise(resolve => chrome.once('close', () => {
    rejectPending(new Error('Chrome 在自测结束前退出'));
    resolve();
  }));
  chrome.once('error', rejectPending);
  input.on('error', rejectPending);
  output.on('error', rejectPending);
  chrome.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
  output.setEncoding('utf8').on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\0')) >= 0){
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      const request = pending.get(message.id);
      if (!request) continue;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    }
  });
  const command = (method, params, sessionId) => {
    if (failure) return Promise.reject(failure);
    const id = ++next;
    return new Promise((resolve, reject) => {
      pending.set(id, {resolve, reject});
      input.write(JSON.stringify({id, method, params, sessionId}) + '\0');
    });
  };
  const timeout = setTimeout(() => rejectPending(new Error(`Chrome 自测超过 ${CHROME_TIMEOUT_MS / 1000} 秒`)), CHROME_TIMEOUT_MS);
  try {
    const {targetId} = await command('Target.createTarget', {url:'about:blank'});
    const {sessionId} = await command('Target.attachToTarget', {targetId, flatten:true});
    await command('Page.navigate', {url}, sessionId);
    // IndexedDB 使用实际 I/O，虚拟时间会在数据库提交完成前耗尽。
    for (;;){
      const result = await command('Runtime.evaluate', {
        expression:"document.querySelector('#result')?.textContent || ''",
        returnByValue:true,
      }, sessionId);
      if (result.result?.value) data = JSON.parse(result.result.value);
      if (data?.done === true) return data;
      await delay(100);
    }
  } catch (e) {
    console.error('Chrome 执行失败：' + e.message);
    if (stderr.trim()) console.error('Chrome stderr（末 2000 字）：\n' + stderr.trim());
    return data;
  } finally {
    clearTimeout(timeout);
    chrome.kill();
    const force = setTimeout(() => chrome.kill('SIGKILL'), 1500);
    await closed;
    clearTimeout(force);
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
  const data = await browserSelftest(url, profileDir);
  if (!Array.isArray(data?.checks)){
    console.error('FAIL: 自测未返回可读结果');
    exitCode = 1;
  } else {
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
