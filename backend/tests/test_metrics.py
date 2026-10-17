import polars as pl
import pytest

from fp.build import time_candles_with_features, time_footprint
from fp.metrics import add_candle_metrics, add_oi_vol_ratio
from fp.volume_bars import State, split_pieces, threshold_units
from tests.conftest import make_trades

P = 300_000
MCFG = {"imbalance_ratio": 3.0, "imbalance_min_usd": 100.0, "big_trade_btc": 5.0}

# Long absorption: open 1010, sellers push into the lower wick down to 998, close 1012.
ROWS = [
    (0, 1010.0, 1.0, False),        # body (== min(O,C))
    (60_000, 1004.0, 2.0, True),    # lower wick, sell
    (120_000, 998.0, 6.0, True),    # lower wick, sell, the low, large trade
    (180_000, 1003.0, 1.0, False),  # lower wick, buy
    (240_000, 1012.0, 1.0, False),  # body (== max(O,C)), close
]


@pytest.fixture
def m():
    t = make_trades(ROWS)
    fp = time_footprint(t, P, 5)
    c = time_candles_with_features(t, P)
    keyed = t.with_columns(start_ts=(pl.col("ts") // P) * P)
    return add_candle_metrics(c, keyed, fp, "start_ts", 5, MCFG).row(0, named=True)


def test_delta_path_and_timing(m):
    # cumulative delta USD: +1010, -998, -6986, -5983, -4971
    assert m["dpath_min_usd"] == pytest.approx(-6986.0)
    assert m["dpath_max_usd"] == pytest.approx(1010.0)
    assert m["d_recov_l_usd"] == pytest.approx(-4971.0 + 6986.0)
    assert m["d_recov_l_ratio"] == pytest.approx(2015.0 / 6986.0)
    assert m["d_recov_s_usd"] == pytest.approx(1010.0 + 4971.0)
    assert m["t_low_frac"] == pytest.approx(0.4)
    assert m["t_dmin_frac"] == pytest.approx(0.4)
    assert m["t_high_frac"] == pytest.approx(0.8)
    assert m["t_dmax_frac"] == pytest.approx(0.0)


def test_time_in_wick(m):
    assert m["lw_time_ms"] == 180_000 and m["lw_time_frac"] == pytest.approx(0.6)
    assert m["uw_time_ms"] == 0 and m["uw_time_frac"] == 0


def test_auction_and_exhaustion_at_extremes(m):
    # lowest 5 USD bucket 995: only sellers -> finished auction; highest bucket 1010: only buyers
    assert m["low_buy_usd"] == 0 and m["low_sell_usd"] == pytest.approx(5988.0)
    assert m["unfinished_low"] is False and m["unfinished_high"] is False
    poc = 5988.0
    assert m["exh_low"] == pytest.approx(1.0)
    assert m["exh_low2"] == pytest.approx((5988.0 + 2008.0 + 1003.0) / poc)
    assert m["exh_high"] == pytest.approx(2022.0 / poc)


def test_imbalances_in_lower_wick(m):
    # sell imbalance at 995 (5988 >= 3 x 1003 bought at 1000) and at 1000 (2008 vs nothing bought at 1005)
    assert m["lw_sell_imb"] == 2 and m["lw_sell_stack"] == 2
    assert m["lw_buy_imb"] == 0 and m["lw_buy_stack"] == 0
    # buy imbalance at 1010 is in the body, not in the wick
    assert m["uw_buy_imb"] == 0


def test_effort_vs_result(m):
    lw_vol = 2008.0 + 5988.0 + 1003.0
    assert m["lw_effort"] == pytest.approx(lw_vol / 12.0)       # 1010 - 998
    assert m["body_effort"] == pytest.approx(2022.0 / 2.0)      # |1012 - 1010|
    assert m["lw_effort_ratio"] == pytest.approx((lw_vol / 12.0) / 1011.0)
    assert m["uw_effort"] is None                               # no upper wick


def test_large_trades_and_intensity(m):
    lw_vol = 2008.0 + 5988.0 + 1003.0
    assert m["lw_big_sell_usd"] == pytest.approx(5988.0) and m["lw_big_count"] == 1
    assert m["lw_big_share"] == pytest.approx(5988.0 / lw_vol)
    assert m["lw_big_sell_share"] == pytest.approx(5988.0 / (2008.0 + 5988.0))
    assert m["lw_trades"] == 3 and m["body_trades"] == 2
    assert m["lw_avg_trade_usd"] == pytest.approx(lw_vol / 3)
    assert m["body_avg_trade_usd"] == pytest.approx(1011.0)
    assert m["lw_rate"] == pytest.approx(3 / 180.0)
    assert m["body_rate"] == pytest.approx(2 / 120.0)


def test_volume_pieces_keep_original_trade_size():
    t = make_trades([(0, 100.0, 3.0, False), (1, 100.0, 10.0, True)])
    pieces, _ = split_pieces(t, "btc", threshold_units("btc", 4), State())
    big = pieces.filter(pl.col("id") == 2)
    # cum 3 -> 13 with threshold 4: pieces 1 + 4 + 4 + 1, each remembers the 10 BTC original
    assert big["qty"].to_list() == pytest.approx([1.0, 4.0, 4.0, 1.0]) and (big["tqty"] == 10.0).all()


def test_oi_vol_ratio():
    df = add_oi_vol_ratio(pl.DataFrame({"d_oi": [50.0, None], "volume": [1000.0, 10.0]}))
    assert df["oi_vol_ratio"].to_list() == [0.05, None]
