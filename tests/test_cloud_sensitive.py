# -*- coding: utf-8 -*-
"""云端敏感信息：预计算脱敏 + 前端默认掩码（防回归）。"""

from pathlib import Path

import pytest

from compute import sanitize

ROOT = Path(__file__).resolve().parents[1]
INDEX_HTML = ROOT / "index.html"


def test_sanitize_trades_strips_price_shares_commission():
    """RED 替身：旧版 compute 保留 price/shares/commission 时本断言失败。"""
    raw = [
        {
            "date": "2026-01-15",
            "symbol": "QQQM",
            "action": "买入",
            "type": "定投",
            "price": 241.78,
            "shares": 24,
            "commission": 1.25,
        }
    ]
    out = sanitize("trades.json", raw)
    row = out[0]
    assert row["symbol"] == "QQQM"
    for key in ("price", "shares", "commission"):
        assert row[key] is None, f"{key} should be nullified for cloud JSON"


def test_index_html_cloud_sensitive_default_mask():
    """云端须用 __isCloudMode 初始化 __sensitiveHidden，且 doInit 再次强制 true。"""
    text = INDEX_HTML.read_text(encoding="utf-8")
    assert "__sensitiveHidden = window.__isCloudMode" in text
    assert "if (window.__isCloudMode) {\n        window.__sensitiveHidden = true;" in text
    # 禁止在模式检测后写死 false（曾导致交易明细明文）
    assert text.count("__sensitiveHidden = false") == 0


@pytest.mark.parametrize(
    "snippet",
    [
        "function _m(v) { return window.__sensitiveHidden ? '***' : v; }",
        "function renderTradesTable()",
        "_m(r.shares)",
        "_m('$' + Number(r.commission || 0).toFixed(2))",
    ],
)
def test_index_html_trade_table_uses_mask_helpers(snippet: str):
    text = INDEX_HTML.read_text(encoding="utf-8")
    assert snippet in text
