"""scripts/import_backtest.py：enrich-benchmark 与收益率曲线计算。"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def _load_import_backtest():
    path = ROOT / "scripts" / "import_backtest.py"
    spec = importlib.util.spec_from_file_location("import_backtest_mod", path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


ib = _load_import_backtest()


def test_compute_port_return_pct_aligned_matches_summary():
    nav_path = ROOT / "data" / "backtest" / "v1.3.1-10y-nav.json"
    summary_path = ROOT / "data" / "backtest" / "v1.3.1-10y-summary.json"
    if not nav_path.is_file():
        pytest.skip("no backtest fixture")
    nav_rows = json.loads(nav_path.read_text(encoding="utf-8"))
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    cum = summary["metrics"]["cumulative_return_pct"]
    out = ib.compute_port_return_pct_aligned(nav_rows, float(cum))
    assert out[-1] == pytest.approx(float(cum), rel=1e-6)


def test_compute_port_twr_synthetic_no_external_matches_naive():
    """无外部注入、无交易时，日链 TWR 累计应接近 nav 比值。"""
    nav_rows = [
        {"date": "2020-01-02", "nav": 100000.0, "cash": 0.0},
        {"date": "2020-01-03", "nav": 101000.0, "cash": 0.0},
        {"date": "2020-01-06", "nav": 100500.0, "cash": 0.0},
    ]
    trades: list = []
    s = ib.compute_port_twr_pct_series(nav_rows, trades)
    naive = (nav_rows[-1]["nav"] / nav_rows[0]["nav"] - 1.0) * 100.0
    assert s[-1] == pytest.approx(naive, rel=1e-4)


def test_qqq_dca_monthly_schedule():
    px = [100.0, 100.0, 110.0, 110.0]
    nav_dates = ["2020-01-02", "2020-01-03", "2020-02-03", "2020-02-04"]
    out = ib.compute_qqq_dca_pct_series(nav_dates, px, 1200.0)
    assert out[0] == pytest.approx(0.0)
    assert out[-1] is not None
    assert out[-1] > 0


def test_build_qqq_proxy_series_seamless_splice():
    nav_dates = ["1999-03-08", "1999-03-09", "1999-03-10", "1999-03-11"]
    qqq = {"1999-03-10": 45.0, "1999-03-11": 46.0}
    ixic = {"1999-03-08": 2000.0, "1999-03-09": 2010.0, "1999-03-10": 2020.0, "1999-03-11": 2030.0}
    px, proxy_days, first = ib._build_qqq_proxy_series(nav_dates, qqq, ixic)
    assert first == "1999-03-10"
    assert proxy_days == 2
    k = 45.0 / 2020.0
    assert px[0] == pytest.approx(k * 2000.0)
    assert px[1] == pytest.approx(k * 2010.0)
    assert px[2] == 45.0
    assert px[3] == 46.0


def test_enrich_skips_ixic_when_nav_starts_after_ipo(tmp_path: Path):
    calls: list[str] = []

    def fake_fetch(sym: str, start: str, end: str) -> dict[str, float]:
        calls.append(sym)
        if sym == "QQQ":
            return {"2016-01-04": 100.0, "2016-01-05": 101.0}
        return {}

    nav_rows = [
        {"date": "2016-01-04", "nav": 1e5, "cash": 1.0, "holdings_value": 1.0, "drawdown_pct": 0.0},
        {"date": "2016-01-05", "nav": 1.01e5, "cash": 1.0, "holdings_value": 1.0, "drawdown_pct": 0.0},
    ]
    summary = {
        "version": "t",
        "period": "t",
        "start_date": "2016-01-04",
        "end_date": "2016-01-05",
        "initial_capital": 10000.0,
        "metrics": {"cumulative_return_pct": 1.0},
    }
    (tmp_path / "t-t-nav.json").write_text(json.dumps(nav_rows), encoding="utf-8")
    (tmp_path / "t-t-summary.json").write_text(json.dumps(summary), encoding="utf-8")
    (tmp_path / "t-t-trades.json").write_text("[]", encoding="utf-8")

    ib.enrich_benchmark(tmp_path, "t", ["t"], force=True, fetch_closes=fake_fetch)
    assert "QQQ" in calls
    assert ib.BENCHMARK_SYMBOL not in calls
