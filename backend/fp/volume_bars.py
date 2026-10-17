"""Volume candles: a candle closes when its volume reaches a threshold (USD notional or BTC).

Tick candles (`vtick_<N>`) use the same machinery: a candle closes after N aggTrades (rows of the
aggTrades dump, not individual trades, so an aggTrade is never split).

The aggTrade that crosses the threshold is split (same price and side); the remainder starts the next
candle. State (accumulated volume of the open candle, its pieces, next candle id) continues across days.

Exact integer arithmetic: BTC in units of 0.001 (qty step), USD notional in units of 0.0001
(price tick 0.1 x qty step 0.001), so splitting never loses or invents volume.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass

import polars as pl

QTY_SCALE = 1000    # 1 unit = 0.001 BTC
PRICE_SCALE = 10    # 1 tick = 0.1 USD
USD_SCALE = QTY_SCALE * PRICE_SCALE  # 1 unit = 0.0001 USD

_NAME = re.compile(r"^v(usd|btc|tick)_(\d+(?:\.\d+)?)$")

LIMITS = {"usd": (1e6, 1e11), "btc": (10.0, 1e6), "tick": (10.0, 1e7)}


def agg_name(unit: str, value: float) -> str:
    v = float(value)
    return f"v{unit}_{int(v) if v.is_integer() else v}"


def parse_agg(name: str) -> tuple[str, float] | None:
    m = _NAME.match(name)
    return (m.group(1), float(m.group(2))) if m else None


def is_volume_agg(name: str) -> bool:
    return parse_agg(name) is not None


def threshold_units(unit: str, value: float) -> int:
    if unit == "tick":
        return int(round(value))
    return int(round(value * (USD_SCALE if unit == "usd" else QTY_SCALE)))


@dataclass
class State:
    acc: int = 0          # volume units already in the open candle
    next_id: int = 0      # id of the open candle
    carry: pl.DataFrame | None = None  # pieces of the open candle

    def to_json(self) -> str:
        return json.dumps({"acc": self.acc, "next_id": self.next_id})

    @classmethod
    def from_json(cls, s: str, carry: pl.DataFrame | None) -> "State":
        d = json.loads(s)
        return cls(acc=int(d["acc"]), next_id=int(d["next_id"]), carry=carry)


PIECE_COLS = ["cid", "id", "first_id", "price", "qty", "usd", "n", "tqty", "ts", "ibm", "rep"]


def split_pieces(trades: pl.DataFrame, unit: str, T: int, state: State) -> tuple[pl.DataFrame, State]:
    """Assign trades (sorted by id) to volume candles, splitting threshold-crossing trades.

    Returns (pieces of this batch incl. carried-over open pieces, new state). Every piece has the
    candle id `cid`; candles with cid < new_state.next_id are complete.
    """
    qty_u = (pl.col("qty") * QTY_SCALE).round(0).cast(pl.Int64)
    price_u = (pl.col("price") * PRICE_SCALE).round(0).cast(pl.Int64)
    m = qty_u * price_u if unit == "usd" else pl.lit(1, dtype=pl.Int64) if unit == "tick" else qty_u
    t = trades.with_columns(_qu=qty_u, _pu=price_u, _m=m).with_columns(_ce=pl.col("_m").cum_sum() + state.acc)
    t = t.with_columns(_cs=pl.col("_ce") - pl.col("_m"))
    t = t.with_columns(_k0=pl.col("_cs") // T, _k1=(pl.col("_ce") - 1) // T)
    p = t.with_columns(_k=pl.int_ranges(pl.col("_k0"), pl.col("_k1") + 1)).explode("_k")
    lo = pl.max_horizontal(pl.col("_cs"), pl.col("_k") * T)
    hi = pl.min_horizontal(pl.col("_ce"), (pl.col("_k") + 1) * T)
    amt = hi - lo
    if unit == "usd":
        qty = amt / pl.col("_pu") / QTY_SCALE
        usd = amt / USD_SCALE
    elif unit == "tick":   # one aggTrade per unit, never split
        qty = pl.col("qty")
        usd = pl.col("price") * pl.col("qty")
    else:
        qty = amt / QTY_SCALE
        usd = pl.col("price") * amt / QTY_SCALE
    pieces = p.select(
        (pl.col("_k") + state.next_id).alias("cid"),
        "id", "first_id", "price",
        qty.alias("qty"),
        usd.alias("usd"),
        # trade count goes to the candle holding the first piece of the aggTrade
        pl.when(pl.col("_k") == pl.col("_k0")).then(pl.col("last_id") - pl.col("first_id") + 1).otherwise(0).alias("n"),
        pl.col("qty").alias("tqty"),   # original aggTrade size (large-trade metrics)
        "ts", "ibm",
        (pl.col("rep") if "rep" in trades.columns else pl.lit(False)).alias("rep"),
    )
    total = state.acc + (int(t["_m"].sum()) if t.height else 0)
    new_next = state.next_id + total // T
    if state.carry is not None and state.carry.height:
        carry = state.carry
        for col, val in (("first_id", pl.col("id")), ("rep", pl.lit(False))):   # carries saved by older builds
            if col not in carry.columns:
                carry = carry.with_columns(val.alias(col))
        pieces = pl.concat([carry.select(PIECE_COLS), pieces])
    new_state = State(acc=total % T, next_id=new_next, carry=pieces.filter(pl.col("cid") >= new_next))
    return pieces, new_state


def aggregate_volume_candles(pieces: pl.DataFrame) -> pl.DataFrame:
    """Candles from complete pieces. Candle time = first trade (open), end = last trade."""
    from .candles import candle_aggs, finish_candles

    df = pieces.group_by("cid", maintain_order=True).agg(candle_aggs("rep" in pieces.columns)).sort("cid")
    df = df.with_columns(start_ts=pl.col("first_ts"), end_ts=pl.col("last_ts"))
    return finish_candles(df)
