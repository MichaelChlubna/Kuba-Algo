"""Intra-candle order-flow metrics (absorption context), stored per candle next to the candle features.

Trade-based metrics use individual aggTrades (or volume-candle pieces); footprint-based metrics use the
base-bin footprint (default 5 USD). All USD values are notional. See README "Metodika".
"""
from __future__ import annotations

import polars as pl

from .candles import IS_BUY

DEFAULTS = {"imbalance_ratio": 3.0, "imbalance_min_usd": 50_000.0, "stack_min": 3, "big_trade_btc": 5.0}

METRIC_COLS = [
    # delta path inside the candle
    "dpath_min_usd", "dpath_max_usd", "d_recov_l_usd", "d_recov_l_ratio", "d_recov_s_usd", "d_recov_s_ratio",
    "t_low_frac", "t_high_frac", "t_dmin_frac", "t_dmax_frac",
    # auction / exhaustion at the extremes (base bin)
    "low_buy_usd", "low_sell_usd", "high_buy_usd", "high_sell_usd", "unfinished_low", "unfinished_high",
    "exh_low", "exh_low2", "exh_high", "exh_high2",
    # diagonal imbalances inside the wicks (base bin)
    "lw_buy_imb", "lw_sell_imb", "lw_buy_stack", "lw_sell_stack",
    "uw_buy_imb", "uw_sell_imb", "uw_buy_stack", "uw_sell_stack",
    # effort vs result (USD traded per 1 USD of price travelled)
    "lw_effort", "uw_effort", "body_effort", "lw_effort_ratio", "uw_effort_ratio",
    # large trades
    "lw_big_buy_usd", "lw_big_sell_usd", "uw_big_buy_usd", "uw_big_sell_usd", "lw_big_count", "uw_big_count",
    "lw_big_share", "uw_big_share", "lw_big_sell_share", "uw_big_buy_share",
    # intensity
    "lw_trades", "uw_trades", "body_trades", "body_vol_usd",
    "lw_avg_trade_usd", "uw_avg_trade_usd", "body_avg_trade_usd", "lw_size_ratio", "uw_size_ratio",
    "lw_rate", "uw_rate", "body_rate", "lw_rate_ratio", "uw_rate_ratio",
    # time spent in the wicks
    "lw_time_ms", "uw_time_ms", "lw_time_frac", "uw_time_frac",
    # open interest vs volume (filled in the range-level stage)
    "oi_vol_ratio",
]


def _ratio(a: pl.Expr, b: pl.Expr) -> pl.Expr:
    return pl.when(b != 0).then(a / b)


def _trade_metrics(trades: pl.DataFrame, candles: pl.DataFrame, key: str, big_btc: float) -> pl.DataFrame:
    c = candles.select(key, "open", "close", "high", "low", pl.col("start_ts").alias("_cs"), pl.col("end_ts").alias("_ce"))
    t = trades
    if "usd" not in t.columns:
        t = t.with_columns(usd=pl.col("price") * pl.col("qty"))
    if "n" not in t.columns:
        t = t.with_columns(n=pl.col("last_id") - pl.col("first_id") + 1)
    if "tqty" not in t.columns:   # original aggTrade size (differs from qty only for split volume-candle pieces)
        t = t.with_columns(tqty=pl.col("qty"))
    t = t.select(key, "first_id", "price", "usd", "n", "tqty", "ts", "ibm").join(c, on=key, how="inner").sort(key, "first_id")
    lo_b, hi_b = pl.min_horizontal("open", "close"), pl.max_horizontal("open", "close")
    t = t.with_columns(
        _lw=pl.col("price") < lo_b,
        _uw=pl.col("price") > hi_b,
        _cum=pl.when(IS_BUY).then(pl.col("usd")).otherwise(-pl.col("usd")).cum_sum().over(key),
        _next=pl.col("ts").shift(-1).over(key),
    ).with_columns(
        _body=~pl.col("_lw") & ~pl.col("_uw"),
        # price holds from a trade until the next one (last trade: until the candle end)
        _dt=(pl.coalesce("_next", "_ce") - pl.col("ts")).clip(lower_bound=0),
        _big=pl.col("tqty") >= big_btc,
    )
    lw, uw, body, big, buy = pl.col("_lw"), pl.col("_uw"), pl.col("_body"), pl.col("_big"), IS_BUY

    def s(cond: pl.Expr, col: str) -> pl.Expr:
        return pl.when(cond).then(pl.col(col)).otherwise(0).sum()

    return t.group_by(key).agg(
        dpath_min_usd=pl.col("_cum").min().clip(upper_bound=0.0),
        dpath_max_usd=pl.col("_cum").max().clip(lower_bound=0.0),
        _t_dmin=pl.col("ts").sort_by(["_cum", "first_id"]).first(),
        _t_dmax=pl.col("ts").sort_by(["_cum", "first_id"], descending=[True, False]).first(),
        _t_low=pl.col("ts").filter(pl.col("price") == pl.col("low")).first(),
        _t_high=pl.col("ts").filter(pl.col("price") == pl.col("high")).first(),
        lw_time_ms=s(lw, "_dt"), uw_time_ms=s(uw, "_dt"), _body_time=s(body, "_dt"),
        lw_trades=s(lw, "n"), uw_trades=s(uw, "n"), body_trades=s(body, "n"),
        body_vol_usd=s(body, "usd"),
        lw_big_buy_usd=s(lw & big & buy, "usd"), lw_big_sell_usd=s(lw & big & ~buy, "usd"),
        uw_big_buy_usd=s(uw & big & buy, "usd"), uw_big_sell_usd=s(uw & big & ~buy, "usd"),
        lw_big_count=(lw & big).sum(), uw_big_count=(uw & big).sum(),
    )


