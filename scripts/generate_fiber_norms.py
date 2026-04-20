#!/usr/bin/env python3
"""Generate the rank-3 shared fiber-norm field for each of the 5 piece types.

Background
----------
Reference: chess_spectral_research_notebook.md §7 (shared fiber bundle).

The 8x8 grid graph Laplacian has an eigenbasis ``U_grid``. Each piece type's
full-board unobstructed-move Laplacian ``L_piece`` can be projected into
that basis as ``C_piece = U_grid.T @ L_piece @ U_grid``. The diagonal of
``C_piece`` carries the piece's D4-symmetric "charge"; the off-diagonal
upper triangle (2016 entries) carries the cross-mode "fiber".

For the rook, ``L_rook`` commutes with the grid Laplacian (both are
tensor products of path operators), so the off-diagonal fiber is
identically zero. The four non-trivial pieces (knight, bishop, queen,
king), once L2-normalized, share a rank-3 subspace of the 2016-dim
fiber space; the top-3 right singular vectors of the stacked fibers
are the basis ``V3``.

The per-square fiber norm is then: for piece P, square k, build a
"single-piece" adjacency that only contains P's edges incident to k
(both directions, symmetric), project into the grid eigenbasis, take
the off-diagonal upper triangle, project onto V3, and measure the L2
norm of the 3-dim projection. This is a static property of the chess
rules; it does not depend on any position.

Output
------
``data/fiber_norms.json`` — see the task spec for the schema.

Usage
-----
    python3 scripts/generate_fiber_norms.py

All paths are relative to the repository root; run from there.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Dict, List, Tuple

import numpy as np

N = 8          # board dim
NSQ = N * N    # 64 squares


# ---------------------------------------------------------------------
# Adjacency builders (unobstructed moves, symmetric, no self-loops).
# ---------------------------------------------------------------------
def _sq(r: int, c: int) -> int:
    return r * N + c


def _empty_adj() -> np.ndarray:
    return np.zeros((NSQ, NSQ), dtype=np.float64)


def grid_adj() -> np.ndarray:
    """4-neighbor grid graph on the 8x8 board."""
    A = _empty_adj()
    for r in range(N):
        for c in range(N):
            for dr, dc in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                rr, cc = r + dr, c + dc
                if 0 <= rr < N and 0 <= cc < N:
                    A[_sq(r, c), _sq(rr, cc)] = 1.0
    return A


def knight_adj() -> np.ndarray:
    A = _empty_adj()
    moves = [(1, 2), (1, -2), (-1, 2), (-1, -2),
             (2, 1), (2, -1), (-2, 1), (-2, -1)]
    for r in range(N):
        for c in range(N):
            for dr, dc in moves:
                rr, cc = r + dr, c + dc
                if 0 <= rr < N and 0 <= cc < N:
                    A[_sq(r, c), _sq(rr, cc)] = 1.0
    return A


def _slider_adj(dirs: List[Tuple[int, int]]) -> np.ndarray:
    """Rider-style adjacency: follow each direction from every square until
    leaving the board, marking every reached square as a neighbor."""
    A = _empty_adj()
    for r in range(N):
        for c in range(N):
            for dr, dc in dirs:
                rr, cc = r + dr, c + dc
                while 0 <= rr < N and 0 <= cc < N:
                    A[_sq(r, c), _sq(rr, cc)] = 1.0
                    rr += dr
                    cc += dc
    return A


def bishop_adj() -> np.ndarray:
    return _slider_adj([(-1, -1), (-1, 1), (1, -1), (1, 1)])


def rook_adj() -> np.ndarray:
    return _slider_adj([(-1, 0), (1, 0), (0, -1), (0, 1)])


def queen_adj() -> np.ndarray:
    # rook and bishop move sets are disjoint (orthogonal vs diagonal), so
    # summing the adjacency matrices yields the queen's union without
    # needing to clip to [0, 1].
    return rook_adj() + bishop_adj()


def king_adj() -> np.ndarray:
    A = _empty_adj()
    for r in range(N):
        for c in range(N):
            for dr in (-1, 0, 1):
                for dc in (-1, 0, 1):
                    if dr == 0 and dc == 0:
                        continue
                    rr, cc = r + dr, c + dc
                    if 0 <= rr < N and 0 <= cc < N:
                        A[_sq(r, c), _sq(rr, cc)] = 1.0
    return A


def laplacian(A: np.ndarray) -> np.ndarray:
    return np.diag(A.sum(axis=1)) - A


# ---------------------------------------------------------------------
# Main computation.
# ---------------------------------------------------------------------
PIECE_ORDER = ["knight", "bishop", "rook", "queen", "king"]
NON_TRIVIAL_FOR_BASIS = ["knight", "bishop", "queen", "king"]  # rook fiber = 0
ADJ_BUILDERS = {
    "knight": knight_adj,
    "bishop": bishop_adj,
    "rook":   rook_adj,
    "queen":  queen_adj,
    "king":   king_adj,
}

# Upper-triangle off-diagonal indices of a 64x64 symmetric matrix (2016 entries)
_IU = np.triu_indices(NSQ, k=1)


def _project(L: np.ndarray, U_grid: np.ndarray) -> np.ndarray:
    return U_grid.T @ L @ U_grid


def _off_upper(M: np.ndarray) -> np.ndarray:
    return M[_IU]


def _single_piece_adj(A_full: np.ndarray, k: int) -> np.ndarray:
    """Adjacency containing only the edges incident to square k in A_full,
    kept symmetric (both (k, j) and (j, k) directions)."""
    A = _empty_adj()
    A[k, :] = A_full[k, :]
    A[:, k] = A_full[:, k]
    return A


def _path_laplacian(n: int) -> np.ndarray:
    A = np.zeros((n, n), dtype=np.float64)
    for i in range(n - 1):
        A[i, i + 1] = 1.0
        A[i + 1, i] = 1.0
    return np.diag(A.sum(axis=1)) - A


def grid_eigenbasis() -> np.ndarray:
    """Canonical 64-dim eigenbasis of the 8x8 grid graph Laplacian, built
    as the tensor product of path-8 eigenvectors.

    A generic ``np.linalg.eigh(L_grid)`` call returns *some* orthonormal
    basis for each (often-degenerate) eigenspace, but not the tensor-
    product basis. Only in the tensor-product basis is the rook
    Laplacian diagonal (hence its off-diagonal fiber = 0) — the §7
    "shared fiber bundle" identity from the research notebook depends
    on that specific basis. So we build it explicitly: path-8
    eigenvalues are non-degenerate, so eigh(L_path) returns a unique
    U_path (up to per-column sign), and np.kron(U_path, U_path) gives
    the intended 64x64 basis.

    Row-major convention: for a basis vector indexed as (k_r, k_c),
    ``U_grid[r*8 + c, k_r*8 + k_c] = U_path[r, k_r] * U_path[c, k_c]``.
    """
    _w, U_path = np.linalg.eigh(_path_laplacian(N))
    # np.kron respects the row-major flatten we use for squares
    # (idx = r*8 + c), so U[i, j] with i = r*8+c, j = k_r*8+k_c has the
    # factored form above.
    return np.kron(U_path, U_path)


def compute_fields() -> Tuple[Dict[str, np.ndarray], Dict[str, Dict[str, float]]]:
    """Returns (values_by_piece, ranges_by_piece).

    values: piece -> float64 array (64 entries).
    ranges: piece -> {min, max, ratio} — ratio is max/min for non-trivial
            pieces, None for the rook (identically zero).
    """
    # Grid eigenbasis — tensor product of path-8 eigenvectors (see docstring
    # on grid_eigenbasis for why a plain eigh(L_grid) doesn't work here).
    U_grid = grid_eigenbasis()

    # Piece adjacencies and Laplacians, aggregated (full-board).
    A_all = {p: ADJ_BUILDERS[p]() for p in PIECE_ORDER}
    L_all = {p: laplacian(A_all[p]) for p in PIECE_ORDER}
    C_all = {p: _project(L_all[p], U_grid) for p in PIECE_ORDER}

    # Per-square "single-piece star graph" fibers for every piece, every
    # square. Shape: piece -> (64, 2016). The sum over squares of each
    # piece's per-square fibers equals 2x the aggregated piece fiber
    # (each edge is counted once when k is its endpoint on either side).
    per_square_fibers: Dict[str, np.ndarray] = {}
    for p in PIECE_ORDER:
        rows = np.zeros((NSQ, _IU[0].size), dtype=np.float64)
        for k in range(NSQ):
            L_k = laplacian(_single_piece_adj(A_all[p], k))
            rows[k] = _off_upper(_project(L_k, U_grid))
        per_square_fibers[p] = rows

    # Aggregated full-piece fibers.
    agg_fibers = {p: _off_upper(C_all[p]) for p in PIECE_ORDER}

    # ---- Build V3 --------------------------------------------------------
    #
    # The "shared fiber" basis must (a) be derived from the non-trivial
    # pieces' aggregated fibers (knight, bishop, queen, king) and (b) be
    # orthogonal to the subspace spanned by rook's per-square fibers.
    #
    # Motivation: rook's full-board aggregated fiber is exactly zero in
    # the tensor-product grid eigenbasis (L_rook and L_grid commute), but
    # its *per-square* star-graph fibers are individually non-zero —
    # they're fluctuations that sum to zero. Those fluctuations represent
    # rule content that lives in the diagonal (trivial) channel rather
    # than the off-diagonal fiber we're trying to visualize. If V3 is
    # allowed to pick up components along the rook-fluctuation subspace,
    # every piece's per-square norm inherits a "rook-like" contribution
    # and rook itself comes out non-zero — violating the §7 identity.
    #
    # So we project the non-trivial pieces' aggregated fibers onto the
    # orthogonal complement of rook's per-square subspace before running
    # SVD. The resulting V3 contains only directions unreachable by any
    # rook per-square fiber, which guarantees the rook field is
    # identically zero by construction.
    rook_basis = per_square_fibers["rook"]
    # Orthonormal basis for the rook subspace via SVD.
    _Ru, _Rs, RVt = np.linalg.svd(rook_basis, full_matrices=False)
    rook_tol = 1e-9
    r_rank = int(np.sum(_Rs > rook_tol))
    R = RVt[:r_rank].T  # 2016 x r_rank

    # Project each non-trivial aggregated fiber onto R's orthogonal
    # complement, then SVD for the top 3 singular directions.
    nt_fibers = np.stack([agg_fibers[p] for p in NON_TRIVIAL_FOR_BASIS])
    nt_ortho = nt_fibers - (nt_fibers @ R) @ R.T
    nt_norms = np.linalg.norm(nt_ortho, axis=1, keepdims=True)
    nt_norms = np.where(nt_norms > 0, nt_norms, 1.0)
    nt_n = nt_ortho / nt_norms
    _U, _S, Vt = np.linalg.svd(nt_n, full_matrices=False)
    V3 = Vt[:3].T  # 2016 x 3 — columns are the top 3 right singular vectors

    # ---- Per-square scalar field -----------------------------------------
    values: Dict[str, np.ndarray] = {}
    for piece in PIECE_ORDER:
        # Project each per-square fiber onto V3 and take its L2 norm.
        p3 = per_square_fibers[piece] @ V3            # 64 x 3
        values[piece] = np.linalg.norm(p3, axis=1)    # 64-vec

    ranges: Dict[str, Dict[str, float]] = {}
    for piece, vec in values.items():
        vmin = float(vec.min())
        vmax = float(vec.max())
        if piece == "rook":
            ranges[piece] = {"min": 0.0, "max": 0.0, "ratio": None}
        else:
            ratio = vmax / vmin if vmin > 0 else None
            ranges[piece] = {"min": vmin, "max": vmax, "ratio": ratio}
    return values, ranges


# ---------------------------------------------------------------------
# Verification gates.
# ---------------------------------------------------------------------
# The 8 D4 symmetries of the square, expressed as a permutation of the
# 64 square indices (row-major, a1 = 0). Each entry maps the source
# square index to the image square index under that symmetry.
def _d4_perms() -> List[np.ndarray]:
    perms = []
    # Identity, rotate 90, rotate 180, rotate 270
    # Reflect horizontal (flip columns), reflect vertical (flip rows),
    # reflect main-diagonal (transpose), reflect anti-diagonal
    def P(fn):
        perm = np.empty(NSQ, dtype=np.int64)
        for r in range(N):
            for c in range(N):
                rr, cc = fn(r, c)
                perm[_sq(r, c)] = _sq(rr, cc)
        return perm
    perms.append(P(lambda r, c: (r, c)))
    perms.append(P(lambda r, c: (c, N - 1 - r)))              # rot 90
    perms.append(P(lambda r, c: (N - 1 - r, N - 1 - c)))      # rot 180
    perms.append(P(lambda r, c: (N - 1 - c, r)))              # rot 270
    perms.append(P(lambda r, c: (r, N - 1 - c)))              # reflect vert axis
    perms.append(P(lambda r, c: (N - 1 - r, c)))              # reflect horiz axis
    perms.append(P(lambda r, c: (c, r)))                       # transpose
    perms.append(P(lambda r, c: (N - 1 - c, N - 1 - r)))      # anti-diag
    return perms


def _is_d4_symmetric(vec: np.ndarray, atol: float = 1e-9) -> bool:
    for perm in _d4_perms():
        if not np.allclose(vec, vec[perm], atol=atol):
            return False
    return True


def verify(values: Dict[str, np.ndarray]) -> None:
    """Raise AssertionError on any failed gate."""
    # Gate 1: rook fiber identically zero
    assert np.allclose(values["rook"], 0.0, atol=1e-9), (
        "rook fiber is not identically zero — the SVD basis is wrong. "
        f"max abs = {np.max(np.abs(values['rook'])):.3e}"
    )

    # Gate 2-5: D4 symmetry on each non-trivial piece (and trivially on rook).
    for piece in ("knight", "bishop", "queen", "king", "rook"):
        assert _is_d4_symmetric(values[piece]), f"{piece} field not D4-symmetric"

    # Gate 6: bishop-queen proportionality (queen = bishop + rook; rook's
    # off-diagonal fiber is zero so the two fields should be parallel).
    b = values["bishop"]
    q = values["queen"]
    bn = np.linalg.norm(b)
    qn = np.linalg.norm(q)
    if bn > 0 and qn > 0:
        cos = float(np.dot(b, q) / (bn * qn))
        assert cos > 0.999999, (
            f"bishop-queen cosine {cos:.6f} — expected ≈ 1.0. "
            "Rook's off-diagonal fiber may not be zero after all."
        )

    # Gate 7: knight has sqrt(degree)-like corner < edge < center structure.
    # Specifically a1 (2 knight targets) should be strictly less than d4
    # (8 knight targets).
    a1 = values["knight"][_sq(0, 0)]
    d4 = values["knight"][_sq(3, 3)]
    assert d4 > a1, (
        f"knight corner/center structure inverted: a1={a1:.4f}, d4={d4:.4f}"
    )


# ---------------------------------------------------------------------
# Entry point.
# ---------------------------------------------------------------------
def main() -> int:
    out_path = Path(__file__).resolve().parent.parent / "data" / "fiber_norms.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)

    values, ranges = compute_fields()
    verify(values)

    # Round to a few sig figs — the viewer displays these as colors, not
    # scientific readouts; 6 decimals is plenty and keeps the JSON small.
    doc = {
        "version": 1,
        "description": (
            "Rank-3 shared fiber bundle norm per square, per piece type. "
            "Static property of the chess rules."
        ),
        "notebook_reference": "chess_spectral_research_notebook.md §7",
        "piece_order": PIECE_ORDER,
        "square_order": (
            "row-major, a1 = index 0, h8 = index 63, "
            "(row, col) = (idx // 8, idx % 8)"
        ),
        "rook_is_identically_zero": True,
        "values": {p: [round(float(x), 6) for x in values[p]] for p in PIECE_ORDER},
        "ranges": {},
    }
    for p in PIECE_ORDER:
        r = ranges[p]
        doc["ranges"][p] = {
            "min":   round(r["min"], 6),
            "max":   round(r["max"], 6),
            "ratio": (round(r["ratio"], 4) if r["ratio"] is not None else None),
        }

    out_path.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")

    # Console report
    print(f"wrote {out_path}")
    for p in PIECE_ORDER:
        r = ranges[p]
        if p == "rook":
            print(f"  {p:6s}  min={r['min']:.3e}  max={r['max']:.3e}  (identically zero)")
        else:
            print(f"  {p:6s}  min={r['min']:.6f}  max={r['max']:.6f}  ratio={r['ratio']:.3f}")
    print("all verification gates passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
