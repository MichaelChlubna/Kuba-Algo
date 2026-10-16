"""Per-candle detector features (absorption in wicks), OI delta and rolling statistics."""
from __future__ import annotations

import polars as pl

from .candles import IS_BUY, local_time

# Wick components are computed from individual aggTrades (never from footprint bins).
# Lower wick K = trades with price strictly below min(O, C); upper wick = strictly above max(O, C).
WICK_COLS = ["lw_vol", "lw_buy", "lw_sell", "lw_vol_usd", "lw_buy_usd", "lw_sell_usd",
             "uw_vol", "uw_buy", "uw_sell", "uw_vol_usd", "uw_buy_usd", "uw_sell_usd"]


def wick_components(trades: pl.DataFrame, candles: pl.DataFrame, key: str) -> pl.DataFrame:
    """Raw wick volume components per candle.

    trades: aggTrades with `key` column assigning each trade (or trade piece) to a candle.
    candles: must contain `key`, open, close.
    """
    body = candles.select(key, pl.min_horizontal("open", "close").alias("_lo"), pl.max_horizontal("open", "close").alias("_hi"))
    t = trades.join(body, on=key, how="inner").with_columns(usd=pl.col("price") * pl.col("qty"))
    lw, uw = pl.col("price") < pl.col("_lo"), pl.col("price") > pl.col("_hi")
    buy, sell = IS_BUY, ~IS_BUY

    def s(cond, col):
        return pl.when(cond).then(pl.col(col)).otherwise(0.0).sum()

    agg = t.group_by(key).agg(
        s(lw, "qty").alias("lw_vol"), s(lw & buy, "qty").alias("lw_buy"), s(lw & sell, "qty").alias("lw_sell"),
        s(lw, "usd").alias("lw_vol_usd"), s(lw & buy, "usd").alias("lw_buy_usd"), s(lw & sell, "usd").alias("lw_sell_usd"),
        s(uw, "qty").alias("uw_vol"), s(uw & buy, "qty").alias("uw_buy"), s(uw & sell, "qty").alias("uw_sell"),
        s(uw, "usd").alias("uw_vol_usd"), s(uw & buy, "usd").alias("uw_buy_usd"), s(uw & sell, "usd").alias("uw_sell_usd"),
    )
    return candles.join(agg, on=key, how="left").with_columns([pl.col(c).fill_null(0.0) for c in WICK_COLS])


def _ratio(num: pl.Expr, den: pl.Expr) -> pl.Expr:
    """num/den, 0 when the numerator is 0, null when den is 0 (undefined)."""
    return pl.when(den != 0).then(num / den).otherwise(None)


def static_features(df: pl.DataFrame) -> pl.DataFrame:
    """Features that depend only on the candle itself. Ratios use USD notional."""
    rng = pl.col("high") - pl.col("low")
    lo_body = pl.min_horizontal("open", "close")
    hi_body = pl.max_horizontal("open", "close")
    return df.with_columns(
        valid=rng > 0,  # H == L candles are skipped by the detector
        color=pl.when(pl.col("close") > pl.col("open")).then(1).when(pl.col("close") < pl.col("open")).then(-1).otherwise(0).cast(pl.Int8),
        close_pos=_ratio(pl.col("close") - pl.col("low"), rng),
        delta_ratio=_ratio(pl.col("delta_usd"), pl.col("volume_usd")),
        # lower wick (long side)
        lw_share=_ratio(pl.col("lw_vol_usd"), pl.col("volume_usd")).fill_null(0.0),
        lw_range=_ratio(lo_body - pl.col("low"), rng),
        lw_delta_usd=pl.col("lw_buy_usd") - pl.col("lw_sell_usd"),
        lw_delta_ratio=_ratio(pl.col("lw_buy_usd") - pl.col("lw_sell_usd"), pl.col("lw_vol_usd")),
        lw_sell_share=_ratio(pl.col("lw_sell_usd"), pl.col("sell_usd")),
        # upper wick (short side)
        uw_share=_ratio(pl.col("uw_vol_usd"), pl.col("volume_usd")).fill_null(0.0),
        uw_range=_ratio(pl.col("high") - hi_body, rng),
        uw_delta_usd=pl.col("uw_buy_usd") - pl.col("uw_sell_usd"),
        uw_delta_ratio=_ratio(pl.col("uw_buy_usd") - pl.col("uw_sell_usd"), pl.col("uw_vol_usd")),
        uw_buy_share=_ratio(pl.col("uw_buy_usd"), pl.col("buy_usd")),
    ).with_columns(
        lw_conc=_ratio(pl.col("lw_share"), pl.col("lw_range")),
        uw_conc=_ratio(pl.col("uw_share"), pl.col("uw_range")),
    )


