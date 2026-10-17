"""Idempotent downloader for Binance public daily dumps (USD-M futures)."""
from __future__ import annotations

import datetime as dt
import hashlib
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import requests

log = logging.getLogger(__name__)

# dataset key -> relative path template (under data/futures/um/daily/)
DATASETS = {
    "aggTrades": "aggTrades/{s}/{s}-aggTrades-{d}.zip",
    "metrics": "metrics/{s}/{s}-metrics-{d}.zip",
    "klines_1m": "klines/{s}/1m/{s}-1m-{d}.zip",
    "klines_5m": "klines/{s}/5m/{s}-5m-{d}.zip",
    # optional, only used to explain validation differences (not in the default dataset list)
    "trades": "trades/{s}/{s}-trades-{d}.zip",
}


def date_range(start: dt.date, end: dt.date) -> list[dt.date]:
    return [start + dt.timedelta(days=i) for i in range((end - start).days + 1)]


def rel_path(dataset: str, symbol: str, day: dt.date) -> str:
    return "data/futures/um/daily/" + DATASETS[dataset].format(s=symbol, d=day.isoformat())


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _expected_checksum(checksum_file: Path) -> str:
    # format: "<sha256>  <filename>"
    return checksum_file.read_text().split()[0].strip().lower()


def is_complete(zip_path: Path) -> bool:
    """A file is complete when its .CHECKSUM exists and matches (verified marker cached)."""
    ck = zip_path.with_name(zip_path.name + ".CHECKSUM")
    ok = zip_path.with_name(zip_path.name + ".ok")
    if ok.exists() and zip_path.exists():
        return True
    if not (zip_path.exists() and ck.exists()):
        return False
    if sha256_file(zip_path) == _expected_checksum(ck):
        ok.touch()
        return True
    return False


def _fetch(session: requests.Session, url: str, dest: Path) -> int:
    """Download url to dest atomically. Returns HTTP status (404 => not yet published)."""
    tmp = dest.with_name(dest.name + ".part")
    with session.get(url, stream=True, timeout=60) as r:
        if r.status_code != 200:
            return r.status_code
        dest.parent.mkdir(parents=True, exist_ok=True)
        with open(tmp, "wb") as f:
            for chunk in r.iter_content(1 << 20):
                f.write(chunk)
    tmp.replace(dest)
    return 200


def download_one(session: requests.Session, base_url: str, raw_dir: Path, rel: str, retries: int) -> str:
    dest = raw_dir / rel
    if is_complete(dest):
        return "skip"
    ck = dest.with_name(dest.name + ".CHECKSUM")
    for attempt in range(1, retries + 1):
        try:
            st = _fetch(session, f"{base_url}/{rel}.CHECKSUM", ck)
            if st == 404:
                return "missing"
            if st != 200:
                raise RuntimeError(f"HTTP {st} for checksum")
            st = _fetch(session, f"{base_url}/{rel}", dest)
            if st != 200:
                raise RuntimeError(f"HTTP {st}")
            if is_complete(dest):
                return "ok"
            log.warning("checksum mismatch %s (attempt %d)", rel, attempt)
            dest.unlink(missing_ok=True)
        except (requests.RequestException, RuntimeError) as e:
            log.warning("error %s (attempt %d): %s", rel, attempt, e)
    return "failed"


def download(cfg: dict, start: dt.date, end: dt.date, datasets: list[str] | None = None) -> dict[str, list[str]]:
    dcfg = cfg["download"]
    datasets = datasets or dcfg["datasets"]
    # daily files are published the following day
    last_available = dt.datetime.now(dt.timezone.utc).date() - dt.timedelta(days=1)
    if end > last_available:
        log.warning("end %s clamped to %s (daily files are published the next day)", end, last_available)
        end = last_available
    jobs = [rel_path(ds, cfg["symbol"], d) for d in date_range(start, end) for ds in datasets]
    result: dict[str, list[str]] = {}
    with requests.Session() as session, ThreadPoolExecutor(dcfg.get("workers", 4)) as ex:
        futs = {ex.submit(download_one, session, dcfg["base_url"], cfg["paths"]["raw"], rel, dcfg.get("retries", 3)): rel for rel in jobs}
        for fut in as_completed(futs):
            rel = futs[fut]
            status = fut.result()
            result.setdefault(status, []).append(rel)
            log.info("%-7s %s", status, rel)
    return result
