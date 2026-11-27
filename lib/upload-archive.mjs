import { randomUUID } from 'node:crypto';
import { mkdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const applicationRoot = fileURLToPath(new URL('../', import.meta.url));

// Each completed directory contains the entire upload, independent of its AI work files.
export async function archiveUploads(source, files, context = {}) {
  if (!files.length) return null;
  if (!/^[a-z][a-z0-9-]*$/.test(source)) throw new Error('Invalid upload source');
  const root = path.resolve(process.env.STUDIO_UPLOAD_ARCHIVE_DIR ||
    path.join(homedir(), '.interior-design-studio', 'uploads'));
  let staging;
  try {
    const category = path.join(root, source);
    await mkdir(category, { recursive: true, mode: 0o700 });
    const destination = await realpath(category);
    const served = await Promise.all([realpath(applicationRoot),
      realpath(path.join(applicationRoot, 'projects')).catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      })]);
    if (served.some(dir => dir && (destination === dir || destination.startsWith(dir + path.sep)))) {
      throw new Error('Upload archive is inside a served directory');
    }
    const createdAt = new Date().toISOString();
    const id = createdAt.slice(0, 10) + '-' + randomUUID();
    const batch = path.join(destination, id);
    const pending = path.join(destination, '.pending-' + id);
    await mkdir(pending, { mode: 0o700 });
    staging = pending;
    const entries = [];
    for (const [index, file] of files.entries()) {
      const number = String(index + 1);
      const name = (file.originalName || file.name || '').split(/[/\\]/).at(-1) || 'upload';
      // Keep duplicates and Unicode names intact. The manifest can also describe names
      // received from non-filesystem clients that cannot be used as a local basename.
      const basename = !/[\u0000-\u001f\u007f]/.test(name) && name !== '.' && name !== '..' && Buffer.byteLength(name) <= 255
        ? name : 'upload';
      await mkdir(path.join(staging, number), { mode: 0o700 });
      const relative = path.join(number, basename);
      await writeFile(path.join(staging, relative), file.buffer, { mode: 0o600, flag: 'wx' });
      entries.push({ name, file: relative, bytes: file.buffer.length });
    }
    await writeFile(path.join(staging, 'manifest.json'), JSON.stringify({ source, createdAt, context, files: entries }), {
      mode: 0o600, flag: 'wx',
    });
    await rename(staging, batch);
    return batch;
  } catch (cause) {
    if (staging) await rm(staging, { recursive: true, force: true }).catch(() => {});
    console.error('上传原件归档失败', cause.code || cause.message);
    throw Object.assign(new Error('上传原件保存失败，请稍后重试。', { cause }), { status: 503 });
  }
}
