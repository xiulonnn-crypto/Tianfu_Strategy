# -*- coding: utf-8 -*-
"""云端敏感信息：预计算脱敏 + 前端默认掩码（防回归）。"""

from pathlib import Path

import pytest

from compute import sanitize

ROOT = Path(__file__).resolve().parents[1]
INDEX_HTML = ROOT / "index.html"


def test_sanitize_trades_keeps_price_strips_shares_commission():
    """云端 trades.json 保留成交价，剔除股数与佣金。"""
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
    assert row["price"] == 241.78
    for key in ("shares", "commission"):
        assert row[key] is None, f"{key} should be nullified for cloud JSON"


def test_index_html_cloud_sensitive_default_mask():
    """云端须用 __isCloudMode 初始化 __sensitiveHidden，且 doInit 再次强制 true。"""
    text = INDEX_HTML.read_text(encoding="utf-8")
    assert "__sensitiveHidden = window.__isCloudMode" in text
    assert "if (window.__isCloudMode) {\n        window.__sensitiveHidden = true;" in text
    # 禁止在模式检测后写死 false（曾导致交易明细明文）
    assert text.count("__sensitiveHidden = false") == 0


def test_index_html_trade_table_cloud_hides_shares_commission():
    """交易明细表：股数/佣金列带 cloud-hide-col，价格不经 _m 掩码。"""
    text = INDEX_HTML.read_text(encoding="utf-8")
    assert '<th class="text-right p-3 cloud-hide-col">股数</th>' in text
    assert 'col-commission cloud-hide-col">佣金(USD)</th>' in text
    assert "var priceStr = r.price != null ? '$' + Number(r.price).toFixed(2) : '--';" in text
    assert "cloud-hide-col\">' + sharesStr + '" in text
    assert "col-commission cloud-hide-col\">' + commStr + '" in text


@pytest.mark.parametrize(
    "snippet",
    [
        "function _m(v) { return window.__sensitiveHidden ? '***' : v; }",
        "function renderTradesTable()",
    ],
)
def test_index_html_trade_table_uses_mask_helpers(snippet: str):
    text = INDEX_HTML.read_text(encoding="utf-8")
    assert snippet in text
