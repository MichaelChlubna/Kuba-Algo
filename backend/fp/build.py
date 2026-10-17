"""Build pipeline: raw zips -> parquet -> candles with features -> series (range-level stats)."""
from __future__ import annotations

import datetime as dt
import logging
from pathlib import Path

import polars as pl

from .candles import TIMEFRAMES_MS, add_cvd, time_candles
from .convert import CONVERTERS, convert_day, parquet_path
from .download import date_range
from .footprint import footprint, poc_features
from .metrics import add_candle_metrics, add_oi_vol_ratio
from .features import add_oi_delta, add_rolling, add_tod_relative, static_features, wick_components

log = logging.getLogger(__name__)


def derived_path(cfg: dict, kind: str, agg: str, day: dt.date) -> Path:
    return cfg["paths"]["derived"] / kind / agg / f"{day.isoformat()}.parquet"


def _write(df: pl.DataFrame, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".tmp")
    df.write_parquet(tmp, compression="zstd")
    tmp.replace(dest)


def load_trades(cfg: dict, day: dt.date) -> pl.DataFrame | None:
    p = parquet_path(cfg, "aggTrades", day)
    return pl.read_parquet(p) if p.exists() else None


def time_candles_with_features(trades: pl.DataFrame, period: int) -> pl.DataFrame:
    c = time_candles(trades, period)
    t = trades.with_columns(open_time=(pl.col("ts") // period) * period)
    return static_features(wick_components(t, c, "open_time"))


def time_footprint(trades: pl.DataFrame, period: int, bin_usd: int) -> pl.DataFrame:
    t = trades.with_columns(start_ts=(pl.col("ts") // period) * period)
    return footprint(t, "start_ts", bin_usd)


def build_day(cfg: dict, day: dt.date, force: bool = False) -> bool:
    """Per-day stage. Returns True if anything was (re)built."""
    from .sample import sample_marker
    if not sample_marker(cfg).exists():   # sample data has no raw zips
        for ds in CONVERTERS:
            convert_day(cfg, ds, day, force=force)
    trades, changed = None, False
    base_bin = cfg["aggregation"]["base_bin"]
    for tf in cfg["aggregation"]["timeframes"]:
        dest = derived_path(cfg, "candles", tf, day)
        fdest = derived_path(cfg, "footprint", tf, day)
        if dest.exists() and fdest.exists() and not force:
            continue
        if trades is None:
            trades = load_trades(cfg, day)
            if trades is None:
                log.warning("no trades for %s, skipping", day)
                return changed
        fp = time_footprint(trades, TIMEFRAMES_MS[tf], base_bin)
        candles = time_candles_with_features(trades, TIMEFRAMES_MS[tf])
        candles = candles.join(poc_features(fp, "start_ts", base_bin), on="start_ts", how="left")
        keyed = trades.with_columns(start_ts=(pl.col("ts") // TIMEFRAMES_MS[tf]) * TIMEFRAMES_MS[tf])
        candles = add_candle_metrics(candles, keyed, fp, "start_ts", base_bin, cfg.get("metrics"))
        _write(candles, dest)
        _write(fp, fdest)
        changed = True
        log.info("built candles + footprint %s %s", tf, day)
    return changed


def available_days(cfg: dict, kind: str, agg: str) -> list[dt.date]:
    d = cfg["paths"]["derived"] / kind / agg
    return sorted(dt.date.fromisoformat(p.stem) for p in d.glob("*.parquet")) if d.exists() else []


def load_oi(cfg: dict) -> pl.DataFrame:
    d = cfg["paths"]["parquet"] / "metrics" / cfg["symbol"]
    files = sorted(d.glob("*.parquet"))
    if not files:
        return pl.DataFrame(schema={"oi_time": pl.Int64, "oi_btc": pl.Float64, "oi_usd": pl.Float64})
    return pl.concat([pl.read_parquet(f) for f in files]).unique("oi_time").sort("oi_time")


def finalize(cfg: dict, agg: str, volume_bars: bool = False) -> pl.DataFrame:
    """Range-level stage over all built days: CVD, ΔOI, rolling z, time-of-day volume."""
    days = available_days(cfg, "candles", agg)
    if not days:
        return pl.DataFrame()
    df = pl.concat([pl.read_parquet(derived_path(cfg, "candles", agg, d)) for d in days], how="diagonal_relaxed")
    if "cid" not in df.columns:   # unique, monotonic candle key: start_ts for time candles, sequence for volume candles
        df = df.with_columns(cid=pl.col("start_ts"))
    df = df.sort("cid")
    fcfg = cfg["features"]
    acfg = cfg["aggregation"]
    df = add_cvd(df, acfg.get("cvd_reset", "daily"), acfg.get("cvd_reset_timezone", "UTC"))
    df = add_oi_vol_ratio(add_oi_delta(df, load_oi(cfg)))
    df = add_rolling(df, fcfg["n"], volume_bars=volume_bars, window=fcfg.get("vol_window", 10))
    if not volume_bars:
        df = add_tod_relative(df, fcfg.get("tod_days", 20), fcfg.get("tod_timezone", "America/New_York"))
    df = df.with_columns(day=pl.from_epoch("start_ts", time_unit="ms").dt.date())
    for (day,), part in df.group_by("day"):
        _write(part.drop("day").sort("cid"), derived_path(cfg, "series", agg, day))
    log.info("finalized %s: %d candles", agg, df.height)
    return df


def load_series(cfg: dict, agg: str, start: dt.date | None = None, end: dt.date | None = None) -> pl.DataFrame:
    days = [d for d in available_days(cfg, "series", agg) if (start is None or d >= start) and (end is None or d <= end)]
    if not days:
        return pl.DataFrame()
    return pl.concat([pl.read_parquet(derived_path(cfg, "series", agg, d)) for d in days], how="diagonal_relaxed").sort("cid")


def build(cfg: dict, start: dt.date, end: dt.date, force: bool = False) -> None:
    for day in date_range(start, end):
        build_day(cfg, day, force=force)
    for tf in cfg["aggregation"]["timeframes"]:
        finalize(cfg, tf)
    for agg in volume_aggs(cfg):
        build_volume_agg(cfg, agg, force=force)


# ---------------------------------------------------------------- volume candles

def volume_aggs(cfg: dict) -> list[str]:
    """Configured volume aggregations plus custom thresholds already cached on disk."""
    from .volume_bars import agg_name, is_volume_agg
    a = cfg["aggregation"]
    names = ([agg_name("usd", v) for v in a.get("volume_usd", [])] + [agg_name("btc", v) for v in a.get("volume_btc", [])]
             + [agg_name("tick", v) for v in a.get("ticks", [])])
    root = cfg["paths"]["derived"] / "candles"
    if root.exists():
        names += [p.name for p in root.iterdir() if p.is_dir() and is_volume_agg(p.name)]
    return list(dict.fromkeys(names))


def trade_days(cfg: dict) -> list[dt.date]:
    d = cfg["paths"]["parquet"] / "aggTrades" / cfg["symbol"]
    return sorted(dt.date.fromisoformat(p.stem) for p in d.glob("*.parquet")) if d.exists() else []


def build_volume_agg(cfg: dict, agg: str, force: bool = False, progress=None) -> None:
    """Build volume candles over all available trade days in order (state continues across days).

    Candles are stored in the file of the UTC day in which they close. Days already built are skipped
    unless an earlier day had to be rebuilt.
    """
    from .volume_bars import State, aggregate_volume_candles, parse_agg, split_pieces, threshold_units

    unit, value = parse_agg(agg)
    T = threshold_units(unit, value)
    base_bin = cfg["aggregation"]["base_bin"]
    sdir = cfg["paths"]["derived"] / "vstate" / agg
    days = trade_days(cfg)
    state: State | None = State()
    prev_day: dt.date | None = None
    rebuild = force
    for i, day in enumerate(days):
        sj = sdir / f"{day.isoformat()}.json"
        done = sj.exists() and derived_path(cfg, "candles", agg, day).exists() and derived_path(cfg, "footprint", agg, day).exists()
        if done and not rebuild:
            state, prev_day = None, day   # loaded lazily if a later day needs it
            if progress:
                progress(i + 1, len(days))
            continue
        rebuild = True   # everything after a rebuilt day depends on its state
        if state is None:
            pj = sdir / f"{prev_day.isoformat()}.json"
            pp = sdir / f"{prev_day.isoformat()}.parquet"
            state = State.from_json(pj.read_text(), pl.read_parquet(pp) if pp.exists() else None)
        trades = load_trades(cfg, day)
        pieces, state = split_pieces(trades, unit, T, state)
        complete = pieces.filter(pl.col("cid") < state.next_id)
        candles = aggregate_volume_candles(complete)
        candles = static_features(wick_components(complete, candles, "cid"))
        fp = footprint(complete, "cid", base_bin)
        candles = candles.join(poc_features(fp, "cid", base_bin), on="cid", how="left")
        candles = add_candle_metrics(candles, complete, fp, "cid", base_bin, cfg.get("metrics"))
        fp = fp.join(candles.select("cid", "start_ts"), on="cid", how="left")
        _write(candles, derived_path(cfg, "candles", agg, day))
        _write(fp, derived_path(cfg, "footprint", agg, day))
        sdir.mkdir(parents=True, exist_ok=True)
        _write(state.carry, sdir / f"{day.isoformat()}.parquet")
        sj.write_text(state.to_json())
        prev_day = day
        log.info("built %s %s: %d candles (open candle carries %d pieces)", agg, day, candles.height, state.carry.height)
        if progress:
            progress(i + 1, len(days))
    finalize(cfg, agg, volume_bars=True)
