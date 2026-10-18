"""Live mode: incremental candles must equal the batch build of the same trades; the feed backfills
gaps over REST and merges into the API."""
import asyncio
import datetime as dt
import json
import random
import shutil

import polars as pl
import pytest
from fastapi.testclient import TestClient
from polars.testing import assert_frame_equal

from fp.build import build, build_day, finalize, build_volume_agg, volume_aggs
from fp.config import load_config
from fp.convert import parquet_path
from fp.live import LiveBuilder, LiveFeed, day_start, find_anchor, live_dir
from fp.sample import sample_marker, write_sample
from fp.server import create_app

D1, D2, D3 = dt.date(2026, 10, 1), dt.date(2026, 10, 2), dt.date(2026, 10, 3)
FINALIZE_ONLY = {"z", "vspeed", "rel_tod", "d_oi", "d_oi_usd", "oi_end", "oi_vol_ratio", "vol_z", "z_n"}


def _cfg(root):
    cfg = load_config()
    cfg["paths"] = {"raw": root / "raw", "parquet": root / "parquet", "derived": root / "derived"}
    return cfg


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    """ref: 3 sample days built in batch; part: the same data with only days 1-2 built (day 3 is 'live')."""
    ref = _cfg(tmp_path_factory.mktemp("ref"))
    write_sample(ref, D1, D3)
    build(ref, D1, D3)
    part = _cfg(tmp_path_factory.mktemp("part"))
    write_sample(part, D1, D2)
    build(part, D1, D2)
    sample_marker(part).unlink()   # behave like real data (live is off on sample data)
    day3 = pl.read_parquet(parquet_path(ref, "aggTrades", D3))
    return ref, part, day3


def _feed_in_chunks(b: LiveBuilder, trades: pl.DataFrame, seed: int = 1) -> None:
    rnd, i = random.Random(seed), 0
    while i < trades.height:
        k = rnd.choice((1, 7, 300, 2500, 9000))
        b.add(trades.slice(i, k))
        i += k
        if rnd.random() < 0.7:
            b.refresh()
    b.refresh()


def _cmp(live: pl.DataFrame, ref: pl.DataFrame, key: str) -> None:
    missing = set(ref.columns) - set(live.columns) - FINALIZE_ONLY
    assert not missing, missing
    cols = sorted(c for c in ref.columns if c in live.columns and c not in FINALIZE_ONLY)
    assert_frame_equal(live.select(cols).sort(key), ref.select(cols).sort(key), check_dtypes=False, rel_tol=1e-9, abs_tol=1e-6)


def test_anchor_continues_after_last_built_day(built):
    _, part, day3 = built
    a = find_anchor(part)
    assert a.base_day == D2 and a.start_ts == day_start(D3)
    assert a.next_id == int(day3["id"][0])
    assert {"1m", "5m", "15m", "vusd_100000000", "vbtc_1000", "vtick_5000"} <= set(a.aggs)


def test_live_candles_equal_batch_build(built):
    ref, part, day3 = built
    b = LiveBuilder(part, find_anchor(part))
    _feed_in_chunks(b, day3)
    D = ref["paths"]["derived"]
    for tf in ("1m", "5m", "15m"):
        rc = pl.read_parquet(D / "candles" / tf / f"{D3}.parquet")
        _cmp(b.series[tf], rc, "start_ts")
        rs = pl.read_parquet(D / "series" / tf / f"{D3}.parquet")
        assert b.series[tf]["cvd_usd"].to_list() == pytest.approx(rs["cvd_usd"].to_list(), rel=1e-9, abs=1e-3)
        rf = pl.read_parquet(D / "footprint" / tf / f"{D3}.parquet")
        _cmp(b.fp[tf], rf, ["start_ts", "level"][0])
        assert b.fp[tf].height == rf.height
    for agg in volume_aggs(ref):
        rc = pl.read_parquet(D / "candles" / agg / f"{D3}.parquet")   # candles that close on day 3
        closed = b.series[agg].filter(pl.col("cid") < b.states[agg].next_id)
        _cmp(closed, rc, "cid")
        rs = pl.read_parquet(D / "series" / agg / f"{D3}.parquet").filter(pl.col("cid").is_in(closed["cid"].implode()))
        lc = closed.filter(pl.col("cid").is_in(rs["cid"].implode())).sort("cid")
        assert lc["cvd_usd"].to_list() == pytest.approx(rs.sort("cid")["cvd_usd"].to_list(), rel=1e-9, abs=1e-3)
        rf = pl.read_parquet(D / "footprint" / agg / f"{D3}.parquet")
        lf = b.fp[agg].filter(pl.col("cid") < b.states[agg].next_id)
        assert_frame_equal(lf.select(sorted(rf.columns)).sort("cid", "level"), rf.select(sorted(rf.columns)).sort("cid", "level"),
                           check_dtypes=False, rel_tol=1e-9, abs_tol=1e-6)


def test_gap_is_rejected(built):
    _, part, day3 = built
    b = LiveBuilder(part, find_anchor(part))
    b.add(day3.slice(0, 10))
    with pytest.raises(ValueError, match="gap"):
        b.add(day3.slice(20, 10))
    b.add(day3.slice(5, 20))   # overlap: already seen ids are dropped
    assert b.next_id == int(day3["id"][24]) + 1


def _rest_rows(df: pl.DataFrame) -> list[dict]:
    return [{"a": r["id"], "p": f"{r['price']:.1f}", "q": f"{r['qty']:.3f}", "f": r["first_id"], "l": r["last_id"],
             "T": r["ts"], "m": r["ibm"]} for r in df.iter_rows(named=True)]


