# -*- coding: utf-8 -*-
"""云端敏感信息：预计算脱敏 + 前端默认掩码（防回归）。"""

from pathlib import Path

import pytest

from compute import sanitize

ROOT = Path(__file__).resolve().parents[1]
INDEX_HTML = ROOT / "index.html"
MAIN_JS = ROOT / "js" / "main.js"


def _frontend_bundle() -> str:
    return INDEX_HTML.read_text(encoding="utf-8") + MAIN_JS.read_text(encoding="utf-8")


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


def test_sanitize_asset_analysis_keeps_avg_cost_strips_shares():
    """云端 asset-analysis 保留均价/现价，剔除总股数。"""
    raw = {
        "metrics": {"avg_cost": 250.12, "current_price": 291.05, "total_shares": 120},
        "trade_attribution": [{"shares": 10, "pnl": 500, "buy_price": 240.0}],
    }
    out = sanitize("asset-analysis-QQQM.json", raw)
    assert out["metrics"]["avg_cost"] == 250.12
    assert out["metrics"]["current_price"] == 291.05
    assert out["metrics"]["total_shares"] is None
    assert out["trade_attribution"][0]["shares"] is None
    assert out["trade_attribution"][0]["pnl"] is None


def test_index_html_cloud_sensitive_default_mask():
    """云端须用 __isCloudMode 初始化 __sensitiveHidden，且 doInit 再次强制 true。"""
    text = _frontend_bundle()
    assert "__sensitiveHidden = window.__isCloudMode" in text
    assert "if (window.__isCloudMode) {\n        window.__sensitiveHidden = true;" in text
    assert text.count("__sensitiveHidden = false") == 0


def test_index_html_trade_table_cloud_hides_shares_commission():
    """交易明细表：股数/佣金列带 cloud-hide-col，价格不经 _m 掩码；CSS 覆盖异步 tbody。"""
    html = INDEX_HTML.read_text(encoding="utf-8")
    bundle = _frontend_bundle()
    assert '<th class="text-right p-3 cloud-hide-col">股数</th>' in html
    assert 'col-commission cloud-hide-col">佣金(USD)</th>' in html
    assert "var priceStr = r.price != null ? '$' + Number(r.price).toFixed(2) : '--';" in bundle
    assert "cloud-hide-col\">' + sharesStr + '" in bundle
    assert "col-commission cloud-hide-col\">' + commStr + '" in bundle
    assert "html.cloud-mode .cloud-hide-col { display: none !important; }" in html
    assert "document.documentElement.classList.add('cloud-mode')" in bundle
    assert "均价 $'+Number(m.avg_cost).toFixed(2)+' → 现价 $'+m.current_price" in bundle


@pytest.mark.parametrize(
    "snippet",
    [
        "function _m(v) { return window.__sensitiveHidden ? '***' : v; }",
        "function renderTradesTable()",
    ],
)
def test_index_html_trade_table_uses_mask_helpers(snippet: str):
    assert snippet in MAIN_JS.read_text(encoding="utf-8")
