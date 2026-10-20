import datetime as dt

import polars as pl
from fastapi.testclient import TestClient

from fp.server import create_app

DAY = 86_400_000
D0 = 1_791_331_200_000  # 2026-10-07 00:00 UTC


def make_cfg(tmp_path):
    derived = tmp_path / "derived"
    for i, day in enumerate([dt.date(2026, 10, 7), dt.date(2026, 10, 8)]):
        ts = [D0 + i * DAY + k * 300_000 for k in range(288)]
        series = pl.DataFrame({"start_ts": ts, "end_ts": [t + 300_000 for t in ts], "open": 1.0, "high": 2.0,
                               "low": 0.5, "close": 1.5, "volume_usd": 10.0, "z": float("nan")})
        p = derived / "series" / "5m" / f"{day}.parquet"
        p.parent.mkdir(parents=True, exist_ok=True)
        series.write_parquet(p)
        fp = pl.DataFrame({"start_ts": [ts[0], ts[0], ts[1]], "level": [100, 105, 100], "buy": [1.0, 2.0, 3.0],
                           "sell": [0.5, 0.0, 1.0], "buy_usd": [100.4, 210.0, 300.0], "sell_usd": [50.0, 0.0, 100.0]})
        p = derived / "footprint" / "5m" / f"{day}.parquet"
        p.parent.mkdir(parents=True, exist_ok=True)
        fp.write_parquet(p)
    return {"paths": {"derived": derived}, "server": {"timezone": "America/New_York"},
            "aggregation": {"base_bin": 5}}


def test_meta_candles_pad_and_footprint(tmp_path):
    c = TestClient(create_app(make_cfg(tmp_path)))
    meta = c.get("/api/meta").json()
    assert meta["aggregations"]["5m"] == {"first_day": "2026-10-07", "last_day": "2026-10-08", "candles": 576, "per_day": 288.0}
    assert meta["timezone"] == "America/New_York"

    r = c.get("/api/candles", params={"agg": "5m", "start": D0 + DAY, "end": D0 + DAY + 3_600_000, "pad": 30, "full": 1}).json()
    ts = r["cols"]["start_ts"]
    assert r["n"] == 12 + 30 and ts[0] == D0 + DAY - 30 * 300_000 and ts[-1] == D0 + DAY + 11 * 300_000
    assert r["cols"]["z"][0] is None  # NaN -> null in JSON

    f = c.get("/api/footprint", params={"agg": "5m", "start": D0, "end": D0 + 300_000}).json()
    assert f["n"] == 2 and f["cols"]["level"] == [100, 105] and f["cols"]["buy_usd"] == [100.0, 210.0]

    assert c.get("/api/candles", params={"agg": "1m", "start": D0, "end": D0 + DAY}).status_code == 404
    assert c.get("/").status_code == 200


def test_light_full_and_detail(tmp_path):
    c = TestClient(create_app(make_cfg(tmp_path)))
    light = c.get("/api/candles", params={"agg": "5m", "start": D0, "end": D0 + 2 * DAY}).json()
    full = c.get("/api/candles", params={"agg": "5m", "start": D0, "end": D0 + DAY, "full": 1}).json()
    assert light["n"] == 576 and "volume_usd" in light["cols"]
    assert set(light["cols"]) <= set(full["cols"]) | {"cid"}
    one = c.get("/api/candle", params={"agg": "5m", "cid": D0 + 300_000, "start_ts": D0 + 300_000}).json()
    assert one["n"] == 1 and one["cols"]["start_ts"] == [D0 + 300_000]


def test_site_at_root_and_app_under_prefix(tmp_path, monkeypatch):
    import fp.server
    site, static = tmp_path / "site", tmp_path / "dist"
    (site / "manual").mkdir(parents=True)
    (site / "index.html").write_text("product")
    (site / "manual" / "index.html").write_text("manual")
    (static / "assets").mkdir(parents=True)
    (static / "index.html").write_text("spa")
    (static / "assets" / "a.js").write_text("js")
    (tmp_path / "secret.txt").write_text("no")
    monkeypatch.setattr(fp.server, "SITE", site)
    monkeypatch.setattr(fp.server, "STATIC", static)
    c = TestClient(create_app(make_cfg(tmp_path)))

    assert c.get("/").text == "product"
    assert c.get("/manual/").text == "manual"
    r = c.get("/manual", follow_redirects=False)
    assert r.status_code in (301, 302, 307) and r.headers["location"] == "/manual/"
    assert c.get("/app").text == "spa"
    assert c.get("/app/").text == "spa"
    assert c.get("/app/some/route").text == "spa"
    assert c.get("/app/assets/a.js").text == "js"
    assert c.get("/missing.html").status_code == 404
    assert c.get("/..%2Fsecret.txt").status_code == 404
    assert c.get("/api/meta").status_code == 200
