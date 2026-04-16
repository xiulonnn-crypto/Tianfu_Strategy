# -*- coding: utf-8 -*-
"""分红 / 合股拆股：成本语义与公司行为同步（mock yfinance）。"""

from unittest.mock import MagicMock, patch

import pandas as pd
import pytest

import server


def test_compute_cost_basis_dividend_adds_shares_not_cost():
    trades = [
        {
            "date": "2026-01-01",
            "symbol": "QQQM",
            "action": "买入",
            "price": 100,
            "shares": 10,
            "commission": 1,
            "type": "定投",
        },
        {
            "date": "2026-03-30",
            "symbol": "QQQM",
            "action": "买入",
            "price": 0,
            "shares": 0.15,
            "commission": 0,
            "type": server.TYPE_DIVIDEND,
            "auto": True,
        },
    ]
    cb = server.compute_cost_basis(trades)
    assert "QQQM" in cb
    assert abs(cb["QQQM"]["shares"] - 10.15) < 1e-5
    assert abs(cb["QQQM"]["total_cost"] - 1001.0) < 0.02


def test_compute_cost_basis_split_pair_preserves_total_cost():
    trades = [
        {
            "date": "2026-01-01",
            "symbol": "X",
            "action": "买入",
            "price": 10,
            "shares": 100,
            "commission": 0,
            "type": "定投",
        },
        {
            "date": "2026-06-01",
            "symbol": "X",
            "action": "卖出",
            "price": 0,
            "shares": 100,
            "commission": 0,
            "type": server.TYPE_CORP_SPLIT,
            "auto": True,
            "split_ratio": 2.0,
        },
        {
            "date": "2026-06-01",
            "symbol": "X",
            "action": "买入",
            "price": 0,
            "shares": 200,
            "commission": 0,
            "type": server.TYPE_CORP_SPLIT,
            "auto": True,
            "split_ratio": 2.0,
        },
    ]
    cb = server.compute_cost_basis(trades)
    assert "X" in cb
    assert abs(cb["X"]["shares"] - 200) < 1e-5
    assert abs(cb["X"]["total_cost"] - 1000.0) < 0.02


def test_is_corp_action():
    assert server._is_corp_action({"type": server.TYPE_DIVIDEND}) is True
    assert server._is_corp_action({"type": server.TYPE_CORP_SPLIT}) is True
    assert server._is_corp_action({"type": "定投"}) is False


def test_mwr_skips_corp_actions():
    trades = [
        {
            "date": "2026-02-01",
            "symbol": "QQQM",
            "action": "买入",
            "price": 0,
            "shares": 1,
            "commission": 0,
            "type": server.TYPE_DIVIDEND,
            "auto": True,
        },
    ]
    funds = []
    hc = {}
    out = server.compute_mwr(trades, funds, hc, "2026-01-01", "2026-12-31", ["2026-01-01", "2026-12-31"])
    # 无真实买卖现金流、期初期末无持仓估值时可能为 None；此处仅确保不因分红行抛错
    assert out is None or isinstance(out, float)


@pytest.fixture
def tmp_trades_file(tmp_path, monkeypatch):
    """将交易文件 + 模型状态 + 资金 + 价格缓存全部指向临时路径，避免污染真实数据。"""
    p = tmp_path / "trades.json"
    monkeypatch.setattr(server, "TRADES_FILE", p)
    monkeypatch.setattr(server, "DATA_DIR", tmp_path)
    monkeypatch.setattr(server, "MODEL_STATE_FILE", tmp_path / "model_state.json")
    monkeypatch.setattr(server, "FUND_FILE", tmp_path / "fund_records.json")
    monkeypatch.setattr(server, "PRICE_CACHE_FILE", tmp_path / "price_cache.json")
    return p


def _install_fake_yfinance(monkeypatch, srv, ex_date, div_per_share, ex_close, pay_open):
    """在 monkeypatch 上安装 fake yfinance：
    - Ticker(...).dividends 只返回一条（ex_date，div_per_share）
    - _fetch_histories_raw 在 ex_date 给出 Close=ex_close
    - _fetch_open_price_on_or_after 返回 pay_open（None 可模拟获取失败）
    """
    div_series = pd.Series([div_per_share], index=[pd.Timestamp(ex_date, tz="UTC")])

    class FakeTicker:
        dividends = div_series
        splits = pd.Series(dtype=float)

    def fake_history_raw(symbols, start_date, end_date):
        idx = pd.DatetimeIndex([pd.Timestamp(ex_date)])
        df = pd.DataFrame({"Close": [ex_close]}, index=idx)
        return {symbols[0]: df}

    monkeypatch.setattr(srv.yf, "Ticker", lambda sy: FakeTicker())
    monkeypatch.setattr(srv, "_fetch_histories_raw", fake_history_raw)
    monkeypatch.setattr(
        srv,
        "_fetch_open_price_on_or_after",
        lambda symbol, date_str: pay_open,
    )


