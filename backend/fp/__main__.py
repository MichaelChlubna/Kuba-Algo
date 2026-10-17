from __future__ import annotations

import argparse
import datetime as dt
import logging

from .config import load_config


def _date(s: str) -> dt.date:
    """ISO date, or 'today' / 'yesterday' (UTC)."""
    today = dt.datetime.now(dt.timezone.utc).date()
    if s == "today":
        return today
    if s == "yesterday":
        return today - dt.timedelta(days=1)
    return dt.date.fromisoformat(s)


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="fp", description="BTCUSDT perp footprint pipeline")
    p.add_argument("--config", default=None)
    p.add_argument("-v", "--verbose", action="store_true")
    sub = p.add_subparsers(dest="cmd", required=True)

    def add_range(sp):
        sp.add_argument("--start", type=_date, default=None)
        sp.add_argument("--end", type=_date, default=None)

    sp = sub.add_parser("download", help="download daily zips from data.binance.vision")
    add_range(sp)
    sp.add_argument("--datasets", nargs="+", default=None)

    sp = sub.add_parser("build", help="convert raw CSV to parquet and build candles/footprint/features")
    add_range(sp)
    sp.add_argument("--force", action="store_true")

    sp = sub.add_parser("validate", help="validate candles against official klines and known cases")
    add_range(sp)

    sp = sub.add_parser("serve", help="run local footprint viewer")
    sp.add_argument("--host", default=None)
    sp.add_argument("--port", type=int, default=None)

    args = p.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    cfg = load_config(args.config)
    start = getattr(args, "start", None) or _date(str(cfg["download"]["start"]))
    end = getattr(args, "end", None) or _date(str(cfg["download"]["end"]))

    if args.cmd == "download":
        from .download import download
        res = download(cfg, start, end, args.datasets)
        print({k: len(v) for k, v in res.items()})
        for k in ("missing", "failed"):
            for rel in sorted(res.get(k, [])):
                print(f"{k}: {rel}")
    elif args.cmd == "build":
        from .build import build
        build(cfg, start, end, force=args.force)
    elif args.cmd == "validate":
        from .validate import validate
        validate(cfg, start, end)
    elif args.cmd == "serve":
        from .server import serve
        serve(cfg, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