def _stack(f: pl.DataFrame, key: str, mask: str, zone: str, bin_usd: int, name: str) -> pl.DataFrame:
    """Longest run of consecutive price levels (step = bin) with the imbalance flag inside the zone."""
    r = f.filter(pl.col(mask) & pl.col(zone)).sort(key, "level")
    if r.is_empty():
        return pl.DataFrame(schema={key: f.schema[key], name: pl.UInt32})
    r = r.with_columns(_g=(pl.col("level") // bin_usd) - pl.int_range(pl.len()).over(key))
    return r.group_by(key, "_g").len().group_by(key).agg(pl.col("len").max().alias(name))


def _footprint_metrics(fp: pl.DataFrame, candles: pl.DataFrame, key: str, bin_usd: int, ratio: float, min_usd: float) -> pl.DataFrame:
    c = candles.select(key, pl.min_horizontal("open", "close").alias("_lo"), pl.max_horizontal("open", "close").alias("_hi"))
    base = fp.select(key, "level", "buy_usd", "sell_usd", (pl.col("buy_usd") + pl.col("sell_usd")).alias("total_usd"))
    below = base.select(key, (pl.col("level") + bin_usd).alias("level"), pl.col("sell_usd").alias("_sell_below"))
    above = base.select(key, (pl.col("level") - bin_usd).alias("level"), pl.col("buy_usd").alias("_buy_above"))
    f = (base.join(c, on=key, how="inner")
         .join(below, on=[key, "level"], how="left")
         .join(above, on=[key, "level"], how="left")
         .with_columns(
             # diagonal imbalance: aggressive buys at L vs aggressive sells one level below (and mirrored)
             _bimb=(pl.col("buy_usd") >= min_usd) & (pl.col("buy_usd") >= ratio * pl.col("_sell_below").fill_null(0.0)),
             _simb=(pl.col("sell_usd") >= min_usd) & (pl.col("sell_usd") >= ratio * pl.col("_buy_above").fill_null(0.0)),
             _in_lw=(pl.col("level") + bin_usd) <= pl.col("_lo"),   # bucket entirely in the wick (as P1)
             _in_uw=pl.col("level") > pl.col("_hi"),
         ))
    lv = pl.col("level")
    ext = f.group_by(key).agg(
        low_buy_usd=pl.col("buy_usd").sort_by(lv).first(), low_sell_usd=pl.col("sell_usd").sort_by(lv).first(),
        high_buy_usd=pl.col("buy_usd").sort_by(lv).last(), high_sell_usd=pl.col("sell_usd").sort_by(lv).last(),
        _low_tot=pl.col("total_usd").sort_by(lv).first(), _low2_tot=pl.col("total_usd").sort_by(lv).head(2).sum(),
        _high_tot=pl.col("total_usd").sort_by(lv).last(), _high2_tot=pl.col("total_usd").sort_by(lv).tail(2).sum(),
        _poc_tot=pl.col("total_usd").max(),
        lw_buy_imb=(pl.col("_bimb") & pl.col("_in_lw")).sum(), lw_sell_imb=(pl.col("_simb") & pl.col("_in_lw")).sum(),
        uw_buy_imb=(pl.col("_bimb") & pl.col("_in_uw")).sum(), uw_sell_imb=(pl.col("_simb") & pl.col("_in_uw")).sum(),
    )
    for mask, zone, name in [("_bimb", "_in_lw", "lw_buy_stack"), ("_simb", "_in_lw", "lw_sell_stack"),
                             ("_bimb", "_in_uw", "uw_buy_stack"), ("_simb", "_in_uw", "uw_sell_stack")]:
        ext = ext.join(_stack(f, key, mask, zone, bin_usd, name), on=key, how="left")
    return ext


def add_candle_metrics(candles: pl.DataFrame, trades: pl.DataFrame, fp: pl.DataFrame, key: str,
                       base_bin: int, mcfg: dict | None = None) -> pl.DataFrame:
    """candles: with wick features; trades/pieces carrying `key`; fp: base-bin footprint keyed by `key`."""
    m = {**DEFAULTS, **(mcfg or {})}
    df = (candles
          .join(_trade_metrics(trades, candles, key, m["big_trade_btc"]), on=key, how="left")
          .join(_footprint_metrics(fp, candles, key, base_bin, m["imbalance_ratio"], m["imbalance_min_usd"]), on=key, how="left"))
    dur = pl.col("duration_ms").cast(pl.Float64)
    lo_b, hi_b = pl.min_horizontal("open", "close"), pl.max_horizontal("open", "close")
    lw_s = pl.col("lw_time_ms") / 1000
    uw_s = pl.col("uw_time_ms") / 1000
    body_s = pl.col("_body_time") / 1000
    df = df.with_columns(
        [pl.col(c).fill_null(0) for c in ("lw_buy_imb", "lw_sell_imb", "uw_buy_imb", "uw_sell_imb",
                                          "lw_buy_stack", "lw_sell_stack", "uw_buy_stack", "uw_sell_stack")]
    ).with_columns(
        d_recov_l_usd=pl.col("delta_usd") - pl.col("dpath_min_usd"),
        d_recov_s_usd=pl.col("dpath_max_usd") - pl.col("delta_usd"),
        t_low_frac=_ratio((pl.col("_t_low") - pl.col("start_ts")).cast(pl.Float64), dur),
        t_high_frac=_ratio((pl.col("_t_high") - pl.col("start_ts")).cast(pl.Float64), dur),
        t_dmin_frac=_ratio((pl.col("_t_dmin") - pl.col("start_ts")).cast(pl.Float64), dur),
        t_dmax_frac=_ratio((pl.col("_t_dmax") - pl.col("start_ts")).cast(pl.Float64), dur),
        unfinished_low=(pl.col("low_buy_usd") > 0) & (pl.col("low_sell_usd") > 0),
        unfinished_high=(pl.col("high_buy_usd") > 0) & (pl.col("high_sell_usd") > 0),
        exh_low=_ratio(pl.col("_low_tot"), pl.col("_poc_tot")), exh_low2=_ratio(pl.col("_low2_tot"), pl.col("_poc_tot")),
        exh_high=_ratio(pl.col("_high_tot"), pl.col("_poc_tot")), exh_high2=_ratio(pl.col("_high2_tot"), pl.col("_poc_tot")),
        lw_effort=_ratio(pl.col("lw_vol_usd"), lo_b - pl.col("low")),
        uw_effort=_ratio(pl.col("uw_vol_usd"), pl.col("high") - hi_b),
        body_effort=_ratio(pl.col("body_vol_usd"), (pl.col("close") - pl.col("open")).abs()),
        lw_big_share=_ratio(pl.col("lw_big_buy_usd") + pl.col("lw_big_sell_usd"), pl.col("lw_vol_usd")),
        uw_big_share=_ratio(pl.col("uw_big_buy_usd") + pl.col("uw_big_sell_usd"), pl.col("uw_vol_usd")),
        lw_big_sell_share=_ratio(pl.col("lw_big_sell_usd"), pl.col("lw_sell_usd")),
        uw_big_buy_share=_ratio(pl.col("uw_big_buy_usd"), pl.col("uw_buy_usd")),
        lw_avg_trade_usd=_ratio(pl.col("lw_vol_usd"), pl.col("lw_trades").cast(pl.Float64)),
        uw_avg_trade_usd=_ratio(pl.col("uw_vol_usd"), pl.col("uw_trades").cast(pl.Float64)),
        body_avg_trade_usd=_ratio(pl.col("body_vol_usd"), pl.col("body_trades").cast(pl.Float64)),
        lw_rate=_ratio(pl.col("lw_trades").cast(pl.Float64), lw_s),
        uw_rate=_ratio(pl.col("uw_trades").cast(pl.Float64), uw_s),
        body_rate=_ratio(pl.col("body_trades").cast(pl.Float64), body_s),
        lw_time_frac=_ratio(pl.col("lw_time_ms").cast(pl.Float64), dur),
        uw_time_frac=_ratio(pl.col("uw_time_ms").cast(pl.Float64), dur),
    ).with_columns(
        d_recov_l_ratio=_ratio(pl.col("d_recov_l_usd"), -pl.col("dpath_min_usd")),
        d_recov_s_ratio=_ratio(pl.col("d_recov_s_usd"), pl.col("dpath_max_usd")),
        lw_effort_ratio=_ratio(pl.col("lw_effort"), pl.col("body_effort")),
        uw_effort_ratio=_ratio(pl.col("uw_effort"), pl.col("body_effort")),
        lw_size_ratio=_ratio(pl.col("lw_avg_trade_usd"), pl.col("body_avg_trade_usd")),
        uw_size_ratio=_ratio(pl.col("uw_avg_trade_usd"), pl.col("body_avg_trade_usd")),
        lw_rate_ratio=_ratio(pl.col("lw_rate"), pl.col("body_rate")),
        uw_rate_ratio=_ratio(pl.col("uw_rate"), pl.col("body_rate")),
    )
    return df.drop([c for c in df.columns if c.startswith("_")])


def add_oi_vol_ratio(df: pl.DataFrame) -> pl.DataFrame:
    """ΔOI / volume (both BTC): share of the traded volume that changed open interest (null without ΔOI)."""
    return df.with_columns(oi_vol_ratio=_ratio(pl.col("d_oi"), pl.col("volume")))
