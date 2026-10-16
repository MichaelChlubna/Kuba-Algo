import datetime as dt

import polars as pl
import pytest

from fp.candles import add_cvd
from fp.features import add_tod_relative

NY = "America/New_York"


def ny_ms(y, m, d, hh, mm):
    return int(pl.Series([dt.datetime(y, m, d, hh, mm)]).dt.replace_time_zone(NY).dt.epoch("ms")[0])


def test_tod_relative_follows_ny_time_across_dst():
    # 09:30 NY every day from 2026-10-20 to 2026-11-10 (crosses the 2026-11-01 DST end):
    # 13:30 UTC before, 14:30 UTC after. Decoy candles at the same UTC clock time must not mix in.
    rows = []
    for i in range(22):
        day = dt.date(2026, 10, 20) + dt.timedelta(days=i)
        rows.append({"start_ts": ny_ms(day.year, day.month, day.day, 9, 30), "volume_usd": 100.0 + i})
        decoy = int(dt.datetime(day.year, day.month, day.day, 13, 30, tzinfo=dt.timezone.utc).timestamp() * 1000)
        if decoy != rows[-1]["start_ts"]:
            rows.append({"start_ts": decoy, "volume_usd": 1e9})
    df = add_tod_relative(pl.DataFrame(rows).sort("start_ts"), days=20, tz=NY)
    open_rows = df.filter(pl.col("volume_usd") < 1e6)
    assert open_rows["rel_tod"][:20].is_null().all()
    # day 21: median of previous 20 (100..119) = 109.5, no decoy contamination
    assert open_rows["rel_tod"][20] == pytest.approx(120 / 109.5)


def test_dst_transition_offsets():
    assert ny_ms(2026, 10, 8, 8, 50) == int(dt.datetime(2026, 10, 8, 12, 50, tzinfo=dt.timezone.utc).timestamp() * 1000)
    assert ny_ms(2026, 11, 2, 8, 50) == int(dt.datetime(2026, 11, 2, 13, 50, tzinfo=dt.timezone.utc).timestamp() * 1000)


def test_cvd_reset_in_ny_midnight():
    t0 = ny_ms(2026, 10, 8, 23, 55)  # 03:55 UTC next day
    df = pl.DataFrame({"start_ts": [t0, t0 + 300_000, t0 + 600_000], "delta": [1.0, 2.0, 3.0], "delta_usd": [1.0, 2.0, 3.0]})
    assert add_cvd(df, "daily", NY)["cvd"].to_list() == [1.0, 2.0, 5.0]
    assert add_cvd(df, "daily", "UTC")["cvd"].to_list() == [1.0, 3.0, 6.0]
