"""Footprint viewer backend (FastAPI): JSON API + the built React frontend (frontend/dist)."""
from __future__ import annotations

import base64
import datetime as dt
import logging
import os
import secrets
import threading
from functools import lru_cache
from pathlib import Path

import polars as pl
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles

from .build import available_days, build_volume_agg, derived_path
from .metrics import DEFAULTS as METRIC_DEFAULTS, METRIC_COLS
from .footprint import PRICE_TICK
from .periods import DEFAULT_SESSIONS, SOURCE_AGG, SOURCE_PERIOD_MS, compute_periods, day_range, range_profile
from .sample import sample_marker
from .volume_bars import LIMITS, agg_name, is_volume_agg

log = logging.getLogger(__name__)

# built frontend (npm run build); FP_STATIC_DIR overrides (Docker image: /app/static)
STATIC = Path(os.environ.get("FP_STATIC_DIR") or Path(__file__).resolve().parents[2] / "frontend" / "dist")
DAY_MS = 86_400_000
MAX_CANDLES = 20_000      # per request, full columns
MAX_LIGHT_CANDLES = 250_000  # per request, light columns (range loading)
MAX_FP_ROWS = 400_000     # per request

# candle columns sent to the browser (full detail)
CANDLE_COLS = [
    "cid", "start_ts", "end_ts", "first_ts", "last_ts", "duration_ms", "open", "high", "low", "close",
    "volume", "buy", "sell", "volume_usd", "buy_usd", "sell_usd", "delta", "delta_usd", "cvd", "cvd_usd",
    "trades", "d_oi", "d_oi_usd", "oi_end", "valid", "color", "close_pos", "delta_ratio", "rel_tod",
    "lw_vol", "lw_buy", "lw_sell", "lw_vol_usd", "lw_buy_usd", "lw_sell_usd",
    "uw_vol", "uw_buy", "uw_sell", "uw_vol_usd", "uw_buy_usd", "uw_sell_usd",
    "lw_share", "lw_range", "lw_conc", "lw_delta_usd", "lw_delta_ratio", "lw_sell_share",
    "uw_share", "uw_range", "uw_conc", "uw_delta_usd", "uw_delta_ratio", "uw_buy_share", "z", "vspeed",
] + [f"{k}_{b}" for b in (5, 10, 25, 50, 100) for k in ("vpoc", "dpoc_neg", "dpoc_pos")] + METRIC_COLS
POC_COLS = [f"{k}_{b}" for b in (5, 10, 25, 50, 100) for k in ("vpoc", "dpoc_neg", "dpoc_pos")]
# light columns: everything the chart, table, tooltip and the selected-candle POC markers need; the rest
# (features, metrics, wick components) is fetched per candle on click (/api/candle)
LIGHT_COLS = [
    "cid", "start_ts", "end_ts", "last_ts", "duration_ms", "open", "high", "low", "close",
    "volume", "volume_usd", "delta", "delta_usd", "cvd_usd", "trades", "d_oi", "d_oi_usd",
] + POC_COLS
_ROUND = {0: ("volume_usd", "delta_usd", "cvd_usd", "d_oi_usd"),
          1: ("open", "high", "low", "close"),
          3: ("volume", "delta", "d_oi")}
FP_COLS = ["cid", "start_ts", "level", "buy_usd", "sell_usd", "buy", "sell"]


def _day(ts_ms: int) -> dt.date:
    return dt.datetime.fromtimestamp(ts_ms / 1000, dt.timezone.utc).date()


@lru_cache(maxsize=256)
def _read(path: str, mtime: float) -> pl.DataFrame:
    return pl.read_parquet(path)


def read_day(cfg: dict, kind: str, agg: str, day: dt.date) -> pl.DataFrame | None:
    p = derived_path(cfg, kind, agg, day)
    if not p.exists():
        return None
    return _read(str(p), p.stat().st_mtime)


def _columnar(df: pl.DataFrame) -> dict:
    out = {}
    for name, s in zip(df.columns, df.get_columns()):
        if s.dtype.is_float():
            s = s.fill_nan(None)
        out[name] = s.to_list()
    return {"n": df.height, "cols": out}


