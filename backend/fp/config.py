from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parent.parent


def load_config(path: str | Path | None = None) -> dict[str, Any]:
    """config.yaml (or $FP_CONFIG) with environment overrides for containers:

    FP_DATA_DIR      data root; raw/, parquet/ and derived/ live under it
    FP_HOST, FP_PORT server bind address
    FP_RETENTION_DAYS  rolling window of days kept by `fp update`
    """
    path = Path(path or os.environ.get("FP_CONFIG") or ROOT / "config.yaml")
    with open(path, encoding="utf-8") as f:
        cfg = yaml.safe_load(f)
    data_dir = os.environ.get("FP_DATA_DIR")
    if data_dir:
        cfg["paths"] = {k: Path(data_dir) / k for k in ("raw", "parquet", "derived")}
    for key, value in cfg["paths"].items():
        p = Path(value)
        cfg["paths"][key] = p if p.is_absolute() else (ROOT / p).resolve()
    server = cfg.setdefault("server", {})
    if os.environ.get("FP_HOST"):
        server["host"] = os.environ["FP_HOST"]
    if os.environ.get("FP_PORT"):
        server["port"] = int(os.environ["FP_PORT"])
    if os.environ.get("FP_RETENTION_DAYS"):
        cfg["download"]["retention_days"] = int(os.environ["FP_RETENTION_DAYS"])
    return cfg
