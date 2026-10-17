"""Same sample data -> same outputs as the original application (see golden_util.py)."""
import polars as pl
import pytest
from polars.testing import assert_frame_equal

from .golden_util import GOLDEN, build_sample, compute

NAMES = sorted(p.stem for p in GOLDEN.glob("*.parquet"))


@pytest.fixture(scope="module")
def results(tmp_path_factory):
    return compute(build_sample(tmp_path_factory.mktemp("golden")))


def test_golden_set_complete(results):
    assert NAMES and set(NAMES) <= set(results)   # the web version may add outputs (e.g. tick candles)


@pytest.mark.parametrize("name", NAMES)
def test_golden_output(results, name):
    expected = pl.read_parquet(GOLDEN / f"{name}.parquet")
    got = results[name]
    # new columns may be added by the web version; every original column must be unchanged
    assert set(expected.columns) <= set(got.columns), set(expected.columns) - set(got.columns)
    assert_frame_equal(got.select(expected.columns), expected, rel_tol=1e-9, abs_tol=1e-6)
