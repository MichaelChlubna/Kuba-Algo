"""Validation of aggTrades-based candles against official Binance klines.

Known, verified sources of difference (see README / metodika.md):
  * boundary spill: one aggTrade groups trades of up to 100 ms; its transact_time is the time of the
    first trade, so the rest may belong to the next candle in klines.
  * skipped trade ids: some ids inside [first_trade_id, last_trade_id] do not exist as trades, so
    last - first + 1 over-counts trades slightly.
  * trades missing in the aggTrades dump: on some days (2026-01 .. 2026-06) the aggTrades files lack
    trades that klines and the raw trades dump contain (agg_trade_id stays contiguous). Detected when
    klines have more volume / trades than boundary spill can explain ("agg gap").
Every mismatch is classified; nothing is adjusted.
"""
from __future__ import annotations

import datetime as dt
import logging
from zoneinfo import ZoneInfo

import polars as pl

from .build import derived_path
from .candles import TIMEFRAMES_MS, time_candles
from .convert import convert_day, parquet_path
from .download import date_range, rel_path

log = logging.getLogger(__name__)

AGG_WINDOW_MS = 100
TOL_BTC = 1e-6
TOL_USD = 1e-2

# (kline column, our column, tolerance)
VOLUME_FIELDS = [
    ("volume", "volume", TOL_BTC),
    ("quote_volume", "volume_usd", TOL_USD),
    ("taker_buy_volume", "buy", TOL_BTC),
    ("taker_buy_quote_volume", "buy_usd", TOL_USD),
]
PRICE_FIELDS = ["open", "high", "low", "close"]


