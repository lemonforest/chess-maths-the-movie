/* loader.js — corpus pipeline
 *
 * Pipeline:
 *   1. User drops a .7z file.
 *   2. libarchive.js (Web Worker) decompresses it into File entries.
 *   3. Locate manifest.json (by basename) → resolve all other paths
 *      relative to the manifest's directory inside the archive.
 *   4. Read PGN raw, parse NDJSON line-by-line for ply records.
 *   5. Decompress .spectralz with native DecompressionStream('gzip'),
 *      validate LARTPSEC magic, build per-ply Float32Array views into
 *      the decompressed buffer (no copy), precompute channel energies.
 *
 * Progress events emitted via the supplied onProgress callback:
 *   { phase: 'decompress' | 'manifest' | 'pgn' | 'ndjson' | 'spectral'
 *           | 'done' | 'error',
 *     msg: string, fraction: 0..1 }
 *
 * Spectral data for game 1 is parsed eagerly; other games' spectrals
 * are parsed on first access via parseGameSpectral(corpus, gameIndex).
 */

import {
  CHANNELS,
  channelEnergyForPly,
  parseEvalString,
} from './spectral.js';

// Resolved relative to this module so the paths work both from the repo root
// and from any subdirectory that the site is served from.
const LIBARCHIVE_URL        = new URL('../lib/libarchive/libarchive.js', import.meta.url).href;
const LIBARCHIVE_WORKER_URL = new URL('../lib/libarchive/worker-bundle.js', import.meta.url).href;

let _ArchivePromise = null;
function importArchive() {
  if (!_ArchivePromise) {
    _ArchivePromise = import(/* @vite-ignore */ LIBARCHIVE_URL).then((mod) => {
      const Archive = mod.Archive || (mod.default && mod.default.Archive);
      if (!Archive) throw new Error('libarchive.js: Archive class not found in module');
      Archive.init({ workerUrl: LIBARCHIVE_WORKER_URL });
      return Archive;
    });
  }
  return _ArchivePromise;
}

/* ------------------------------------------------------------------ *
 * Public entry point
 * ------------------------------------------------------------------ */

export async function loadCorpusFromFile(file, onProgress = () => {}) {
  const emit = (phase, msg, fraction) => onProgress({ phase, msg, fraction });

  emit('decompress', `Decompressing ${file.name} (${formatBytes(file.size)})…`, 0.02);

  const fileMap = await extractArchive(file);
  emit('decompress', `Archive extracted: ${fileMap.size} entries`, 0.18);

  // Locate manifest.json (by basename) so we tolerate a wrapping directory
  const manifestEntry = findEntry(fileMap, 'manifest.json');
  if (!manifestEntry) throw new Error('manifest.json not found in archive');

  const baseDir = manifestEntry.dir;
  const manifest = JSON.parse(await manifestEntry.file.text());
  emit('manifest', `Manifest: ${manifest.games.length} games · run ${manifest.run_id || '—'}`, 0.22);

  const games = {};
  const totalGames = manifest.games.length;

  for (let i = 0; i < manifest.games.length; i++) {
    const g = manifest.games[i];
    const gameIndex = g.index;

    // PGN
    const pgnEntry = lookup(fileMap, baseDir, g.pgn);
    const pgn = pgnEntry ? await pgnEntry.text() : null;

    // NDJSON
    const ndjsonEntry = lookup(fileMap, baseDir, g.ndjson);
    if (!ndjsonEntry) throw new Error(`Missing ndjson for game ${gameIndex}: ${g.ndjson}`);
    const plies = parseNdjson(await ndjsonEntry.text());

    // Spectralz file ref (parse lazily, except for first game)
    const spectralEntry = lookup(fileMap, baseDir, g.spectralz);
    if (!spectralEntry) throw new Error(`Missing spectralz for game ${gameIndex}: ${g.spectralz}`);

    games[gameIndex] = {
      meta: g,
      pgn,
      plies,
      _spectralFile: spectralEntry,    // raw File for lazy parse
      spectral: null,                  // populated by parseGameSpectral()
    };

    const frac = 0.22 + 0.18 * ((i + 1) / totalGames);
    emit('ndjson', `Parsed game ${gameIndex} · ${plies.length} plies`, frac);
  }

  // Eager-parse spectral data for game 1 so the viewer is immediately interactive
  const firstIndex = manifest.games[0].index;
  emit('spectral', `Decoding spectral data for game ${firstIndex}…`, 0.5);
  await parseGameSpectral({ games, manifest }, firstIndex);
  emit('spectral', `Spectral data ready for game ${firstIndex}`, 0.85);

  // Augment each manifest game with derived mean_FT for table sort convenience
  for (const g of manifest.games) {
    g.mean_FT = (g.mean_F1 ?? 0) + (g.mean_F2 ?? 0) + (g.mean_F3 ?? 0);
  }

  emit('done', 'Ready', 1.0);
  return { manifest, games, sourceName: file.name, sourceSize: file.size };
}