def rolling_z(x: pl.Expr, n: int, lag: int = 1) -> pl.Expr:
    """z-score of x vs. mean/std (ddof=1) of n earlier values ending `lag` rows back (lag=1: the n previous,
    current excluded). Null until all n values exist."""
    prev = x.shift(lag)
    mean = prev.rolling_mean(n, min_samples=n)
    std = prev.rolling_std(n, min_samples=n)
    return pl.when(std > 0).then((x - mean) / std).otherwise(None)


def window_speed(w: int) -> pl.Expr:
    """-ln(time in ms needed to complete the last w volume candles, current included):
    from the close of candle t-w to the close of candle t (gaps between candles included)."""
    span = (pl.col("end_ts") - pl.col("end_ts").shift(w)).clip(lower_bound=1).cast(pl.Float64)
    return -span.log()


def add_rolling(df: pl.DataFrame, n: int, volume_bars: bool = False, window: int = 10) -> pl.DataFrame:
    """V1 statistic.

    Time candles: z of ln(volume_usd) vs the n previous candles.
    Volume candles (experimental): speed of the last `window` candles, z of -ln(span_window) vs the n
    earlier windows that ended before the current window started (no overlap with the current window).
    """
    if volume_bars:
        x = window_speed(window)
        return df.with_columns(vspeed=x, z=rolling_z(x, n, lag=window))
    return df.with_columns(z=rolling_z(pl.col("volume_usd").log(), n))


def add_tod_relative(df: pl.DataFrame, days: int, tz: str = "America/New_York") -> pl.DataFrame:
    """volume_usd / median volume_usd at the same local time of day (in tz, DST-aware) over the previous `days` days.

    Null unless all `days` previous same-time candles exist (not enough history otherwise).
    """
    tod = local_time("start_ts", tz).dt.time()
    prev = pl.col("volume_usd").shift(1)
    med = prev.rolling_median(days, min_samples=days).over(tod, order_by="start_ts")
    return df.with_columns(rel_tod=pl.col("volume_usd") / med)


def add_oi_delta(df: pl.DataFrame, oi: pl.DataFrame) -> pl.DataFrame:
    """ΔOI = OI(last snapshot <= end) - OI(last snapshot <= start), only for candles containing a snapshot.

    oi: columns oi_time (ms, effective snapshot time), oi_btc, oi_usd; sorted by oi_time.
    Candles without a snapshot boundary inside (start, end] get null (no interpolation).
    """
    oi = oi.sort("oi_time")
    snap = oi.select(pl.col("oi_time").alias("_t"), pl.col("oi_btc").alias("_b"), pl.col("oi_usd").alias("_u"), pl.col("oi_time").alias("_st"))
    d = df.with_row_index("_i")
    s = d.select("_i", "start_ts").sort("start_ts").join_asof(snap, left_on="start_ts", right_on="_t", strategy="backward")
    e = d.select("_i", "end_ts").sort("end_ts").join_asof(snap, left_on="end_ts", right_on="_t", strategy="backward")
    j = (d.join(s.select("_i", pl.col("_b").alias("_sb"), pl.col("_u").alias("_su"), pl.col("_st").alias("_sst")), on="_i", how="left")
          .join(e.select("_i", pl.col("_b").alias("_eb"), pl.col("_u").alias("_eu"), pl.col("_st").alias("_est")), on="_i", how="left"))
    has = pl.col("_est").is_not_null() & pl.col("_sst").is_not_null() & (pl.col("_est") > pl.col("_sst"))
    return j.with_columns(
        d_oi=pl.when(has).then(pl.col("_eb") - pl.col("_sb")),
        d_oi_usd=pl.when(has).then(pl.col("_eu") - pl.col("_su")),
        oi_end=pl.col("_eb"),
    ).sort("_i").drop("_i", "_sb", "_su", "_sst", "_eb", "_eu", "_est")


