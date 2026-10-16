import polars as pl
import pytest

from fp.build import time_candles_with_features
from fp.features import add_oi_delta, add_rolling, rolling_z
from tests.conftest import T0, make_trades

P = 300_000


def one_candle(rows):
    return time_candles_with_features(make_trades(rows), P).row(0, named=True)


def test_wick_strictly_below_body_boundary_prices():
    # O=100, C=102 -> body low = 100. Trades at exactly 100 are NOT in the lower wick.
    r = one_candle([
        (0, 100.0, 1.0, False),
        (1, 98.0, 2.0, True),    # lower wick, sell
        (2, 99.9, 1.0, False),   # lower wick, buy
        (3, 100.0, 4.0, True),   # == min(O,C): body, not wick
        (4, 103.0, 1.0, False),  # upper wick (> max(O,C)=102)
        (5, 102.0, 3.0, False),  # close == max(O,C): body, not wick
    ])
    assert r["lw_vol"] == pytest.approx(3.0)
    assert r["lw_sell"] == pytest.approx(2.0) and r["lw_buy"] == pytest.approx(1.0)
    assert r["lw_sell_usd"] == pytest.approx(196.0)
    assert r["uw_vol"] == pytest.approx(1.0) and r["uw_buy"] == pytest.approx(1.0)
    assert r["lw_range"] == pytest.approx((100 - 98) / (103 - 98))
    assert r["uw_range"] == pytest.approx((103 - 102) / (103 - 98))


def test_red_candle_body_uses_close_as_low():
    # O=105, C=101 -> lower wick is strictly below 101
    r = one_candle([(0, 105.0, 1.0, False), (1, 101.0, 1.0, True), (2, 100.0, 2.0, True), (3, 101.0, 1.0, True)])
    assert r["lw_vol"] == pytest.approx(2.0)
    assert r["color"] == -1


def test_zero_wick_share_zero():
    r = one_candle([(0, 100.0, 1.0, True), (1, 101.0, 1.0, False)])  # O=L, C=H
    assert r["lw_vol"] == 0 and r["lw_share"] == 0.0 and r["lw_range"] == 0.0


def test_no_sell_volume_sell_share_null():
    r = one_candle([(0, 100.0, 1.0, False), (1, 99.0, 5.0, False), (2, 100.5, 1.0, False)])
    assert r["sell_usd"] == 0 and r["lw_sell_share"] is None


def test_flat_candle_not_valid():
    r = one_candle([(0, 100.0, 1.0, True), (1, 100.0, 1.0, True)])
    assert not r["valid"]


def test_volume_z_spike_on_heavy_candle():
    n = 30
    rows = []
    for i in range(n):  # quiet history with slightly varying volume
        q = 1.0 + 0.1 * (i % 5)
        rows += [(i * P, 100.0, q, False), (i * P + 1, 100.5, q, True), (i * P + 2, 100.2, q, False)]
    rows += [(n * P, 100.0, 1.0, False), (n * P + 1, 96.0, 30.0, True), (n * P + 2, 95.0, 10.0, True),
             (n * P + 3, 97.0, 5.0, False), (n * P + 4, 101.0, 2.0, False)]
    df = add_rolling(time_candles_with_features(make_trades(rows), P), n)
    last = df.row(-1, named=True)
    assert df["z"][:n].is_null().all()
    assert last["z"] > 2
    assert last["lw_share"] >= 0.5 and last["lw_delta_usd"] < 0 and last["lw_sell_share"] >= 0.5


def test_rolling_z_excludes_current_and_needs_n():
    df = pl.DataFrame({"x": [1.0, 2.0, 3.0, 4.0, 10.0]}).with_columns(z=rolling_z(pl.col("x"), 3))
    assert df["z"][:3].is_null().all()
    # z for index 3 uses [1,2,3]: mean 2, std 1
    assert df["z"][3] == pytest.approx(2.0)
    assert df["z"][4] == pytest.approx((10 - 3) / 1)


def test_oi_delta_only_with_snapshot_inside():
    oi = pl.DataFrame({"oi_time": [T0, T0 + 300_000, T0 + 600_000], "oi_btc": [100.0, 110.0, 105.0], "oi_usd": [1.0, 2.0, 3.0]})
    c = pl.DataFrame({"start_ts": [T0 + i * 60_000 for i in range(10)], "end_ts": [T0 + (i + 1) * 60_000 for i in range(10)]})
    r = add_oi_delta(c, oi)
    # only the minutes ending at a snapshot (05:00 and 10:00) get a value
    assert r["d_oi"].to_list() == [None, None, None, None, 10.0, None, None, None, None, -5.0]
    m5 = pl.DataFrame({"start_ts": [T0, T0 + P], "end_ts": [T0 + P, T0 + 2 * P]})
    assert add_oi_delta(m5, oi)["d_oi"].to_list() == [10.0, -5.0]


def test_volume_candles_window_speed_z():
    import math
    import random

    rng = random.Random(7)
    gaps = [rng.uniform(30_000, 90_000) for _ in range(80)] + [5_000] * 10   # last 10 candles form fast
    end = [0]
    for g in gaps:
        end.append(end[-1] + int(g))
    df = add_rolling(pl.DataFrame({"end_ts": end}), n=30, volume_bars=True, window=10)
    W, N = 10, 30
    x = [None] * W + [-math.log(end[i] - end[i - W]) for i in range(W, len(end))]
    i = len(end) - 1
    base = x[i - W - N + 1: i - W + 1]          # windows ending before the current window starts
    mean = sum(base) / N
    sd = math.sqrt(sum((v - mean) ** 2 for v in base) / (N - 1))
    assert df["vspeed"][i] == pytest.approx(x[i])
    assert df["z"][i] == pytest.approx((x[i] - mean) / sd)
    assert df["z"][i] > 3                         # 10 fast candles => acceleration
    assert df["z"][: 2 * W + N - 1].is_null().all()  # needs W + (N - 1) + W candles of history
    assert df["z"][2 * W + N - 1] is not None
