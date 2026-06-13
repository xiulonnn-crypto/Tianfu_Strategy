# -*- coding: utf-8 -*-
"""三期新增端点与脱敏回归。"""

import pytest

from compute import sanitize
from server import app


@pytest.fixture
def client():
    return app.test_client()


def test_monthly_returns_structure(client):
    resp = client.get("/api/monthly-returns")
    assert resp.status_code == 200
    data = resp.get_json()
    assert "rows" in data
    assert data.get("method") == "TWR"
    if data["rows"]:
        row = data["rows"][0]
        assert "year" in row
        assert "months" in row
        assert len(row["months"]) == 12


def test_signal_history_endpoint(client):
    resp = client.get("/api/signal-history")
    assert resp.status_code == 200
    data = resp.get_json()
    assert "entries" in data
    assert isinstance(data["entries"], list)


def test_signal_history_starts_at_since_date(client, monkeypatch):
    """信号历史时间线起点须对齐首次持仓日（= 最早交易日），过滤掉建仓前的回填信号，
    与 #history/trades 等周期口径一致。"""
    import server

    monkeypatch.setattr(server, "load_signal_history", lambda: {
        "entries": [
            {"date": "2020-10-13", "S": 0.47, "backfilled": True},
            {"date": "2025-12-31", "S": 0.50, "backfilled": True},
            {"date": "2026-01-16", "S": 0.40, "backfilled": True},
            {"date": "2026-06-13", "S": 0.37, "backfilled": False},
        ],
        "version": 1,
    })
    monkeypatch.setattr(server, "get_trades", lambda: [
        {"date": "2026-03-01"}, {"date": "2026-01-16"}, {"date": "2026-05-01"},
    ])

    data = client.get("/api/signal-history").get_json()
    assert [e["date"] for e in data["entries"]] == ["2026-01-16", "2026-06-13"]


def test_signal_history_monthly_signal_vs_actual(client, monkeypatch):
    """月投记录须同时给出信号推荐倍率 signal_M（按滚动 36 月 S_median 重建）与
    实际执行倍率 actual_M（= 当月定投实投 ÷ 月投基准），用于「信号 vs 实际」对比。
    月投时间点 = 当月最后一个交易日。"""
    import server

    monkeypatch.setattr(server, "load_signal_history", lambda: {
        "entries": [
            {"date": "2026-01-05", "S": 0.50, "backfilled": True},
            {"date": "2026-02-02", "S": 0.55, "backfilled": True},
            {"date": "2026-02-27", "S": 0.60, "backfilled": True},
        ],
        "version": 1,
    })
    monkeypatch.setattr(server, "get_trades", lambda: [
        {"date": "2026-01-05"},
        # 2 月定投实投 = 100*20 + 50*20 = 3000 -> /base
        {"date": "2026-02-10", "type": "定投", "symbol": "QQQM", "shares": 100, "price": 20},
        {"date": "2026-02-11", "type": "定投", "symbol": "IAU", "shares": 50, "price": 20},
        # 投弹/现金管理不计入月投实际倍率
        {"date": "2026-02-12", "type": "投弹", "symbol": "QQQM", "shares": 999, "price": 20},
    ])
    monkeypatch.setattr(server, "_get_settings", lambda: {"MONTHLY_BASE_OVERRIDE": 2000, "K_MAX_CAP": 0.2})

    entries = client.get("/api/signal-history").get_json()["entries"]
    # 图表曲线：所有 entry 均带逐日 signal_M
    assert all(e.get("signal_M") is not None for e in entries)
    # 月投事件 = 每月最后一个交易日（2 月应是 02-27 而非 02-02）
    monthly = [e["date"] for e in entries if e.get("monthly_event")]
    assert "2026-02-27" in monthly
    assert "2026-02-02" not in monthly
    feb = [e for e in entries if e["date"] == "2026-02-27"][0]
    # actual = 3000 / 2000 = 1.5（投弹 999 股不计入月投）
    assert feb["actual_M"] == 1.5
    assert feb["actual_invest"] == 3000.0
    # 金额：信号推荐月投 = base × signal_M；实际 = actual_invest
    assert feb["signal_amount"] == round(2000 * feb["signal_M"], 2)


