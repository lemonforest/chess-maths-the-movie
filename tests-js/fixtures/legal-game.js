/* Legal 10-ply Ruy Lopez opening, hand-verified, reused across every
 * synthetic game slot in the large-corpus smoke test.
 *
 * Each ply record carries the exact shape parseNdjson() + downstream
 * consumers expect: ply (number), fen (valid FEN), san (valid SAN for
 * that position), stm, eval/clock (optional). All transitions are
 * legal chess so a future test extension that routes these plies
 * through a real chess validator won't reject the fixture.
 */

import { gzipSync } from 'node:zlib';

const PLIES = [
  { ply: 0,  stm: 'w', san: '',     fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' },
  { ply: 1,  stm: 'b', san: 'e4',   fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1' },
  { ply: 2,  stm: 'w', san: 'e5',   fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2' },
  { ply: 3,  stm: 'b', san: 'Nf3',  fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2' },
  { ply: 4,  stm: 'w', san: 'Nc6',  fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3' },
  { ply: 5,  stm: 'b', san: 'Bb5',  fen: 'r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3' },
  { ply: 6,  stm: 'w', san: 'a6',   fen: 'r1bqkbnr/1ppp1ppp/p1n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4' },
  { ply: 7,  stm: 'b', san: 'Ba4',  fen: 'r1bqkbnr/1ppp1ppp/p1n5/4p3/B3P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 1 4' },
  { ply: 8,  stm: 'w', san: 'Nf6',  fen: 'r1bqkb1r/1ppp1ppp/p1n2n2/4p3/B3P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 2 5' },
  { ply: 9,  stm: 'b', san: 'O-O',  fen: 'r1bqkb1r/1ppp1ppp/p1n2n2/4p3/B3P3/5N2/PPPP1PPP/RNBQ1RK1 b kq - 3 5' },
  { ply: 10, stm: 'w', san: 'Be7',  fen: 'r1bqk2r/1pppbppp/p1n2n2/4p3/B3P3/5N2/PPPP1PPP/RNBQ1RK1 w kq - 4 6' },
];

export const N_PLIES = PLIES.length;

/** Return a fresh NDJSON string. Includes one header line (ignored by
 *  parseNdjson) plus one JSON object per ply. */
export function buildNdjson() {
  const lines = [
    JSON.stringify({ bridge_version: 'smoke', run_id: 'synthetic' }),
  ];
  for (const p of PLIES) {
    lines.push(JSON.stringify({
      ply: p.ply,
      stm: p.stm,
      san: p.san,
      fen: p.fen,
      eval: (p.ply % 2 === 0 ? 0.12 : -0.08) * (1 + p.ply * 0.01),
      clock: 180 - p.ply,
    }));
  }
  return lines.join('\n') + '\n';
}

/** Build a valid spectralz binary buffer matching loader.js:parseSpectralz.
 *  Header (256B): magic 'LARTPSEC', version, dim=640, stride, nPlies.
 *  Body: nPlies * stride bytes of Float32 values (values are cosmetically
 *  non-trivial so enrichSpectral's per-channel energy/min/max and stats
 *  produce meaningful, non-zero output). */
export function buildSpectralzBuffer() {
  const DIM = 640;
  const STRIDE = DIM * 4;
  const HEADER = 256;
  const nPlies = PLIES.length;

  const buf = new ArrayBuffer(HEADER + nPlies * STRIDE);
  const bytes = new Uint8Array(buf);
  const view  = new DataView(buf);

  // magic
  const magic = 'LARTPSEC';
  for (let i = 0; i < 8; i++) bytes[i] = magic.charCodeAt(i);
  view.setUint32(8,  1,      true);  // version
  view.setUint32(12, DIM,    true);  // dim
  view.setUint32(16, STRIDE, true);  // stride
  view.setUint32(20, nPlies, true);  // nPlies
  // rest of header left zeroed

  // Body — small deterministic floats so energies are non-zero but bounded.
  for (let p = 0; p < nPlies; p++) {
    const off = HEADER + p * STRIDE;
    const f32 = new Float32Array(buf, off, DIM);
    for (let i = 0; i < DIM; i++) {
      // Gentle sinusoidal pattern keeps every 64-wide channel slice distinct.
      f32[i] = 0.01 * Math.sin((p + 1) * (i + 1) * 0.017);
    }
  }
  return buf;
}

/** Gzip-compressed copy of the spectralz buffer, matching what the real
 *  loader pulls out of the archive and gunzips via DecompressionStream. */
export function buildSpectralzGzipBuffer() {
  const raw = buildSpectralzBuffer();
  const gz = gzipSync(Buffer.from(raw));
  // Return a fresh ArrayBuffer (not a Node Buffer slice) so the consumer
  // can wrap it in a Blob / DecompressionStream without owning Buffer memory.
  const out = new ArrayBuffer(gz.byteLength);
  new Uint8Array(out).set(gz);
  return out;
}

export { PLIES };
