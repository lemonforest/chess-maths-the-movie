"""Tests for data/fiber_norms.json — the rank-3 shared fiber norm field.

These gates enforce structural properties of the data file, not specific
absolute numbers:

* rook array is identically zero (notebook §7 / §7b identity)
* each non-rook field is invariant under the 8 D4 symmetries of the
  square (chess rules respect the square's dihedral symmetry)
* bishop and queen fields are parallel, because queen = bishop + rook
  and rook's off-diagonal fiber contribution is zero
* per-piece range metadata stored in the file matches a recomputation
  from the values array itself — no drift between data and summary

The file is generated offline by scripts/generate_fiber_norms.py; these
tests are read-only and run under the same ``pytest -q`` suite as the
existing Othello board tests.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
FIBER_PATH = ROOT / "data" / "fiber_norms.json"

N = 8


def _sq(r: int, c: int) -> int:
    return r * N + c


@pytest.fixture(scope="module")
def doc():
    assert FIBER_PATH.exists(), (
        f"{FIBER_PATH} not found — run scripts/generate_fiber_norms.py"
    )
    with FIBER_PATH.open(encoding="utf-8") as f:
        return json.load(f)


# ---------------------------------------------------------------------
# D4 symmetry helpers
# ---------------------------------------------------------------------
def _d4_perms():
    perms = []

    def P(fn):
        perm = [0] * (N * N)
        for r in range(N):
            for c in range(N):
                rr, cc = fn(r, c)
                perm[_sq(r, c)] = _sq(rr, cc)
        return perm
    perms.append(P(lambda r, c: (r, c)))
    perms.append(P(lambda r, c: (c, N - 1 - r)))
    perms.append(P(lambda r, c: (N - 1 - r, N - 1 - c)))
    perms.append(P(lambda r, c: (N - 1 - c, r)))
    perms.append(P(lambda r, c: (r, N - 1 - c)))
    perms.append(P(lambda r, c: (N - 1 - r, c)))
    perms.append(P(lambda r, c: (c, r)))
    perms.append(P(lambda r, c: (N - 1 - c, N - 1 - r)))
    return perms


_D4 = _d4_perms()


def _is_d4_symmetric(vec, atol=1e-6):
    for perm in _D4:
        for i in range(len(vec)):
            if abs(vec[i] - vec[perm[i]]) > atol:
                return False
    return True


# ---------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------
def test_file_structure(doc):
    """Schema sanity: the fields promised in the spec are present."""
    assert doc["version"] == 1
    assert doc["piece_order"] == ["knight", "bishop", "rook", "queen", "king"]
    assert doc["rook_is_identically_zero"] is True
    for p in doc["piece_order"]:
        assert len(doc["values"][p]) == 64, f"{p}: expected 64 values"
        assert p in doc["ranges"]


def test_rook_is_zero(doc):
    """The rook field is identically zero (§7b — rook's rule content lives
    in the diagonal channel, not the off-diagonal fiber)."""
    vals = doc["values"]["rook"]
    for v in vals:
        assert abs(v) < 1e-9, f"rook field non-zero at some square: v={v}"
    r = doc["ranges"]["rook"]
    assert r["min"] == 0.0
    assert r["max"] == 0.0
    assert r["ratio"] is None


@pytest.mark.parametrize("piece", ["knight", "bishop", "rook", "queen", "king"])
def test_d4_symmetry(doc, piece):
    """Every field is invariant under the 8 symmetries of the square.
    This is a consequence of chess's move rules on an 8x8 board — every
    piece's unobstructed move set respects the D4 group."""
    vals = doc["values"][piece]
    assert _is_d4_symmetric(vals), f"{piece}: field not D4-symmetric"


def test_bishop_queen_proportional(doc):
    """queen = bishop + rook (as move sets); rook contributes zero to
    the off-diagonal fiber (§7b), so the bishop and queen per-square
    fields must be parallel when viewed as 64-vectors (cosine = 1)."""
    b = doc["values"]["bishop"]
    q = doc["values"]["queen"]
    bn = math.sqrt(sum(x * x for x in b))
    qn = math.sqrt(sum(x * x for x in q))
    assert bn > 0 and qn > 0, "bishop or queen fields are zero — unexpected"
    dot = sum(x * y for x, y in zip(b, q))
    cos = dot / (bn * qn)
    assert cos > 0.999999, (
        f"bishop-queen cosine = {cos:.6f}, expected ≈ 1 — "
        "the rook fiber is leaking into the queen field"
    )


def test_knight_corner_center_structure(doc):
    """Knight: corner < center (sqrt-degree-like). §7 anchor identity."""
    vals = doc["values"]["knight"]
    corner = vals[_sq(0, 0)]   # a1
    center = vals[_sq(3, 3)]   # d4
    assert corner > 0, "knight corner value should be strictly positive"
    assert center > corner, (
        f"knight corner/center structure inverted: "
        f"a1={corner:.4f} d4={center:.4f}"
    )


@pytest.mark.parametrize("piece", ["knight", "bishop", "queen", "king"])
def test_ranges_make_sense(doc, piece):
    """For each non-rook piece: min > 0, max > min, and the stored range
    metadata matches recomputation from the values array."""
    vals = doc["values"][piece]
    r = doc["ranges"][piece]
    v_min = min(vals)
    v_max = max(vals)
    assert v_min > 0, f"{piece} min = {v_min} — expected strictly positive"
    assert v_max > v_min, f"{piece} max ({v_max}) should exceed min ({v_min})"
    assert abs(r["min"] - v_min) < 1e-5, f"{piece} stored min drifted: {r['min']} vs {v_min}"
    assert abs(r["max"] - v_max) < 1e-5, f"{piece} stored max drifted: {r['max']} vs {v_max}"
    stored_ratio = r["ratio"]
    recomputed = v_max / v_min
    assert stored_ratio is not None and abs(stored_ratio - recomputed) < 1e-2, (
        f"{piece} stored ratio drifted: {stored_ratio} vs {recomputed}"
    )
