import datetime as dt

import polars as pl
import pytest

from fp.periods import assign_periods, compute_periods

NY = "America/New_York"


def ny(y, m, d, hh, mm):
    return int(pl.Series([dt.datetime(y, m, d, hh, mm)]).dt.replace_time_zone(NY).dt.epoch("ms")[0])


def kinds(ts, tz=NY):
    a = assign_periods(pl.DataFrame({"start_ts": [ts]}), tz)
    return {(r["kind"], r["name"], r["key"]) for r in a.iter_rows(named=True)}


def test_sessions_in_ny_time_and_wrap_to_next_day():
    assert kinds(ny(2026, 10, 7, 20, 0)) == {("day", "Day", "2026-10-07"), ("session", "Asia", "2026-10-08")}
    assert kinds(ny(2026, 10, 8, 2, 55)) == {("day", "Day", "2026-10-08"), ("session", "Asia", "2026-10-08")}
    assert kinds(ny(2026, 10, 8, 3, 0)) == {("day", "Day", "2026-10-08"), ("session", "London", "2026-10-08")}
    assert kinds(ny(2026, 10, 8, 8, 50)) == {("day", "Day", "2026-10-08"), ("session", "New York", "2026-10-08")}
    assert kinds(ny(2026, 10, 8, 17, 30)) == {("day", "Day", "2026-10-08")}          # gap 17:00-18:00


def test_sessions_follow_dst():
    # 08:00 NY is 12:00 UTC in summer (EDT) and 13:00 UTC in winter (EST)
    summer = int(dt.datetime(2026, 10, 8, 12, 0, tzinfo=dt.timezone.utc).timestamp() * 1000)
    winter = int(dt.datetime(2026, 11, 9, 13, 0, tzinfo=dt.timezone.utc).timestamp() * 1000)
    assert ("session", "New York", "2026-10-08") in kinds(summer)
    assert ("session", "New York", "2026-11-09") in kinds(winter)


def test_day_follows_display_timezone():
    ts = int(dt.datetime(2026, 10, 8, 2, 0, tzinfo=dt.timezone.utc).timestamp() * 1000)   # 22:00 NY on 10-07
    assert ("day", "Day", "2026-10-07") in kinds(ts, NY)
    assert ("day", "Day", "2026-10-08") in kinds(ts, "UTC")


def test_compute_periods_high_low_and_profiles():
    t = [ny(2026, 10, 8, 9, 0), ny(2026, 10, 8, 9, 5)]
    candles = pl.DataFrame({"start_ts": t, "high": [101.0, 104.0], "low": [99.0, 100.5]})
    fp = pl.DataFrame({"start_ts": [t[0], t[0], t[1]], "level": [95, 100, 100],
                       "buy_usd": [10.0, 5.0, 7.0], "sell_usd": [1.0, 2.0, 30.0]})
    per, lv = compute_periods(candles, fp, NY, 25)
    p = {r["id"]: r for r in per.iter_rows(named=True)}
    ny_s, day = p["session|New York|2026-10-08"], p["day|Day|2026-10-08"]
    for r in (ny_s, day):
        assert r["high"] == 104.0 and r["low"] == 99.0
        assert r["start_ts"] == t[0] and r["end_ts"] == t[1] + 300_000
        assert r["volume_usd"] == pytest.approx(55.0) and r["delta_usd"] == pytest.approx(22.0 - 33.0)
    rows = lv.filter(pl.col("id") == "day|Day|2026-10-08").select("level", "buy_usd", "sell_usd").rows()
    assert rows == [(75, 10.0, 1.0), (100, 12.0, 32.0)]   # 95 -> 75 bucket, 100 -> 100 bucket at bin 25
