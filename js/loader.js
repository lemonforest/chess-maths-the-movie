/* loader.js — corpus pipeline
 *
 * Pipeline:
 *   1. User drops a .7z file.
 *   2. libarchive.js (Web Worker) walks the archive directory (no byte
 *      extraction yet) and returns a tree of CompressedFile handles
 *      via getFilesObject().
 *   3. Locate manifest.json (by basename), extract only that one entry,
 *      parse it, and resolve sibling paths relative to its directory.
 *   4. Index every game in the manifest into corpus.games[i] holding
 *      *only* path strings. PGN text, NDJSON plies, and spectral data
 *      are all parsed on demand when a game is selected.
 *   5. Eager-parse only game[0] so the viewer is interactive on reveal.
 *
 * On selection, ensureGameData(corpus, idx) pulls the NDJSON + spectralz
 * bytes through the libarchive worker, parses them, and touches an LRU
 * keyed by gameIndex. When the LRU fills (default 50), older entries'
 * parsed state is nulled; manifest metadata is never evicted.
 *
 * Progress events via onProgress:
 *   { phase, msg, fraction }     (throttled to ~10 Hz, guaranteed flush
 *                                 on 'done' and 'error')
 */

import {
  CHANNELS,
  channelEnergyForPly,
  parseEvalString,
} from './spectral.js';
import { createLRU } from './lru.js';
import {
  isOpfsAvailable,
  computeCacheKey,
  getCorpusDir,
  writeFile as opfsWrite,
  readFile as opfsRead,
  fileExists as opfsFileExists,
} from './opfs.js';

// Resolved relative to this module so the paths work both from the repo root
// and from any subdirectory that the site is served from.
const LIBARCHIVE_URL        = new URL('../lib/libarchive/libarchive.js', import.meta.url).href;
const LIBARCHIVE_WORKER_URL = new URL('../lib/libarchive/worker-bundle.js', import.meta.url).href;

// Cap on parsed game state (game.spectral + game.plies). At ~400KB per
// game this keeps the retained heap around 4MB — small enough that even
// a 15k-game broadcast corpus doesn't pressure the tab's memory after
// rapid-clicking through many games. The currently-active game is
// pinned so it never evicts even if a user clicks through many others.
const LRU_CAPACITY = 10;

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
 * Progress throttle
 * ------------------------------------------------------------------ */
function throttleProgress(onProgress, minIntervalMs = 100) {
  let last = 0;
  let pending = null;
  let rafId = 0;
  const flush = () => {
    if (!pending) return;
    const p = pending;
    pending = null;
    last = performance.now();
    try { onProgress(p); } catch (e) { console.error('onProgress:', e); }
  };
  return (phase, msg, fraction) => {
    pending = { phase, msg, fraction };
    const now = performance.now();
    // Always flush terminal phases immediately.
    if (phase === 'done' || phase === 'error' || now - last > minIntervalMs) {
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
      flush();
      return;
    }
    if (!rafId) {
      rafId = requestAnimationFrame(() => { rafId = 0; flush(); });
    }
  };
}

/* ------------------------------------------------------------------ *
 * Public entry point
 *
 * Single path: open libarchive, extract the manifest, build the games
 * index, eager-parse game[0], return. Every row is clickable from the
 * start; per-game bytes are extracted on demand inside ensureGameData
 * and cached to OPFS on first read (if OPFS is available) so second and
 * later clicks on the same game skip libarchive entirely.
 *
 * This replaces the earlier three-path design (fast / expand / legacy)
 * and the phase-A prefetch + phase-B background expansion that shipped
 * in v0.4.0–v0.4.3. Those paths fought libarchive.js's single-threaded
 * worker in ways we couldn't reliably tame on large corpora; letting
 * ensureGameData be the one place that talks to the worker makes the
 * whole system obviously correct.
 * ------------------------------------------------------------------ */
