"""Candle aggregation from aggTrades."""
from __future__ import annotations

import polars as pl

TIMEFRAMES_MS = {"1m": 60_000, "5m": 300_000, "15m": 900_000}

# taker side: is_buyer_maker = true => aggressor was the seller
IS_BUY = ~pl.col("ibm")


def with_trade_columns(trades: pl.DataFrame | pl.LazyFrame):
    """Add per-trade helper columns used by all aggregations."""
    return trades.with_columns(
        n=(pl.col("last_id") - pl.col("first_id") + 1),
        usd=pl.col("price") * pl.col("qty"),
    )


def candle_aggs(has_rep: bool = False) -> list[pl.Expr]:
    """OHLCV/delta aggregations over trades grouped by candle (trades in trade order).

    has_rep: trades carry `rep` (aggTrade reconstructed from the raw trades dump) -> `repaired_btc`.
    """
    buy_qty = pl.when(IS_BUY).then(pl.col("qty")).otherwise(0.0)
    buy_usd = pl.when(IS_BUY).then(pl.col("usd")).otherwise(0.0)
    return [
        pl.col("price").first().alias("open"),
        pl.col("price").max().alias("high"),
        pl.col("price").min().alias("low"),
        pl.col("price").last().alias("close"),
        pl.col("qty").sum().alias("volume"),
        buy_qty.sum().alias("buy"),
        pl.col("usd").sum().alias("volume_usd"),
        buy_usd.sum().alias("buy_usd"),
        pl.col("n").sum().alias("trades"),
        pl.len().alias("agg_trades"),
        pl.col("ts").first().alias("first_ts"),
        pl.col("ts").last().alias("last_ts"),
        pl.col("id").first().alias("first_agg_id"),
        pl.col("id").last().alias("last_agg_id"),
        (pl.when(pl.col("rep")).then(pl.col("qty")).otherwise(0.0).sum() if has_rep else pl.lit(0.0)).alias("repaired_btc"),
    ]


def finish_candles(df: pl.DataFrame) -> pl.DataFrame:
    return df.with_columns(
        sell=pl.col("volume") - pl.col("buy"),
        sell_usd=pl.col("volume_usd") - pl.col("buy_usd"),
    ).with_columns(
        delta=pl.col("buy") - pl.col("sell"),
        delta_usd=pl.col("buy_usd") - pl.col("sell_usd"),
        duration_ms=pl.col("end_ts") - pl.col("start_ts"),
    )


def time_candles(trades: pl.DataFrame, period_ms: int) -> pl.DataFrame:
    """Time candles keyed by open time (UTC ms). Minutes without trades produce no candle."""
    t = with_trade_columns(trades).with_columns(open_time=(pl.col("ts") // period_ms) * period_ms)
    df = (
        t.group_by("open_time", maintain_order=True)
        .agg(candle_aggs("rep" in trades.columns))
        .sort("open_time")
        .with_columns(start_ts=pl.col("open_time"), end_ts=pl.col("open_time") + period_ms)
    )
    return finish_candles(df)


def local_time(ts_col: str, tz: str) -> pl.Expr:
    """Epoch ms (UTC) -> local datetime in tz (DST-aware)."""
    return pl.from_epoch(pl.col(ts_col), time_unit="ms").dt.replace_time_zone("UTC").dt.convert_time_zone(tz)


def add_cvd(df: pl.DataFrame, reset: str = "daily", tz: str = "UTC") -> pl.DataFrame:
    """CVD in BTC and USD. reset: 'none' | 'daily' (00:00 local time in tz, by candle start)."""
    if reset == "none":
        return df.with_columns(cvd=pl.col("delta").cum_sum(), cvd_usd=pl.col("delta_usd").cum_sum())
    day = local_time("start_ts", tz).dt.date()
    return df.with_columns(
        cvd=pl.col("delta").cum_sum().over(day),
        cvd_usd=pl.col("delta_usd").cum_sum().over(day),
    )
