"""Synthetic sample dataset: deterministic aggTrades + OI metrics per day, written as parquet.

Lets the whole stack (build, API, viewer, golden tests) run without downloading from Binance.
The days are marked as sample data (`SAMPLE` file in the data root) so that `fp update` replaces
them with real data instead of keeping them.
"""
from __future__ import annotations

import datetime as dt
import logging
import math
import random
from pathlib import Path

import polars as pl

from .convert import parquet_path
from .download import date_range

log = logging.getLogger(__name__)

DAY_MS = 86_400_000
TRADES_PER_DAY = 50_000


def sample_marker(cfg: dict) -> Path:
    return cfg["paths"]["parquet"].parent / "SAMPLE"


def _day_ms(day: dt.date) -> int:
    return int(dt.datetime(day.year, day.month, day.day, tzinfo=dt.timezone.utc).timestamp() * 1000)


def sample_trades(day: dt.date, start_price: float, first_id: int, first_trade_id: int,
                  n: int = TRADES_PER_DAY, seed: int = 7) -> pl.DataFrame:
    """One day of synthetic aggTrades (sorted by id, BTCUSDT-like tick 0.1 / qty step 0.001)."""
    rnd = random.Random(seed * 100_003 + day.toordinal())
    t0 = _day_ms(day)
    gaps = [rnd.expovariate(1.0) for _ in range(n)]
    scale = (DAY_MS - 1) / sum(gaps)
    price, trend, ts, tid = start_price, 0.0, float(t0), first_trade_id
    rows = {k: [] for k in ("id", "price", "qty", "first_id", "last_id", "ts", "ibm")}
    for i in range(n):
        ts += gaps[i] * scale
        trend = 0.995 * trend + rnd.gauss(0, 0.06)
        step = rnd.gauss(trend, 5.0) + (rnd.choice((-1, 1)) * rnd.uniform(20, 80) if rnd.random() < 0.0005 else 0.0)
        price = max(1000.0, price + step)
        buy = rnd.random() < 0.5 + max(-0.3, min(0.3, trend / 4))
        qty = math.exp(rnd.gauss(-1.6, 1.1))
        if rnd.random() < 0.004:
            qty += rnd.uniform(5, 25)   # occasional large trade
        k = 1 + int(rnd.expovariate(0.6))
        rows["id"].append(first_id + i)
        rows["price"].append(round(price, 1))
        rows["qty"].append(max(0.001, round(qty, 3)))
        rows["first_id"].append(tid)
        rows["last_id"].append(tid + k - 1)
        rows["ts"].append(min(int(ts), t0 + DAY_MS - 1))
        rows["ibm"].append(not buy)
        tid += k
    return pl.DataFrame(rows, schema={"id": pl.Int64, "price": pl.Float64, "qty": pl.Float64, "first_id": pl.Int64,
                                      "last_id": pl.Int64, "ts": pl.Int64, "ibm": pl.Boolean}).with_columns(rep=pl.lit(False))


def sample_metrics(day: dt.date, trades: pl.DataFrame, oi_start: float, seed: int = 7) -> pl.DataFrame:
    """288 OI snapshots per day (create_time every 5 min, oi_time = create_time + 5 min)."""
    rnd = random.Random(seed * 7_919 + day.toordinal())
    t0 = _day_ms(day)
    create = [t0 + k * 300_000 for k in range(288)]
    last = trades.select(pl.col("ts"), pl.col("price")).sort("ts")
    oi, out_btc, out_usd = oi_start, [], []
    for c in create:
        oi = max(1_000.0, oi + rnd.gauss(0, 60))
        px = last.filter(pl.col("ts") <= c + 300_000)["price"]
        p = px[-1] if px.len() else last["price"][0]
        out_btc.append(round(oi, 3))
        out_usd.append(round(oi * p, 2))
    return pl.DataFrame({"create_time": create, "oi_time": [c + 300_000 for c in create],
                         "oi_btc": out_btc, "oi_usd": out_usd},
                        schema={"create_time": pl.Int64, "oi_time": pl.Int64, "oi_btc": pl.Float64, "oi_usd": pl.Float64})


def _write(df: pl.DataFrame, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".tmp")
    df.write_parquet(tmp, compression="zstd")
    tmp.replace(dest)


def write_sample(cfg: dict, start: dt.date, end: dt.date, n: int = TRADES_PER_DAY, seed: int = 7) -> list[dt.date]:
    """Write synthetic parquet days [start, end]. Refuses to mix with real (downloaded) data."""
    agg_dir = cfg["paths"]["parquet"] / "aggTrades" / cfg["symbol"]
    marker = sample_marker(cfg)
    if agg_dir.exists() and any(agg_dir.glob("*.parquet")) and not marker.exists():
        raise RuntimeError(f"{agg_dir} already holds real data; sample data is only written into an empty data folder")
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text("synthetic sample data (fp sample); `fp update` replaces it with real Binance data\n")
    price, oi, fid, tid = 82_000.0, 90_000.0, 1_000_000, 5_000_000
    written = []
    for day in date_range(start, end):
        trades = sample_trades(day, price, fid, tid, n, seed)
        metrics = sample_metrics(day, trades, oi, seed)
        price, oi = trades["price"][-1], metrics["oi_btc"][-1]
        fid, tid = trades["id"][-1] + 1, trades["last_id"][-1] + 1
        _write(trades, parquet_path(cfg, "aggTrades", day))
        _write(metrics, parquet_path(cfg, "metrics", day))
        written.append(day)
        log.info("sample day %s: %d aggTrades, close %.1f", day, trades.height, price)
    return written
