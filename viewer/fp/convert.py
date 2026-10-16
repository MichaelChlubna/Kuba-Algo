"""Convert raw Binance daily CSV zips to per-day parquet files."""
from __future__ import annotations

import datetime as dt
import logging
import zipfile
from pathlib import Path

import polars as pl

from .download import rel_path

log = logging.getLogger(__name__)

AGGTRADES_COLS = ["agg_trade_id", "price", "quantity", "first_trade_id", "last_trade_id", "transact_time", "is_buyer_maker"]
KLINES_COLS = ["open_time", "open", "high", "low", "close", "volume", "close_time", "quote_volume", "count",
               "taker_buy_volume", "taker_buy_quote_volume", "ignore"]
METRICS_COLS = ["create_time", "symbol", "sum_open_interest", "sum_open_interest_value", "count_toptrader_long_short_ratio",
                "sum_toptrader_long_short_ratio", "count_long_short_ratio", "sum_taker_long_short_vol_ratio"]

# metrics snapshot with create_time T describes OI at T + 5 min (verified, see README)
OI_SNAPSHOT_OFFSET_MS = 5 * 60 * 1000


def parquet_path(cfg: dict, dataset: str, day: dt.date) -> Path:
    return cfg["paths"]["parquet"] / dataset / cfg["symbol"] / f"{day.isoformat()}.parquet"


def _read_zip_csv(path: Path, columns: list[str], schema: dict) -> pl.DataFrame:
    with zipfile.ZipFile(path) as z:
        data = z.read(z.namelist()[0])
    first = data.split(b"\n", 1)[0].split(b",", 1)[0].strip().decode()
    has_header = first == columns[0]
    df = pl.read_csv(data, has_header=has_header, new_columns=columns, schema_overrides=schema)
    if has_header and df.columns != columns:
        raise ValueError(f"unexpected header in {path.name}: {df.columns}")
    return df


def _to_ms(s: pl.Series) -> pl.Series:
    """Normalize epoch timestamps to milliseconds (dumps may switch to microseconds)."""
    mx = s.max()
    if mx is not None and mx > 10**14:  # >= 16 digits => microseconds
        return s // 1000
    return s


def convert_aggtrades(src: Path) -> pl.DataFrame:
    df = _read_zip_csv(src, AGGTRADES_COLS, {
        "agg_trade_id": pl.Int64, "price": pl.Float64, "quantity": pl.Float64, "first_trade_id": pl.Int64,
        "last_trade_id": pl.Int64, "transact_time": pl.Int64, "is_buyer_maker": pl.Boolean})
    df = df.with_columns(_to_ms(df["transact_time"]).alias("transact_time"))
    return df.sort("agg_trade_id").select(
        pl.col("agg_trade_id").alias("id"),
        "price",
        pl.col("quantity").alias("qty"),
        pl.col("first_trade_id").alias("first_id"),
        pl.col("last_trade_id").alias("last_id"),
        pl.col("transact_time").alias("ts"),
        pl.col("is_buyer_maker").alias("ibm"),
        pl.lit(False).alias("rep"),
    )


AGG_WINDOW_MS = 100


