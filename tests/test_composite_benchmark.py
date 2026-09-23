# -*- coding: utf-8 -*-
"""60/25/15 季度再平衡收益基准。"""

import pandas as pd
import pytest

import server


def _history(values):
    dates = pd.to_datetime(["2025-03-31", "2025-04-01", "2025-04-02", "2025-04-03"])
    return pd.DataFrame({"Close": values}, index=dates)


def test_composite_benchmark_rebalances_after_first_trading_day_of_quarter():
    """Q2 首日按旧权重走完后，以当日收盘净值恢复 60/25/15。"""
    benchmark = server._build_rebalanced_benchmark_history({
        "QQQ": _history([100.0, 110.0, 121.0, 121.0]),
        "BRK-B": _history([100.0, 200.0, 200.0, 200.0]),
        "IAU": _history([100.0, 100.0, 100.0, 100.0]),
    })

    assert benchmark is not None
    values = benchmark["Close"].tolist()
    assert values[0] == pytest.approx(100.0)
    # Q2 首日：仍由 Q1 末持仓计算，60%×110% + 25%×200% + 15%×100%。
    assert values[1] == pytest.approx(131.0)
    # Q2 首日收盘后调仓，次日 QQQ 再涨 10% 时只按 60% 暴露。
    assert values[2] == pytest.approx(131.0 * 1.06)


def test_composite_benchmark_requires_all_component_prices():
    assert server._build_rebalanced_benchmark_history({"QQQ": _history([100] * 4)}) is None


def test_history_fetches_components_and_returns_synthetic_benchmark(monkeypatch):
    fetched_symbols = []

    def fake_fetch(symbols, _start, _end):
        fetched_symbols.extend(symbols)
        return {
            "QQQM": _history([100.0, 100.0, 100.0, 100.0]),
            "QQQ": _history([100.0, 110.0, 121.0, 121.0]),
            "BRK-B": _history([100.0, 200.0, 200.0, 200.0]),
            "IAU": _history([100.0, 100.0, 100.0, 100.0]),
        }

    monkeypatch.setattr(server, "_load_price_cache", lambda *_: None)
    monkeypatch.setattr(server, "_save_price_cache", lambda *_: None)
    monkeypatch.setattr(server, "_fetch_histories_raw", fake_fetch)
    server._PRICE_MEM_CACHE.clear()
    history, bench, dates = server.fetch_histories_with_bench(
        ["QQQM"], "2025-03-31", "2025-04-04",
    )

    assert set(fetched_symbols) == {"QQQM", "QQQ", "BRK-B", "IAU"}
    assert server.BENCHMARK_SYMBOL not in fetched_symbols
    assert set(history) == {"QQQM"}
    assert dates == ["2025-03-31", "2025-04-01", "2025-04-02", "2025-04-03"]
    assert bench[server.BENCHMARK_SYMBOL]["Close"].iloc[-1] == pytest.approx(131.0 * 1.06)


def test_dca_uses_composite_benchmark_not_qqqm_price():
    dates = pd.to_datetime(["2025-01-02", "2025-01-03", "2025-01-06"])
    history = {
        "QQQM": pd.DataFrame({"Close": [100.0, 90.0, 80.0]}, index=dates),
        "QQQ": pd.DataFrame({"Close": [100.0, 110.0, 121.0]}, index=dates),
    }
    bench = {server.BENCHMARK_SYMBOL: pd.DataFrame({"Close": [100.0, 110.0, 121.0]}, index=dates)}
    trades = [{
        "date": "2025-01-02", "symbol": "QQQM", "action": "买入", "type": "定投",
        "price": 100.0, "shares": 1.0, "commission": 0.0,
    }]
    date_strings = [str(d)[:10] for d in dates]
    perf = server.build_perf_bundle(trades, history, bench, date_strings)
    chart = server.compute_twr_chart(
        trades, history, bench, "2025-01-02", "2025-01-06", date_strings, perf, [],
    )

    assert chart["dca"][-1] > 0, "DCA 应跟随上涨的混合基准，而不是下跌的 QQQM"
    assert chart["qqq"] == pytest.approx([10.0, 21.0])
    assert chart["dates"] == ["2025-01-03", "2025-01-06"]
