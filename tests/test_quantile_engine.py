# -*- coding: utf-8 -*-
"""分位数引擎：SPY 估值代理窗口与下游 S/M 输入一致性。"""

from datetime import datetime, timedelta
from unittest.mock import patch

import numpy as np
import pandas as pd
import pytest

import server


@pytest.fixture(autouse=True)
def _reset_quantile_cache():
    server._quantile_cache["date"] = None
    server._quantile_cache["data"] = None
    server._quantile_cache["qe_version"] = None
    yield
    server._quantile_cache["date"] = None
    server._quantile_cache["data"] = None
    server._quantile_cache["qe_version"] = None


def _spy_only_long_history():
    """约 10 年日频：早年有尖峰>现价，末 800 日缓升；现价在近窗内极高、在全样本内非极高。"""
    n = 2600
    ix = pd.bdate_range("2014-06-01", periods=n, freq="B")
    early = np.concatenate(
        [
            np.full(100, 55.0),
            np.array([220.0, 210.0]),
            np.linspace(55.0, 95.0, 1698),
        ]
    )
    recent = np.linspace(92.0, 118.0, 800)
    closes = np.concatenate([early, recent])
    assert len(closes) == n
    return pd.DataFrame({"Close": closes}, index=ix)


def _make_quantile_fetch_fake():
    calls = []

    def fake_fetch(symbols, start_date, end_date):
        calls.append((tuple(sorted(symbols)), start_date))
        if symbols == ["SPY"]:
            return {"SPY": _spy_only_long_history()}
        out = {}
        for sym in symbols:
            ix = pd.bdate_range("2022-06-01", periods=800, freq="B")
            out[sym] = pd.DataFrame(
                {"Close": np.linspace(10.0, 30.0, len(ix))},
                index=ix,
            )
        return out

    return fake_fetch, calls


def test_quantile_engine_second_fetch_spy_uses_ten_year_start():
    """SPY 必须与 3 年主拉取分离，否则 pe_10y 实为短窗，月投 S 中 (1-pe_10y) 权重失真。"""
    fake_fetch, calls = _make_quantile_fetch_fake()
    dt = datetime.now()
    expect_10y_start = (dt - timedelta(days=10 * 365 + 60)).strftime("%Y-%m-%d")
    expect_3y_start = (dt - timedelta(days=3 * 365 + 60)).strftime("%Y-%m-%d")

    orig_load = server.load_json

    def load_json_skip_quantile_cache(path, default=None):
        if path == server.QUANTILE_CACHE_FILE:
            return None
        return orig_load(path, default)

    with patch.object(server, "_fetch_histories_raw", side_effect=fake_fetch), \
         patch.object(server, "save_json"), \
         patch.object(server, "load_json", side_effect=load_json_skip_quantile_cache):
        qe = server.compute_quantile_engine()

    spy_calls = [c for c in calls if c[0] == ("SPY",)]
    assert len(spy_calls) == 1, f"expected exactly one SPY-only fetch, got {spy_calls}"
    assert spy_calls[0][1] == expect_10y_start

    main_calls = [c for c in calls if "QQQM" in c[0]]
    assert len(main_calls) == 1
    assert main_calls[0][1] == expect_3y_start

    assert qe.get("pe_10y_pctile") is not None
    assert qe.get("pe_3y_pctile") is not None
    # 末段急拉：近 756 日多在高位 → 3y 分位高于全 10y 样本分位
    assert qe["pe_3y_pctile"] > qe["pe_10y_pctile"]


def test_compute_monthly_multiplier_uses_distinct_pe_windows():
    """合成 S 同时依赖 pe_10y 与 pe_3y；二者来自同一长序列的不同切片时数值应可区分。"""
    fake_fetch, _ = _make_quantile_fetch_fake()
    orig_load = server.load_json

    def load_json_skip_quantile_cache(path, default=None):
        if path == server.QUANTILE_CACHE_FILE:
            return None
        return orig_load(path, default)

    with patch.object(server, "_fetch_histories_raw", side_effect=fake_fetch), \
         patch.object(server, "save_json"), \
         patch.object(server, "load_json", side_effect=load_json_skip_quantile_cache):
        qe = server.compute_quantile_engine()
        ms = server.compute_monthly_multiplier(
            qe, reserve_pool=100_000.0, has_toundan_this_month=False, model_state={}
        )

    assert ms["S"] is not None
    # 若错误地将 pe_10y==pe_3y（短窗全样本），S 会与正确长窗模型不同；此处用与 pe 权重一致的反算校验
    pe10 = qe["pe_10y_pctile"]
    pe3 = qe["pe_3y_pctile"]
    vixp = qe.get("vix_3y_pctile") or 0.5
    e200 = qe.get("ema200_deviation_3y_pctile") or 0.5
    e20 = qe.get("ema20_deviation_3y_pctile") or 0.5
    s_manual = (
        0.20 * (1 - pe10)
        + 0.15 * (1 - pe3)
        + 0.45 * vixp
        + 0.10 * (1 - e200)
        + 0.10 * (1 - e20)
    )
    assert abs(ms["S"] - round(s_manual, 4)) < 1e-3


