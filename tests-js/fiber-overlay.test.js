/* fiber-overlay.test.js — jsdom-backed smoke test for the fiber toggle.
 *
 * Regression: the ∥F∥ button in the board panel header was silently
 * dropping clicks because handleAction() early-returned on missing
 * game state. This test stubs chessboard.js's DOM, imports the real
 * board.js, clicks the button, and verifies that the state store
 * toggles fiberOverlay and the panel un-hides.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const htmlPath = join(__dirname, '..', 'index.html');

describe('fiber overlay toggle', () => {
  beforeEach(async () => {
    const html = readFileSync(htmlPath, 'utf8');
    document.documentElement.innerHTML = html
      .replace(/<!doctype html>/i, '')
      .replace(/<html[^>]*>/, '')
      .replace(/<\/html>/, '');
    document.body.className = 'state-viewer';
    // Un-hide the viewer so #board-panel is selectable.
    const viewer = document.getElementById('viewer');
    if (viewer) viewer.hidden = false;

    // Stub chessboard.js so the real driver can init without loading it.
    window.Chessboard = function (id) {
      const host = document.getElementById(id);
      host.innerHTML = '';
      for (let r = 8; r >= 1; r--) {
        for (let c = 0; c < 8; c++) {
          const sq = 'abcdefgh'[c] + r;
          const cell = document.createElement('div');
          cell.setAttribute('data-square', sq);
          host.appendChild(cell);
        }
      }
      return { position() {}, flip() {}, resize() {}, destroy() {} };
    };
    window.__inlineChessPieceTheme = () => '';
    // jQuery stub (chessboard.js dep) — not used by the driver paths we exercise.
    window.$ = window.jQuery = () => ({ on() {}, off() {} });
    // Stub fetch for fiber_norms.json
    const fiberJson = readFileSync(join(__dirname, '..', 'data', 'fiber_norms.json'), 'utf8');
    global.fetch = vi.fn(async () => ({
      ok: true, status: 200,
      async json() { return JSON.parse(fiberJson); },
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fiber button toggles fiberOverlay and un-hides the sub-panel', async () => {
    // Fresh module graph so app.js state doesn't leak between tests.
    vi.resetModules();
    const { initBoard } = await import('../js/board.js');
    const { state } = await import('../js/app.js');
    initBoard();

    const btn = document.querySelector('button[data-action="fiber"]');
    const panel = document.getElementById('fiber-controls');
    expect(btn).toBeTruthy();
    expect(panel.hidden).toBe(true);
    expect(state.fiberOverlay).toBe(false);

    // Simulate click — panel-header click listener delegates to handleAction.
    btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    expect(state.fiberOverlay).toBe(true);
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.classList.contains('active')).toBe(true);
    expect(panel.hidden).toBe(false);

    // Second click — flip back off.
    btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    expect(state.fiberOverlay).toBe(false);
    expect(panel.hidden).toBe(true);
  });

  it('selecting R from the piece selector shows the rook helper', async () => {
    vi.resetModules();
    const { initBoard } = await import('../js/board.js');
    const { state } = await import('../js/app.js');
    initBoard();

    const fiberBtn = document.querySelector('button[data-action="fiber"]');
    fiberBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(state.fiberOverlay).toBe(true);

    const rBtn = document.querySelector('button[data-fiber-piece="R"]');
    rBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(state.fiberPiece).toBe('R');

    const helper = document.getElementById('fiber-helper');
    expect(helper.hidden).toBe(false);
    expect(helper.textContent).toMatch(/identically zero/);
    // Native tooltip on R button mirrors the message.
    expect(rBtn.getAttribute('title')).toMatch(/identically zero/);

    // Back to knight — helper hides.
    const nBtn = document.querySelector('button[data-fiber-piece="N"]');
    nBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(helper.hidden).toBe(true);
    expect(rBtn.getAttribute('title')).toBe('Rook');
  });

  it('follow button lives in the chess-control row and hides when fiber is off', async () => {
    vi.resetModules();
    const { initBoard } = await import('../js/board.js');
    const { state } = await import('../js/app.js');
    initBoard();

    const followBtn = document.getElementById('fiber-follow-btn');
    expect(followBtn).toBeTruthy();
    // Sits inside #board-controls (chess-control row), not fiber-controls.
    expect(followBtn.closest('#board-controls')).toBeTruthy();
    expect(followBtn.closest('#fiber-controls')).toBeNull();
    // Hidden while the fiber overlay is off.
    expect(followBtn.hidden).toBe(true);

    // Turning fiber on reveals the follow button.
    document.querySelector('button[data-action="fiber"]')
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(state.fiberOverlay).toBe(true);
    expect(followBtn.hidden).toBe(false);

    // Clicking follow flips state.fiberFollow and paints the .active class.
    followBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(state.fiberFollow).toBe(true);
    expect(followBtn.classList.contains('active')).toBe(true);

    // Turning fiber off again re-hides the button (follow flag persists).
    document.querySelector('button[data-action="fiber"]')
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(state.fiberOverlay).toBe(false);
    expect(followBtn.hidden).toBe(true);
  });

  it('follow-moves suppresses the rook-helper tooltip when R is selected', async () => {
    vi.resetModules();
    const { initBoard } = await import('../js/board.js');
    const { state, set: setState } = await import('../js/app.js');
    initBoard();

    document.querySelector('button[data-action="fiber"]')
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    document.querySelector('button[data-fiber-piece="R"]')
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    const helper = document.getElementById('fiber-helper');
    expect(helper.hidden).toBe(false);   // follow off → helper shows

    // Turning follow on should hide the helper.
    setState({ fiberFollow: true });
    expect(state.fiberFollow).toBe(true);
    expect(helper.hidden).toBe(true);

    // Turning follow off restores it.
    setState({ fiberFollow: false });
    expect(helper.hidden).toBe(false);
  });

  it('selecting P from the piece selector paints the pawn field', async () => {
    vi.resetModules();
    const { initBoard } = await import('../js/board.js');
    const { state } = await import('../js/app.js');
    initBoard();

    const fiberBtn = document.querySelector('button[data-action="fiber"]');
    fiberBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    const pBtn = document.querySelector('button[data-fiber-piece="P"]');
    expect(pBtn).toBeTruthy();
    pBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(state.fiberPiece).toBe('P');

    // Helper should stay hidden (only rook triggers it).
    const helper = document.getElementById('fiber-helper');
    expect(helper.hidden).toBe(true);
  });
});

describe('parseSanPiece', () => {
  it('maps SAN first character to piece letter', async () => {
    const { parseSanPiece } = await import('../js/board.js');
    expect(parseSanPiece('Nf3')).toBe('N');
    expect(parseSanPiece('Bxe5')).toBe('B');
    expect(parseSanPiece('Rae1')).toBe('R');
    expect(parseSanPiece('Qh5+')).toBe('Q');
    expect(parseSanPiece('Kxf7')).toBe('K');
    // Castling both notations
    expect(parseSanPiece('O-O')).toBe('K');
    expect(parseSanPiece('O-O-O')).toBe('K');
    expect(parseSanPiece('0-0')).toBe('K');
    // Pawn variants
    expect(parseSanPiece('e4')).toBe('P');
    expect(parseSanPiece('exd5')).toBe('P');
    expect(parseSanPiece('e8=Q')).toBe('P');
    expect(parseSanPiece('e8=Q+')).toBe('P');
    // Garbage
    expect(parseSanPiece('')).toBe(null);
    expect(parseSanPiece(null)).toBe(null);
    expect(parseSanPiece(undefined)).toBe(null);
  });
});
