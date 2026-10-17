"""Web deployment additions: auth, health, range profile + value area, rolling window, sample data."""
import datetime as dt

import polars as pl
import pytest
from fastapi.testclient import TestClient

from fp.periods import range_profile
from fp.sample import sample_marker, write_sample
from fp.server import create_app
from fp.update import clear_sample, prune, window
from tests.test_server import D0, DAY, make_cfg


def test_basic_auth_protects_everything_but_health(tmp_path):
    c = TestClient(create_app(make_cfg(tmp_path), auth=("kuba", "s3cret")))
    assert c.get("/api/health").json()["status"] == "ok"
    r = c.get("/api/meta")
    assert r.status_code == 401 and r.headers["www-authenticate"].startswith("Basic")
    assert c.get("/api/meta", auth=("kuba", "wrong")).status_code == 401
    assert c.get("/api/meta", auth=("kuba", "s3cret")).status_code == 200


def test_missing_candle_is_404_not_500(tmp_path):
    c = TestClient(create_app(make_cfg(tmp_path)))
    r = c.get("/api/candle", params={"agg": "5m", "cid": 5, "start_ts": 5})
    assert r.status_code == 404


def test_range_profile_api(tmp_path):
    c = TestClient(create_app(make_cfg(tmp_path)))
    js = c.get("/api/profile", params={"start": D0, "end": D0 + 600_000, "bin": 5}).json()
    assert js["levels"]["cols"]["level"] == [100, 105]
    assert js["levels"]["cols"]["buy_usd"] == [400.0, 210.0]   # 100.4 + 300 rounded, 210
    assert js["poc"] == 100 and js["val"] == 100 and js["vah"] == 105   # POC alone holds 72 %
    assert c.get("/api/profile", params={"start": D0, "end": D0 + 600 * DAY}).status_code == 413


def test_value_area_grows_towards_larger_neighbour():
    fp = pl.DataFrame({"level": [100, 105, 110, 115, 120], "buy_usd": [5.0, 10.0, 50.0, 20.0, 15.0],
                       "sell_usd": [0.0, 0.0, 0.0, 0.0, 0.0]})
    lv, s = range_profile(fp, 5)
    # total 100, POC 110 (50) -> + larger neighbour 115 (20) = 70 >= 70
    assert s["poc"] == 110 and s["val"] == 110 and s["vah"] == 120
    assert s["volume_usd"] == 100.0 and lv.height == 5
    _, s2 = range_profile(fp, 10)   # re-binned: 100:15, 110:70, 120:15
    assert s2["poc"] == 110 and (s2["val"], s2["vah"]) == (110, 120)
    assert range_profile(pl.DataFrame(), 5)[1]["poc"] is None


def test_window_ends_yesterday():
    cfg = {"download": {"retention_days": 30}}
    assert window(cfg, today=dt.date(2026, 10, 17)) == (dt.date(2026, 9, 17), dt.date(2026, 10, 16))
    assert window(cfg, 3, today=dt.date(2026, 10, 17)) == (dt.date(2026, 10, 14), dt.date(2026, 10, 16))


def _cfg(tmp_path):
    return {"symbol": "BTCUSDT", "paths": {k: tmp_path / k for k in ("raw", "parquet", "derived")}}


def test_prune_drops_only_older_days(tmp_path):
    cfg = _cfg(tmp_path)
    files = [cfg["paths"]["parquet"] / "aggTrades/BTCUSDT/2026-09-01.parquet",
             cfg["paths"]["derived"] / "series/5m/2026-09-02.parquet",
             cfg["paths"]["raw"] / "data/futures/um/daily/aggTrades/BTCUSDT/BTCUSDT-aggTrades-2026-09-01.zip.CHECKSUM",
             cfg["paths"]["derived"] / "series/5m/2026-09-03.parquet",
             cfg["paths"]["derived"] / "vstate/vusd_1/2026-09-03.json"]
    for f in files:
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text("x")
    assert prune(cfg, dt.date(2026, 9, 3)) == 3
    assert [f.exists() for f in files] == [False, False, False, True, True]


def test_sample_is_marked_and_cleared_before_real_data(tmp_path):
    cfg = _cfg(tmp_path)
    write_sample(cfg, dt.date(2026, 10, 1), dt.date(2026, 10, 1), n=500)
    t = pl.read_parquet(cfg["paths"]["parquet"] / "aggTrades/BTCUSDT/2026-10-01.parquet")
    assert t.height == 500 and t["id"].is_sorted() and t["ts"].is_sorted()
    assert (t["price"] * 10).round(6).cast(pl.Int64).cast(pl.Float64).equals((t["price"] * 10).round(6))   # 0.1 tick
    assert sample_marker(cfg).exists()
    assert clear_sample(cfg) and not cfg["paths"]["parquet"].exists() and not sample_marker(cfg).exists()


def test_sample_refuses_to_mix_with_real_data(tmp_path):
    cfg = _cfg(tmp_path)
    real = cfg["paths"]["parquet"] / "aggTrades/BTCUSDT/2026-10-01.parquet"
    real.parent.mkdir(parents=True)
    pl.DataFrame({"id": [1]}).write_parquet(real)
    with pytest.raises(RuntimeError):
        write_sample(cfg, dt.date(2026, 10, 2), dt.date(2026, 10, 2), n=10)
