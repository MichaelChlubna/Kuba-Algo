import polars as pl
import pytest

from fp.candles import time_candles
from fp.convert import repair_aggtrades
from tests.conftest import T0


def raw_trades(rows):
    """rows: (trade_id, ts_offset_ms, price, qty, is_buyer_maker)"""
    return pl.DataFrame([{"id": i, "price": p, "qty": q, "ts": T0 + o, "ibm": b} for i, o, p, q, b in rows],
                        schema={"id": pl.Int64, "price": pl.Float64, "qty": pl.Float64, "ts": pl.Int64, "ibm": pl.Boolean})


RAW = raw_trades([
    (1, 0, 100.0, 1.0, False), (2, 0, 100.0, 1.0, False), (3, 5, 100.0, 1.0, False),   # agg 1 (present)
    (4, 10, 99.0, 0.5, True), (5, 60, 99.0, 0.5, True),                                 # missing -> one agg
    (6, 70, 98.5, 2.0, True),                                                           # missing, other price
    (7, 80, 98.0, 1.0, False), (8, 90, 98.0, 1.0, False),                               # agg 2 (present)
    (9, 100, 97.0, 3.0, True), (10, 250, 97.0, 1.0, True),                              # missing, > 100 ms apart
])
AGG = pl.DataFrame({"id": [500, 501], "price": [100.0, 98.0], "qty": [3.0, 2.0], "first_id": [1, 7], "last_id": [3, 8],
                    "ts": [T0, T0 + 80], "ibm": [False, False], "rep": [False, False]})


def test_reconstructs_missing_aggtrades_like_binance():
    df, add = repair_aggtrades(AGG, RAW)
    assert add.select("first_id", "last_id", "price", "qty", "ibm").rows() == [
        (4, 5, 99.0, 1.0, True), (6, 6, 98.5, 2.0, True), (9, 9, 97.0, 3.0, True), (10, 10, 97.0, 1.0, True)]
    assert add["id"].is_null().all() and add["rep"].all()
    assert df["first_id"].to_list() == [1, 4, 6, 7, 9, 10]          # true trade order
    assert df["qty"].sum() == pytest.approx(RAW["qty"].sum())       # nothing lost, nothing double counted


def test_nothing_missing_is_a_no_op():
    full = RAW.filter(pl.col("id").is_in([1, 2, 3, 7, 8]))
    df, add = repair_aggtrades(AGG, full)
    assert add.height == 0 and df.height == 2


def test_candles_flag_repaired_volume():
    df, _ = repair_aggtrades(AGG, RAW)
    c = time_candles(df, 60_000).row(0, named=True)
    assert c["volume"] == pytest.approx(12.0)
    assert c["repaired_btc"] == pytest.approx(0.5 + 0.5 + 2.0 + 3.0 + 1.0)
    assert c["open"] == 100.0 and c["close"] == 97.0 and c["low"] == 97.0
    assert c["trades"] == 10


def test_trades_of_previous_days_last_aggtrade_are_not_missing():
    # the previous day's last aggTrade (trades 1..3) spans midnight: trade 3 is in this day's raw file
    prev = pl.DataFrame({"id": [499], "price": [100.0], "qty": [3.0], "first_id": [1], "last_id": [3],
                         "ts": [T0 - 50], "ibm": [False], "rep": [False]})
    today_raw = RAW.filter(pl.col("id") >= 3)
    today_agg = AGG.filter(pl.col("id") == 501)
    _, add = repair_aggtrades(today_agg, today_raw, prev)
    assert 3 not in add["first_id"].to_list()
    _, add_without = repair_aggtrades(today_agg, today_raw)
    assert 3 in add_without["first_id"].to_list()   # what happened before the fix