def test_sync_corp_actions_dedup_dividend(tmp_trades_file, monkeypatch):
    """同一除息日自动分红只插入一次。"""
    import server as srv

    initial = [
        {
            "date": "2026-01-10",
            "symbol": "QQQM",
            "action": "买入",
            "price": 200,
            "shares": 10,
            "commission": 0,
            "type": "定投",
        }
    ]
    srv.save_json(srv.TRADES_FILE, initial)

    _install_fake_yfinance(
        monkeypatch, srv,
        ex_date="2026-03-30", div_per_share=0.25,
        ex_close=180.0, pay_open=175.0,
    )

    out1 = srv.sync_corp_actions_from_yfinance(symbol_filter="QQQM")
    assert len(out1["inserted"]) >= 1
    out2 = srv.sync_corp_actions_from_yfinance(symbol_filter="QQQM")
    assert len(out2["inserted"]) == 0
    final = srv.get_trades()
    div_rows = [t for t in final if t.get("type") == srv.TYPE_DIVIDEND and t.get("auto")]
    assert len(div_rows) == 1


def test_sync_dividend_applies_withholding_and_pay_date_open(tmp_trades_file, monkeypatch):
    """复现 IB DRIP 口径：股数 = (每股分红 × 持仓 × (1-税率)) / 付息日开盘价。

    基于 QQQM 2026-03-23 实际分红反推的案例：
      div_per=0.328，持仓=156.5，税率=0.30，付息日开盘=233.57 → 0.153889
    """
    import server as srv

    initial = [
        {
            "date": "2026-01-10",
            "symbol": "QQQM",
            "action": "买入",
            "price": 200,
            "shares": 156.5,
            "commission": 0,
            "type": "定投",
        }
    ]
    srv.save_json(srv.TRADES_FILE, initial)
    srv.save_model_state({
        "settings": {
            "dividend_withholding_rate": 0.30,
            "dividend_reinvest_offset_bd": 5,
        }
    })

    _install_fake_yfinance(
        monkeypatch, srv,
        ex_date="2026-03-23", div_per_share=0.328,
        ex_close=242.07, pay_open=233.57,
    )

    out = srv.sync_corp_actions_from_yfinance(symbol_filter="QQQM")
    assert len(out["inserted"]) == 1
    row = out["inserted"][0]
    expected = 0.328 * 156.5 * 0.70 / 233.57
    assert abs(row["shares"] - expected) < 1e-5
    assert abs(row["shares"] - 0.153889) < 1e-4
    assert row["type"] == srv.TYPE_DIVIDEND
    assert row["auto"] is True
    assert row.get("withholding_rate") == pytest.approx(0.30)
    assert row.get("reinvest_price") == pytest.approx(233.57, abs=1e-4)


def test_sync_dividend_falls_back_to_ex_close_when_pay_open_missing(tmp_trades_file, monkeypatch):
    """付息日开盘价拉取失败时，回退到除息日收盘价，但仍应用预扣税。"""
    import server as srv

    initial = [
        {
            "date": "2026-01-10",
            "symbol": "QQQM",
            "action": "买入",
            "price": 200,
            "shares": 100.0,
            "commission": 0,
            "type": "定投",
        }
    ]
    srv.save_json(srv.TRADES_FILE, initial)
    srv.save_model_state({
        "settings": {
            "dividend_withholding_rate": 0.30,
            "dividend_reinvest_offset_bd": 5,
        }
    })

    _install_fake_yfinance(
        monkeypatch, srv,
        ex_date="2026-03-23", div_per_share=0.328,
        ex_close=242.07, pay_open=None,
    )

    out = srv.sync_corp_actions_from_yfinance(symbol_filter="QQQM")
    assert len(out["inserted"]) == 1
    row = out["inserted"][0]
    expected = 0.328 * 100.0 * 0.70 / 242.07
    assert abs(row["shares"] - expected) < 1e-5
    assert row.get("reinvest_price") == pytest.approx(242.07, abs=1e-4)


