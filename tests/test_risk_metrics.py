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