export async function loadCorpusFromFile(file, onProgress = () => {}) {
  const emit = throttleProgress(onProgress);

  emit('decompress', `Opening ${file.name} (${formatBytes(file.size)})…`, 0.02);

  let opfsDir = null;
  if (isOpfsAvailable()) {
    try {
      opfsDir = await getCorpusDir(computeCacheKey(file));
    } catch (e) {
      console.warn('OPFS unavailable despite feature detection:', e);
    }
  }

  const handle = await openArchive(file);
  emit('decompress', `Archive indexed: ${handle.compressedMap.size} entries`, 0.18);

  const manifestRef = findEntry(handle.compressedMap, 'manifest.json');
  if (!manifestRef) throw new Error('manifest.json not found in archive');
  const baseDir = manifestRef.dir;
  const manifestFile = await manifestRef.file.extract();
  const manifestText = await manifestFile.text();
  const manifest = JSON.parse(manifestText);
  emit('manifest', `Manifest: ${manifest.games.length} games · run ${manifest.run_id || '—'}`, 0.22);

  const games = {};
  const totalGames = manifest.games.length;
  for (let i = 0; i < totalGames; i++) {
    const g = manifest.games[i];
    games[g.index] = {
      meta: g,
      pgn: null,
      plies: null,
      spectral: null,
      _ndjsonPath:   resolvePath(handle.compressedMap, baseDir, g.ndjson),
      _pgnPath:      resolvePath(handle.compressedMap, baseDir, g.pgn),
      _spectralPath: resolvePath(handle.compressedMap, baseDir, g.spectralz),
      _loadPromise: null,
      // Runtime-only failure flag. Flipped by ensureGameData when it
      // discovers a game's bytes are genuinely corrupt (wrong magic,
      // truncated spectralz, un-gunzippable). Not persisted: a reload
      // gives every row a fresh shot so transient "corrupt" diagnoses
      // don't silently strand a good game.
      loadFailed: false,
    };
    if ((i & 63) === 0 || i === totalGames - 1) {
      const frac = 0.22 + 0.18 * ((i + 1) / totalGames);
      emit('index', `Indexed ${i + 1}/${totalGames} games`, frac);
    }
  }

  augmentManifest(manifest);
  const variant = deriveVariant(manifest);

  const corpus = makeCorpusShell({ file, manifest, games, variant, opfsDir, handle });
  corpus._file = file;   // retained for recycleArchive() on stale-handle

  const firstIndex = manifest.games[0].index;
  emit('spectral', `Decoding game ${firstIndex}…`, 0.5);
  await ensureGameData(corpus, firstIndex);
  emit('spectral', `Ready: game ${firstIndex}`, 0.95);
  emit('done', 'Ready', 1.0);
  return corpus;
}

/* ------------------------------------------------------------------ *
 * Shared corpus-construction helpers
 * ------------------------------------------------------------------ */
function augmentManifest(manifest) {
  // Augment manifest rows with derived mean_FT for table sort convenience.
  for (const g of manifest.games) {
    g.mean_FT = (g.mean_F1 ?? 0) + (g.mean_F2 ?? 0) + (g.mean_F3 ?? 0);
  }
}

function deriveVariant(manifest) {
  // "chess" (default, backwards-compatible) or "othello". Older manifests
  // have no variant key; treat those as chess corpora unchanged.
  return (manifest.variant || manifest.game || 'chess').toLowerCase();
}

function makeCorpusShell({ file, manifest, games, variant, opfsDir = null, handle = null }) {
  const corpus = {
    manifest,
    games,
    variant,
    sourceName: file.name,
    sourceSize: file.size,
    _file: null,
    _handle: handle,
    _opfsDir: opfsDir,
    _lru: null,
  };
  corpus._lru = createLRU(LRU_CAPACITY, (evictedIdx) => {
    const g = corpus.games[evictedIdx];
    if (!g) return;
    g.spectral = null;
    g.plies = null;
    g.pgn = null;
    g._loadPromise = null;
  });
  return corpus;
}

/** Tear down a corpus: close the libarchive worker and drop parsed state.
 *  Idempotent — safe to call twice; the second call resolves to the first
 *  call's pending promise so a rapid reload-button mash doesn't double-close. */
export async function closeCorpus(corpus) {
  if (!corpus) return;
  if (corpus._closing) return corpus._closing;
  corpus._closing = (async () => {
    if (corpus._handle) {
      try {
        await corpus._handle.archive.close();
      } catch (e) {
        console.warn('archive.close:', e);
      }
      corpus._handle = null;
    }
    corpus._lru && corpus._lru.clear();
  })();
  return corpus._closing;
}

