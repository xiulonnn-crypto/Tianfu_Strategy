# -*- coding: utf-8 -*-
"""Flask 必须通过 /data/backtest/*.json 暴露预生成的回测 JSON，供本地模式前端读取。"""

import json

import server


def _client():
    return server.app.test_client()


def test_backtest_summary_served_statically():
    """本地模式下 fetch('./data/backtest/v1.3.1-10y-summary.json') 必须拿到 200 + 正确 JSON。"""
    c = _client()
    resp = c.get("/data/backtest/v1.3.1-10y-summary.json")
    assert resp.status_code == 200, resp.status_code
    payload = json.loads(resp.data.decode("utf-8"))
    assert payload["version"] == "v1.3.1"
    assert payload["period"] == "10y"


def test_backtest_nav_and_trades_served_statically():
    c = _client()
    for name in (
        "v1.3.1-10y-nav.json",
        "v1.3.1-10y-trades.json",
        "v1.3.1-20y-summary.json",
        "v1.3.1-30y-summary.json",
    ):
        resp = c.get(f"/data/backtest/{name}")
        assert resp.status_code == 200, (name, resp.status_code)


def test_backtest_path_traversal_blocked():
    """防御性：不允许跨越目录访问其他敏感 JSON（如 data/trades.json）。"""
    c = _client()
    resp = c.get("/data/backtest/../trades.json")
    assert resp.status_code in (400, 403, 404)


def test_non_existent_backtest_file_is_404():
    c = _client()
    resp = c.get("/data/backtest/v1.3.1-99y-summary.json")
    assert resp.status_code == 404
