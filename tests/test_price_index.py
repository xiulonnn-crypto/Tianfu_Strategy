# -*- coding: utf-8 -*-
"""价格索引 get_price_on_date_fast 与 pandas 路径对拍。"""

import random

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
