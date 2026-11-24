/**
 * codex app-server 的 stdio 传输（精简移植自 baocut 的 rpc-connection.ts）。
 *
 * 每行一个 JSON 对象，JSON-RPC 形状但不带 "jsonrpc" 字段。三种入站消息：
 * - 对我方请求的响应：有 id、有 result 或 error；
 * - 服务端请求：有 id 与 method（需要回写一条响应）；
 * - 通知：有 method、无 id。
 * 服务端请求的 id 可能是字符串或数字，原样回写。
 */
import readline from 'node:readline';

export class RpcError extends Error {
  constructor(message, code = undefined, data = undefined) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
}

/** 请求处理器抛出它表示「不回写响应」。 */
export const NO_RESPONSE = Symbol('no-response');

const STDERR_LIMIT = 8192;

export class RpcConnection {
  #child;
  #pending = new Map();
  #handlers = new Map();
  #onNotification = () => {};
  #onExit = () => {};
  #nextId = 1;
  #closed = false;
  #stderr = '';

  constructor(child) {
    this.#child = child;
    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => this.#handleLine(line));
    child.stderr.on('data', (chunk) => {
      this.#stderr = (this.#stderr + chunk.toString()).slice(-STDERR_LIMIT);
    });
    // 进程已退出时再写 stdin 会 EPIPE；忽略即可，真正的错误由 exit 事件处理。
    child.stdin.on('error', () => {});
    child.on('error', (error) => this.#terminate(error));
    child.on('exit', (code, signal) => {
      const clean = this.#closed || (code === 0 && !signal);
      this.#terminate(
        clean
          ? null
          : new RpcError(
              `codex 进程意外退出（code=${code ?? 'null'} signal=${signal ?? 'null'}）` +
                (this.#stderr.trim() ? `：${this.#stderr.trim()}` : ''),
            ),
      );
    });
  }

  get closed() {
    return this.#closed;
  }

  get stderrTail() {
    return this.#stderr;
  }

  onNotification(handler) {
    this.#onNotification = handler;
  }

  onExit(handler) {
    this.#onExit = handler;
  }

  handle(method, handler) {
    this.#handlers.set(method, handler);
  }

  request(method, params, timeoutMs = 60_000) {
    if (this.#closed) return Promise.reject(new RpcError('codex 连接已关闭'));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      let timer = null;
      if (timeoutMs && timeoutMs > 0) {
        timer = setTimeout(() => {
          if (!this.#pending.delete(id)) return;
          reject(new RpcError(`codex 请求超时：${method}`, 'timeout'));
        }, timeoutMs);
      }
      this.#pending.set(id, { method, resolve, reject, timer });
      this.#write({ id, method, params });
    });
  }

  notify(method, params) {
    if (this.#closed) return;
    this.#write(params === undefined ? { method } : { method, params });
  }

  /** 关闭 stdin 请它退出；超时后 SIGTERM，再超时 SIGKILL。 */
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectAll(new RpcError('codex 连接已关闭'));
    const child = this.#child;
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once('exit', () => resolve()));
    try {
      child.stdin.end();
    } catch {
      /* 已关闭 */
    }
    const wait = (ms) =>
      Promise.race([exited.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), ms))]);
    if (await wait(1500)) return;
    child.kill('SIGTERM');
    if (await wait(1500)) return;
    child.kill('SIGKILL');
    await wait(1000);
  }

  #write(message) {
    if (!this.#child.stdin.writable) return;
    try {
      this.#child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {
      /* stdin 已关闭，错误由 exit 事件处理 */
    }
  }

  #handleLine(line) {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // codex 偶尔会往 stdout 打非 JSON 日志，忽略
    }
    if (!msg || typeof msg !== 'object') return;
    const hasId = typeof msg.id === 'number' || typeof msg.id === 'string';
    const method = typeof msg.method === 'string' ? msg.method : null;

    if (hasId && method) {
      void this.#answer(msg.id, method, msg.params);
      return;
    }
    if (hasId) {
      const pending = this.#pending.get(msg.id);
      if (!pending) return;
      this.#pending.delete(msg.id);
      if (pending.timer) clearTimeout(pending.timer);
      const error = msg.error;
      if (error) {
        pending.reject(
          new RpcError(
            typeof error.message === 'string' ? error.message : 'codex 返回未知错误',
            error.code,
            error.data,
          ),
        );
      } else {
        pending.resolve(msg.result);
      }
      return;
    }
    if (method) {
      try {
        this.#onNotification(method, msg.params);
      } catch {
        /* 通知处理器不应影响连接 */
      }
    }
  }

  async #answer(id, method, params) {
    const handler = this.#handlers.get(method);
    if (!handler) {
      this.#write({ id, error: { code: -32601, message: `interior-design-studio 不支持 ${method}` } });
      return;
    }
    try {
      const result = await handler(params, id);
      this.#write({ id, result });
    } catch (error) {
      if (error === NO_RESPONSE) return;
      this.#write({ id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
    }
  }

  #terminate(error) {
    const wasClosed = this.#closed;
    this.#closed = true;
    this.#rejectAll(error ?? new RpcError('codex 连接已关闭'));
    if (!wasClosed || error) this.#onExit(error);
    this.#onExit = () => {};
  }

  #rejectAll(error) {
    for (const pending of this.#pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
