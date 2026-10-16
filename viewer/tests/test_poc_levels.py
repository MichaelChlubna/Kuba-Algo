from fp.build import time_candles_with_features, time_footprint
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