/* ------------------------------------------------------------------ *
 * Lazy per-game loader
 *
 * Called by app.js on every selectGame (and once at load time for
 * game 1). Coalesces concurrent calls via game._loadPromise.
 * ------------------------------------------------------------------ */
export async function ensureGameData(corpus, gameIndex) {
  const game = corpus.games[gameIndex];
  if (!game) throw new Error(`Unknown game ${gameIndex}`);
  // Refuse to re-parse a game whose bytes we already proved are corrupt
  // this session. Quarantine is runtime-only — a full page reload clears
  // it so transient "corrupt" diagnoses don't permanently strand a row.
  if (game.loadFailed) throw new Error(`game ${gameIndex} is quarantined`);
  if (game.plies && game.spectral) {
    corpus._lru.touch(gameIndex);
    return game;
  }
  if (game._loadPromise) return game._loadPromise;

  game._loadPromise = (async () => {
    // OPFS first when available — a previous session (or an earlier
    // click this session) may have already cached the bytes, in which
    // case we skip the libarchive worker entirely. Otherwise extract
    // from the archive and cache the bytes on the way through.
    //
    // If OPFS bytes are present but fail to parse (v0.4.x left partial
    // or truncated files after a crashed phase-B expansion), we
    // transparently fall through to the archive and overwrite the bad
    // cache entry. This auto-heals any stale state from prior versions.
    const dir = corpus._opfsDir;
    const ndjsonOpfsPath   = `games/${gameIndex}.ndjson`;
    const spectralOpfsPath = `games/${gameIndex}.spectralz.gz`;

    if (!game.plies) {
      let plies = null;
      if (dir && await opfsFileExists(dir, ndjsonOpfsPath)) {
        try {
          const f = await opfsRead(dir, ndjsonOpfsPath);
          const text = await f.text();
          if (!text) throw new Error('empty ndjson in OPFS cache');
          plies = parseNdjson(text);
          if (!plies.length) throw new Error('no plies parsed from OPFS ndjson');
        } catch (e) {
          console.warn(`OPFS ndjson cache bad for game ${gameIndex}; re-extracting:`, e);
          plies = null;
        }
      }
      if (!plies) {
        if (!game._ndjsonPath) {
          throw new Error(`game ${gameIndex} ndjson missing (no archive fallback)`);
        }
        const ndjsonFile = await extractByPath(corpus, game._ndjsonPath, 'ndjson');
        const text = await ndjsonFile.text();
        plies = parseNdjson(text);
        if (dir) {
          try { await opfsWrite(dir, ndjsonOpfsPath, new TextEncoder().encode(text)); }
          catch (e) { console.warn('OPFS ndjson cache-write failed:', e); }
        }
      }
      game.plies = plies;
    }

    if (!game.spectral) {
      let spectral = null;
      if (dir && await opfsFileExists(dir, spectralOpfsPath)) {
        try {
          const f = await opfsRead(dir, spectralOpfsPath);
          const buf = await f.arrayBuffer();
          if (!buf || buf.byteLength === 0) throw new Error('empty spectralz in OPFS cache');
          const decompressed = await gunzip(buf);
          spectral = enrichSpectral(parseSpectralz(decompressed));
        } catch (e) {
          console.warn(`OPFS spectralz cache bad for game ${gameIndex}; re-extracting:`, e);
          spectral = null;
        }
      }
      if (!spectral) {
        if (!game._spectralPath) {
          throw new Error(`game ${gameIndex} spectralz missing (no archive fallback)`);
        }
        const spectralFile = await extractByPath(corpus, game._spectralPath, 'spectralz');
        const buf = await spectralFile.arrayBuffer();
        const decompressed = await gunzip(buf);
        spectral = enrichSpectral(parseSpectralz(decompressed));
        if (dir) {
          try { await opfsWrite(dir, spectralOpfsPath, new Uint8Array(buf)); }
          catch (e) { console.warn('OPFS spectralz cache-write failed:', e); }
        }
      }
      game.spectral = spectral;
    }

    corpus._lru.touch(gameIndex);
    return game;
  })();

  try {
    return await game._loadPromise;
  } catch (e) {
    game._loadPromise = null;
    if (isDataError(e)) {
      game.loadFailed = true;
    }
    throw e;
  }
}

