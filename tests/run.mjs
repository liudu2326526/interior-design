#!/usr/bin/env node
/* ============================================================
 * 零依赖自测跑分器
 *   1. 用 Node 内置 http 在空闲端口静态服务项目根
 *   2. 用系统 Chrome（headless）打开 tests/selftest.html，--dump-dom 抓取最终 DOM
 *   3. 从 <pre id="result"> 解析 JSON，打印通过/失败明细；失败退出码 1
 * 不安装任何依赖，端口由系统分配，路径全部相对项目根拼接。
 * ============================================================ */
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PAGE = '/tests/selftest.html';
const BUDGET_MS = 20000;          // 与 selftest.html 内部 15s 等待上限留余量
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

/* ---------------- 结果解析 ---------------- */
const decodeHtml = s => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#0*39;/g, "'")
  .replace(/&#x27;/gi, "'").replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&');

function parseResult(dom){
  const m = dom.match(/<pre id="result"[^>]*>([\s\S]*?)<\/pre>/i);
  if (!m) throw new Error('未在 DOM 中找到 <pre id="result">');
  const raw = decodeHtml(m[1]).trim();
  if (!raw) throw new Error('<pre id="result"> 为空（自测未完成或 Chrome 提前退出）');
  let data;
  try { data = JSON.parse(raw); }
  catch (e) { throw new Error('结果不是合法 JSON：' + e.message + '；原文前 200 字：' + raw.slice(0, 200)); }
  if (!data || !Array.isArray(data.checks)) throw new Error('结果缺少 checks 数组');
  return data;
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
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--mute-audio',
    '--user-data-dir=' + profileDir,
    '--virtual-time-budget=' + BUDGET_MS,
    '--dump-dom',
    url,
  ];

  let dom = '';
  try {
    const out = await execFileAsync(CHROME, args, {
      maxBuffer: 64 * 1024 * 1024,
      timeout: CHROME_TIMEOUT_MS,
      encoding: 'utf8',
    });
    dom = out.stdout || '';
  } catch (e) {
    dom = (e && e.stdout) || '';
    if (!dom) {
      console.error('Chrome 执行失败：' + ((e && e.message) || e));
      const err = String((e && e.stderr) || '').trim();
      if (err) console.error('Chrome stderr（末 2000 字）：\n' + err.slice(-2000));
    }
  }

  let data;
  try {
    data = parseResult(dom);
  } catch (e) {
    console.error('FAIL: ' + e.message);
    const tail = String(dom).trim().slice(0, 500);
    if (tail) console.error('DOM 片段：\n' + tail);
    exitCode = 1;
  }

  if (data) {
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
