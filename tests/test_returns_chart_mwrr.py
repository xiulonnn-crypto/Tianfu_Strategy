# -*- coding: utf-8 -*-
"""收益图 my_mwrr 与策略复盘超额收益（MWRR−DCA）终点一致。"""

from __future__ import annotations

import json
from unittest.mock import patch

import numpy as np
import pandas as pd
import pytest

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


TRADES_FIXTURE = [
    {"date": "2025-04-02", "symbol": "QQQM", "action": "买入", "type": "定投", "price": 100.0, "shares": 10, "commission": 0},
    {"date": "2025-04-10", "symbol": "QQQM", "action": "买入", "type": "定投", "price": 102.0, "shares": 5, "commission": 0},
]


@pytest.fixture
def client_mwrr_consistency():
    with patch.object(server, "_load_price_cache", return_value=None), \
         patch.object(server, "_save_price_cache"), \
         patch.object(server, "_fetch_histories_raw", side_effect=_fake_hist), \
         patch.object(server, "fetch_realtime_quote", return_value=None), \
         patch.object(server, "get_risk_free_us1y_annual_decimal", return_value=0.04), \
         patch.object(server, "get_trades", return_value=TRADES_FIXTURE), \
         patch.object(server, "get_fund_records", return_value=[]):
        with server.app.test_client() as c:
            yield c


def test_returns_since_my_mwrr_minus_dca_matches_strategy_review_excess(client_mwrr_consistency):
    r1 = client_mwrr_consistency.get("/api/returns-overview")
    r2 = client_mwrr_consistency.get("/api/strategy-review?period=all")
    assert r1.status_code == 200 and r2.status_code == 200
    over = json.loads(r1.data.decode("utf-8"))
    rev = json.loads(r2.data.decode("utf-8"))
    ch = over["chart"]["since"]
    assert ch.get("my_mwrr") and ch.get("dca"), "chart should expose my_mwrr and dca"
    mw = ch["my_mwrr"][-1]
    dca = ch["dca"][-1]
    gap = round(mw - dca, 2)
    assert gap == rev["excess_return"]
    assert mw == over["cards"]["since"]["mwr_pct"]
    assert over["chart"]["since"].get("excess_mwrr_minus_dca") == rev["excess_return"]

    r1y = client_mwrr_consistency.get("/api/strategy-review?period=1y_roll")
    assert r1y.status_code == 200
    rev1y = json.loads(r1y.data.decode("utf-8"))
    chroll = over["chart"]["1y_roll"]
    if chroll.get("dca"):
        assert chroll.get("excess_mwrr_minus_dca") == rev1y["excess_return"]