def missing_aggtrades(agg: pl.DataFrame, raw: pl.DataFrame, prev_tail: pl.DataFrame | None = None) -> pl.DataFrame:
    """Reconstruct aggTrades missing from the aggTrades dump out of the raw trades dump.

    Raw trades not covered by any [first_id, last_id] range are grouped exactly like Binance aggregates:
    consecutive trade ids with the same price and taker side within 100 ms of the group's first trade.
    The result has the aggTrades schema; `id` (agg_trade_id) is null, `rep` = True.
    prev_tail: last aggTrades of the previous day - the day's raw trades file starts with trades that
    belong to the previous day's last aggTrade (it can span midnight), they are not missing.
    """
    ranges = agg if prev_tail is None else pl.concat([prev_tail.select(agg.columns), agg])
    covered = ranges.select(pl.int_ranges("first_id", pl.col("last_id") + 1).alias("id")).explode("id")
    miss = raw.join(covered, on="id", how="anti").sort("id")
    if miss.is_empty():
        return agg.clear()
    brk = ((pl.col("id").diff() != 1) | (pl.col("price") != pl.col("price").shift())
           | (pl.col("ibm") != pl.col("ibm").shift())).fill_null(True)
    miss = miss.with_columns(_blk=brk.cum_sum())
    miss = miss.with_columns(_sub=(pl.col("ts") - pl.col("ts").min().over("_blk")) // (AGG_WINDOW_MS + 1))
    return (miss.group_by("_blk", "_sub", maintain_order=True)
            .agg(pl.col("price").first(), pl.col("qty").sum(), pl.col("id").min().alias("first_id"),
                 pl.col("id").max().alias("last_id"), pl.col("ts").min(), pl.col("ibm").first())
            .select(pl.lit(None, dtype=pl.Int64).alias("id"), "price", "qty", "first_id", "last_id", "ts", "ibm",
                    pl.lit(True).alias("rep")))


def repair_aggtrades(agg: pl.DataFrame, raw: pl.DataFrame,
                     prev_tail: pl.DataFrame | None = None) -> tuple[pl.DataFrame, pl.DataFrame]:
    """aggTrades + reconstructed missing ones, ordered by first trade id (true trade order)."""
    add = missing_aggtrades(agg, raw, prev_tail)
    return pl.concat([agg, add]).sort("first_id"), add


def convert_klines(src: Path) -> pl.DataFrame:
    df = _read_zip_csv(src, KLINES_COLS, {
        "open_time": pl.Int64, "close_time": pl.Int64, "count": pl.Int64, "open": pl.Float64, "high": pl.Float64,
        "low": pl.Float64, "close": pl.Float64, "volume": pl.Float64, "quote_volume": pl.Float64,
        "taker_buy_volume": pl.Float64, "taker_buy_quote_volume": pl.Float64})
    df = df.with_columns(_to_ms(df["open_time"]).alias("open_time"), _to_ms(df["close_time"]).alias("close_time"))
    return df.drop("ignore").sort("open_time")


def convert_metrics(src: Path) -> pl.DataFrame:
    df = _read_zip_csv(src, METRICS_COLS, {"create_time": pl.Utf8, "symbol": pl.Utf8})
    create_ms = pl.col("create_time").str.to_datetime("%Y-%m-%d %H:%M:%S").dt.replace_time_zone("UTC").dt.epoch("ms")
    return df.select(
        create_ms.alias("create_time"),
        (create_ms + OI_SNAPSHOT_OFFSET_MS).alias("oi_time"),
        pl.col("sum_open_interest").cast(pl.Float64).alias("oi_btc"),
        pl.col("sum_open_interest_value").cast(pl.Float64).alias("oi_usd"),
    ).sort("oi_time")


TRADES_COLS = ["id", "price", "qty", "quote_qty", "time", "is_buyer_maker"]


def convert_trades(src: Path) -> pl.DataFrame:
    """Raw (non-aggregated) trades; only used by validation."""
    df = _read_zip_csv(src, TRADES_COLS, {"id": pl.Int64, "price": pl.Float64, "qty": pl.Float64,
                                          "quote_qty": pl.Float64, "time": pl.Int64, "is_buyer_maker": pl.Boolean})
    df = df.with_columns(_to_ms(df["time"]).alias("time"))
    return df.sort("id").select("id", "price", "qty", pl.col("time").alias("ts"), pl.col("is_buyer_maker").alias("ibm"))


CONVERTERS = {
    "aggTrades": convert_aggtrades,
    "metrics": convert_metrics,
    "klines_1m": convert_klines,
    "klines_5m": convert_klines,
}
OPTIONAL_CONVERTERS = {"trades": convert_trades}


def convert_day(cfg: dict, dataset: str, day: dt.date, force: bool = False) -> Path | None:
    dest = parquet_path(cfg, dataset, day)
    if dest.exists() and not force:
        return dest
    src = cfg["paths"]["raw"] / rel_path(dataset, cfg["symbol"], day)
    if not src.exists():
        log.warning("raw file missing: %s", src)
        return None
    df = (CONVERTERS | OPTIONAL_CONVERTERS)[dataset](src)
    if dataset == "aggTrades":
        # the aggTrades dump sometimes lacks trades (2026-01 .. 2026-06); repair from raw trades if downloaded
        traw = cfg["paths"]["raw"] / rel_path("trades", cfg["symbol"], day)
        if traw.exists():
            tp = convert_day(cfg, "trades", day)
            pp = parquet_path(cfg, "aggTrades", day - dt.timedelta(days=1))
            prev_tail = pl.read_parquet(pp).tail(1000) if pp.exists() else None
            df, add = repair_aggtrades(df, pl.read_parquet(tp), prev_tail)
            if add.height:
                log.info("repaired aggTrades %s: +%d reconstructed aggTrades (%.3f BTC)", day, add.height, add["qty"].sum())
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".tmp")
    df.write_parquet(tmp, compression="zstd")
    tmp.replace(dest)
    log.info("converted %s %s (%d rows)", dataset, day, df.height)
    return dest