/* ------------------------------------------------------------------ *
 * Lazy spectral parser (called for non-eager games on first selection)
 * ------------------------------------------------------------------ */
export async function parseGameSpectral(corpus, gameIndex) {
  const game = corpus.games[gameIndex];
  if (!game) throw new Error(`Unknown game ${gameIndex}`);
  if (game.spectral) return game.spectral;

  const buf = await game._spectralFile.arrayBuffer();
  const decompressed = await gunzip(buf);
  const parsed = parseSpectralz(decompressed);
  game.spectral = enrichSpectral(parsed);
  return game.spectral;
}

/* ------------------------------------------------------------------ *
 * Archive helpers
 * ------------------------------------------------------------------ */

async function extractArchive(file) {
  const Archive = await importArchive();
  const archive = await Archive.open(file);

  // extractFiles() materialises every entry as a real File object (vs the
  // CompressedFile placeholders returned by getFilesObject), which lets us
  // call .text() / .arrayBuffer() directly without a second extraction round.
  const tree = await archive.extractFiles();
  const entries = flattenTree(tree);

  const map = new Map();
  for (const { file: f, path } of entries) {
    if (!f || typeof f === 'string') continue;
    const norm = normalisePath(path ? `${path}/${f.name}` : f.name);
    map.set(norm, f);
  }
  return map;
}

function flattenTree(tree, prefix = '') {
  const out = [];
  for (const [name, value] of Object.entries(tree)) {
    const here = prefix ? `${prefix}/${name}` : name;
    if (value instanceof File) out.push({ file: value, path: prefix });
    else if (value && typeof value === 'object') out.push(...flattenTree(value, here));
  }
  return out;
}

function normalisePath(p) {
  return String(p).replace(/^\.?\/+/, '').replace(/\\/g, '/');
}

function findEntry(fileMap, basename) {
  for (const [path, file] of fileMap) {
    const segs = path.split('/');
    if (segs[segs.length - 1] === basename) {
      const dir = segs.slice(0, -1).join('/');
      return { file, path, dir };
    }
  }
  return null;
}