def _spill_stats(trades: pl.DataFrame, period: int) -> pl.DataFrame:
    """Per candle: aggTrades from the last 100 ms of the previous candle that may spill into it."""
    t = trades.with_columns(n=pl.col("last_id") - pl.col("first_id") + 1, usd=pl.col("price") * pl.col("qty"))
    t = t.filter(pl.col("ts") % period >= period - AGG_WINDOW_MS)
    buy = ~pl.col("ibm")
    return t.group_by(((pl.col("ts") // period) + 1) * period).agg(
        pre_volume=pl.col("qty").sum(),
        pre_volume_usd=pl.col("usd").sum(),
        pre_buy=pl.when(buy).then(pl.col("qty")).otherwise(0.0).sum(),
        pre_buy_usd=pl.when(buy).then(pl.col("usd")).otherwise(0.0).sum(),
        pre_extra=(pl.col("n") - 1).sum(),
        pre_prices=pl.col("price").unique(),
    ).rename({"ts": "open_time"})


def compare_day(candles: pl.DataFrame, klines: pl.DataFrame, trades: pl.DataFrame, period: int) -> pl.DataFrame:
    """Return one row per candle with diffs and an explanation for each mismatching field."""
    pre = _spill_stats(trades, period)
    # what spills out of candle X is what spills into X + period
    post = pre.select(
        (pl.col("open_time") - period).alias("open_time"),
        *[pl.col(c).alias(c.replace("pre_", "post_")) for c in pre.columns if c != "open_time"],
    )
    j = (
        klines.join(candles, on="open_time", how="full", suffix="_a", coalesce=True)
        .join(pre, on="open_time", how="left")
        .join(post, on="open_time", how="left")
    )
    num_cols = [c for c in j.columns if c.startswith(("pre_", "post_")) and not c.endswith("prices")]
    j = j.with_columns([pl.col(c).fill_null(0) for c in num_cols]).with_columns(
        pl.col("pre_prices").fill_null(pl.lit([], dtype=pl.List(pl.Float64))),
        pl.col("post_prices").fill_null(pl.lit([], dtype=pl.List(pl.Float64))),
    )
    out = [pl.col("open_time"),
           pl.col("open").is_null().alias("missing_in_klines"),
           pl.col("open_a").is_null().alias("missing_in_ours")]
    for f in PRICE_FIELDS:
        k, a = pl.col(f), pl.col(f + "_a")
        if f == "open":
            expl = pl.col("pre_prices").list.contains(k)
        elif f == "high":
            expl = pl.when(k > a).then(pl.col("pre_prices").list.contains(k)).otherwise(pl.col("post_prices").list.contains(a))
        elif f == "low":
            expl = pl.when(k < a).then(pl.col("pre_prices").list.contains(k)).otherwise(pl.col("post_prices").list.contains(a))
        else:
            expl = pl.col("pre_prices").list.contains(k)
        out += [(k != a).alias(f"{f}_mismatch"), expl.alias(f"{f}_boundary")]
    for kc, ac, tol in VOLUME_FIELDS:
        # columns named the same in klines and ours got the '_a' suffix in the join
        d = pl.col(kc) - pl.col(ac + "_a" if ac in klines.columns else ac)
        pre_c, post_c = "pre_" + ac, "post_" + ac
        out += [d.alias(f"{kc}_diff"),
                (d.abs() > tol).alias(f"{kc}_mismatch"),
                ((d <= pl.col(pre_c) + tol) & (d >= -pl.col(post_c) - tol)).alias(f"{kc}_boundary"),
                # klines have more than any spill could add -> trades missing in the aggTrades dump
                (d > pl.col(pre_c) + tol).alias(f"{kc}_gap")]
    dc = pl.col("count") - pl.col("trades")
    out += [dc.alias("count_diff"), (dc != 0).alias("count_mismatch"),
            # klines may get up to pre_extra more trades (spill in) and fewer (spill out / skipped ids)
            (dc <= pl.col("pre_extra")).alias("count_boundary"),
            (dc > pl.col("pre_extra")).alias("count_gap")]
    return j.select(out)


def _raw_reconcile(cfg: dict, day: dt.date, trades: pl.DataFrame, prev_tail: pl.DataFrame,
                   klines: dict[str, pl.DataFrame]) -> list[str]:
    """Exact decomposition of differences using the raw trades dump (if downloaded)."""
    p = convert_day(cfg, "trades", day)
    if p is None:
        return [f"  raw trades for {day} not downloaded (python -m fp download --datasets trades) - exact check skipped"]
    raw = pl.read_parquet(p)
    lines = []
    # map each raw trade to its aggTrade by id range (previous day's tail: aggTrades spilling over midnight)
    aggs = pl.concat([prev_tail, trades]).select("first_id", "last_id", pl.col("ts").alias("agg_ts"))
    m = raw.join_asof(aggs, left_on="id", right_on="first_id", strategy="backward")
    orphan = m.filter(pl.col("last_id").is_null() | (pl.col("id") > pl.col("last_id"))).height
    # trade ids inside this day's aggTrade ranges that exist in no raw trade (next day's head included)
    raw_ids = raw.select("id")
    nxt = day + dt.timedelta(days=1)
    np_ = convert_day(cfg, "trades", nxt) if (cfg["paths"]["raw"] / rel_path("trades", cfg["symbol"], nxt)).exists() else None
    if np_ is not None:
        raw_ids = pl.concat([raw_ids, pl.scan_parquet(np_).select("id").head(10_000).collect()])
    ids = trades.select(pl.int_ranges("first_id", pl.col("last_id") + 1).alias("id")).explode("id")
    skipped = ids.join(raw_ids, on="id", how="anti").height
    lines.append(f"  raw trades: {raw.height:,}; not covered by any aggTrade: {orphan}; "
                 f"ids inside aggTrade ranges with no trade (skipped ids): {skipped:,}")
    dt_ms = m["ts"] - m["agg_ts"]
    lines.append(f"  trade time - aggTrade time: min {dt_ms.min()} ms, max {dt_ms.max()} ms")
    for tf, kl in klines.items():
        period = TIMEFRAMES_MS[tf]
        rc = time_candles(raw.with_columns(first_id=pl.col("id"), last_id=pl.col("id")), period)
        j = kl.join(rc, on="open_time", how="full", suffix="_r", coalesce=True)
        bad = {f: int((j[f] != j[f + "_r"]).fill_null(True).sum()) for f in PRICE_FIELDS}
        bad["count"] = int((j["count"] != j["trades"]).fill_null(True).sum())
        for kc, ac, tol in VOLUME_FIELDS:
            bad[kc] = int(((j[kc] - j[ac + "_r" if ac in kl.columns else ac]).abs() > tol).fill_null(True).sum())
        moved = m.filter((pl.col("ts") // period) != (pl.col("agg_ts") // period))
        status = "EXACT MATCH" if not any(bad.values()) else f"MISMATCH {bad}"
        lines.append(f"  [{tf}] candles from raw trades vs klines: {status}; "
                     f"raw trades crossing a candle boundary vs. their aggTrade: {moved.height} ({moved['qty'].sum():.3f} BTC)")
    return lines


def validate(cfg: dict, start: dt.date, end: dt.date) -> bool:
    out_dir = cfg["paths"]["derived"].parent / "validation"
    out_dir.mkdir(parents=True, exist_ok=True)
    all_ok = True
    per_tf: dict[str, list[pl.DataFrame]] = {"1m": [], "5m": []}
    raw_lines: list[str] = []
    for day in date_range(start, end):
        tp = parquet_path(cfg, "aggTrades", day)
        if not tp.exists():
            print(f"{day}: no aggTrades parquet, run build first")
            all_ok = False
            continue
        trades = pl.read_parquet(tp)
        # last aggTrades of the previous day may spill into this day's first candle
        pp = parquet_path(cfg, "aggTrades", day - dt.timedelta(days=1))
        prev_tail = pl.read_parquet(pp).tail(1000) if pp.exists() else trades.clear()
        kls = {}
        for tf in per_tf:
            kp, cp = parquet_path(cfg, f"klines_{tf}", day), derived_path(cfg, "candles", tf, day)
            if not (kp.exists() and cp.exists()):
                print(f"{day} {tf}: klines or candles missing, run build first")
                all_ok = False
                continue
            kls[tf] = pl.read_parquet(kp)
            per_tf[tf].append(compare_day(pl.read_parquet(cp), kls[tf], pl.concat([prev_tail, trades]), TIMEFRAMES_MS[tf]))
        raw_lines.append(f"{day}:")
        raw_lines += _raw_reconcile(cfg, day, trades, prev_tail, kls)

    fields = PRICE_FIELDS + [k for k, _, _ in VOLUME_FIELDS] + ["count"]
    for tf, parts in per_tf.items():
        if not parts:
            continue
        df = pl.concat(parts)
        print(f"\n=== {tf}: {df.height} candles ({start} .. {end}) ===")
        miss_k, miss_a = int(df["missing_in_klines"].sum()), int(df["missing_in_ours"].sum())
        print(f"  candles missing in klines: {miss_k}, missing in ours: {miss_a}")
        all_ok &= miss_k == 0 and miss_a == 0
        print(f"  {'field':24s} {'mismatch':>9s} {'boundary':>9s} {'agg gap':>8s} {'unexplained':>11s}  max |diff|")
        for f in fields:
            mm = df[f"{f}_mismatch"].fill_null(False)
            expl = df[f"{f}_boundary"].fill_null(False)
            gap = (df[f"{f}_gap"].fill_null(False) & ~expl) if f"{f}_gap" in df.columns else mm & False
            n_mm, n_b, n_g = int(mm.sum()), int((mm & expl).sum()), int((mm & gap).sum())
            unexpl = n_mm - n_b - n_g
            maxd = df[f"{f}_diff"].abs().max() if f"{f}_diff" in df.columns else None
            print(f"  {f:24s} {n_mm:9d} {n_b:9d} {n_g:8d} {unexpl:11d}  {'' if maxd is None else f'{maxd:.6g}'}")
            if f == "count":
                print(f"  {'':24s} count: klines-ours total {int(df['count_diff'].sum()):+d}; "
                      f"mismatches below the boundary bound are skipped trade ids (verified with raw trades below)")
            else:
                all_ok &= unexpl == 0
        g = df.filter(pl.col("volume_gap").fill_null(False) & ~pl.col("volume_boundary").fill_null(False))
        if g.height:
            per_day = (g.with_columns(day=pl.from_epoch("open_time", time_unit="ms").dt.date())
                        .group_by("day").agg(pl.len().alias("candles"), pl.col("volume_diff").sum().alias("btc"))
                        .sort("btc", descending=True))
            print(f"  agg gap (trades missing in the aggTrades dump): {per_day.height} days, {g.height} candles, "
                  f"~{per_day['btc'].sum():.0f} BTC; worst: " +
                  ", ".join(f"{r['day']} {r['btc']:.0f} BTC" for r in per_day.head(5).iter_rows(named=True)))
        mism = df.filter(pl.any_horizontal([pl.col(f"{f}_mismatch").fill_null(False) for f in fields]))
        dest = out_dir / f"mismatches_{tf}.csv"
        mism.with_columns(pl.from_epoch("open_time", time_unit="ms").alias("open_time_utc")).drop(
            [c for c in mism.columns if c.endswith("prices")]).write_csv(dest)
        print(f"  details: {dest}")

    print("\n=== exact reconciliation with raw trades ===")
    print("\n".join(raw_lines))
    kc_ok = known_cases(cfg)
    print("\nRESULT klines:", "OK - all differences explained (boundary spill, skipped trade ids, trades missing "
          "in the aggTrades dump)" if all_ok else "UNEXPLAINED DIFFERENCES - see above")
    print("RESULT known cases:", "OK" if kc_ok else "FAILED")
    return all_ok and kc_ok


# Known cases from the reference screenshot (USD, approximate +-5 %), 2026-10-08, M5.
KNOWN_A = {"volume_usd": 464e6, "delta_usd": -100e6, "low": 81_830, "high": 82_400}
KNOWN_AFTER_A_DELTAS = [10e6, -1.6e6, 13e6]
KNOWN_B = {"volume_usd": 374e6, "delta_usd": -47e6, "low": 81_710}
KNOWN_B_OFFSET_MS = 50 * 60_000
KNOWN_TOL = 0.05


def _fmt_usd(x: float | None) -> str:
    if x is None:
        return "-"
    a = abs(x)
    return f"{x / 1e6:+.2f}M" if a >= 1e6 else f"{x / 1e3:+.1f}K"


def _within(row: dict, ref: dict) -> dict[str, bool]:
    return {k: abs(row[k] / v - 1) <= KNOWN_TOL for k, v in ref.items()}


def describe_conditions(row: dict, cfg: dict) -> list[str]:
    d = cfg["detector"]
    def mark(ok):
        return "OK  " if ok else "FAIL"
    z = row["z"]
    pb = d.get("poc_bin", 25)
    conds = list(d.get("conditions", ["V1", "V2", "D1", "D2"]))
    lines = [
        f"    valid (H > L): {row['valid']}",
        f"    LONG  V1 z(ln Vol_USD, N={d['n']}) = {z:.3f} >= {d['z_min']}            {mark(row['L_V1'])}" if z is not None else "    LONG  V1 z = n/a (not enough history) FAIL",
        f"    LONG  V2 Vol(K)/Vol = {_fmt_usd(row['lw_vol_usd'])}/{_fmt_usd(row['volume_usd'])} = {row['lw_share']:.3f} >= {d['v2_min']}  {mark(row['L_V2'])}",
        f"    LONG  D1 Delta(K) = {_fmt_usd(row['lw_delta_usd'])} < 0                        {mark(row['L_D1'])}",
        f"    LONG  D2 SellVol(K)/SellVol = {_fmt_usd(row['lw_sell_usd'])}/{_fmt_usd(row['sell_usd'])} = "
        + (f"{row['lw_sell_share']:.3f}" if row['lw_sell_share'] is not None else "n/a") + f" >= {d['d2_min']}  {mark(row['L_D2'])}",
        f"    LONG  P1 volume POC bucket [{row.get(f'vpoc_{pb}')}, +{pb}) entirely below min(O,C)={min(row['open'], row['close'])}"
        f"   {mark(row.get('L_P1'))}{'' if 'P1' in conds else ' (not enabled)'}",
        f"    LONG  P2 delta POC (most negative) bucket [{row.get(f'dpoc_neg_{pb}')}, +{pb}) entirely below min(O,C)"
        f"   {mark(row.get('L_P2'))}{'' if 'P2' in conds else ' (not enabled)'}",
        f"    => long_signal = {row['long_signal']}  (enabled {','.join(conds)}, required {d.get('min_true') or 'all'})",
        f"    SHORT V2 {row['uw_share']:.3f}  D1 {_fmt_usd(row['uw_delta_usd'])}  D2 "
        + (f"{row['uw_buy_share']:.3f}" if row['uw_buy_share'] is not None else "n/a") + f"  => short_signal = {row['short_signal']}",
        f"    features: wick range share {row['lw_range']:.3f}, concentration "
        + (f"{row['lw_conc']:.2f}" if row['lw_conc'] is not None else "n/a")
        + f", Delta(K)/Vol(K) " + (f"{row['lw_delta_ratio']:+.3f}" if row['lw_delta_ratio'] is not None else "n/a")
        + f", delta/vol {row['delta_ratio']:+.3f}, color {row['color']:+d}, close pos {row['close_pos']:.3f}, "
        f"trades {row['trades']:,}, dOI {row['d_oi']:+.1f} BTC" if row['d_oi'] is not None else "",
    ]
    return lines


def known_cases(cfg: dict) -> bool:
    from .build import load_series
    day = dt.date(2026, 10, 8)
    df = load_series(cfg, "5m", day, day)
    print("\n=== known cases 2026-10-08 (M5) ===")
    if df.is_empty():
        print("  series for 2026-10-08 not built")
        return False
    score = sum(((pl.col(k) / v) - 1).abs() for k, v in KNOWN_A.items())
    a = df.with_columns(_score=score).sort("_score").row(0, named=True)
    ok = all(_within(a, KNOWN_A).values())
    tz = ZoneInfo(cfg["server"].get("timezone", "America/New_York"))

    def ts(r):
        t = dt.datetime.fromtimestamp(r["start_ts"] / 1000, dt.timezone.utc)
        return f"{t:%Y-%m-%d %H:%M} UTC ({t.astimezone(tz):%H:%M %Z})"
    print(f"  Candle A: {ts(a)}  O {a['open']} H {a['high']} L {a['low']} C {a['close']}  "
          f"vol {_fmt_usd(a['volume_usd'])}  delta {_fmt_usd(a['delta_usd'])}  "
          f"(all within +-5 % of reference: {ok})")
    print("\n".join(describe_conditions(a, cfg)))
    ok &= bool(a["long_signal"])
    nxt = df.filter(pl.col("start_ts") > a["start_ts"]).head(3)
    print("  Three candles after A (delta sign check):")
    for r, ref in zip(nxt.iter_rows(named=True), KNOWN_AFTER_A_DELTAS):
        sign_ok = (r["delta_usd"] > 0) == (ref > 0)
        ok &= sign_ok
        print(f"    {ts(r)}  delta {_fmt_usd(r['delta_usd'])}  reference ~{_fmt_usd(ref)}  sign {'OK' if sign_ok else 'MISMATCH'}")
    b_rows = df.filter(pl.col("start_ts") == a["start_ts"] + KNOWN_B_OFFSET_MS)
    if b_rows.is_empty():
        print("  Candle B: not found")
        return False
    b = b_rows.row(0, named=True)
    wb = _within(b, KNOWN_B)
    print(f"  Candle B (A + 50 min): {ts(b)}  O {b['open']} H {b['high']} L {b['low']} C {b['close']}  "
          f"vol {_fmt_usd(b['volume_usd'])}  delta {_fmt_usd(b['delta_usd'])}  (within +-5 %: {wb})")
    print("\n".join(describe_conditions(b, cfg)))
    return ok