def _basic_auth() -> tuple[str, str] | None:
    user, pw = os.environ.get("FP_AUTH_USER"), os.environ.get("FP_AUTH_PASSWORD")
    return (user, pw) if user and pw else None


def create_app(cfg: dict, auth: tuple[str, str] | None = None) -> FastAPI:
    """auth: (user, password) for HTTP Basic auth on everything except /api/health; default from
    FP_AUTH_USER / FP_AUTH_PASSWORD (unset = no auth, fine on localhost, required on a public server)."""
    app = FastAPI(title="BTCUSDT footprint")
    app.add_middleware(GZipMiddleware, minimum_size=2048)
    auth = auth or _basic_auth()
    expected = "Basic " + base64.b64encode(f"{auth[0]}:{auth[1]}".encode()).decode() if auth else None

    @app.middleware("http")
    async def guard(request: Request, call_next):
        if expected and request.url.path != "/api/health":
            if not secrets.compare_digest(request.headers.get("authorization", ""), expected):
                return Response("authentication required", status_code=401,
                                headers={"WWW-Authenticate": 'Basic realm="footprint"'})
        response = await call_next(request)
        # index.html must be revalidated (new builds); hashed assets can be cached forever
        path = request.url.path
        if path.startswith("/assets/"):
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        elif not path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-cache"
        return response

    def aggs() -> list[str]:
        root = cfg["paths"]["derived"] / "series"
        return sorted(p.name for p in root.iterdir() if p.is_dir()) if root.exists() else []

    jobs: dict[str, dict] = {}
    jobs_lock = threading.Lock()

    def run_job(agg: str) -> None:
        def progress(done, total):
            jobs[agg].update(done=done, total=total)
        try:
            build_volume_agg(cfg, agg, progress=progress)
            jobs[agg]["status"] = "done"
        except Exception as e:  # reported to the UI
            log.exception("volume build %s failed", agg)
            jobs[agg].update(status="error", error=str(e))

    def check_agg(agg: str) -> None:
        if agg not in aggs():
            raise HTTPException(404, f"aggregation {agg!r} not built")

    @app.get("/api/health")
    def health():
        return {"status": "ok", "aggregations": len(aggs()), "sample": sample_marker(cfg).exists()}

    @app.get("/api/meta")
    def meta():
        out = {"aggregations": {}, "features": cfg.get("features") or {}, "timezone": cfg["server"].get("timezone", "America/New_York"),
               "symbol": cfg.get("symbol", "BTCUSDT"), "price_tick": PRICE_TICK, "sample": sample_marker(cfg).exists(),
               "base_bin": cfg["aggregation"]["base_bin"], "bins": [5, 10, 25, 50, 100], "default_bin": 25,
               "volume_usd": cfg["aggregation"].get("volume_usd", []), "volume_btc": cfg["aggregation"].get("volume_btc", []),
               "metrics": {**METRIC_DEFAULTS, **(cfg.get("metrics") or {})}, "metric_cols": METRIC_COLS,
               "sessions": cfg.get("sessions") or DEFAULT_SESSIONS}
        for a in aggs():
            days = available_days(cfg, "series", a)
            if days:
                n = pl.scan_parquet(cfg["paths"]["derived"] / "series" / a / "*.parquet").select(pl.len()).collect().item()
                out["aggregations"][a] = {"first_day": days[0].isoformat(), "last_day": days[-1].isoformat(),
                                          "candles": n, "per_day": n / len(days)}
        out["max_light_candles"] = MAX_LIGHT_CANDLES
        return out

    def load_range(agg: str, start: int, end: int) -> pl.DataFrame:
        d0, d1 = _day(start), _day(end - 1)
        parts = [df for d in available_days(cfg, "series", agg) if d0 <= d <= d1
                 and (df := read_day(cfg, "series", agg, d)) is not None]
        if not parts:
            return pl.DataFrame()
        df = pl.concat(parts, how="diagonal_relaxed").filter((pl.col("start_ts") >= start) & (pl.col("start_ts") < end))
        return df if "cid" in df.columns else df.with_columns(cid=pl.col("start_ts"))

    @app.get("/api/periods")
    def periods(start: int, end: int, tz: str = "America/New_York", bin: int = Query(25, ge=5, le=1000)):
        """Sessions and days overlapping [start, end): high/low and volume/delta profile levels (at `bin`).

        Built from the 5m candles and 5m footprint of the range padded by one day, so every returned
        period is complete."""
        if SOURCE_AGG not in aggs():
            raise HTTPException(404, "5m aggregation not built")
        cs, fs = [], []
        for d in day_range(start, end):
            c = read_day(cfg, "series", SOURCE_AGG, d)
            f = read_day(cfg, "footprint", SOURCE_AGG, d)
            if c is not None:
                cs.append(c.select("start_ts", "high", "low"))
            if f is not None:
                fs.append(f.select("start_ts", "level", "buy_usd", "sell_usd"))
        if not cs or not fs:
            return {"periods": _columnar(pl.DataFrame()), "levels": _columnar(pl.DataFrame())}
        per, lv = compute_periods(pl.concat(cs), pl.concat(fs), tz, bin, cfg.get("sessions"))
        per = per.filter((pl.col("start_ts") < end) & (pl.col("end_ts") > start))
        lv = lv.filter(pl.col("id").is_in(per["id"].implode())).with_columns(pl.col("buy_usd", "sell_usd").round(0))
        return JSONResponse({"periods": _columnar(per), "levels": _columnar(lv)})

    @app.get("/api/candle")
    def candle(agg: str, cid: int, start_ts: int):
        """All columns of one candle (side panel detail)."""
        check_agg(agg)
        df = load_range(agg, start_ts, start_ts + 1)
        df = df.filter(pl.col("cid") == cid) if df.height else df
        if df.is_empty():
            raise HTTPException(404, "candle not found")
        return JSONResponse(_columnar(df))

    @app.get("/api/profile")
    def profile(start: int, end: int, bin: int = Query(25, ge=5, le=1000)):
        """Volume profile of [start, end) (5m footprint, so the range snaps to 5 minutes): levels at `bin`
        plus POC and the 70 % value area (VAH / VAL)."""
        if SOURCE_AGG not in aggs():
            raise HTTPException(404, "5m aggregation not built")
        if end - start > 400 * DAY_MS:
            raise HTTPException(413, "range too long")
        fs = []
        for d in day_range(start, end, pad_days=0):
            f = read_day(cfg, "footprint", SOURCE_AGG, d)
            if f is not None:
                fs.append(f.filter((pl.col("start_ts") >= start - SOURCE_PERIOD_MS + 1) & (pl.col("start_ts") < end))
                          .select("level", "buy_usd", "sell_usd"))
        lv, summary = range_profile(pl.concat(fs) if fs else pl.DataFrame(), bin)
        return JSONResponse({"levels": _columnar(lv.with_columns(pl.col("buy_usd", "sell_usd").round(0))), **summary})

    @app.post("/api/volume")
    def volume(unit: str, value: float):
        """Build (and cache on disk) volume or tick candles for a custom threshold in the background."""
        if unit not in LIMITS:
            raise HTTPException(400, "unit must be usd, btc or tick")
        lo, hi = LIMITS[unit]
        if not lo <= value <= hi:
            raise HTTPException(400, f"threshold must be within [{lo:g}, {hi:g}] {unit.upper()}")
        agg = agg_name(unit, value)
        with jobs_lock:
            if agg in aggs() and jobs.get(agg, {}).get("status") != "running":
                return {"agg": agg, "status": "done"}
            busy = [a for a, j in jobs.items() if j.get("status") == "running" and a != agg]
            if busy:   # one build at a time (CPU / memory bound)
                raise HTTPException(429, f"another threshold is being computed: {busy[0]}")
            if jobs.get(agg, {}).get("status") != "running":
                jobs[agg] = {"status": "running", "done": 0, "total": 0}
                threading.Thread(target=run_job, args=(agg,), daemon=True).start()
        return {"agg": agg, **jobs[agg]}

    @app.get("/api/jobs")
    def job_status():
        return jobs

    @app.get("/api/candles")
    def candles(agg: str, start: int, end: int, pad: int = Query(0, ge=0, le=2000), full: bool = False):
        """Candles with start_ts in [start, end) plus `pad` candles before `start`.

        Default: light columns (LIGHT_COLS, rounded) for range loading; full=1: all viewer columns."""
        check_agg(agg)
        days = available_days(cfg, "series", agg)
        if not days:
            return _columnar(pl.DataFrame())
        d0, d1 = _day(start), _day(end - 1)
        parts = [df for d in days if d0 <= d <= d1 and (df := read_day(cfg, "series", agg, d)) is not None]
        main = pl.concat(parts, how="diagonal_relaxed") if parts else pl.DataFrame()
        if main.height:
            main = main.filter((pl.col("start_ts") >= start) & (pl.col("start_ts") < end))
        before = []
        if pad:
            have, earlier = 0, [d for d in days if d <= d0][::-1]
            for d in earlier:
                df = read_day(cfg, "series", agg, d).filter(pl.col("start_ts") < start)
                if df.height:
                    before.insert(0, df)
                    have += df.height
                if have >= pad:
                    break
        frames = [pl.concat(before, how="diagonal_relaxed").tail(pad)] if before else []
        if main.height:
            frames.append(main)
        if not frames:
            return _columnar(pl.DataFrame())
        df = pl.concat(frames, how="diagonal_relaxed")
        if "cid" not in df.columns:
            df = df.with_columns(cid=pl.col("start_ts"))
        df = df.sort("cid")
        limit = MAX_CANDLES if full else MAX_LIGHT_CANDLES
        if df.height > limit:
            raise HTTPException(413, f"too many candles ({df.height}), request a smaller range")
        if full:
            return JSONResponse(_columnar(df.select([c for c in CANDLE_COLS if c in df.columns])))
        df = df.select([c for c in LIGHT_COLS if c in df.columns])
        df = df.with_columns([pl.col(c).round(d) for d, cols in _ROUND.items() for c in cols if c in df.columns])
        return JSONResponse(_columnar(df))

    @app.get("/api/footprint")
    def footprint(agg: str, start: int, end: int):
        """Base-bin footprint rows for candles with start_ts in [start, end). The browser re-bins."""
        check_agg(agg)
        parts = []
        d, d1 = _day(start), _day(end - 1)
        if is_volume_agg(agg):   # stored by the UTC day in which the candle closes
            d1 += dt.timedelta(days=1)
        while d <= d1:
            df = read_day(cfg, "footprint", agg, d)
            if df is not None:
                if "cid" not in df.columns:
                    df = df.with_columns(cid=pl.col("start_ts"))
                parts.append(df.filter((pl.col("start_ts") >= start) & (pl.col("start_ts") < end)).select(FP_COLS))
            d += dt.timedelta(days=1)
        if not parts:
            return _columnar(pl.DataFrame())
        df = pl.concat(parts).sort("cid", "level")
        if df.height > MAX_FP_ROWS:
            raise HTTPException(413, f"too many footprint rows ({df.height}), zoom in")
        # compact: round volumes (USD to 1 USD, BTC to 1e-3)
        df = df.with_columns(pl.col("buy_usd", "sell_usd").round(0), pl.col("buy", "sell").round(3))
        return JSONResponse(_columnar(df))

    if STATIC.is_dir() and (STATIC / "index.html").exists():
        if (STATIC / "assets").is_dir():
            app.mount("/assets", StaticFiles(directory=STATIC / "assets"), name="assets")

        @app.get("/{path:path}", include_in_schema=False)
        def spa(path: str):
            f = (STATIC / path).resolve()
            if path and f.is_file() and STATIC.resolve() in f.parents:
                return FileResponse(f)
            return FileResponse(STATIC / "index.html")
    else:
        @app.get("/", include_in_schema=False)
        def no_frontend():
            return Response("frontend not built: run `npm run build` in frontend/ (or use docker compose)",
                            media_type="text/plain")

    return app


def serve(cfg: dict, host: str | None = None, port: int | None = None) -> None:
    import uvicorn
    scfg = cfg.get("server", {})
    host, port = host or scfg.get("host", "127.0.0.1"), port or scfg.get("port", 8000)
    if host not in ("127.0.0.1", "localhost") and not _basic_auth():
        log.warning("listening on %s without FP_AUTH_USER / FP_AUTH_PASSWORD: anyone who reaches the port can use the API", host)
    print(f"Footprint viewer: http://{'localhost' if host in ('127.0.0.1', '0.0.0.0') else host}:{port}")
    uvicorn.run(create_app(cfg), host=host, port=port, log_level="warning")
