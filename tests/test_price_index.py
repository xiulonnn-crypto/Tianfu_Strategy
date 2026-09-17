# -*- coding: utf-8 -*-
"""价格索引 get_price_on_date_fast 与 pandas 路径对拍。"""

import random
import math

import pandas as pd
import pytest

import server


def _sample_history():
    idx = pd.date_range("2025-01-02", periods=80, freq="B")
    return pd.DataFrame({"Close": [100.0 + i * 0.1 for i in range(len(idx))]}, index=idx)


def test_fast_matches_legacy_random_dates():
    df = _sample_history()
    cache = {"QQQM": df}
    idx = server._build_price_index(cache)
    random.seed(42)
    for _ in range(200):
        d = f"2025-{random.randint(1, 6):02d}-{random.randint(1, 28):02d}"
        a = server.get_price_on_date("QQQM", d, cache)
        b = server.get_price_on_date_fast("QQQM", d, idx)
        if a is None:
            assert b is None
        else:
            assert abs(a - b) < 1e-6


def test_benchmark_symbol_in_merged_index():
    df = _sample_history()
    merged = {"QQQM": df, server.BENCHMARK_SYMBOL: df}
    idx = server._build_price_index(merged)
    d = "2025-03-15"
    assert server.get_price_on_date_fast(server.BENCHMARK_SYMBOL, d, idx) == server.get_price_on_date(
        server.BENCHMARK_SYMBOL, d, {server.BENCHMARK_SYMBOL: df}
    )


@pytest.mark.parametrize("bad_close", [0.0, -1.0, float("nan"), float("inf")])
def test_price_index_ignores_invalid_latest_close_and_uses_previous_valid_quote(bad_close):
    """Yahoo 的异常末行不能把组合的最新估值归零。"""
    dates = pd.to_datetime(["2026-09-15", "2026-09-16"])
    cache = {"QQQM": pd.DataFrame({"Close": [101.25, bad_close]}, index=dates)}

    idx = server._build_price_index(cache)

    assert math.isclose(server.get_price_on_date_fast("QQQM", "2026-09-16", idx), 101.25)
    assert math.isclose(server.get_price_on_date("QQQM", "2026-09-16", cache), 101.25)
