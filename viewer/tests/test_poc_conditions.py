import polars as pl
import pytest

from fp.build import time_candles_with_features, time_footprint
from fp.features import add_rolling, detect
from fp.footprint import poc_features
from tests.conftest import make_trades

P = 300_000


def candle_with_poc(rows, bins=(5, 25)):
    t = make_trades(rows)
    fp = time_footprint(t, P, 5)
    c = time_candles_with_features(t, P).join(poc_features(fp, "start_ts", 5, bins), on="start_ts", how="left")
    return c


def test_poc_levels_per_bin():
    # O=1010 C=1012; heavy selling at 1001 (bucket 1000 at bin 5), most negative delta at 996 (bucket 995)
    c = candle_with_poc([
        (0, 1010.0, 1.0, False), (1, 1001.0, 10.0, True), (2, 1001.5, 4.0, False),
        (3, 996.0, 6.0, True), (4, 1003.0, 1.0, False), (5, 1012.0, 1.0, False),
    ]).row(0, named=True)
    assert c["vpoc_5"] == 1000          # 15 BTC traded in [1000, 1005)
    # delta USD: bucket 1000 = -10*1001 + 4*1001.5 + 1003 = -5001; bucket 995 = -6*996 = -5976
    assert c["dpoc_neg_5"] == 995
    assert c["dpoc_pos_5"] == 1010      # bucket 1010: buys at 1010 and 1012
    assert c["vpoc_25"] == 1000 and c["dpoc_neg_25"] == 975


def test_dpoc_null_when_no_negative_delta():
    c = candle_with_poc([(0, 100.0, 1.0, False), (1, 95.0, 2.0, False), (2, 101.0, 1.0, False)]).row(0, named=True)
    assert c["dpoc_neg_5"] is None and c["dpoc_pos_5"] is not None


def det(c, **kw):
    df = c.with_columns(z=pl.lit(5.0))
    base = dict(z_min=2.0, v2_min=0.5, d2_min=0.5, poc_bin=5)
    base.update(kw)
    return detect(df, **base).row(0, named=True)


def test_p1_poc_bucket_must_be_entirely_in_wick():
    # body low = min(O,C) = 1005; POC bucket [1000, 1005) lies fully in the wick -> P1 true
    rows = [(0, 1005.0, 1.0, False), (1, 1002.0, 20.0, True), (2, 1008.0, 1.0, False)]
    assert det(candle_with_poc(rows))["L_P1"]
    # body low 1004.9: bucket [1000,1005) contains body prices -> not entirely in wick -> P1 false
    rows = [(0, 1004.9, 1.0, False), (1, 1002.0, 20.0, True), (2, 1008.0, 1.0, False)]
    assert not det(candle_with_poc(rows))["L_P1"]


def test_p2_delta_poc_must_lie_in_the_wick():
    # body low = min(O,C) = 1010; strongest selling at 995 (in the wick) -> P2 true
    rows = [(0, 1010.0, 1.0, False), (1, 1001.0, 10.0, False), (2, 1002.0, 9.0, True), (3, 996.0, 5.0, True), (4, 1012.0, 1.0, False)]
    r = det(candle_with_poc(rows))
    assert r["vpoc_5"] == 1000 and r["dpoc_neg_5"] == 995 and r["L_P2"]
    # strongest selling ABOVE the volume POC but still entirely in the wick ([1005, 1010) < 1010) -> P2 true
    rows = [(0, 1010.0, 1.0, False), (1, 1001.0, 30.0, False), (2, 1006.0, 9.0, True), (3, 1012.0, 1.0, False)]
    r = det(candle_with_poc(rows))
    assert r["vpoc_5"] == 1000 and r["dpoc_neg_5"] == 1005 and r["L_P2"]
    # strongest selling inside the body (body low 1004) -> P2 false, regardless of a big positive delta elsewhere
    rows = [(0, 1004.0, 1.0, False), (1, 1001.0, 30.0, False), (2, 1006.0, 9.0, True), (3, 1012.0, 40.0, False)]
    r = det(candle_with_poc(rows))
    assert r["dpoc_neg_5"] == 1005 and not r["L_P2"]


def test_short_mirror_p1_p2():
    rows = [(0, 1000.0, 1.0, True), (1, 1008.0, 9.0, True), (2, 1009.0, 10.0, False), (3, 1013.0, 5.0, False), (4, 998.0, 1.0, True)]
    r = det(candle_with_poc(rows))
    assert r["vpoc_5"] == 1005 and r["S_P1"]
    assert r["dpoc_pos_5"] == 1010 and r["S_P2"]


def test_k_of_n_and_enabled_conditions():
    rows = [(0, 100.0, 1.0, False), (1, 96.0, 30.0, True), (2, 95.0, 10.0, True), (3, 97.0, 5.0, False), (4, 101.0, 2.0, False)]
    c = candle_with_poc(rows).with_columns(z=pl.lit(0.0))  # V1 fails
    df = lambda **kw: detect(c, 2.0, 0.5, 0.5, poc_bin=5, **kw).row(0, named=True)
    assert not df()["long_signal"]                                   # all 4 required, V1 fails
    assert df(min_true=3)["long_signal"]                             # 3 of 4 is enough
    assert df(conditions=["V2", "D1", "D2"])["long_signal"]          # V1 not enabled
    assert not df(conditions=[])["long_signal"]                      # nothing enabled -> no signal
    assert df(conditions=["V1", "V2"], min_true=1)["long_signal"]
