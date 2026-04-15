/* lib/pieces.js — minimalist inline-SVG chess piece set.
 *
 * chessboard.js calls `pieceTheme(pieceCode)` for each piece, where
 * pieceCode is one of "wK" "wQ" "wR" "wB" "wN" "wP" "bK" "bQ" "bR"
 * "bB" "bN" "bP". We return a `data:image/svg+xml,...` URL containing
 * the appropriate Unicode chess glyph rendered with theme-aware colors.
 *
 * Self-contained, no external assets, ~200 bytes per piece response.
 */

(function () {
  const GLYPHS = {
    wK: '\u2654', wQ: '\u2655', wR: '\u2656', wB: '\u2657', wN: '\u2658', wP: '\u2659',
    bK: '\u265A', bQ: '\u265B', bR: '\u265C', bB: '\u265D', bN: '\u265E', bP: '\u265F',
  };

  // Use solid (filled) glyphs for both colors with explicit fills so dark/light
  // contrast doesn't depend on font rendering quirks.
  const SOLID_FOR = {
    wK: '\u265A', wQ: '\u265B', wR: '\u265C', wB: '\u265D', wN: '\u265E', wP: '\u265F',
    bK: '\u265A', bQ: '\u265B', bR: '\u265C', bB: '\u265D', bN: '\u265E', bP: '\u265F',
  };

  function svgFor(piece) {
    const isWhite = piece[0] === 'w';
    const fill   = isWhite ? '#f4f4f0' : '#15151e';
    const stroke = isWhite ? '#15151e' : '#f4f4f0';
    const glyph  = SOLID_FOR[piece];
    // 100x100 viewbox; chessboard.js will size the <img> to fit.
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
      `<text x="50" y="86" text-anchor="middle" ` +
      `font-family="serif" font-size="96" ` +
      `fill="${fill}" stroke="${stroke}" stroke-width="2" ` +
      `paint-order="stroke">${glyph}</text></svg>`;
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  }

  // Cache to avoid recomputing on every render
  const cache = {};
  window.__inlineChessPieceTheme = function (piece) {
    if (!cache[piece]) cache[piece] = svgFor(piece);
    return cache[piece];
  };
})();
