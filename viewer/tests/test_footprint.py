import polars as pl
import pytest

from fp.build import time_footprint
from fp.footprint import rebin
from tests.conftest import T0, make_trades


def test_levels_floor_and_bin_edges():
    t = make_trades([
        (0, 81850.0, 1.0, False),   # exactly on edge -> 81850
        (1, 81849.9, 2.0, True),    # just below -> 81845
        (2, 81854.9, 0.5, False),   # top of the 81850 bin
        (3, 81855.0, 0.25, True),   # next bin
    ])
    fp = time_footprint(t, 300_000, 5)
    rows = {r["level"]: r for r in fp.iter_rows(named=True)}
    assert sorted(rows) == [81845, 81850, 81855]
    assert rows[81850]["buy"] == pytest.approx(1.5) and rows[81850]["sell"] == 0
    assert rows[81845]["sell"] == pytest.approx(2.0) and rows[81845]["delta"] == pytest.approx(-2.0)
    assert rows[81855]["total"] == pytest.approx(0.25)
    assert rows[81850]["buy_usd"] == pytest.approx(81850.0 + 81854.9 * 0.5)


def test_rebin_matches_direct_and_preserves_totals():
    rows = [(i * 1000, 81800 + (i * 7.3) % 120, 0.1 + i % 3, i % 2 == 0) for i in range(200)]
    t = make_trades([(o, round(p, 1), q, b) for o, p, q, b in rows])
    base = time_footprint(t, 300_000, 5)
    for b in (10, 25, 50, 100):
        direct = time_footprint(t, 300_000, b)
        r = rebin(base, "start_ts", b)
        j = direct.join(r, on=["start_ts", "level"], how="full", coalesce=True)
        assert j["delta"].to_list() == pytest.approx(j["delta_right"].to_list())
        assert r["total"].sum() == pytest.approx(t["qty"].sum())


def test_footprint_keyed_by_candle():
    t = make_trades([(0, 100.0, 1.0, False), (300_000, 100.0, 2.0, True)])
    fp = time_footprint(t, 300_000, 5)
    assert fp["start_ts"].to_list() == [T0, T0 + 300_000]
