# -*- coding: utf-8 -*-
"""等额定投基准：按每年计划投入总额（月投基数×12 + 年度投弹总额）均摊到各年交易日。"""

from __future__ import annotations

from unittest.mock import patch

import numpy as np
import pandas as pd

import server


def _fake_hist(symbols, start_date, end_date):
    out = {}
    for s in symbols:
        ix = pd.date_range("2025-04-01", periods=80, freq="B")
        out[s] = pd.DataFrame(
            {"Close": np.linspace(100.0, 110.0, len(ix))},
            index=ix,
        )
    return out


def _run_chart(trades):
    with patch.object(server, "_load_price_cache", return_value=None), \
         patch.object(server, "_save_price_cache"), \
         patch.object(server, "_fetch_histories_raw", side_effect=_fake_hist):
        hc, bc, td = server.fetch_histories_with_bench(["QQQM"], "2025-04-01", "2025-06-30")
        perf = server.build_perf_bundle(trades, hc, bc, td)
        return server.compute_twr_chart(
            trades, hc, bc, "2025-04-02", td[-1], td, perf, [],
        )


def test_yearly_planned_invest_fixed_budget():
    assert server._yearly_planned_invest_amount() == 2000 * 12 + 40000


def test_dca_independent_of_actual_buy_amount():
    """DCA 曲线只依赖年度计划 pace，与实际买入金额无关。"""
    small = [
        {"date": "2025-04-02", "symbol": "QQQM", "action": "买入", "type": "定投",
         "price": 100.0, "shares": 1, "commission": 0},
    ]
    large = [
        {"date": "2025-04-02", "symbol": "QQQM", "action": "买入", "type": "定投",
         "price": 100.0, "shares": 100, "commission": 0},
        {"date": "2025-05-01", "symbol": "QQQM", "action": "买入", "type": "投弹",
         "price": 105.0, "shares": 50, "commission": 0},
    ]
    dca_small = _run_chart(small)["dca"]
    dca_large = _run_chart(large)["dca"]
    assert dca_small == dca_large
    assert dca_small[-1] != 0.0, "价格上行时 DCA 末点应有正收益"