/** Is this error a data-format problem (the corpus actually contains
 *  bad bytes), as opposed to a transient infrastructure glitch? Data
 *  errors → quarantine the game; transient errors → let the caller
 *  retry later. Errs on the side of NOT quarantining so a flaky OPFS
 *  write or a worker race doesn't permanently sideline good games.
 *
 *  Matches on explicit message signatures from the three places that
 *  can legitimately tell us the bytes are bad:
 *    - parseSpectralz (our own parser: wrong magic, wrong dim, truncated)
 *    - gunzip (DecompressionStream / pako failures on corrupt gzip)
 *    - JSON.parse in parseNdjson (malformed JSON on every line) */
function isDataError(e) {
  if (!e) return false;
  if (isStaleArchiveError(e)) return false;
  const msg = String(e.message ?? e ?? '');
  if (/Not a spectralz file|spectralz truncated|Unsupported spectralz/i.test(msg)) return true;
  if (/decod|gzip|invalid compressed|invalid stored|incorrect header check|unexpected end of (?:input|data|stream)/i.test(msg)) return true;
  return false;
}

/* ------------------------------------------------------------------ *
 * Back-compat alias for any call site still using parseGameSpectral.
 * ------------------------------------------------------------------ */
export async function parseGameSpectral(corpus, gameIndex) {
  const g = await ensureGameData(corpus, gameIndex);
  return g.spectral;
}

/** Pull a single archive entry by path, retrying once through a fresh
 *  archive worker if libarchive.js's handle has gone stale.
 *
 *  After ~25-30 extracts against a large 7z (191 MB broadcast corpus),
 *  libarchive.js trips its own assertion: "PROGRAMMER ERROR: Function
 *  archive_read_support_filter_all invoked with invalid archive handle."
 *  The worker's WASM process aborts. Recycling — close old worker, spawn
 *  a fresh one from the retained File — fully resets the handle state at
 *  the cost of one archive re-walk (~200-400 ms).
 *
 *  The retry is one-shot. A second failure is propagated so the caller's
 *  catch (selectGame's try/catch, manifest load, etc.) still surfaces a
 *  real defect rather than looping forever. */
async function extractByPath(corpus, path, label) {
  // Serialize all libarchive worker calls for a corpus. Phase-B expansion
  // and click-driven ensureGameData both route through here; firing two
  // extract() messages at the single-threaded worker concurrently has been
  // observed to wedge the worker (every subsequent extract hangs or
  // throws "invalid archive handle"), which matches the "click game 11,
  // page locks up" symptom. One extract in flight at a time, FIFO.
  const prev = corpus._archiveQueue || Promise.resolve();
  let release;
  const next = new Promise((r) => { release = r; });
  corpus._archiveQueue = prev.then(() => next);
  await prev;
  try {
    return await doExtract(corpus, path, label);
  } finally {
    release();
  }
}

async function doExtract(corpus, path, label) {
  const cf0 = corpus._handle.compressedMap.get(path);
  if (!cf0) throw new Error(`${label} entry missing: ${path}`);
  try {
    return await cf0.extract();
  } catch (e) {
    if (!isStaleArchiveError(e)) throw e;
    console.warn(`libarchive handle stale on ${label} extract; recycling worker…`);
    await recycleArchive(corpus);
    const cf1 = corpus._handle.compressedMap.get(path);
    if (!cf1) throw new Error(`${label} entry missing after recycle: ${path}`);
    return await cf1.extract();
  }
}

/** Heuristic match on libarchive.js's abort message + the downstream
 *  Emscripten "Aborted()" RuntimeError. Matching on message text is
 *  brittle but the library doesn't expose a typed error; restricting
 *  the retry to these two signatures keeps us from silently papering
 *  over unrelated failures. */
function isStaleArchiveError(e) {
  const msg = String(e && (e.message ?? e) || '');
  return msg.includes('invalid archive handle')
      || msg.includes('archive_read_support_filter_all')
      || msg.includes('Aborted()');
}

/** Close the archive worker and re-open from the retained File, then
 *  swap the fresh compressedMap onto corpus._handle in-place. Existing
 *  CompressedFile references held on game records are only paths (strings);
 *  the live CompressedFile objects are looked up via the Map per-extract,
 *  so swapping the Map transparently rebinds them. */
