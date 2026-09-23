# -*- coding: utf-8 -*-
"""价格缓存不得将缺失行情伪装成可用收益数据。"""

from __future__ import annotations

import json
from datetime import datetime

import pandas as pd

import server


def _history() -> pd.DataFrame:
    return pd.DataFrame(
        {"Close": [100.0, 101.0]},
        index=pd.to_datetime(["2026-09-17", "2026-09-18"]),
    )


def test_rejects_cache_that_advertises_symbols_but_lacks_benchmark(monkeypatch, tmp_path):
    """旧格式可列出全部标的，但没有合成基准；绝不能作为有效缓存读取。"""
    cache_file = tmp_path / "price_cache.json"
    monkeypatch.setattr(server, "PRICE_CACHE_FILE", cache_file)
    start, end = "2026-01-01", "2026-09-22"
    cache_file.write_text(json.dumps({
        "version": server._CACHE_VERSION,
        "cache_date": datetime.now().strftime("%Y-%m-%d"),
        "symbols": ["QQQM", "QQQ", "BRK-B", "IAU"],
        "start": start,
        "end": end,
        "history": {
            "QQQM": {"2026-09-17": 100.0, "2026-09-18": 101.0},
        },
        "bench": {},
        "trading_dates": ["2026-09-17", "2026-09-18"],
    }), encoding="utf-8")

    assert server._load_price_cache(["QQQM", "QQQ", "BRK-B", "IAU"], start, end) is None


def test_incomplete_yahoo_response_is_not_cached_or_returned(monkeypatch, tmp_path):
    """抓取失败时不能只用剩余标的计算组合收益。"""
    cache_file = tmp_path / "price_cache.json"
    monkeypatch.setattr(server, "PRICE_CACHE_FILE", cache_file)
    monkeypatch.setattr(server, "_load_price_cache", lambda *_: None)
    monkeypatch.setattr(server, "_fetch_histories_raw", lambda symbols, *_: {
        symbol: (_history() if symbol == "QQQM" else None) for symbol in symbols
    })
    server._PRICE_MEM_CACHE.clear()

    history, bench, dates = server.fetch_histories_with_bench(
        ["QQQM"], "2026-01-01", "2026-09-22",
    )

    assert history == {}
    assert bench == {}
    assert dates == []
    assert not cache_file.exists()


def test_memory_cache_does_not_drop_newly_requested_benchmark_component(monkeypatch):
    """预热时仅请求持仓标的后，收益页追加请求 QQQ 仍必须拿到 QQQ 历史。"""
    dates = ["2026-09-17", "2026-09-18"]
    full_history = {
        symbol: _history()
        for symbol in ("QQQM", "QQQ", "BRK-B", "IAU")
    }
    bench = {server.BENCHMARK_SYMBOL: _history()}
    monkeypatch.setattr(
        server, "_load_price_cache",
        lambda *_: (full_history, bench, dates),
    )
    server._PRICE_MEM_CACHE.clear()

    warm_history, _, _ = server.fetch_histories_with_bench(
        ["QQQM"], "2026-01-01", "2026-09-22",
    )
    assert set(warm_history) == {"QQQM"}

    returns_history, _, _ = server.fetch_histories_with_bench(
        ["QQQM", "QQQ"], "2026-01-01", "2026-09-22",
    )
    assert set(returns_history) == {"QQQM", "QQQ"}
