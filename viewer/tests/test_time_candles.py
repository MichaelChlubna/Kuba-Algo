import pytest

from fp.candles import add_cvd, time_candles
from tests.conftest import T0, make_trades


def test_ohlcv_delta_and_counts():
    t = make_trades([
        (0, 100.0, 1.0, False, 3),      # buy, 3 trades
        (10_000, 105.0, 2.0, True),     # sell
        (20_000, 95.0, 0.5, True),      # sell
        (59_999, 101.0, 1.5, False, 2), # buy, last ms of the minute
        (60_000, 102.0, 1.0, False),    # next minute
    ])
    c = time_candles(t, 60_000)
    assert c["open_time"].to_list() == [T0, T0 + 60_000]
    r = c.row(0, named=True)
    assert (r["open"], r["high"], r["low"], r["close"]) == (100.0, 105.0, 95.0, 101.0)
    assert r["volume"] == pytest.approx(5.0)
    assert r["buy"] == pytest.approx(2.5)
    assert r["sell"] == pytest.approx(2.5)
    assert r["delta"] == pytest.approx(0.0)
    assert r["volume_usd"] == pytest.approx(100 + 210 + 47.5 + 151.5)
    assert r["buy_usd"] == pytest.approx(100 + 151.5)
    assert r["delta_usd"] == pytest.approx((100 + 151.5) - (210 + 47.5))
    assert r["trades"] == 3 + 1 + 1 + 2
    assert r["agg_trades"] == 4
    assert r["start_ts"] == T0 and r["end_ts"] == T0 + 60_000 and r["duration_ms"] == 60_000
    assert c.row(1, named=True)["open"] == 102.0


def test_is_buyer_maker_means_taker_sell():
    c = time_candles(make_trades([(0, 100.0, 1.0, True)]), 60_000)
    assert c["sell"][0] == 1.0 and c["buy"][0] == 0.0 and c["delta"][0] == -1.0


def test_open_close_follow_id_order_not_price():
    t = make_trades([(0, 200.0, 1.0, False), (1, 100.0, 1.0, False), (2, 150.0, 1.0, False)])
    r = time_candles(t, 300_000).row(0, named=True)
    assert r["open"] == 200.0 and r["close"] == 150.0


def test_5m_and_15m_alignment():
    t = make_trades([(0, 1, 1, False), (299_999, 1, 1, False), (300_000, 1, 1, False), (899_999, 1, 1, False), (900_000, 1, 1, False)])
    assert time_candles(t, 300_000)["open_time"].to_list() == [T0, T0 + 300_000, T0 + 600_000, T0 + 900_000]
    assert time_candles(t, 900_000)["open_time"].to_list() == [T0, T0 + 900_000]


def test_empty_minutes_produce_no_candle():
    t = make_trades([(0, 1, 1, False), (180_000, 1, 1, False)])
    assert time_candles(t, 60_000).height == 2


def test_cvd_daily_reset():
    day = 86_400_000
    t = make_trades([(day - 60_000, 1, 1.0, False), (day - 1, 1, 2.0, False), (day, 1, 1.0, True), (day + 60_000, 1, 3.0, False)])
    c = add_cvd(time_candles(t, 60_000), "daily")
    assert c["cvd"].to_list() == pytest.approx([3.0, -1.0, 2.0])
    c = add_cvd(time_candles(t, 60_000), "none")
    assert c["cvd"].to_list() == pytest.approx([3.0, 2.0, 5.0])