def test_signal_history_bomb_signal_vs_actual(client, monkeypatch):
    """投弹事件锚定「实际投弹订单日」：当日策略推荐 K（信号建议比例）与实际投弹比例
    actual_bomb_pct（= 当日净投弹 ÷ 当时投弹池规模 year_max_reserve）同日对比。"""
    import server

    monkeypatch.setattr(server, "load_signal_history", lambda: {
        "entries": [
            {"date": "2026-03-03", "S": 0.6, "K": 0.1, "vix": 23.0, "qqqm_change_pct": -1.0,
             "qqqm_drop_3y_pctile": 0.3, "vix_3y_pctile": 0.7, "backfilled": True, "triggers": {}},
        ],
        "version": 1,
    })
    monkeypatch.setattr(server, "get_trades", lambda: [
        {"date": "2026-03-03", "type": "投弹", "action": "买入", "symbol": "QQQM", "shares": 40, "price": 250},
    ])
    # 投弹池 = 全年 year_max_reserve = 总净入金 100000 − 定投净买入 0 = 100000
    monkeypatch.setattr(server, "get_fund_records", lambda: [
        {"date": "2026-03-01", "amount": 100000, "note": "入金"},
    ])
    monkeypatch.setattr(server, "_get_settings", lambda: {"MONTHLY_BASE_OVERRIDE": 2000, "K_MAX_CAP": 0.2})

    e = client.get("/api/signal-history").get_json()["entries"][0]
    assert e["bomb_event"] is True
    assert e["bomb_level"] == "M2"  # QQQM 单日跌仅 -1%（非急跌）→ M2
    # M2 档按 RR 风险预算：RR=(0.6×0.3+0.4×0.7)×0.9≈0.41 ∈ [0.25,0.7) → K=0.10
    assert e["bomb_signal_pct"] == 10.0  # 当日推荐 K%（图表/信号侧，公开）
    assert e["bomb_signal_amount"] == 10000.0  # K(0.1) × 100000（全年池）
    assert e["bomb_actual_amount"] == 10000.0  # 40 × 250
    assert e["actual_bomb_pct"] == 10.0  # 10000 / 100000


def test_signal_history_monthly_actual_is_net_of_sells(client, monkeypatch):
    """月投实际执行取当月「定投」净投入值（买入 − 卖出），卖出须冲减。"""
    import server

    monkeypatch.setattr(server, "load_signal_history", lambda: {
        "entries": [
            {"date": "2026-02-02", "S": 0.5, "backfilled": True},
            {"date": "2026-02-27", "S": 0.6, "backfilled": True},
        ],
        "version": 1,
    })
    monkeypatch.setattr(server, "get_trades", lambda: [
        # 定投：买入 100×50=5000，卖出 10×200=2000 → 净 3000
        {"date": "2026-02-10", "type": "定投", "action": "买入", "symbol": "QQQM", "shares": 100, "price": 50},
        {"date": "2026-02-11", "type": "定投", "action": "卖出", "symbol": "IVV", "shares": 10, "price": 200},
    ])
    monkeypatch.setattr(server, "get_fund_records", lambda: [])
    monkeypatch.setattr(server, "_get_settings", lambda: {"MONTHLY_BASE_OVERRIDE": 2000, "K_MAX_CAP": 0.2})

    feb = [e for e in client.get("/api/signal-history").get_json()["entries"]
           if e["date"] == "2026-02-27"][0]
    assert feb["actual_invest"] == 3000.0  # 5000 买入 − 2000 卖出
    assert feb["actual_M"] == 1.5


