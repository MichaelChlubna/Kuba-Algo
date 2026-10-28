"""Live data: Binance USDⓈ-M aggTrade WebSocket + REST backfill -> candles and footprint of the days
that are not built from the daily dumps yet.

The daily pipeline builds every day up to yesterday from data.binance.vision. Live mode continues
from the last aggTrade id of the last built day: gaps (start-up, reconnects) are filled from the public
REST endpoint, new trades come from the WebSocket. No API key is needed.

LiveBuilder computes candles with the same functions as the batch build (build_day, build_volume_agg),
incrementally: closed candles are cached, only open candles are recomputed. Volume and tick candles
continue from the stored state of the last built day, so they get the same ids as the later batch build.
Range features that need history (z-scores, time-of-day volume) are left empty for live candles.
Open interest comes from the public REST endpoint openInterestHist (the same 5-min snapshots as the
daily metrics dumps), so live candles get ΔOI and the OI line like the built days.

When the daily update builds a new day, the live state re-anchors on it and drops the trades it covers.
"""
from __future__ import annotations

import asyncio
import datetime as dt
import json
import logging
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

import polars as pl

from .build import available_days, derived_path, load_oi, load_trades, time_candles_with_features, time_footprint
from .candles import TIMEFRAMES_MS, add_cvd, local_time
from .convert import parquet_path
from .features import add_oi_delta, static_features, wick_components
from .footprint import footprint, poc_features
from .metrics import add_candle_metrics, add_oi_vol_ratio
from .volume_bars import State, aggregate_volume_candles, is_volume_agg, parse_agg, split_pieces, threshold_units

log = logging.getLogger(__name__)

DAY_MS = 86_400_000
BASE_AGG = "5m"   # the last day built for this aggregation is the live anchor
OI_SCHEMA = {"oi_time": pl.Int64, "oi_btc": pl.Float64, "oi_usd": pl.Float64}
OI_COLS = ["d_oi", "d_oi_usd", "oi_end", "oi_end_usd", "oi_vol_ratio"]
TRADE_SCHEMA = {"id": pl.Int64, "price": pl.Float64, "qty": pl.Float64, "first_id": pl.Int64,
                "last_id": pl.Int64, "ts": pl.Int64, "ibm": pl.Boolean, "rep": pl.Boolean}
DEFAULTS = {
    "ws_urls": ["wss://fstream.binance.com/market/ws", "wss://fstream.binance.com/ws"],
    "rest_url": "https://fapi.binance.com",
    "rest_interval_s": 0.6,     # aggTrades has weight 20; 0.6 s = 2000 of the 2400 weight / minute
    "refresh_s": 1.0,
    "persist_s": 60.0,
    "oi_interval_s": 60.0,      # openInterestHist poll (new 5-min snapshot appears a few minutes after it)
}


def live_config(cfg: dict) -> dict:
    return {**DEFAULTS, **(cfg.get("live") or {})}


def live_dir(cfg: dict) -> Path:
    return Path(cfg["paths"]["parquet"]).parent / "live" / "aggTrades" / cfg["symbol"]


def day_start(day: dt.date) -> int:
    return int(dt.datetime(day.year, day.month, day.day, tzinfo=dt.timezone.utc).timestamp() * 1000)


def trades_frame(rows: list[dict]) -> pl.DataFrame:
    """Binance aggTrade dicts (WebSocket event or REST row: a, p, q, f, l, T, m) -> aggTrades frame."""
    return pl.DataFrame(
        {"id": [r["a"] for r in rows], "price": [float(r["p"]) for r in rows], "qty": [float(r["q"]) for r in rows],
         "first_id": [r["f"] for r in rows], "last_id": [r["l"] for r in rows], "ts": [r["T"] for r in rows],
         "ibm": [bool(r["m"]) for r in rows], "rep": [False] * len(rows)},
        schema=TRADE_SCHEMA)