function lookup(fileMap, baseDir, relPath) {
  const candidates = [
    baseDir ? `${baseDir}/${relPath}` : relPath,
    relPath,
  ];
  for (const c of candidates) {
    const norm = normalisePath(c);
    if (fileMap.has(norm)) return fileMap.get(norm);
  }
  // Last resort: match by basename
  const want = relPath.split('/').pop();
  for (const [p, f] of fileMap) {
    if (p.endsWith('/' + want) || p === want) return f;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * NDJSON parser
 * ------------------------------------------------------------------ */
function parseNdjson(text) {
  const lines = text.split('\n');
  const plies = [];
  for (const line of lines) {
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.bridge_version || obj.type === 'game_header') continue;
    if (typeof obj.ply !== 'number') continue;
    plies.push(obj);
  }
  // Ensure ply array is dense + ordered
  plies.sort((a, b) => a.ply - b.ply);
  return plies;
}

/* ------------------------------------------------------------------ *
 * Spectralz binary parser
 * ------------------------------------------------------------------ */
const SPECTRALZ_MAGIC = 'LARTPSEC';
const HEADER_SIZE = 256;
const DIM = 640;

function parseSpectralz(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const magic = new TextDecoder().decode(new Uint8Array(arrayBuffer, 0, 8));
  if (magic !== SPECTRALZ_MAGIC) {
    throw new Error(`Not a spectralz file (magic="${magic}")`);
  }
  const version = view.getUint32(8, true);
  const dim     = view.getUint32(12, true);
  const stride  = view.getUint32(16, true);
  const nPlies  = view.getUint32(20, true);

  if (dim !== DIM) {
    throw new Error(`Unsupported spectralz dim=${dim} (expected ${DIM})`);
  }
  const expected = HEADER_SIZE + nPlies * stride;
  if (arrayBuffer.byteLength < expected) {
    throw new Error(`spectralz truncated: have ${arrayBuffer.byteLength}, need ${expected}`);
  }

  const plies = new Array(nPlies);
  for (let p = 0; p < nPlies; p++) {
    const offset = HEADER_SIZE + p * stride;
    plies[p] = new Float32Array(arrayBuffer, offset, DIM); // view, no copy
  }
  return { version, dim, stride, nPlies, plies, _buffer: arrayBuffer };
}

/* Compute per-channel energy series + per-channel min/max + per-(channel,mode)
 * min/max so the heatmap and chart can render without scanning the data
 * each frame. */
function enrichSpectral(parsed) {
  const { plies, nPlies } = parsed;
  const channelEnergies = {};
  for (const ch of CHANNELS) {
    channelEnergies[ch.id] = new Float32Array(nPlies);
  }
  // Derived: total fiber
  channelEnergies.FT = new Float32Array(nPlies);

  // Per-channel value min/max (across all modes & plies in that channel)
  const valueMinMax = {};
  for (const ch of CHANNELS) valueMinMax[ch.id] = { min: Infinity, max: -Infinity };

  for (let p = 0; p < nPlies; p++) {
    const arr = plies[p];
    for (let c = 0; c < CHANNELS.length; c++) {
      const ch = CHANNELS[c];
      const start = ch.index * 64;
      let energy = 0;
      let mn = valueMinMax[ch.id].min;
      let mx = valueMinMax[ch.id].max;
      for (let i = start; i < start + 64; i++) {
        const v = arr[i];
        energy += v * v;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      channelEnergies[ch.id][p] = energy;
      valueMinMax[ch.id].min = mn;
      valueMinMax[ch.id].max = mx;
    }
    channelEnergies.FT[p] =
      channelEnergies.F1[p] + channelEnergies.F2[p] + channelEnergies.F3[p];
  }

  // Mean & sigma per channel for z-score line chart
  const stats = {};
  for (const id of Object.keys(channelEnergies)) {
    const arr = channelEnergies[id];
    let s = 0;
    for (let i = 0; i < arr.length; i++) s += arr[i];
    const mean = s / arr.length;
    let v = 0;
    for (let i = 0; i < arr.length; i++) {
      const d = arr[i] - mean;
      v += d * d;
    }
    const sigma = Math.sqrt(v / Math.max(1, arr.length));
    stats[id] = { mean, sigma: sigma || 1 };
  }

  // Eval series (parsed once, here, for chart overlay) — populated by app.js
  // from plies; we don't have plies meta here.

  return {
    ...parsed,
    channelEnergies,   // Map id → Float32Array(nPlies)
    valueMinMax,       // Map id → {min,max}
    stats,             // Map id → {mean,sigma}
    helpers: { channelEnergyForPly },  // re-export for callers
  };
}

/* ------------------------------------------------------------------ *
 * Gzip decompression
 * ------------------------------------------------------------------ */
async function gunzip(buf) {
  if (typeof DecompressionStream === 'function') {
    const stream = new Response(buf).body.pipeThrough(new DecompressionStream('gzip'));
    return await new Response(stream).arrayBuffer();
  }
  // Fallback: pako global if loaded
  if (typeof window !== 'undefined' && window.pako) {
    return window.pako.ungzip(new Uint8Array(buf)).buffer;
  }
  throw new Error('No gzip decompressor available (DecompressionStream missing and pako not loaded)');
}

/* ------------------------------------------------------------------ *
 * Format helpers
 * ------------------------------------------------------------------ */
export function formatBytes(n) {
  if (!Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n < 10 ? n.toFixed(2) : n < 100 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

export { parseSpectralz, parseNdjson, parseEvalString };