def test_signal_history_bomb_anchored_order_day_fullyear_pool_and_level(client, monkeypatch):
    """投弹事件锚定实际订单日（非规则回放日）：仅在有实际投弹的日期生成事件，
    占比/金额按全年 year_max_reserve（年度投弹总额）计算；档位按标的+VIX 判定；
    无实际投弹的信号日不产生投弹事件。"""
    import server

    monkeypatch.setattr(server, "load_signal_history", lambda: {
        "entries": [
            {"date": "2026-03-02", "S": 0.6, "K": 0.1, "vix": 19.0, "qqqm_change_pct": -3.0, "backfilled": True, "triggers": {}},
            {"date": "2026-03-05", "S": 0.6, "K": 0.2, "vix": 23.0, "qqqm_change_pct": 0.5, "backfilled": True, "triggers": {}},
            {"date": "2026-03-09", "S": 0.6, "K": 0.1, "vix": 26.0, "qqqm_change_pct": 1.0, "backfilled": True, "triggers": {}},
        ],
        "version": 1,
    })
    monkeypatch.setattr(server, "get_trades", lambda: [
        # 实际投弹仅 03-02（QQQM 1000）与 03-09（IAU 2000）；03-05 无实际投弹 → 无事件
        {"date": "2026-03-02", "type": "投弹", "action": "买入", "symbol": "QQQM", "shares": 10, "price": 100},
        {"date": "2026-03-09", "type": "投弹", "action": "买入", "symbol": "IAU", "shares": 20, "price": 100},
    ])
    # 全年 year_max_reserve = 总净入金 10000 − 定投净 0 = 10000（稳定基准）
    monkeypatch.setattr(server, "get_fund_records", lambda: [
        {"date": "2026-03-01", "amount": 10000, "note": "入金"},
    ])
    monkeypatch.setattr(server, "_get_settings", lambda: {"MONTHLY_BASE_OVERRIDE": 2000, "K_MAX_CAP": 0.2})

    es = {e["date"]: e for e in client.get("/api/signal-history").get_json()["entries"]}
    assert es["2026-03-02"].get("bomb_event") is True
    assert es["2026-03-09"].get("bomb_event") is True
    assert es["2026-03-05"].get("bomb_event") is None  # 无实际投弹 → 无事件
    # 档位：QQQM 单日跌 -3%（急跌）→ M1；IAU 标的 → IAU。M1/IAU 信号档 K 固定 0.05（5%）
    assert es["2026-03-02"]["bomb_level"] == "M1"
    assert es["2026-03-09"]["bomb_level"] == "IAU"
    assert es["2026-03-02"]["bomb_signal_pct"] == 5.0
    assert es["2026-03-09"]["bomb_signal_pct"] == 5.0
    # 全年池 10000：信号档金额 = K(0.05) × 10000 = 500；实际占比 = 净投弹 ÷ 10000
    assert es["2026-03-02"]["bomb_signal_amount"] == 500.0
    assert es["2026-03-02"]["bomb_actual_amount"] == 1000.0
    assert es["2026-03-02"]["actual_bomb_pct"] == 10.0
    assert es["2026-03-09"]["bomb_actual_amount"] == 2000.0
    assert es["2026-03-09"]["actual_bomb_pct"] == 20.0


def test_sanitize_signal_history_strips_actual_keeps_signal():
    """云端脱敏：剥离实际执行字段（actual_M/actual_invest/actual_bomb_pct，敏感），
    保留信号推荐倍率 signal_M、投弹信号档 K 与分位数（公开行情可算）。"""
    raw = {
        "entries": [
            {
                "date": "2026-06-13",
                "S": 0.62,
                "vix_3y_pctile": 0.82,
                "signal_M": 1.24,
                "signal_amount": 2480.0,
                "bomb_event": True,
                "bomb_signal_pct": 10.0,
                "actual_M": 33.1,
                "actual_invest": 66197.36,
                "actual_bomb_pct": 16.2,
                "bomb_signal_amount": 10000.0,
                "bomb_actual_amount": 11856.92,
                "backfilled": False,
            }
        ],
        "version": 1,
    }
    out = sanitize("signal-history.json", raw)
    e = out["entries"][0]
    assert e["S"] == 0.62
    assert e["vix_3y_pctile"] == 0.82
    assert e["signal_M"] == 1.24
    assert e["bomb_event"] is True  # 投弹事件标记保留（公开）
    assert e["bomb_signal_pct"] == 10.0  # 投弹信号 K%（公开）
    assert "actual_M" not in e
    assert "actual_invest" not in e
    assert "actual_bomb_pct" not in e
    # 金额一律云端脱敏
    assert "signal_amount" not in e
    assert "bomb_signal_amount" not in e
    assert "bomb_actual_amount" not in e


def test_index_html_es_module_and_methodology():
    from pathlib import Path
    text = Path(__file__).resolve().parents[1] / "index.html"
    content = text.read_text(encoding="utf-8")
    assert 'type="module" src="js/main.js"' in content
    assert 'id="modalMethodology"' in content
    assert 'id="globalStatusBar"' in content
    assert 'id="monthlyHeatTable"' in content
    assert 'id="tradeCalendarGrid"' in content
    assert 'id="chartSignalHistory"' in content
