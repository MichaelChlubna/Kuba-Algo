import polars as pl
import pytest

from fp.volume_bars import State, agg_name, aggregate_volume_candles, parse_agg, split_pieces, threshold_units
from tests.conftest import make_trades


def run(trades, unit, value, state=None):
    T = threshold_units(unit, value)
    pieces, st = split_pieces(trades, unit, T, state or State())
    return pieces, st, aggregate_volume_candles(pieces.filter(pl.col("cid") < st.next_id))


def test_split_btc_threshold_remainder_moves_to_next_candle():
    t = make_trades([(0, 100.0, 4.0, False), (1, 101.0, 4.0, True), (2, 102.0, 4.0, False, 3), (3, 103.0, 9.0, True)])
    pieces, st, c = run(t, "btc", 10)
    # candle 0: 4 + 4 + 2 (split of the 3rd trade), candle 1: 2 + 8 (split of the 4th), open candle: 1
    assert c["volume"].to_list() == pytest.approx([10.0, 10.0])
    assert c["close"].to_list() == [102.0, 103.0]
    assert c["open"].to_list() == [100.0, 102.0]   # remainder keeps price and side
    assert c["buy"].to_list() == pytest.approx([6.0, 2.0])
    assert c["sell"].to_list() == pytest.approx([4.0, 8.0])
    assert c["trades"].to_list() == [1 + 1 + 3, 1]  # trade count stays with the first piece
    assert st.acc == threshold_units("btc", 1.0) and st.next_id == 2
    assert st.carry["qty"].sum() == pytest.approx(1.0)
    assert pieces["qty"].sum() == pytest.approx(t["qty"].sum())


def test_one_trade_spanning_several_candles():
    t = make_trades([(0, 100.0, 3.0, False), (5, 100.0, 25.0, True)])
    _, st, c = run(t, "btc", 10)
    assert c["volume"].to_list() == pytest.approx([10.0, 10.0])
    assert c.height == 2 and st.carry["qty"].sum() == pytest.approx(8.0)
    assert c["cid"].to_list() == [0, 1]
    assert c["start_ts"][1] == c["end_ts"][1]  # formed by a single trade


def test_exact_threshold_closes_candle():
    t = make_trades([(0, 100.0, 5.0, False), (1, 100.0, 5.0, False), (2, 100.0, 1.0, False)])
    _, st, c = run(t, "btc", 10)
    assert c.height == 1 and c["volume"][0] == pytest.approx(10.0) and c["agg_trades"][0] == 2
    assert st.carry["qty"].sum() == pytest.approx(1.0)


def test_usd_threshold_exact_notional():
    t = make_trades([(0, 50_000.0, 1.5, False), (1, 50_000.1, 1.0, True)])
    _, st, c = run(t, "usd", 100_000)
    assert c["volume_usd"][0] == pytest.approx(100_000.0)
    # 75 000 from trade 1, remaining 25 000 USD from trade 2 at 50 000.1
    assert c["volume"][0] == pytest.approx(1.5 + 25_000 / 50_000.1)
    assert c["sell_usd"][0] == pytest.approx(25_000.0)
    assert st.acc / 1e4 == pytest.approx(1.5 * 50_000 + 50_000.1 - 100_000)


def test_state_continues_across_days_like_a_single_run():
    rows = [(i * 1000, 100.0 + (i % 7) * 0.1, 0.3 + (i % 5) * 0.7, i % 3 == 0, 1 + i % 2) for i in range(300)]
    t = make_trades(rows)
    _, _, whole = run(t, "btc", 25)
    p1, st1, c1 = run(t.head(137), "btc", 25)
    _, st2, c2 = run(t.tail(300 - 137), "btc", 25, st1)
    both = pl.concat([c1, c2])
    assert both["cid"].to_list() == whole["cid"].to_list()
    for col in ("volume", "buy", "sell", "open", "high", "low", "close", "trades", "start_ts", "end_ts"):
        assert both[col].to_list() == pytest.approx(whole[col].to_list()), col


def test_names():
    assert agg_name("usd", 100_000_000) == "vusd_100000000"
    assert agg_name("btc", 1000.0) == "vbtc_1000"
    assert agg_name("btc", 2.5) == "vbtc_2.5"
    assert parse_agg("vusd_100000000") == ("usd", 1e8)
    assert parse_agg("5m") is None


def test_tick_candles_count_aggtrades_and_carry_state():
    t = make_trades([(i, 100.0 + i, 1.0 + i, i % 2 == 0, 2) for i in range(7)])
    _, st, c = run(t, "tick", 3)
    assert agg_name("tick", 3) == "vtick_3" and parse_agg("vtick_3") == ("tick", 3.0)
    assert c.height == 2 and c["agg_trades"].to_list() == [3, 3]
    assert c["volume"].to_list() == pytest.approx([1 + 2 + 3, 4 + 5 + 6])   # never split
    assert c["trades"].to_list() == [6, 6]
    assert c["open"].to_list() == [100.0, 103.0] and c["close"].to_list() == [102.0, 105.0]
    assert st.acc == 1 and st.next_id == 2 and st.carry.height == 1
    t2 = make_trades([(10, 200.0, 1.0, False), (11, 201.0, 1.0, True)])
    _, st2, c2 = run(t2, "tick", 3, st)
    assert c2["cid"].to_list() == [2] and c2["open"][0] == 106.0 and c2["close"][0] == 201.0
    assert st2.acc == 0 and st2.next_id == 3