class FakeWs:
    def __init__(self, msgs):
        self.q: asyncio.Queue = asyncio.Queue()
        for m in msgs:
            self.q.put_nowait(m)

    def __aiter__(self):
        return self

    async def __anext__(self):
        return await self.q.get()

    async def close(self):
        pass


def test_feed_backfills_over_rest_then_follows_websocket(built, tmp_path):
    ref, part0, day3 = built
    part = _cfg(tmp_path)
    shutil.copytree(part0["paths"]["parquet"], part["paths"]["parquet"])
    shutil.copytree(part0["paths"]["derived"], part["paths"]["derived"])
    head = day3.filter(pl.col("ts") < day_start(D3) + 6 * 3_600_000)   # 6 hours
    split = head.height // 2
    rows = _rest_rows(head)
    calls = []

    def rest_get(path, params):
        calls.append(params)
        i = next(k for k, r in enumerate(rows) if r["a"] >= params["fromId"])
        return rows[i:i + params["limit"]]

    ws = FakeWs([json.dumps({"e": "aggTrade", **r}) for r in rows[split:]])

    async def connect():
        return ws

    feed = LiveFeed(part, ws_connect=connect, rest_get=rest_get)
    feed.lcfg.update(refresh_s=0.01, rest_interval_s=0.0, persist_s=0.0)

    async def go():
        task = asyncio.create_task(feed.run())
        for _ in range(3000):
            await asyncio.sleep(0.01)
            b = feed.snapshot
            if b and b.next_id == int(head["id"][-1]) + 1 and feed.status["state"] == "live":
                break
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(go())
    b = feed.snapshot
    assert b.next_id == int(head["id"][-1]) + 1 and calls and calls[0]["fromId"] == int(head["id"][0])
    ref5 = pl.read_parquet(ref["paths"]["derived"] / "candles" / "5m" / f"{D3}.parquet").filter(pl.col("start_ts") < int(b.series["5m"]["start_ts"].max()))
    _cmp(b.series["5m"].filter(pl.col("start_ts") < int(b.series["5m"]["start_ts"].max())), ref5, "start_ts")
    assert any(live_dir(part).glob("*.parquet"))   # persisted for a restart

    # restart: the persisted trades are reloaded, nothing to fetch again
    feed2 = LiveFeed(part, rest_get=lambda *a: pytest.fail("no REST expected"))
    feed2._reset()
    assert feed2.snapshot.next_id == b.next_id

    # the daily update builds day 3: live re-anchors on it and drops the persisted trades it covers
    shutil.copy(parquet_path(ref, "aggTrades", D3), parquet_path(part, "aggTrades", D3))
    shutil.copy(parquet_path(ref, "metrics", D3), parquet_path(part, "metrics", D3))
    build_day(part, D3)
    for tf in ("1m", "5m", "15m"):
        finalize(part, tf)
    for agg in volume_aggs(part):
        build_volume_agg(part, agg)
    assert feed2._anchor_changed()
    feed2._reset()
    assert feed2.snapshot.anchor.base_day == D3 and feed2.snapshot.series == {}
    assert not any(live_dir(part).glob("*.parquet"))


def test_api_merges_live_candles(built):
    ref, part, day3 = built
    feed = LiveFeed(part)
    feed.builder = LiveBuilder(part, find_anchor(part))
    _feed_in_chunks(feed.builder, day3.filter(pl.col("ts") < day_start(D3) + 3_600_000))
    feed._publish()
    feed.status["state"] = "live"
    c = TestClient(create_app(part, live=feed))
    meta = c.get("/api/meta").json()
    assert meta["aggregations"]["5m"]["last_day"] == "2026-10-03" and meta["live"]["state"] == "live"
    js = c.get("/api/candles", params={"agg": "5m", "start": day_start(D3), "end": day_start(D3) + 86_400_000}).json()
    assert js["n"] == 12 and js["cols"]["start_ts"][0] == day_start(D3)
    js = c.get("/api/candles", params={"agg": "5m", "start": day_start(D2), "end": day_start(D3) + 86_400_000}).json()
    assert js["n"] == 288 + 12 and sorted(js["cols"]["cid"]) == js["cols"]["cid"]
    fp = c.get("/api/footprint", params={"agg": "5m", "start": day_start(D3), "end": day_start(D3) + 86_400_000}).json()
    assert fp["n"] == feed.snapshot.fp["5m"].height
    one = c.get("/api/candle", params={"agg": "15m", "cid": day_start(D3), "start_ts": day_start(D3)}).json()
    assert one["n"] == 1 and "lw_share" in one["cols"]
    vol = c.get("/api/candles", params={"agg": "vtick_5000", "start": day_start(D2), "end": day_start(D3) + 86_400_000}).json()
    assert len(set(vol["cols"]["cid"])) == vol["n"]
    assert c.get("/api/profile", params={"start": day_start(D3), "end": day_start(D3) + 3_600_000}).json()["volume_usd"] > 0
    with c.websocket_connect("/api/live?agg=5m") as ws:
        msg = ws.receive_json()
    assert msg["status"]["state"] == "live" and msg["candles"]["n"] == 5
    assert set(msg["fp"]["cols"]["cid"]) <= set(msg["candles"]["cols"]["cid"])


def test_websocket_requires_auth(built):
    _, part, _ = built
    c = TestClient(create_app(part, auth=("u", "p"), live=LiveFeed(part)))
    from starlette.websockets import WebSocketDisconnect
    with pytest.raises(WebSocketDisconnect):
        with c.websocket_connect("/api/live?agg=5m") as ws:
            ws.receive_json()
    import base64
    h = {"authorization": "Basic " + base64.b64encode(b"u:p").decode()}
    with c.websocket_connect("/api/live?agg=5m", headers=h) as ws:
        assert "status" in ws.receive_json()