def _empty_trades() -> pl.DataFrame:
    return pl.DataFrame(schema=TRADE_SCHEMA)


def oi_frame(rows: list[dict]) -> pl.DataFrame:
    """openInterestHist rows (timestamp, sumOpenInterest, sumOpenInterestValue) -> OI snapshots.

    The REST timestamp is already the moment the OI describes: timestamp T equals the metrics row with
    create_time T - 5 min (docs/pipeline.md), i.e. oi_time = timestamp.
    """
    return pl.DataFrame(
        {"oi_time": [int(r["timestamp"]) for r in rows], "oi_btc": [float(r["sumOpenInterest"]) for r in rows],
         "oi_usd": [float(r["sumOpenInterestValue"]) for r in rows]},
        schema=OI_SCHEMA)


@dataclass
class Anchor:
    """Where live data continue: the last built day and what the batch build left behind for it."""
    base_day: dt.date | None
    next_id: int | None                      # first aggTrade id after base_day (None: start by time)
    start_ts: int                            # live trades start here (00:00 UTC after base_day)
    aggs: list[str]
    states: dict[str, State] = field(default_factory=dict)
    last: dict[str, dict] = field(default_factory=dict)   # agg -> last built candle (cvd continuation)


def _base_day(cfg: dict) -> dt.date | None:
    days = available_days(cfg, "series", BASE_AGG)
    return days[-1] if days else None


def _live_aggs(cfg: dict, base: dt.date | None) -> list[str]:
    """Built aggregations live data can continue exactly: time candles, and volume / tick candles whose
    state after the base day is stored."""
    root = cfg["paths"]["derived"] / "series"
    out = []
    for agg in sorted(p.name for p in root.iterdir() if p.is_dir()) if root.exists() else []:
        if is_volume_agg(agg):
            if base is None or (cfg["paths"]["derived"] / "vstate" / agg / f"{base}.json").exists():
                out.append(agg)
        elif agg in TIMEFRAMES_MS:
            out.append(agg)
    return out


def anchor_key(cfg: dict) -> tuple:
    """Changes when the daily build adds a day (or a volume aggregation): live data must re-anchor."""
    base = _base_day(cfg)
    return base, tuple(_live_aggs(cfg, base))


def find_anchor(cfg: dict, today: dt.date | None = None) -> Anchor:
    base = _base_day(cfg)
    start_day = base + dt.timedelta(days=1) if base else (today or dt.datetime.now(dt.timezone.utc).date())
    next_id = None
    if base:
        p = parquet_path(cfg, "aggTrades", base)
        if p.exists():
            next_id = int(pl.scan_parquet(p).select(pl.col("id").max()).collect().item()) + 1
    aggs, states, last = _live_aggs(cfg, base), {}, {}
    for agg in aggs:
        if is_volume_agg(agg):
            sdir = cfg["paths"]["derived"] / "vstate" / agg
            if base is None:
                states[agg] = State()
            else:
                sp = sdir / f"{base}.parquet"
                states[agg] = State.from_json((sdir / f"{base}.json").read_text(), pl.read_parquet(sp) if sp.exists() else None)
        if base:
            for d in (base, base - dt.timedelta(days=1)):
                p = derived_path(cfg, "series", agg, d)
                if p.exists():
                    s = pl.read_parquet(p, columns=["cid", "start_ts", "cvd", "cvd_usd"] if is_volume_agg(agg)
                                        else ["start_ts", "cvd", "cvd_usd"])
                    if s.height:
                        last[agg] = s.sort("start_ts").row(-1, named=True)
                        break
    return Anchor(base, next_id, day_start(start_day), aggs, states, last)


