import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const converterPaths = ['/opt/homebrew/bin/dxf2dwg', '/usr/local/bin/dxf2dwg', '/usr/bin/dxf2dwg'];
const signature = Buffer.from('AC1015');
const timeoutMs = 20_000;
const maxDxfBytes = 24 * 1024 * 1024;
const maxDwgBytes = 64 * 1024 * 1024;

class DwgExportError extends Error {
  constructor(status, message, cause) {
    super(message, { cause });
    this.name = 'DwgExportError';
    this.status = status;
  }
}

async function findConverter() {
  const configured = process.env.STUDIO_DXF2DWG_PATH;
  if (configured && !isAbsolute(configured)) {
    throw new DwgExportError(503, 'STUDIO_DXF2DWG_PATH 需要指向 dxf2dwg 的绝对路径。');
  }
  for (const file of configured ? [configured] : converterPaths) {
    try {
      if (!(await stat(file)).isFile()) continue;
      await access(file, constants.R_OK | constants.X_OK);
      return file;
    } catch {
      // 顺序检查常见安装位置。
    }
  }
  const message = configured
    ? 'STUDIO_DXF2DWG_PATH 指向的 dxf2dwg 无法读取或执行。'
    : '缺少 LibreDWG 的 dxf2dwg。请安装 LibreDWG 或设置 STUDIO_DXF2DWG_PATH。';
  throw new DwgExportError(503, message);
}

async function readDrawing(file, signal) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size <= signature.length || info.size > maxDwgBytes) {
      throw new DwgExportError(502, 'DWG 转换输出缺失或文件大小异常。');
    }
    const result = await handle.readFile({ signal });
    if (result.length !== info.size || !result.subarray(0, signature.length).equals(signature)) {
      throw new DwgExportError(502, 'DWG 转换输出不是有效的 AutoCAD 2000 文件。');
    }
    return result;
  } finally {
    await handle.close();
  }
}

/** Convert a generated DXF document into an AutoCAD 2000 DWG. */
export async function convertDxfToDwg(dxf, { signal } = {}) {
  const size = typeof dxf === 'string' ? Buffer.byteLength(dxf) : Buffer.isBuffer(dxf) ? dxf.length : 0;
  if (!size) throw new DwgExportError(400, '没有可转换的 DXF 内容。');
  if (size > maxDxfBytes) throw new DwgExportError(413, 'DXF 图纸超出 DWG 转换大小限制。');
  if (signal?.aborted) throw new DwgExportError(499, 'DWG 转换已取消。', signal.reason);

  const converter = await findConverter();
  const deadline = AbortSignal.timeout(timeoutMs);
  const operation = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let directory;
  try {
    directory = await mkdtemp(join(tmpdir(), 'studio-dwg-'));
    await writeFile(join(directory, 'input.dxf'), dxf, { flag:'wx', mode:0o600, signal:operation });
    try {
      await run(converter, ['--as', 'r2000', '-o', 'output.dwg', 'input.dxf'], {
        cwd:directory,
        env:{ PATH:'/usr/bin:/bin', LANG:'en_US.UTF-8', TMPDIR:directory },
        signal:operation,
        killSignal:'SIGKILL',
        maxBuffer:256 * 1024,
      });
    } catch (error) {
      if (['ENOENT', 'EACCES', 'ENOEXEC'].includes(error.code)) {
        throw new DwgExportError(503, '无法启动 LibreDWG 的 dxf2dwg。', error);
      }
      throw error;
    }
    return await readDrawing(join(directory, 'output.dwg'), operation);
  } catch (error) {
    if (signal?.aborted) throw new DwgExportError(499, 'DWG 转换已取消。', signal.reason);
    if (deadline.aborted) throw new DwgExportError(504, 'DWG 转换超时。', error);
    if (error instanceof DwgExportError) throw error;
    throw new DwgExportError(502, 'DWG 转换失败，请检查转换器或重试。', error);
  } finally {
    if (directory) {
      await rm(directory, { recursive:true, force:true, maxRetries:2 }).catch(error => {
        console.error('DWG 转换临时文件清理失败：', error.code || 'unknown');
      });
    }
  }
}
