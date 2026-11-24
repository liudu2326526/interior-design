/**
 * codex app-server 会话（精简移植自 baocut 的 codex-session.ts）。
 *
 * 一个 CodexSession 对应一个常驻的 `codex app-server` 子进程：
 * initialize → thread/start → 每轮 turn/start，收到 turn/completed 结束。
 * 协议字段以 baocut 的 codex-protocol.ts 为准（0.158.0 / 0.159.0）。
 */
import { spawn } from 'node:child_process';
import { RpcConnection, RpcError } from './rpc.mjs';

const CLIENT_INFO = { name: 'interior-design-studio', title: 'Interior Design Studio', version: '1.0.0' };
const INIT_TIMEOUT_MS = 30_000;
const THREAD_TIMEOUT_MS = 60_000;
const TURN_START_TIMEOUT_MS = 30_000;
const INTERRUPT_TIMEOUT_MS = 10_000;

/** 回合的错误（最近一条不再重试的 `error` 通知），等 turn/completed 一起报。 */
function turnFailure(error) {
  const message = typeof error?.message === 'string' && error.message ? error.message : 'codex 回合失败';
  return { message, codexErrorInfo: error?.codexErrorInfo ?? null, details: error?.additionalDetails ?? null };
}

export class CodexSession {
  #conn;
  #threadId = null;
  #pending = null;
  #alive = true;

  constructor(conn) {
    this.#conn = conn;
  }

