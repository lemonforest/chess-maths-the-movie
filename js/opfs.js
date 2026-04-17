/* opfs.js — thin helpers over Origin Private File System.
 *
 * Used by loader.js to cache per-game decompressed corpus entries between
 * sessions so repeated clicks on the same game skip the libarchive worker.
 * Layout under the OPFS root:
 *
 *   corpora/
 *     <cacheKey>/
 *       games/
 *         <index>.ndjson
 *         <index>.spectralz.gz
 *
 * Cache key is derived from filename + size + mtime (see computeCacheKey).
 * No content hashing — a re-downloaded file with new mtime invalidates the
 * cache, which is what we want.
 */

export function isOpfsAvailable() {
  return typeof navigator !== 'undefined'
      && !!navigator.storage
      && typeof navigator.storage.getDirectory === 'function';
}

/** Safe-ish cache key from a File. Filename is lightly sanitized; size
 *  and lastModified guard against same-name files being conflated. */
export function computeCacheKey(file) {
  const safeName = String(file.name || 'corpus').replace(/[^A-Za-z0-9._-]+/g, '_');
  return `${safeName}-${file.size ?? 0}-${file.lastModified ?? 0}`;
}

/** Return (creating if needed) the directory handle for corpora/<cacheKey>/.
 *  Throws if OPFS is unavailable. */
export async function getCorpusDir(cacheKey) {
  const root = await navigator.storage.getDirectory();
  const corpora = await root.getDirectoryHandle('corpora', { create: true });
  return corpora.getDirectoryHandle(cacheKey, { create: true });
}

/** Recursively resolve a slash-separated path into a directory handle,
 *  creating intermediate dirs when `create` is true. Returns the parent
 *  directory handle plus the final segment (the file basename). */
async function resolveParent(dir, path, create) {
  const segs = String(path).split('/').filter(Boolean);
  if (!segs.length) throw new Error('opfs: empty path');
  let here = dir;
  for (let i = 0; i < segs.length - 1; i++) {
    here = await here.getDirectoryHandle(segs[i], { create });
  }
  return { parent: here, name: segs[segs.length - 1] };
}

/** Write a Blob / ArrayBuffer / Uint8Array to `<dir>/<path>`, creating
 *  intermediate directories. Overwrites any existing entry. */
export async function writeFile(dir, path, data) {
  const { parent, name } = await resolveParent(dir, path, true);
  const fh = await parent.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  try {
    await w.write(data);
  } finally {
    await w.close();
  }
}

/** Read `<dir>/<path>` and return a File, or null if the entry is missing. */
export async function readFile(dir, path) {
  const { parent, name } = await resolveParent(dir, path, false).catch(() => ({}));
  if (!parent) return null;
  try {
    const fh = await parent.getFileHandle(name, { create: false });
    return await fh.getFile();
  } catch (e) {
    if (e && (e.name === 'NotFoundError' || e.code === 8)) return null;
    throw e;
  }
}

/** True iff `<dir>/<path>` exists and is a regular file. */
export async function fileExists(dir, path) {
  const f = await readFile(dir, path).catch(() => null);
  return !!f;
}

