/**
 * 定位本机的 codex 可执行文件（精简移植自 baocut 的 codex-binary.ts）。
 *
 * 顺序：CODEX_PATH → `zsh -lc 'command -v codex'` → 常见安装路径。
 * 找到后跑一次 `codex --version`，并读 `codex login status` 判断登录态。
 * 结果缓存 30 秒，避免每次请求都起进程。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** 机器协议（codex-protocol.ts）对照的版本；更旧的 app-server 字段对不上。 */
export const MIN_CODEX_VERSION = '0.158.0';

const COMMON_PATHS = [
  '/opt/homebrew/bin/codex',
  '/usr/local/bin/codex',
  '~/.local/bin/codex',
  '~/.npm-global/bin/codex',
  '~/.bun/bin/codex',
  // 随 ChatGPT / Codex 桌面应用安装的 codex（与桌面应用共用登录态）
  '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
  '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
  '~/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
  '/Applications/Codex.app/Contents/Resources/codex',
  '~/Applications/Codex.app/Contents/Resources/codex',
];

const PROBE_TTL_MS = 30_000;
let cache = null;

/** 解析 "0.159.0" / "codex-cli 0.159.0" 里的版本号。 */
export function parseVersion(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? ''));
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

/** 比较两个点分版本：a<b 返回负数，相等 0，a>b 正数；解析不出的当作 0。 */
export function compareVersions(a, b) {
  const pa = String(a ?? '')
    .split('.')
    .map((n) => parseInt(n, 10) || 0);
  const pb = String(b ?? '')
    .split('.')
    .map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * 在登录 shell 里查 codex，并带回它的 PATH（GUI 进程的 PATH 往往不含 homebrew / node 全局目录）。
 * zsh 不存在时退回 sh。
 */
async function loginShellLookup() {
  const script = 'printf "%s\\n%s\\n" "$(command -v codex 2>/dev/null)" "$PATH"';
  for (const shell of ['zsh', 'sh']) {
    try {
      const { stdout } = await run(shell, ['-lc', script], { timeout: 10_000, env: process.env, maxBuffer: 256 * 1024 });
      const lines = String(stdout ?? '').split('\n');
      const candidate = (lines[0] ?? '').trim();
      const loginPath = lines.slice(1).join('\n').trim();
      return { candidate: candidate && candidate.includes(path.sep) && !candidate.includes(' ') ? candidate : null, loginPath };
    } catch {
      /* 换下一个 shell */
    }
  }
  return { candidate: null, loginPath: null };
}

async function readVersion(command, env) {
  try {
    const { stdout } = await run(command, ['--version'], { timeout: 10_000, env, maxBuffer: 64 * 1024 });
    return parseVersion(stdout);
  } catch {
    return null;
  }
}

/**
 * `codex login status` 退出码为 0 表示已登录。原文形如「Logged in using ChatGPT」，
 * 有些版本会带上邮箱；认不出账号时 email 为 null。
 */
export async function readLogin(install) {
  try {
    const { stdout, stderr } = await run(install.path, ['login', 'status'], {
      timeout: 10_000,
      env: install.env,
      maxBuffer: 256 * 1024,
    });
    const detail = String(stdout || stderr || '').trim();
    return { loggedIn: true, detail, ...parseAccount(detail) };
  } catch (error) {
    const detail = String(error?.stdout || error?.stderr || error?.message || '').trim();
    return { loggedIn: false, detail, account: null, method: null };
  }
}

function parseAccount(detail) {
  const email = /[\w.+-]+@[\w-]+\.[\w.-]+/.exec(detail)?.[0] ?? null;
  const method = /Logged in using\s+(.+)/i.exec(detail)?.[1]?.trim() ?? null;
  return { account: { email, method }, method };
}

/**
 * 找到 codex。返回：
 * { installed, path, version, compatible, env }
 * 找不到时 installed=false，path/version 为 null。
 */
export async function locateCodex({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < PROBE_TTL_MS) return cache.value;
  const value = findCodex();
  cache = { at: Date.now(), value };
  return value;
}

async function findCodex() {
  const override = process.env.CODEX_PATH?.trim();
  let loginPath = null;
  let candidate = null;

  if (override) {
    candidate = override;
  } else {
    const lookup = await loginShellLookup();
    candidate = lookup.candidate;
    loginPath = lookup.loginPath;
  }

  const env = { ...process.env };
  if (loginPath && !override) env.PATH = loginPath;
  const candidates = override && isExecutable(override) ? [override] : [candidate, ...COMMON_PATHS];
  let first = null;
  for (const file of new Set(candidates.filter(Boolean))) {
    const expanded = file.startsWith('~') ? path.join(os.homedir(), file.slice(1)) : file;
    if (!isExecutable(expanded)) continue;
    const version = await readVersion(expanded, env);
    const compatible = Boolean(version && compareVersions(version, MIN_CODEX_VERSION) >= 0);
    const install = { installed: true, path: expanded, version, compatible, env };
    if (compatible) return install;
    first ||= install;
  }
  return first || { installed: false, path: null, version: null, compatible: false, env };
}