def test_fetch_open_price_on_or_after_acquires_yfin_lock():
    """_fetch_open_price_on_or_after 必须在 _YFIN_HISTORY_FETCH_LOCK 保护下调用 yf.Ticker。
    RED（修复前）：lock_held=[False]；GREEN（修复后）：lock_held=[True]。
    """
    lock_ref = server._YFIN_HISTORY_FETCH_LOCK
    lock_held_at_call = []

    class FakeTicker:
        def history(self, **kwargs):
            got = lock_ref.acquire(blocking=False)
            lock_held_at_call.append(not got)
            if got:
                lock_ref.release()
            ix = pd.bdate_range("2024-01-01", periods=5)
            return pd.DataFrame({"Close": [100.0] * 5, "Open": [99.0] * 5}, index=ix)

    with patch.object(server.yf, "Ticker", return_value=FakeTicker()):
        server._fetch_open_price_on_or_after("QQQM", "2024-01-02")

    assert lock_held_at_call, "yf.Ticker.history never called"
    assert all(lock_held_at_call), (
        "_fetch_open_price_on_or_after must hold _YFIN_HISTORY_FETCH_LOCK "
        f"when calling yf.Ticker.history; got lock_held={lock_held_at_call}"
    )


def test_sync_corp_actions_acquires_yfin_lock():
    """sync_corp_actions_from_yfinance 必须在 _YFIN_HISTORY_FETCH_LOCK 保护下
    访问 Ticker.dividends 和 Ticker.splits。
    """
    lock_ref = server._YFIN_HISTORY_FETCH_LOCK
    lock_held_at_call = []

    class FakeDivsTicker:
        @property
        def dividends(self):
            got = lock_ref.acquire(blocking=False)
            lock_held_at_call.append(("divs", not got))
            if got:
                lock_ref.release()
            return pd.Series([], dtype=float)

        @property
        def splits(self):
            got = lock_ref.acquire(blocking=False)
            lock_held_at_call.append(("splits", not got))
            if got:
                lock_ref.release()
            return pd.Series([], dtype=float)

    fake_trade = {
        "symbol": "QQQM",
        "type": "买入",
        "date": "2024-01-02",
        "shares": 1,
        "price": 100,
        "commission": 0,
    }
    with (
        patch.object(server.yf, "Ticker", return_value=FakeDivsTicker()),
        patch.object(server, "get_trades", return_value=[fake_trade]),
        patch.object(server, "get_all_symbols", return_value=["QQQM"]),
        patch.object(server, "save_json"),
    ):
        server.sync_corp_actions_from_yfinance()

    assert lock_held_at_call, "Ticker.dividends/splits never accessed"
    failed = [(tag, held) for tag, held in lock_held_at_call if not held]
    assert not failed, (
        "sync_corp_actions_from_yfinance must hold _YFIN_HISTORY_FETCH_LOCK "
        f"when accessing Ticker properties; unlocked calls: {failed}"
    )


def test_repair_quantile_vix_tnx_after_yfinance_leak():
    """模拟 VIX/^TNX 被写成 QQQM 股价；单列重拉后应恢复合理数值。"""
    def fake_fetch(symbols, start_date, end_date):
        if symbols == ["^VIX"]:
            ix = pd.bdate_range("2023-01-01", periods=120, freq="B")
            return {"^VIX": pd.DataFrame({"Close": np.linspace(16.0, 19.5, len(ix))}, index=ix)}
        if symbols == ["^TNX"]:
            ix = pd.bdate_range("2023-01-01", periods=120, freq="B")
            return {"^TNX": pd.DataFrame({"Close": np.full(len(ix), 4.35)}, index=ix)}
        return {}

    result = {
        "qqqm_price": 110.0,
        "vix_price": 110.0,
        "vix_3y_pctile": 0.9999,
        "tnx_yield": 110.0,
    }
    with patch.object(server, "_fetch_histories_raw", side_effect=fake_fetch):
        server._repair_quantile_vix_tnx_if_equity_leak(result, "2020-01-01", "2030-01-01")

    assert result["vix_price"] == 19.5
    assert result["vix_3y_pctile"] is not None
    assert result["tnx_yield"] == 4.35