def test_sync_dividend_respects_zero_withholding(tmp_trades_file, monkeypatch):
    """美国税务居民场景：税率=0 时全额再投资。"""
    import server as srv

    initial = [
        {
            "date": "2026-01-10",
            "symbol": "QQQM",
            "action": "买入",
            "price": 200,
            "shares": 100.0,
            "commission": 0,
            "type": "定投",
        }
    ]
    srv.save_json(srv.TRADES_FILE, initial)
    srv.save_model_state({
        "settings": {
            "dividend_withholding_rate": 0.0,
            "dividend_reinvest_offset_bd": 0,
        }
    })

    _install_fake_yfinance(
        monkeypatch, srv,
        ex_date="2026-03-23", div_per_share=0.328,
        ex_close=242.07, pay_open=242.07,
    )

    out = srv.sync_corp_actions_from_yfinance(symbol_filter="QQQM")
    row = out["inserted"][0]
    expected = 0.328 * 100.0 / 242.07
    assert abs(row["shares"] - expected) < 1e-5


def test_api_trades_update_preserves_auto_dividend(tmp_trades_file):
    """编辑已有的 auto 分红记录：允许修改 shares，自动保留 auto 标记。"""
    import server as srv

    initial = [
        {
            "date": "2026-03-23",
            "symbol": "QQQM",
            "action": "买入",
            "price": 0.0,
            "shares": 0.212054,
            "commission": 0.0,
            "type": srv.TYPE_DIVIDEND,
            "auto": True,
            "source": "yfinance",
        }
    ]
    srv.save_json(srv.TRADES_FILE, initial)

    client = srv.app.test_client()
    resp = client.post("/api/trades/update", json={
        "index": 0,
        "date": "2026-03-23",
        "symbol": "QQQM",
        "action": "买入",
        "price": 0.0,
        "shares": 0.1539,
        "commission": 0.0,
        "type": srv.TYPE_DIVIDEND,
    })
    assert resp.status_code == 200, resp.get_json()
    assert resp.get_json().get("ok") is True

    rows = srv.get_trades()
    assert abs(rows[0]["shares"] - 0.1539) < 1e-6
    assert rows[0]["auto"] is True
    assert rows[0]["type"] == srv.TYPE_DIVIDEND


def test_api_trades_new_dividend_still_rejected(tmp_trades_file):
    """手动新建分红（非 update）仍应被禁止，确保没有开后门。"""
    import server as srv

    srv.save_json(srv.TRADES_FILE, [])
    client = srv.app.test_client()
    resp = client.post("/api/trades", json={
        "date": "2026-03-23",
        "symbol": "QQQM",
        "action": "买入",
        "price": 0.0,
        "shares": 0.1,
        "commission": 0.0,
        "type": srv.TYPE_DIVIDEND,
    })
    assert resp.status_code == 400


def test_api_update_settings_accepts_withholding_params(tmp_trades_file):
    """/api/update-settings 可持久化新字段，超出范围会被钳制。"""
    import server as srv

    srv.save_model_state({})
    client = srv.app.test_client()
    resp = client.post("/api/update-settings", json={
        "dividend_withholding_rate": 0.10,
        "dividend_reinvest_offset_bd": 6,
    })
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["settings"]["dividend_withholding_rate"] == pytest.approx(0.10)
    assert data["settings"]["dividend_reinvest_offset_bd"] == 6

    resp2 = client.post("/api/update-settings", json={
        "dividend_withholding_rate": 0.9,
        "dividend_reinvest_offset_bd": 100,
    })
    settings = resp2.get_json()["settings"]
    assert settings["dividend_withholding_rate"] <= 0.5
    assert settings["dividend_reinvest_offset_bd"] <= 10


def test_next_nth_weekday_after():
    """工作日偏移辅助函数：Monday + 5 BD = next Monday。"""
    import server as srv

    assert srv._next_nth_weekday_after("2026-03-23", 5) == "2026-03-30"
    assert srv._next_nth_weekday_after("2026-03-23", 0) == "2026-03-23"
    assert srv._next_nth_weekday_after("2026-03-20", 1) == "2026-03-23"
