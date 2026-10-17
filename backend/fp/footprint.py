"""Footprint: per candle and price level taker buy/sell volume."""
from __future__ import annotations

import polars as pl

from .candles import IS_BUY

PRICE_TICK = 0.1  # BTCUSDT perp tick size (verified: prices have 1 decimal)


def level_expr(bin_usd: int) -> pl.Expr:
    """floor(price / bin) * bin, computed on integer ticks to avoid float rounding at bin edges."""
    ticks = (pl.col("price") / PRICE_TICK).round(0).cast(pl.Int64)
    step = int(round(bin_usd / PRICE_TICK))
    return ((ticks // step) * bin_usd).cast(pl.Int64)


def footprint(trades: pl.DataFrame, key: str, bin_usd: int) -> pl.DataFrame:
    """trades must carry `key` (candle id). Returns key, level (USD, lower edge of the bin) and volumes."""
    t = trades.with_columns(level=level_expr(bin_usd), usd=pl.col("price") * pl.col("qty"))
    buy = IS_BUY
    return (
        t.group_by(key, "level")
        .agg(
            buy=pl.when(buy).then(pl.col("qty")).otherwise(0.0).sum(),
            sell=pl.when(~buy).then(pl.col("qty")).otherwise(0.0).sum(),
            buy_usd=pl.when(buy).then(pl.col("usd")).otherwise(0.0).sum(),
            sell_usd=pl.when(~buy).then(pl.col("usd")).otherwise(0.0).sum(),
        )
        .with_columns(
            delta=pl.col("buy") - pl.col("sell"),
            total=pl.col("buy") + pl.col("sell"),
            delta_usd=pl.col("buy_usd") - pl.col("sell_usd"),
            total_usd=pl.col("buy_usd") + pl.col("sell_usd"),
        )
        .sort(key, "level")
    )


def rebin(fp: pl.DataFrame, key: str, bin_usd: int) -> pl.DataFrame:
    """Re-aggregate a base-bin footprint to a coarser bin (bin must be a multiple of the base bin)."""
    cols = ["buy", "sell", "buy_usd", "sell_usd", "delta", "total", "delta_usd", "total_usd"]
    return (
        fp.with_columns(level=(pl.col("level") // bin_usd) * bin_usd)
        .group_by(key, "level")
        .agg([pl.col(c).sum() for c in cols])
        .sort(key, "level")
    )


POC_BINS = (5, 10, 25, 50, 100)


def poc_features(fp: pl.DataFrame, key: str, base_bin: int, bins=POC_BINS) -> pl.DataFrame:
    """Per candle and bin size: volume POC and delta POC levels (lower bucket edge, USD notional).

    vpoc_<b>     level with the largest total volume (ties: lowest level)
    dpoc_neg_<b> level with the most negative delta (sellers dominate most), null if no level has delta < 0
    dpoc_pos_<b> level with the most positive delta (buyers dominate most), null if no level has delta > 0
    """
    out = None
    for b in (b for b in bins if b % base_bin == 0):
        r = fp if b == base_bin else rebin(fp, key, b)
        g = r.group_by(key).agg(
            pl.col("level").sort_by(["total_usd", "level"], descending=[True, False]).first().alias(f"vpoc_{b}"),
            pl.when(pl.col("delta_usd").min() < 0)
            .then(pl.col("level").sort_by(["delta_usd", "level"]).first()).alias(f"dpoc_neg_{b}"),
            pl.when(pl.col("delta_usd").max() > 0)
            .then(pl.col("level").sort_by(["delta_usd", "level"], descending=[True, False]).first()).alias(f"dpoc_pos_{b}"),
        )
        out = g if out is None else out.join(g, on=key, how="full", coalesce=True)
    return out