ALL_CONDITIONS = ("V1", "V2", "D1", "D2", "P1", "P2")
DEFAULT_CONDITIONS = ("V1", "V2", "D1", "D2")


def detect(df: pl.DataFrame, z_min: float, v2_min: float, d2_min: float, long: bool = True, short: bool = True,
           conditions=DEFAULT_CONDITIONS, min_true: int | None = None, poc_bin: int = 25) -> pl.DataFrame:
    """Evaluate all conditions for both sides; a signal needs >= min_true of the enabled `conditions`.

    V1 volume z-score, V2 wick volume share, D1 wick delta sign, D2 wick share of sell (buy) volume,
    P1 volume POC bucket lies entirely in the wick, P2 delta POC bucket lies entirely in the wick
    (long: delta POC = most negative delta level, below min(O,C); short: most positive delta level, above
    max(O,C)). Unsatisfiable on null (zero wick, missing POC, ...).
    min_true None = all enabled conditions.
    """
    v = pl.col("valid")
    v1 = (pl.col("z") >= z_min).fill_null(False)
    b = poc_bin
    has_poc = f"vpoc_{b}" in df.columns
    vpoc, dneg, dpos = pl.col(f"vpoc_{b}"), pl.col(f"dpoc_neg_{b}"), pl.col(f"dpoc_pos_{b}")
    false = pl.lit(False)
    out = df.with_columns(
        L_V1=v1,
        L_V2=(pl.col("lw_share") >= v2_min).fill_null(False) & (pl.col("lw_vol_usd") > 0),
        L_D1=(pl.col("lw_delta_usd") < 0).fill_null(False),
        L_D2=(pl.col("lw_sell_share") >= d2_min).fill_null(False),
        # bucket [vpoc, vpoc + b) entirely below min(O, C)
        L_P1=((vpoc + b) <= pl.min_horizontal("open", "close")).fill_null(False) if has_poc else false,
        L_P2=((dneg + b) <= pl.min_horizontal("open", "close")).fill_null(False) if has_poc else false,
        S_V1=v1,
        S_V2=(pl.col("uw_share") >= v2_min).fill_null(False) & (pl.col("uw_vol_usd") > 0),
        S_D1=(pl.col("uw_delta_usd") > 0).fill_null(False),
        S_D2=(pl.col("uw_buy_share") >= d2_min).fill_null(False),
        # bucket entirely above max(O, C)
        S_P1=(vpoc > pl.max_horizontal("open", "close")).fill_null(False) if has_poc else false,
        S_P2=(dpos > pl.max_horizontal("open", "close")).fill_null(False) if has_poc else false,
    )
    conds = [c for c in ALL_CONDITIONS if c in set(conditions)]
    k = len(conds) if min_true is None else max(1, min(int(min_true), len(conds)))

    def sig(side: str, enabled: bool) -> pl.Expr:
        if not conds:
            return pl.lit(False)
        n = pl.sum_horizontal([pl.col(f"{side}_{c}").cast(pl.Int8) for c in conds])
        return pl.lit(enabled) & v & (n >= k)

    return out.with_columns(long_signal=sig("L", long), short_signal=sig("S", short))
