# -*- coding: utf-8 -*-
"""关键 API 暖路径耗时 < 1s（mock 行情，避免网络）。"""

import time
from unittest.mock import patch

import numpy as np
import pandas as pd
import pytest

import server


def _fake_hist(symbols, start_date, end_date):
    out = {}
    for s in symbols:
        ix = pd.date_range("2025-04-01", periods=120, freq="B")
        out[s] = pd.DataFrame(
            {"Close": np.linspace(50.0, 120.0, len(ix))},
            index=ix,
        )
    return out


@pytest.fixture
def client_with_mock_yahoo():
    # 同时 mock _save_price_cache，避免测试产生的假行情污染真实 data/price_cache.json
    with patch.object(server, "_load_price_cache", return_value=None), \
         patch.object(server, "_save_price_cache"), \
         patch.object(server, "_fetch_histories_raw", side_effect=_fake_hist), \
         patch.object(server, "fetch_realtime_quote", return_value=None), \
         patch.object(server, "get_risk_free_us1y_annual_decimal", return_value=0.04):
        with server.app.test_client() as c:
            yield c


def test_key_endpoints_warm_under_one_second(client_with_mock_yahoo):
    c = client_with_mock_yahoo
    paths = [
        "/api/returns-overview",
        "/api/trade-summary?period=all",
        "/api/signals",
        "/api/strategy-review?period=all",
        "/api/allocation",
    ]
    for p in paths:
        c.get(p)
    for p in paths:
        t0 = time.perf_counter()
        r = c.get(p)
        elapsed = time.perf_counter() - t0
        assert r.status_code == 200, p
        assert elapsed < 1.0, f"{p} took {elapsed:.3f}s (expected <1s)"
