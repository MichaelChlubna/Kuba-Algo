import polars as pl
import pytest

T0 = 1_791_417_600_000  # 2026-10-08 00:00:00 UTC in ms


def make_trades(rows: list[tuple]) -> pl.DataFrame:
    """rows: (ts_offset_ms, price, qty, is_buyer_maker[, n_trades])"""
    out, tid = [], 100
    for i, r in enumerate(rows):
        off, price, qty, ibm = r[:4]
        n = r[4] if len(r) > 4 else 1
        out.append({"id": i + 1, "price": float(price), "qty": float(qty), "first_id": tid,
                    "last_id": tid + n - 1, "ts": T0 + off, "ibm": ibm})
        tid += n
    return pl.DataFrame(out, schema={"id": pl.Int64, "price": pl.Float64, "qty": pl.Float64, "first_id": pl.Int64,
                                     "last_id": pl.Int64, "ts": pl.Int64, "ibm": pl.Boolean})


@pytest.fixture
def trades_factory():
    return make_trades
