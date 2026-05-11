# -*- coding: utf-8 -*-
"""收益概览风险指标：夏普 / Beta / Jensen Alpha 数值口径单测。"""

import numpy as np

import server


def test_get_risk_free_falls_back_when_fred_returns_none(monkeypatch) -> None:
    monkeypatch.setattr(server, "_RISK_FREE_DGS1_CACHE", None)
    monkeypatch.setattr(server, "fetch_fred_dgs1_yield_pct_latest", lambda **__: None)
    assert abs(server.get_risk_free_us1y_annual_decimal() - server.RISK_FREE_RATE_FALLBACK) < 1e-12


def test_sharpe_beta_jensen_beta_scales_with_benchmark() -> None:
    """组合日收益 = 2× 纳指日收益时，OLS Beta 应约为 2。"""
    rng = np.random.default_rng(0)
    rb = rng.normal(0.0, 0.012, 120)
    rp = 2.0 * rb
    sh, beta, alpha_pct = server._sharpe_beta_jensen_pct_from_daily(rp, rb, 0.0)
    assert beta is not None and abs(beta - 2.0) < 0.02
    assert sh is not None
    assert isinstance(alpha_pct, (int, float))


def test_jensen_alpha_matches_capm_definition() -> None:
    """给定序列，Alpha 与公式 R_p-R_fh-β(R_m-R_fh) 一致（考虑四舍五入）。"""
    rf_ann = 0.021  # 固定实验年化无风险小数，独立于生产 DGS1
    rp = np.array([0.004, -0.001, 0.0025, -0.0005, 0.001], dtype=float)
    rb = np.array([0.003, -0.0012, 0.002, -0.0003, 0.0008], dtype=float)
    _sh, beta, alpha_pct = server._sharpe_beta_jensen_pct_from_daily(rp, rb, rf_ann)
    assert beta is not None
    n = len(rp)
    r_p = float(np.prod(1.0 + rp) - 1.0)
    r_m = float(np.prod(1.0 + rb) - 1.0)
    r_fh = server._compound_horizon_rf(rf_ann, n)
    expected_alpha_pct = (r_p - r_fh - beta * (r_m - r_fh)) * 100.0
    assert abs(expected_alpha_pct - alpha_pct) <= 0.06


def test_sharpe_near_zero_when_mean_daily_excess_is_zero() -> None:
    """日超额收益均值为 0（有波动）时，年化夏普应接近 0。"""
    rf = 0.035
    rf_d = server._equivalent_daily_rf(rf)
    rng = np.random.default_rng(2)
    noise = rng.normal(0, 0.008, 100)
    rp = rf_d + noise - float(np.mean(noise))
    rb = rng.normal(0.0002, 0.01, 100)
    sh, _beta, _ = server._sharpe_beta_jensen_pct_from_daily(rp, rb, rf)
    assert sh is not None and abs(sh) < 0.05


def test_sortino_undefined_when_no_downside_excess() -> None:
    """日超额收益全为非负时下行偏差为 0，Sortino 不予定义。"""
    rp = np.array([0.001, 0.002, 0.0015], dtype=float)
    assert server._sortino_ratio_from_daily(rp, 0.0) is None


def test_sortino_finite_with_mixed_excess() -> None:
    rng = np.random.default_rng(4)
    rp = rng.normal(0.0002, 0.012, 120)
    s = server._sortino_ratio_from_daily(rp, 0.02)
    assert s is not None and np.isfinite(s)


def test_bench_sortino_uses_same_sortino_formula() -> None:
    """纳指 Sortino 与组合共用 _sortino_ratio_from_daily（仅输入序列不同）。"""
    rb = np.array([0.001, -0.002, 0.0015, -0.0005, 0.002], dtype=float)
    rf = 0.025
    s = server._sortino_ratio_from_daily(rb, rf)
    assert s is not None and isinstance(s, float)


def test_bench_sharpe_matches_portfolio_sharpe_when_inputs_equal() -> None:
    """单序列基准夏普应与 _sharpe_beta_jensen_pct_from_daily 在 rp==rb 时的组合夏普一致。"""
    rng = np.random.default_rng(7)
    r = rng.normal(0.0003, 0.011, 120)
    rf = 0.032
    sh_pair, _beta, _alpha = server._sharpe_beta_jensen_pct_from_daily(r, r, rf)
    sh_single = server._sharpe_ratio_from_daily(r, rf)
    assert sh_pair is not None and sh_single is not None
    assert abs(sh_pair - sh_single) < 1e-9


def test_bench_sharpe_none_when_no_volatility() -> None:
    """波动近 0 时基准夏普未定义。"""
    r = np.array([0.0, 0.0, 0.0, 0.0], dtype=float)
    assert server._sharpe_ratio_from_daily(r, 0.02) is None


def test_calmar_ratio_matches_ann_over_max_drawdown_pct() -> None:
    rp = np.array([0.01, -0.005, 0.02], dtype=float)
    dd_pct = 15.0
    n = len(rp)
    prod = float(np.prod(1.0 + rp))
    years = max(n / 252.0, 1e-9)
    ann = prod ** (1.0 / years) - 1.0
    expected = round(float(ann / (dd_pct / 100.0)), 2)
    assert server._calmar_ratio_from_daily(rp, dd_pct) == expected


def test_calmar_none_when_drawdown_too_small() -> None:
    assert server._calmar_ratio_from_daily(np.array([0.01, 0.02]), 0.0) is None