async function recycleArchive(corpus) {
  if (!corpus._file) throw new Error('cannot recycle archive: _file not retained');
  if (corpus._recycling) return corpus._recycling;
  corpus._recycling = (async () => {
    try {
      try { await corpus._handle.archive.close(); } catch (e) { console.warn('recycle close:', e); }
      const fresh = await openArchive(corpus._file);
      corpus._handle = fresh;
    } finally {
      corpus._recycling = null;
    }
  })();
  return corpus._recycling;
}

/* ------------------------------------------------------------------ *
 * Archive open: walk the directory (no extraction) via getFilesObject.
 *
 * Returns { archive, compressedMap } where compressedMap is
 * Map<normalizedPath, CompressedFile>. Each CompressedFile's .extract()
 * round-trips through the libarchive worker to pull just that entry's
 * bytes on demand.
 *
 * The archive instance is kept alive for the session; closing it would
 * terminate the worker and invalidate every CompressedFile handle. On
 * reload (see app.js reload-btn teardown), closeCorpus() is called.
 * ------------------------------------------------------------------ */
async function openArchive(file) {
  const Archive = await importArchive();
  const archive = await Archive.open(file);
  const tree = await archive.getFilesObject();
  const entries = flattenTree(tree);

  const map = new Map();
  for (const { file: cf, path } of entries) {
    if (!cf || typeof cf.extract !== 'function') continue;
    const norm = normalisePath(path ? `${path}/${cf.name}` : cf.name);
    map.set(norm, cf);
  }
  return { archive, compressedMap: map };
}

function flattenTree(tree, prefix = '') {
  const out = [];
  for (const [name, value] of Object.entries(tree)) {
    const here = prefix ? `${prefix}/${name}` : name;
    // Leaf test: CompressedFile exposes .extract(); File does too but we
    // prefer the duck-typed check to avoid coupling to either class.
    if (value && typeof value === 'object' && typeof value.extract === 'function') {
      out.push({ file: value, path: prefix });
    } else if (value && typeof value === 'object') {
      out.push(...flattenTree(value, here));
    }
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

/** Resolve a manifest-relative path against the archive's compressed map.
 *  Returns the normalised key used in the Map, or null if not found.
 *  We store the string key (not the CompressedFile) on the game record
 *  so the game object stays cheap and uniform across evictions. */
function resolvePath(fileMap, baseDir, relPath) {
  if (!relPath) return null;
  const candidates = [
    baseDir ? `${baseDir}/${relPath}` : relPath,
    relPath,
  ];
  for (const c of candidates) {
    const norm = normalisePath(c);
    if (fileMap.has(norm)) return norm;
  }
  // Last resort: match by basename
  const want = relPath.split('/').pop();
  for (const p of fileMap.keys()) {
    if (p.endsWith('/' + want) || p === want) return p;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * NDJSON parser
 * ------------------------------------------------------------------ */
function parseNdjson(text) {
  const lines = text.split('\n');
  const plies = [];
  let skipped = 0;
  for (const line of lines) {
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { skipped++; continue; }
    if (obj.bridge_version || obj.type === 'game_header') continue;
    if (typeof obj.ply !== 'number') { skipped++; continue; }
    plies.push(obj);
  }
  if (skipped) console.warn(`parseNdjson: skipped ${skipped} malformed line(s)`);
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
    try {
      const stream = new Response(buf).body.pipeThrough(new DecompressionStream('gzip'));
      return await new Response(stream).arrayBuffer();
    } catch (e) {
      // DecompressionStream throws TypeError with an empty message on
      // several engines (Node, some Chromium builds). Rewrap so the
      // data-error classifier matches deterministically.
      const orig = String(e?.message ?? '');
      throw new Error(`gzip decode failed${orig ? `: ${orig}` : ''}`);
    }
  }
  // Fallback: pako global if loaded
  if (typeof window !== 'undefined' && window.pako) {
    try {
      return window.pako.ungzip(new Uint8Array(buf)).buffer;
    } catch (e) {
      throw new Error(`gzip decode failed: ${String(e?.message ?? e)}`);
    }
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
