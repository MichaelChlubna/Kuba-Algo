"""Sessions and days: high/low and volume / delta profiles for the viewer.

Computed on demand from the 5m candles (exact high/low) and the 5m footprint (base bin) of the
requested range. A day is a calendar day in the display timezone; sessions are defined in their own
timezone (default America/New_York, DST-aware) and may wrap midnight (then they belong to the day on
which they end).
"""
from __future__ import annotations

import datetime as dt

import polars as pl

DEFAULT_SESSIONS = {
    "timezone": "America/New_York",
    "list": [
        {"name": "Asia", "start": "18:00", "end": "03:00"},
        {"name": "London", "start": "03:00", "end": "08:00"},
        {"name": "New York", "start": "08:00", "end": "17:00"},
    ],
}
SOURCE_AGG = "5m"
SOURCE_PERIOD_MS = 300_000


def _minutes(hhmm: str) -> int:
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def _local(col: str, tz: str) -> pl.Expr:
    return pl.from_epoch(pl.col(col), time_unit="ms").dt.replace_time_zone("UTC").dt.convert_time_zone(tz)


def assign_periods(candles: pl.DataFrame, display_tz: str, sessions: dict | None = None) -> pl.DataFrame:
    """Map each candle (start_ts) to its day (display tz) and session (session tz).

    Returns rows (start_ts, kind, name, key) where kind is 'day' or 'session' and key is the local date
    (ISO) the period belongs to. A candle belongs to exactly one day and at most one session.
    """
    sessions = sessions or DEFAULT_SESSIONS
    days = candles.select("start_ts", pl.lit("day").alias("kind"), pl.lit("Day").alias("name"),
                          _local("start_ts", display_tz).dt.date().cast(pl.Utf8).alias("key"))
    stz = sessions.get("timezone", "America/New_York")
    loc = candles.select("start_ts", _local("start_ts", stz).alias("_t"))
    loc = loc.with_columns(_mod=pl.col("_t").dt.hour().cast(pl.Int32) * 60 + pl.col("_t").dt.minute().cast(pl.Int32),
                           _date=pl.col("_t").dt.date())
    parts = [days]
    for s in sessions["list"]:
        a, b = _minutes(s["start"]), _minutes(s["end"])
        if a < b:
            sel = loc.filter((pl.col("_mod") >= a) & (pl.col("_mod") < b)).with_columns(_key=pl.col("_date"))
        else:   # wraps midnight: the evening part belongs to the next day's session
            sel = loc.filter((pl.col("_mod") >= a) | (pl.col("_mod") < b)).with_columns(
                _key=pl.when(pl.col("_mod") >= a).then(pl.col("_date") + pl.duration(days=1)).otherwise(pl.col("_date")))
        parts.append(sel.select("start_ts", pl.lit("session").alias("kind"), pl.lit(s["name"]).alias("name"),
                                pl.col("_key").cast(pl.Utf8).alias("key")))
    return pl.concat(parts)


def compute_periods(candles: pl.DataFrame, fp: pl.DataFrame, display_tz: str, bin_usd: int,
                    sessions: dict | None = None) -> tuple[pl.DataFrame, pl.DataFrame]:
    """candles: 5m series (start_ts, high, low); fp: 5m base-bin footprint (start_ts, level, buy_usd, sell_usd).

    Returns (periods, levels):
      periods: id, kind, name, key, start_ts, end_ts, high, low, volume_usd, delta_usd
      levels:  id, level (lower bucket edge at bin_usd), buy_usd, sell_usd
    """
    m = assign_periods(candles.select("start_ts"), display_tz, sessions)
    m = m.with_columns(id=pl.concat_str(["kind", "name", "key"], separator="|"))
    per = (m.join(candles.select("start_ts", "high", "low"), on="start_ts")
           .group_by("id", "kind", "name", "key")
           .agg(pl.col("start_ts").min(), (pl.col("start_ts").max() + SOURCE_PERIOD_MS).alias("end_ts"),
                pl.col("high").max(), pl.col("low").min()))
    lv = (m.select("id", "start_ts")
          .join(fp.select("start_ts", "level", "buy_usd", "sell_usd"), on="start_ts")
          .with_columns(level=(pl.col("level") // bin_usd) * bin_usd)
          .group_by("id", "level").agg(pl.col("buy_usd").sum(), pl.col("sell_usd").sum())
          .sort("id", "level"))
    tot = lv.group_by("id").agg((pl.col("buy_usd") + pl.col("sell_usd")).sum().alias("volume_usd"),
                                (pl.col("buy_usd") - pl.col("sell_usd")).sum().alias("delta_usd"))
    per = per.join(tot, on="id", how="left").sort("start_ts", "kind")
    return per, lv


def day_range(start_ms: int, end_ms: int, pad_days: int = 1) -> list[dt.date]:
    d0 = dt.datetime.fromtimestamp(start_ms / 1000, dt.timezone.utc).date() - dt.timedelta(days=pad_days)
    d1 = dt.datetime.fromtimestamp((end_ms - 1) / 1000, dt.timezone.utc).date() + dt.timedelta(days=pad_days)
    return [d0 + dt.timedelta(days=i) for i in range((d1 - d0).days + 1)]
