# Changelog

Until this file was introduced, release notes lived in the prefix
of the version-bump commit messages (`vX.Y.Z: ...`). That history is
preserved verbatim below for the pre-0.6 line; everything from 0.6.0
onward gets a dedicated entry here.

The viewer follows loose semver: minor bumps for new overlays or
significant UX additions, patch bumps for fixes and infrastructure.
The `.spectralz` format version is tracked separately in
`README.md` and the file's header bytes.

## v0.6.0 — 2026-04-20

### Added
- **Fiber-norm overlay.** A new toggle (`∥F∥`) in the board panel
  header paints the per-square rank-3 fiber norm for a chosen piece
  type (N/B/R/Q/K) over the board. The field is a static property of
  the chess rules (independent of position/ply) and is served from
  `data/fiber_norms.json`, generated offline by
  `scripts/generate_fiber_norms.py`.
  - Sub-controls: piece selector, render mode (`smooth` bilinear
    canvas gradient vs `tiles` per-square), colormap (perceptual
    `viridis` vs divergent-around-mean).
  - Rook case handled with a uniform tint and a short helper line
    explaining that rook's rule content lives in the diagonal
    channel, not the off-diagonal fiber (research notebook §7b).
  - URL hash carries `fiber=<piece>,<mode>,<cmap>` when on, so
    shared links reproduce the view.
  - Existing per-channel overlay (`⊞`) is unchanged; the two
    overlays are mutually exclusive at the rendering level.
- **Verification gates.** `tests/test_fiber_norms.py` runs under
  `pytest -q` alongside the Othello tests and enforces rook-is-zero,
  D4 symmetry, bishop-queen parallelism (queen = bishop when rook's
  fiber is zero), knight corner-dim/center-bright structure, and
  consistency between the stored range metadata and the values
  array.
- **Data pipeline.** `pip install -e '.[fiber]'` adds numpy as a
  regeneration-only dependency. The viewer itself ships the JSON as
  a static asset and never computes the field at runtime.

### Notes
- The script and viewer work in the JS environment (chessboard.js),
  not python-chess; the task plan that originally spec'd the
  rendering paths assumed python-chess. The three candidate paths
  (per-square tint / canvas gradient / separate SVG) translate to
  Path A (existing `chess-overlay.js` mechanism), Path B (the new
  gradient canvas), and Path C (kept in
  `tests/fiber-overlay-poc.html` for reference, not shipped).

---

## v0.5.1 — self-heal bad OPFS cache bytes on read

Pre-0.6 history lives in the commit log. Run
`git log --oneline --grep='^v0\\.'` to see the per-release summaries
the project used before this file existed.