class LiveBuilder:
    """Incremental candles + footprint from a growing, id-contiguous stream of aggTrades."""

    def __init__(self, cfg: dict, anchor: Anchor):
        self.cfg, self.anchor = cfg, anchor
        self.base_bin = cfg["aggregation"]["base_bin"]
        self.mcfg = cfg.get("metrics")
        acfg = cfg["aggregation"]
        self.cvd_reset, self.cvd_tz = acfg.get("cvd_reset", "daily"), acfg.get("cvd_reset_timezone", "UTC")
        self.trades = _empty_trades()
        self.pending: list[pl.DataFrame] = []    # added since the last refresh (volume candles consume these)
        self.next_id: int | None = anchor.next_id
        self.closed_c: dict[str, list[pl.DataFrame]] = {a: [] for a in anchor.aggs}
        self.closed_fp: dict[str, list[pl.DataFrame]] = {a: [] for a in anchor.aggs}
        self.open_start = {a: anchor.start_ts for a in anchor.aggs if not is_volume_agg(a)}
        self.states = {a: anchor.states[a] for a in anchor.aggs if is_volume_agg(a)}
        self.series: dict[str, pl.DataFrame] = {}
        self.fp: dict[str, pl.DataFrame] = {}
        # OI snapshots: the built ones up to the live start (ΔOI of the first live candle needs the last
        # snapshot before it), live ones are added by set_oi
        self.oi_built = load_oi(cfg).select(OI_SCHEMA.keys()).filter(pl.col("oi_time") <= anchor.start_ts).tail(1)
        self.oi = self.oi_built

    def set_oi(self, live_oi: pl.DataFrame) -> None:
        """Replace the live OI snapshots and recompute ΔOI / the OI line of all live candles."""
        self.oi = pl.concat([self.oi_built, live_oi.select(OI_SCHEMA.keys())]).unique("oi_time", keep="last").sort("oi_time")
        self.series = {a: self._with_oi(c) for a, c in self.series.items()}

    def _with_oi(self, c: pl.DataFrame) -> pl.DataFrame:
        c = c.drop([k for k in OI_COLS if k in c.columns])
        if not self.oi.height or not c.height:
            return c
        return add_oi_vol_ratio(add_oi_delta(c, self.oi))

    @property
    def last_ts(self) -> int | None:
        return int(self.trades["ts"][-1]) if self.trades.height else None

    def add(self, trades: pl.DataFrame) -> None:
        """Append trades sorted by id; ids already seen and trades before the live start are dropped."""
        t = trades.filter(pl.col("ts") >= self.anchor.start_ts)
        if self.next_id is not None:
            t = t.filter(pl.col("id") >= self.next_id)
        if not t.height:
            if trades.height and self.next_id is None:
                self.next_id = int(trades["id"].max()) + 1
            elif trades.height:
                self.next_id = max(self.next_id, int(trades["id"].max()) + 1)
            return
        if self.next_id is not None and int(t["id"][0]) != self.next_id:
            raise ValueError(f"gap in aggTrades: expected id {self.next_id}, got {int(t['id'][0])}")
        if t["id"].diff().drop_nulls().ne(1).any():
            raise ValueError("aggTrades batch is not contiguous")
        self.next_id = int(t["id"][-1]) + 1
        self.pending.append(t)

    def refresh(self) -> bool:
        """Recompute open candles from the trades added since the last refresh. Returns True if changed."""
        if not self.pending:
            return False
        new = pl.concat(self.pending)
        self.pending = []
        self.trades = pl.concat([self.trades, new], rechunk=False)
        if self.trades.n_chunks() > 64:
            self.trades = self.trades.rechunk()
        for agg in self.anchor.aggs:
            if is_volume_agg(agg):
                self._volume(agg, new)
            else:
                self._time(agg)
        return True

    # ---------------------------------------------------------------- per aggregation
    def _time(self, agg: str) -> None:
        period = TIMEFRAMES_MS[agg]
        start = self.open_start[agg]
        i = self.trades["ts"].search_sorted(start, side="left")
        sub = self.trades.slice(i)
        fp = time_footprint(sub, period, self.base_bin)
        c = time_candles_with_features(sub, period)
        c = c.join(poc_features(fp, "start_ts", self.base_bin), on="start_ts", how="left")
        keyed = sub.with_columns(start_ts=(pl.col("ts") // period) * period)
        c = add_candle_metrics(c, keyed, fp, "start_ts", self.base_bin, self.mcfg).with_columns(cid=pl.col("start_ts"))
        open_start = int(c["start_ts"][-1])
        done = c.filter(pl.col("start_ts") < open_start)
        if done.height:
            self.closed_c[agg].append(done)
            self.closed_fp[agg].append(fp.filter(pl.col("start_ts") < open_start).with_columns(cid=pl.col("start_ts")))
        self.open_start[agg] = open_start
        self._publish(agg, c.filter(pl.col("start_ts") >= open_start),
                      fp.filter(pl.col("start_ts") >= open_start).with_columns(cid=pl.col("start_ts")))

    def _volume_candles(self, pieces: pl.DataFrame) -> tuple[pl.DataFrame, pl.DataFrame]:
        c = aggregate_volume_candles(pieces)
        c = static_features(wick_components(pieces, c, "cid"))
        fp = footprint(pieces, "cid", self.base_bin)
        c = c.join(poc_features(fp, "cid", self.base_bin), on="cid", how="left")
        c = add_candle_metrics(c, pieces, fp, "cid", self.base_bin, self.mcfg)
        return c, fp.join(c.select("cid", "start_ts"), on="cid", how="left")

    def _volume(self, agg: str, new: pl.DataFrame) -> None:
        unit, value = parse_agg(agg)
        pieces, state = split_pieces(new, unit, threshold_units(unit, value), self.states[agg])
        self.states[agg] = state
        complete = pieces.filter(pl.col("cid") < state.next_id)
        if complete.height:
            c, fp = self._volume_candles(complete)
            self.closed_c[agg].append(c)
            self.closed_fp[agg].append(fp)
        if state.carry is not None and state.carry.height:
            oc, ofp = self._volume_candles(state.carry)
        else:
            oc = ofp = None
        self._publish(agg, oc, ofp)

    def _publish(self, agg: str, open_c: pl.DataFrame | None, open_fp: pl.DataFrame | None) -> None:
        cs = self.closed_c[agg] + ([open_c] if open_c is not None and open_c.height else [])
        fs = self.closed_fp[agg] + ([open_fp] if open_fp is not None and open_fp.height else [])
        if len(self.closed_c[agg]) > 32:   # keep the closed lists short
            self.closed_c[agg] = [pl.concat(self.closed_c[agg], how="diagonal_relaxed")]
            self.closed_fp[agg] = [pl.concat(self.closed_fp[agg], how="diagonal_relaxed")]
        if not cs:
            return
        c = pl.concat(cs, how="diagonal_relaxed").sort("cid")
        self.series[agg] = self._with_oi(self._cvd(agg, c))
        self.fp[agg] = pl.concat(fs, how="diagonal_relaxed").sort("cid", "level") if fs else pl.DataFrame()

    def _cvd(self, agg: str, c: pl.DataFrame) -> pl.DataFrame:
        """CVD like finalize(), continuing the last built candle when it belongs to the same CVD day."""
        c = add_cvd(c, self.cvd_reset, self.cvd_tz)
        last = self.anchor.last.get(agg)
        if not last:
            return c
        if self.cvd_reset == "none":
            same = pl.lit(True)
        else:
            last_day = pl.DataFrame({"start_ts": [last["start_ts"]]}).select(local_time("start_ts", self.cvd_tz).dt.date()).item()
            same = local_time("start_ts", self.cvd_tz).dt.date() == pl.lit(last_day)
        return c.with_columns(
            cvd=pl.when(same).then(pl.col("cvd") + (last["cvd"] or 0.0)).otherwise(pl.col("cvd")),
            cvd_usd=pl.when(same).then(pl.col("cvd_usd") + (last["cvd_usd"] or 0.0)).otherwise(pl.col("cvd_usd")),
        )


# ---------------------------------------------------------------- feed (network side)

class LiveFeed:
    """Keeps a LiveBuilder fed from Binance; the server reads `snapshot` (thread-safe, swapped atomically)."""

    def __init__(self, cfg: dict, ws_connect=None, rest_get=None):
        self.cfg, self.lcfg = cfg, live_config(cfg)
        self.symbol = cfg["symbol"]
        self._ws_connect = ws_connect          # injectable for tests
        self._rest_get = rest_get or self._requests_get
        self.builder: LiveBuilder | None = None
        self.snapshot: LiveBuilder | None = None
        self.status = {"state": "starting", "last_ts": None, "backfill_from": None, "error": None, "url": None}
        self.version = 0   # bumped on every new snapshot (the WebSocket endpoint polls it)
        self.lock = threading.Lock()
        self._ws_buf: list[dict] = []
        self._persisted_id = 0
        self._last_persist = time.monotonic()
        self._last_rest = 0.0
        self._last_oi = float("-inf")
        self._oi = pl.DataFrame(schema=OI_SCHEMA)   # live OI snapshots, kept across re-anchoring
        self._url_idx = 0
        self._received = 0

    # ---------------------------------------------------------------- lifecycle
    def _reset(self) -> None:
        anchor = find_anchor(self.cfg)
        b = LiveBuilder(self.cfg, anchor)
        stored = self._load_persisted(anchor.start_ts)
        if stored.height:
            if b.next_id is None:
                b.next_id = int(stored["id"][0])
            stored = stored.filter(pl.col("id") >= b.next_id)
            if stored.height and int(stored["id"][0]) == b.next_id:
                runs = stored.with_columns(_g=(pl.col("id").diff().fill_null(1) != 1).cum_sum())
                first = runs.filter(pl.col("_g") == 0).drop("_g")   # contiguous prefix; the rest is refetched
                b.add(first)
        b.refresh()
        if self._oi.height:
            b.set_oi(self._oi)
        self._persisted_id = (b.next_id or 0) - 1
        self.builder = b
        self._publish()
        log.info("live: anchored after %s, next aggTrade id %s", anchor.base_day, b.next_id)

    def _anchor_changed(self) -> bool:
        b = self.builder
        return b is None or anchor_key(self.cfg) != (b.anchor.base_day, tuple(b.anchor.aggs))

    def _publish(self) -> None:
        b = self.builder
        with self.lock:
            self.snapshot = b
            self.status["last_ts"] = b.last_ts if b else None
            self.version += 1

    async def run(self) -> None:
        """Forever: (re)connect the WebSocket, backfill gaps over REST, refresh the candles."""
        from .sample import sample_marker
        backoff = 1.0
        while True:
            if sample_marker(self.cfg).exists() or _base_day(self.cfg) is None:
                # live data continue real history only: wait for the first `fp update`
                self.status.update(state="waiting", error=None)
                await asyncio.sleep(30)
                continue
            try:
                await asyncio.to_thread(self._reset_if_needed)
                await self._session()
                backoff = 1.0
            except asyncio.CancelledError:   # shutdown: keep the trades for the next start
                self._persist()
                raise
            except Exception as e:   # network errors: retry with backoff, keep serving the last snapshot
                log.warning("live: %s", e)
                self.status.update(state="reconnecting", error=str(e))
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 60.0)

    def _reset_if_needed(self) -> None:
        if self._anchor_changed():
            self._reset()

    async def _session(self) -> None:
        ws = await self._connect()
        self._received = 0
        reader = asyncio.create_task(self._read(ws))
        try:
            self.status.update(state="backfill", error=None)
            while not reader.done():
                await asyncio.sleep(self.lcfg["refresh_s"])
                if await asyncio.to_thread(self._anchor_changed):
                    await asyncio.to_thread(self._reset)
                await self._step()
            reader.result()   # re-raises the reader's error
        finally:
            if not self._received:   # accepted but silent (wrong stream URL?): try the next URL first
                self._url_idx += 1
            reader.cancel()
            try:
                await ws.close()
            except Exception:
                pass

    async def _connect(self):
        if self._ws_connect:
            return await self._ws_connect()
        import websockets
        last, urls = None, self.lcfg["ws_urls"]
        for k in range(len(urls)):   # start with the URL that worked last
            base = urls[(self._url_idx + k) % len(urls)]
            url = f"{base.rstrip('/')}/{self.symbol.lower()}@aggTrade"
            try:
                ws = await websockets.connect(url, open_timeout=15, ping_interval=60, max_queue=None)
                self.status["url"] = url
                self._url_idx = (self._url_idx + k) % len(urls)
                log.info("live: connected %s", url)
                return ws
            except Exception as e:
                last = e
                log.info("live: %s failed: %s", url, e)
        raise ConnectionError(f"WebSocket: {last}")

    async def _read(self, ws) -> None:
        async for msg in ws:
            d = json.loads(msg)
            d = d.get("data", d)
            if d.get("e") == "aggTrade":
                self._ws_buf.append(d)
                self._received += 1

    async def _step(self) -> None:
        b = self.builder
        changed = False
        if time.monotonic() - self._last_oi > self.lcfg["oi_interval_s"]:
            changed = await self._poll_oi(b)
        buf, self._ws_buf = self._ws_buf, []
        if b.next_id is not None:
            buf = [d for d in buf if d["a"] >= b.next_id]
        buf.sort(key=lambda d: d["a"])
        if b.next_id is None and buf:   # no anchor id: start by time, then by id
            await self._backfill_by_time(b, buf[0]["a"])
        if buf and b.next_id is not None and buf[0]["a"] > b.next_id:
            done = await self._backfill(b, buf[0]["a"])
            if not done:   # still catching up: keep the WebSocket trades for the next step
                self._ws_buf = buf + self._ws_buf
                buf = []
        if buf:
            await asyncio.to_thread(b.add, trades_frame(buf))
            self.status.update(state="live", backfill_from=None)
        changed = await asyncio.to_thread(b.refresh) or changed
        if changed:
            self._publish()
        if time.monotonic() - self._last_persist > self.lcfg["persist_s"]:
            await asyncio.to_thread(self._persist)

    async def _poll_oi(self, b: LiveBuilder) -> bool:
        """Fetch the 5-min OI snapshots since the live start. Errors only log: OI must not stop the trades."""
        self._last_oi = time.monotonic()
        rows: list[dict] = []
        try:
            while True:   # 500 snapshots = 41 h; page when the live range is longer (late daily update)
                start = int(rows[-1]["timestamp"]) + 1 if rows else b.anchor.start_ts
                page = await asyncio.to_thread(self._rest_get, "/futures/data/openInterestHist",
                                               {"symbol": self.symbol, "period": "5m", "startTime": start, "limit": 500})
                rows += page
                if len(page) < 500:
                    break
            oi = oi_frame(rows)
        except Exception as e:
            log.warning("live: open interest: %s", e)
            self.status["oi_error"] = str(e)
            return False
        self.status["oi_error"] = None
        if oi.equals(self._oi):
            return False
        self._oi = oi
        await asyncio.to_thread(b.set_oi, oi)
        return True

    async def _rest(self, params: dict) -> list[dict]:
        wait = self._last_rest + self.lcfg["rest_interval_s"] - time.monotonic()
        if wait > 0:
            await asyncio.sleep(wait)
        self._last_rest = time.monotonic()
        return await asyncio.to_thread(self._rest_get, "/fapi/v1/aggTrades", {"symbol": self.symbol, "limit": 1000, **params})

    async def _backfill(self, b: LiveBuilder, until_id: int, budget_s: float = 5.0) -> bool:
        """Fetch [b.next_id, until_id) over REST for up to budget_s. Returns True once caught up."""
        self.status.update(state="backfill", backfill_from=b.next_id)
        t_end = time.monotonic() + budget_s
        while b.next_id < until_id and time.monotonic() < t_end:
            rows = await self._rest({"fromId": b.next_id})
            rows = [r for r in rows if r["a"] < until_id]
            if not rows:
                break
            await asyncio.to_thread(b.add, trades_frame(rows))
        if await asyncio.to_thread(b.refresh):
            self._publish()
        return b.next_id >= until_id

    async def _backfill_by_time(self, b: LiveBuilder, ws_first: int) -> None:
        """No built day to continue from: find the first aggTrade at the live start (00:00 UTC)."""
        t = b.anchor.start_ts
        while t < time.time() * 1000:
            rows = await self._rest({"startTime": t, "endTime": t + 3_600_000 - 1})
            if rows:
                b.next_id = rows[0]["a"]
                return
            t += 3_600_000
        b.next_id = ws_first

    def _requests_get(self, path: str, params: dict) -> list[dict]:
        import requests
        while True:
            r = requests.get(self.lcfg["rest_url"].rstrip("/") + path, params=params, timeout=20)
            if r.status_code in (418, 429):
                time.sleep(int(r.headers.get("Retry-After", "10")))
                continue
            r.raise_for_status()
            return r.json()

    # ---------------------------------------------------------------- persistence (restart without full backfill)
    def _persist(self) -> None:
        self._last_persist = time.monotonic()
        b = self.builder
        if not b or not b.trades.height:
            return
        new = b.trades.filter(pl.col("id") > self._persisted_id)
        if not new.height:
            return
        d = live_dir(self.cfg)
        d.mkdir(parents=True, exist_ok=True)
        first, last = int(new["id"][0]), int(new["id"][-1])
        tmp = d / f"{first}-{last}.tmp"
        new.write_parquet(tmp, compression="zstd")
        tmp.replace(d / f"{first}-{last}.parquet")
        self._persisted_id = last

    def _load_persisted(self, start_ts: int) -> pl.DataFrame:
        d = live_dir(self.cfg)
        if not d.exists():
            return _empty_trades()
        keep = []
        for p in sorted(d.glob("*.parquet"), key=lambda p: int(p.stem.split("-")[0])):
            df = pl.read_parquet(p)
            if not df.height or int(df["ts"].max()) < start_ts:
                p.unlink(missing_ok=True)   # covered by a built day
                continue
            keep.append(df)
        if not keep:
            return _empty_trades()
        return pl.concat(keep).unique("id", keep="first").sort("id").filter(pl.col("ts") >= start_ts)

    # ---------------------------------------------------------------- reads (server)
    def rows(self, kind: str, agg: str, start: int, end: int) -> pl.DataFrame | None:
        """Live candles ('series') or footprint ('footprint') with start_ts in [start, end)."""
        b = self.snapshot
        if b is None:
            return None
        df = (b.series if kind == "series" else b.fp).get(agg)
        if df is None or not df.height:
            return None
        df = df.filter((pl.col("start_ts") >= start) & (pl.col("start_ts") < end))
        return df if df.height else None

    def days(self, agg: str) -> list[dt.date]:
        b = self.snapshot
        df = b.series.get(agg) if b else None
        if df is None or not df.height:
            return []
        return sorted(df.select(pl.from_epoch("start_ts", time_unit="ms").dt.date().unique())["start_ts"].to_list())

    def last_day(self, agg: str) -> dt.date | None:
        b = self.snapshot
        df = b.series.get(agg) if b else None
        if df is None or not df.height:
            return None
        return dt.datetime.fromtimestamp(int(df["start_ts"].max()) / 1000, dt.timezone.utc).date()

    def info(self) -> dict:
        b = self.snapshot
        last = b.last_ts if b else None
        return {**self.status, "last_ts": last, "lag_ms": int(time.time() * 1000) - last if last else None,
                "base_day": b.anchor.base_day.isoformat() if b and b.anchor.base_day else None}
