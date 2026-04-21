# Changelog

Until this file was introduced, release notes lived in the prefix
of the version-bump commit messages (`vX.Y.Z: ...`). That history is
preserved verbatim below for the pre-0.6 line; everything from 0.6.0
onward gets a dedicated entry here.

The viewer follows loose semver: minor bumps for new overlays or
significant UX additions, patch bumps for fixes and infrastructure.
The `.spectralz` format version is tracked separately in
`README.md` and the file's header bytes.

## v0.8.1 — 2026-04-21

### Changed
- **Follow ⇝ button moved from the fiber sub-controls to the chess-
  control row**, next to the flip ⇅ button. At typical desktop
  widths the fiber sub-controls row couldn't fit all four children
  (piece · mode · cmap · follow) on one line, so follow wrapped to
  a second row and dangled below the rest. The chess-control row
  has room and is the more logical home anyway — auto-follow
  steers which piece shows per ply, so it belongs next to the
  ply-stepping buttons it's coupled to. Visibility is still gated
  on `state.fiberOverlay` (hidden when fiber is off).
- **Follow suppresses the rook-helper note.** When auto-follow is
  on and a rook move rolls past, the tooltip used to flash over
  the top of the board. With follow enabled that's noise rather
  than information, so the helper is suppressed entirely in that
  mode. The R button's native `title` tooltip still carries the
  explanation for anyone who wants it.

## v0.8.0 — 2026-04-21

### Added
- **Pawn fiber norm.** Adds a 6th piece (`P`) to the fiber overlay.
  Pawn moves are asymmetric, so there is no formally-symmetric
  pawn Laplacian in the same sense as N/B/R/Q/K; the field is
  built from a symmetrized union of both colours' one-square moves
  (vertical step + four capture diagonals, no two-square advance)
  and is then projected onto the existing N/B/Q/K-derived V3 basis
  — so existing values for the other pieces are byte-stable. The
  resulting field has Z2×Z2 symmetry (axis reflections + 180°
  rotation) but NOT full D4. This is disclosed in the data file
  (`pawn_is_direction_collapsed: true`), in the P button's title,
  and in `README.md`. Verification gates updated: D4 only applies
  to N/B/R/Q/K; pawn gets a dedicated Klein-4 gate plus an
  explicit "pawn must not be D4-symmetric" negative gate that
  catches over-symmetrization bugs. The data file bumps from
  `version: 1` to `version: 2` with pawn added to `piece_order`.
- **`follow ⇝` auto-follow toggle** in the fiber sub-controls. When
  on, stepping through plies auto-switches the fiber piece
  selector to match whoever just moved (SAN's first character:
  N/B/R/Q/K directly, `O-O`/`O-O-O` → K, lowercase file letter →
  P). The starting position has no last-move and holds the prior
  selection. The URL hash appends `,follow` to the `fiber=` query
  string when on.

### Changed
- `data/fiber_norms.json` schema bump: `version` 1 → 2,
  `piece_order` now `["pawn", "knight", "bishop", "rook", "queen",
  "king"]`, new top-level `pawn_is_direction_collapsed: true`.
  `generate_fiber_norms.py` extended with `pawn_adj()` and a
  `_is_klein4_symmetric` helper; `tests/test_fiber_norms.py`
  picks up parametrized pawn cases.
- Fiber controls row: added P (piece selector) and ⇝ (follow)
  buttons. Follow deliberately rendered as a single-glyph seg-btn
  so the row doesn't wrap and re-introduce the board-boop from
  v0.7.0's fix.

### Fixed
- Rook-helper note no longer sits permanently over the top of the
  chessboard while R is selected. v0.7.0 took it out of the flex
  flow so the row wouldn't wrap; v0.8.0 adds the fade behaviour on
  top — the note flashes in for ~2.5s after R is picked, fades
  out, and re-appears on R hover (with a ~400ms grace period on
  mouse-leave so a flick off the button doesn't snap it away
  mid-glance). The R button's `title` attribute also carries the
  same text for a native hover tooltip.

## v0.7.0 — 2026-04-20

### Added
- **Channel overlay + fiber overlay can now coexist.** Previously
  mutually exclusive (both claimed the same board squares); the
  fiber overlay's `gradient` render mode uses a separate canvas
  layer, so the real conflict is only with `discrete` mode. The
  mutex now fires only in that narrow case: flipping on the channel
  while the fiber is discrete auto-promotes the fiber to gradient,
  and switching the fiber back to discrete auto-disables the
  channel. Clean composition rule: fiber is the smooth "elevation"
  underlay, channel is the localised per-square spike on top.
- **`mono` fiber colormap.** Greyscale elevation ramp designed to
  stay out of the channel overlay's cyan/amber hue zone, so both
  overlays can read simultaneously without hue competition. Joins
  `viridis` and `diverging` in the fiber panel's colormap
  seg-control.
- **Companion-aware gradient alpha.** When the channel overlay is
  also active, the fiber canvas auto-dims from 0.72 → 0.42 (0.5 in
  `mono`), so the per-square channel tints stay readable through
  the fiber layer.

### Changed
- Tighter board-panel header metrics. `.hdr-btn` now matches
  `.chan-btn`'s 11px font / 4×8 padding / 0.04em letter-spacing /
  transparent background + line-strong border. `.header-controls`
  gap 10px → 6px. `.fiber-controls` gap 10px → 6px. Both panel
  headers now read as the same button family at a glance.

### Fixed
- The ∥F∥ / ⊞ / ◻ / ⇅ buttons were clickable but silently no-op on
  the landing screen and during the brief window between
  corpus-load and first-game-parse. `handleAction()` was
  early-returning on `if (!game) return;` before reaching the
  switch. Non-game-dependent actions now fire first and return;
  the game guard protects only the ply/play/speed actions that
  genuinely need spectral data. Covered by
  `tests-js/fiber-overlay.test.js`.
- Picking **R** in the fiber piece selector booped the whole
  chessboard down by one row. The `.fiber-helper` span was inline
  in the `.fiber-controls` flex row with `flex: 1; min-width:
  180px;`, so its 185-char message couldn't fit beside the three
  seg-controls and the row wrapped. The helper is now absolutely
  positioned — it floats as a tooltip-style note over the top
  edge of the board, never contributes to row height, and
  disappears when a non-rook piece is picked. The R button's
  `title` attribute also carries the same message for a native
  hover tooltip.

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