  static async start(options) {
    const {
      install,
      cwd,
      sandbox = 'read-only',
      approvalPolicy = 'never',
      developerInstructions = null,
      model = null,
    } = options || {};
    if (!install?.path) throw new RpcError('未找到 codex 可执行文件（codex executable not found）');
    const child = spawn(install.path, ['app-server'], {
      cwd,
      env: install.env || process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const session = new CodexSession(new RpcConnection(child));
    try {
      await session.#initialize({ cwd, sandbox, approvalPolicy, developerInstructions, model });
      return session;
    } catch (error) {
      await session.dispose().catch(() => {});
      throw error;
    }
  }

  get threadId() {
    return this.#threadId;
  }

  get alive() {
    return this.#alive && !this.#conn.closed;
  }

  async #initialize({ cwd, sandbox, approvalPolicy, developerInstructions, model }) {
    const conn = this.#conn;
    conn.onNotification((method, params) => this.#onNotification(method, params));
    conn.onExit((error) => {
      this.#alive = false;
      const pending = this.#pending;
      this.#pending = null;
      if (pending) {
        clearTimeout(pending.timer);
        pending.reject(error ?? new RpcError('codex 会话已退出（codex session exited）'));
      }
    });
    // 审批策略是 never，正常不会收到这两个请求；万一收到（越界升级），一律拒绝，保证服务不卡住。
    for (const method of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval']) {
      conn.handle(method, () => ({ decision: 'decline' }));
    }

    await conn.request('initialize', { clientInfo: CLIENT_INFO, capabilities: null }, INIT_TIMEOUT_MS);
    conn.notify('initialized');

    const params = { cwd, approvalPolicy, sandbox, developerInstructions: developerInstructions ?? null };
    if (model) params.model = model;
    const res = await conn.request('thread/start', params, THREAD_TIMEOUT_MS);
    const threadId = res?.thread?.id;
    if (typeof threadId !== 'string' || !threadId) {
      throw new RpcError('codex thread/start 没有返回 thread id');
    }
    this.#threadId = threadId;
  }

  /** 直接发一条 RPC（目前用于 model/list 之类的探测）。 */
  request(method, params, timeoutMs) {
    return this.#conn.request(method, params, timeoutMs);
  }

  /**
   * 跑一个回合。同一会话同一时间只允许一个回合，调用方负责排队（见 SessionPool）。
   * @returns {Promise<{text:string, outcome:'completed'|'failed'|'interrupted', error:string|null, turnId:string|null, items:unknown[]}>}
   */
  runTurn({ input, timeoutMs = 10 * 60_000, onEvent = () => {} } = {}) {
    if (!this.alive) return Promise.reject(new RpcError('codex 会话不可用（codex session is not alive）'));
    if (this.#pending) return Promise.reject(new RpcError('codex 会话正忙，上一轮尚未结束（session busy）'));
    if (!this.#threadId) return Promise.reject(new RpcError('codex 会话尚未就绪（thread not started）'));

    return new Promise((resolve, reject) => {
      const pending = {
        resolve,
        reject,
        timer: null,
        turnId: null,
        messages: new Map(),
        deltas: '',
        items: [],
        failure: null,
        onEvent,
        abortRequested: false,
      };
      this.#pending = pending;
      pending.timer = setTimeout(() => {
        if (this.#pending !== pending) return;
        this.#pending = null;
        if (pending.turnId) {
          this.#conn
            .request('turn/interrupt', { threadId: this.#threadId, turnId: pending.turnId }, INTERRUPT_TIMEOUT_MS)
            .catch(() => {});
        }
        reject(new RpcError(`codex 响应超时（${Math.round(timeoutMs / 1000)} 秒）`, 'timeout'));
      }, timeoutMs);

      this.#conn
        .request('turn/start', { threadId: this.#threadId, input }, TURN_START_TIMEOUT_MS)
        .then((res) => {
          const turnId = res?.turn?.id ?? null;
          if (this.#pending !== pending) {
            // 超时 / 取消之后才收到应答：回合可能已经在跑，主动打断，避免留下无人跟踪的任务。
            if (turnId && this.#threadId) {
              this.#conn
                .request('turn/interrupt', { threadId: this.#threadId, turnId }, INTERRUPT_TIMEOUT_MS)
                .catch(() => {});
            }
            return;
          }
          pending.turnId = turnId;
          if (pending.abortRequested && pending.turnId) {
            this.#conn
              .request('turn/interrupt', { threadId: this.#threadId, turnId: pending.turnId }, INTERRUPT_TIMEOUT_MS)
              .catch(() => {});
          }
          // 极少数情况下回合在应答前就结束了：按已完成处理。
          if (res?.turn && res.turn.status && res.turn.status !== 'inProgress') this.#finish(res.turn);
        })
        .catch((error) => {
          if (this.#pending !== pending) return;
          this.#pending = null;
          clearTimeout(pending.timer);
          reject(error);
        });
    });
  }

  /** 打断当前回合（SSE 客户端断开、用户取消时用）。 */
  async interrupt() {
    const pending = this.#pending;
    if (!pending) return;
    pending.abortRequested = true;
    if (pending.turnId && this.#threadId) {
      await this.#conn
        .request('turn/interrupt', { threadId: this.#threadId, turnId: pending.turnId }, INTERRUPT_TIMEOUT_MS)
        .catch(() => {});
    }
  }

  async dispose() {
    this.#alive = false;
    await this.#conn.close();
  }

  #emit(event) {
    const pending = this.#pending;
    if (!pending) return;
    try {
      pending.onEvent(event);
    } catch {
      /* 回调异常不影响会话 */
    }
  }

  #onNotification(method, raw) {
    const p = raw && typeof raw === 'object' ? raw : {};
    if (typeof p.threadId === 'string' && this.#threadId && p.threadId !== this.#threadId) return;

    switch (method) {
      case 'turn/started': {
        this.#emit({ type: 'status', text: 'codex 开始处理…' });
        return;
      }
      case 'item/agentMessage/delta': {
        const delta = typeof p.delta === 'string' ? p.delta : '';
        if (delta && this.#pending) {
          this.#pending.deltas += delta;
          this.#emit({ type: 'delta', text: delta });
        }
        return;
      }
      case 'item/started':
      case 'item/completed': {
        this.#onItem(p.item, method);
        return;
      }
      case 'error': {
        const failure = turnFailure(p.error);
        const willRetry = p.willRetry === true;
        if (this.#pending) this.#pending.failure = failure;
        this.#emit({
          type: 'status',
          text: willRetry ? `codex 遇到错误，正在重试：${failure.message}` : `codex 错误：${failure.message}`,
          error: true,
        });
        return;
      }
      case 'turn/completed': {
        this.#finish(p.turn);
        return;
      }
      default:
        return; // 其余通知（reasoning 摘要等）忽略
    }
  }

  #onItem(item, phase) {
    const pending = this.#pending;
    if (!pending || !item || typeof item !== 'object') return;
    if (phase === 'item/completed') pending.items.push(item);
    if (item.type !== 'agentMessage') {
      if (phase === 'item/started') {
        const label = {
          commandExecution: 'codex 正在执行命令…',
          fileChange: 'codex 正在写入文件…',
          mcpToolCall: `codex 正在调用工具${item.tool ? ` ${item.tool}` : ''}…`,
          dynamicToolCall: `codex 正在调用工具${item.tool ? ` ${item.tool}` : ''}…`,
          reasoning: 'codex 正在思考…',
        }[item.type];
        if (label) this.#emit({ type: 'status', text: label });
      }
      return;
    }
    if (typeof item.text === 'string') {
      const id = typeof item.id === 'string' ? item.id : `m${pending.messages.size}`;
      pending.messages.set(id, item.text);
    }
  }

  #finish(turn) {
    const pending = this.#pending;
    if (!pending) return;
    // 不是当前回合的完成通知（理论上不会出现）：忽略。
    if (pending.turnId && turn?.id && turn.id !== pending.turnId) return;
    this.#pending = null;
    clearTimeout(pending.timer);

    const status = turn?.status;
    const outcome = status === 'failed' ? 'failed' : status === 'interrupted' ? 'interrupted' : 'completed';
    const messages = [...pending.messages.values()].map((t) => t.trim()).filter(Boolean);
    const text = (messages.length ? messages.join('\n\n') : pending.deltas).trim();
    const failure = outcome === 'failed' ? turnFailure(turn?.error ?? pending.failure ?? {}) : null;
    const error =
      outcome === 'failed'
        ? (failure?.message ?? pending.failure?.message ?? 'codex 回合失败')
        : outcome === 'interrupted'
          ? 'codex 回合被中断（interrupted）'
          : null;

    pending.resolve({
      text,
      outcome,
      error,
      turnId: pending.turnId ?? turn?.id ?? null,
      items: pending.items,
    });
  }
}

/** 用一个临时 app-server 取模型表（health 用）。失败返回空数组。 */
export async function probeModels(install, { cwd, timeoutMs = 8000 } = {}) {
  if (!install?.path) return [];
  const child = spawn(install.path, ['app-server'], {
    cwd,
    env: install.env || process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const conn = new RpcConnection(child);
  try {
    await conn.request('initialize', { clientInfo: CLIENT_INFO, capabilities: null }, timeoutMs);
    conn.notify('initialized');
    const res = await conn.request('model/list', { includeHidden: false, limit: 50 }, timeoutMs);
    const data = Array.isArray(res?.data) ? res.data : [];
    return data
      .map((m) => (typeof m === 'string' ? m : m?.id || m?.model))
      .filter((id) => typeof id === 'string' && id);
  } finally {
    await conn.close().catch(() => {});
  }
}

/**
 * 按 key 复用 CodexSession，并把同一 key 的回合串行化。
 * 空闲超过 idleMs 的会话会被回收；找不到/退出的进程会在下一轮重建。
 */
export class SessionPool {
  #entries = new Map();
  #max;
  #idleMs;
  #timer;

  constructor({ max = 6, idleMs = 30 * 60_000 } = {}) {
    this.#max = max;
    this.#idleMs = idleMs;
    this.#timer = setInterval(() => {
      void this.sweep();
    }, 60_000);
    this.#timer.unref?.();
  }

  /**
   * @param {string} key 会话键（如 `chat:<sessionId>`）
   * @param {() => Promise<CodexSession>} create 新建会话
   * @param {(session: CodexSession) => Promise<T>} work 使用会话
   */
  run(key, create, work) {
    let entry = this.#entries.get(key);
    if (!entry) {
      if (this.#entries.size >= this.#max) this.#evictOne(key);
      entry = { session: null, chain: Promise.resolve(), lastUsed: Date.now(), active: 0 };
      this.#entries.set(key, entry);
    }

    const job = entry.chain.then(async () => {
      try {
        if (!entry.session || !entry.session.alive) {
          if (entry.session) await entry.session.dispose().catch(() => {});
          entry.session = await create();
        }
        entry.lastUsed = Date.now();
        return await work(entry.session);
      } finally {
        entry.lastUsed = Date.now();
      }
    });
    // 排队中的任务也算活跃，避免被 #evictOne 提前回收。
    entry.active++;
    job.then(
      () => entry.active--,
      () => entry.active--,
    );
    // 队列里的失败不能拖垮后续回合。
    entry.chain = job.then(
      () => undefined,
      () => undefined,
    );
    return job;
  }

  #evictOne(keepKey) {
    const candidates = [...this.#entries.entries()]
      .filter(([key, entry]) => key !== keepKey && entry.active === 0)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    const picked = candidates[0];
    if (!picked) return;
    this.#entries.delete(picked[0]);
    void picked[1].session?.dispose().catch(() => {});
  }

  async sweep() {
    const now = Date.now();
    for (const [key, entry] of [...this.#entries]) {
      if (entry.active === 0 && now - entry.lastUsed > this.#idleMs) {
        this.#entries.delete(key);
        await entry.session?.dispose().catch(() => {});
      }
    }
  }

  async dispose(key) {
    const entry = this.#entries.get(key);
    if (!entry) return;
    this.#entries.delete(key);
    await entry.session?.dispose().catch(() => {});
  }

  async disposeAll() {
    clearInterval(this.#timer);
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    await Promise.all(entries.map((entry) => entry.session?.dispose().catch(() => {})));
  }
}
