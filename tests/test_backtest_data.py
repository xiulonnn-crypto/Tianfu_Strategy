"""校验 data/backtest 下预生成的回测 JSON 结构与一致性。"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
BACKTEST = ROOT / "data" / "backtest"
PERIODS = ("10y", "20y", "30y")
VERSION = "v1.3.1"


def _load(name: str) -> dict | list:
    p = BACKTEST / name
    assert p.is_file(), f"missing {p}"
    return json.loads(p.read_text(encoding="utf-8"))


@pytest.mark.parametrize("period", PERIODS)
def test_summary_schema(period: str) -> None:
    data = _load(f"{VERSION}-{period}-summary.json")
    assert data.get("version") == VERSION
    assert data.get("period") == period
    assert isinstance(data.get("symbols"), list) and len(data["symbols"]) >= 1
    for k in ("start_date", "end_date", "initial_capital", "commission_rate", "slippage_bps"):
        assert k in data
    m = data["metrics"]
    for k in (
        "cumulative_return_pct",
        "cagr_pct",
        "max_drawdown_pct",
        "sharpe",
        "trade_count",
        "final_capital",
    ):
        assert k in m
    assert isinstance(m["trade_count"], int) and m["trade_count"] > 0
    tdd = data.get("top_drawdowns") or []
    assert len(tdd) <= 3
    depths = [x["drawdown_pct"] for x in tdd]
    assert depths == sorted(depths, reverse=True)


@pytest.mark.parametrize("period", PERIODS)
def test_nav_and_trades_align_with_summary(period: str) -> None:
    summary = _load(f"{VERSION}-{period}-summary.json")
    nav = _load(f"{VERSION}-{period}-nav.json")
    trades = _load(f"{VERSION}-{period}-trades.json")
    assert isinstance(nav, list) and len(nav) > 100
    assert summary["nav_rows"] == len(nav)
    assert "benchmark" in summary
    bm = summary["benchmark"]
    assert bm.get("symbol") == "QQQ"
    assert "proxy_days" in bm
    assert len(trades) == summary["metrics"]["trade_count"]
    assert all("date" in r and "nav" in r for r in nav[:5])
    assert all(
        k in nav[0] for k in ("port_ret_pct", "qqq_bh_pct", "qqq_dca_pct")
    )
    assert all("symbol" in t and "side" in t for t in trades[:5])


@pytest.mark.parametrize("period", PERIODS)
def test_nav_monotonic_dates(period: str) -> None:
    nav = _load(f"{VERSION}-{period}-nav.json")
    dates = [r["date"] for r in nav]
    assert dates == sorted(dates)
