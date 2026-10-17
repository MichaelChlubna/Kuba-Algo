"""Rolling data window for the web deployment: download + build the last N days, drop older ones.

`fp update` is what the scheduler runs once a day (Binance publishes a day's files the next day,
around 07-09 UTC). Sample data (fp sample) is removed once real data has been downloaded, so the two
never mix and an offline update keeps the sample.
"""
from __future__ import annotations

import datetime as dt
import logging
import shutil
import time
from pathlib import Path

from .sample import sample_marker

log = logging.getLogger(__name__)


def window(cfg: dict, days: int | None = None, today: dt.date | None = None) -> tuple[dt.date, dt.date]:
    """[first, last] day of the rolling window ending yesterday (UTC)."""
    days = days or int(cfg["download"].get("retention_days", 30))
    last = (today or dt.datetime.now(dt.timezone.utc).date()) - dt.timedelta(days=1)
    return last - dt.timedelta(days=days - 1), last


def _day_of(p: Path) -> dt.date | None:
    stem = p.name.split(".")[0]
    for cand in (stem, stem[-10:]):   # parquet: YYYY-MM-DD, raw zips: BTCUSDT-aggTrades-YYYY-MM-DD
        try:
            return dt.date.fromisoformat(cand)
        except ValueError:
            continue
    return None


def prune(cfg: dict, keep_from: dt.date) -> int:
    """Delete raw, parquet and derived per-day files older than keep_from. Returns files removed."""
    removed = 0
    for key in ("raw", "parquet", "derived"):
        root = cfg["paths"][key]
        if not root.exists():
            continue
        for p in root.rglob("*"):
            if p.is_file() and (d := _day_of(p)) is not None and d < keep_from:
                p.unlink()
                removed += 1
    if removed:
        log.info("pruned %d files older than %s", removed, keep_from)
    return removed


def clear_sample(cfg: dict) -> bool:
    marker = sample_marker(cfg)
    if not marker.exists():
        return False
    for key in ("parquet", "derived"):
        shutil.rmtree(cfg["paths"][key], ignore_errors=True)
    marker.unlink()
    log.info("removed sample data before the first real update")
    return True


def update(cfg: dict, days: int | None = None) -> None:
    from .build import build
    from .download import download

    first, last = window(cfg, days)
    res = download(cfg, first, last)
    log.info("download %s..%s: %s", first, last, {k: len(v) for k, v in res.items()})
    got = [r for k in ("ok", "skip") for r in res.get(k, []) if "/aggTrades/" in r]
    if not got:   # offline or nothing published: keep whatever data (incl. sample data) is there
        raise RuntimeError(f"no aggTrades downloaded for {first}..{last} (network / data.binance.vision reachable?)")
    clear_sample(cfg)   # real data arrived: sample data must not mix with it
    prune(cfg, first)
    build(cfg, first, last)


def schedule(cfg: dict, at: str = "09:30", days: int | None = None) -> None:
    """Run update now, then every day at `at` (UTC). Never returns."""
    h, m = (int(x) for x in at.split(":"))
    while True:
        try:
            update(cfg, days)
        except Exception:   # keep the scheduler alive; the next run retries
            log.exception("update failed")
        now = dt.datetime.now(dt.timezone.utc)
        nxt = now.replace(hour=h, minute=m, second=0, microsecond=0)
        if nxt <= now:
            nxt += dt.timedelta(days=1)
        log.info("next update at %s UTC", nxt.isoformat(timespec="minutes"))
        time.sleep((nxt - now).total_seconds())
