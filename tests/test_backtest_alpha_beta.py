"""回测 Alpha/Beta 重算测试：验证纯函数与最终 JSON 均有合理非零值。"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
BACKTEST = ROOT / "data" / "backtest"
VERSION = "v1.3.1"
PERIODS = ("10y", "20y", "30y")


def test_compute_alpha_beta_from_returns_synthetic() -> None:
    """β≈1.5 合成序列：组合=1.5×基准+小噪声，α≈0 / β≈1.5。"""
    import random

    from scripts.import_backtest import compute_alpha_beta_from_returns

    rnd = random.Random(42)
    rb = [rnd.gauss(0.0005, 0.01) for _ in range(2000)]
    rp = [1.5 * x + rnd.gauss(0.0, 0.001) for x in rb]

    alpha_pct, beta = compute_alpha_beta_from_returns(rp, rb)
    assert alpha_pct is not None and beta is not None
    assert 1.4 <= beta <= 1.6, f"beta={beta} out of expected range"
    assert abs(alpha_pct) < 1.0, f"alpha_pct={alpha_pct} not near zero"


def test_compute_alpha_beta_returns_none_on_empty() -> None:
    from scripts.import_backtest import compute_alpha_beta_from_returns

    assert compute_alpha_beta_from_returns([], []) == (None, None)
    assert compute_alpha_beta_from_returns([0.01], [0.01]) == (None, None)


@pytest.mark.parametrize("period", PERIODS)
def test_backtest_summary_has_nonzero_alpha_beta(period: str) -> None:
    """所有周期的 summary.json 必须有合理的非零 alpha/beta。"""
    data = json.loads((BACKTEST / f"{VERSION}-{period}-summary.json").read_text(encoding="utf-8"))
    m = data["metrics"]
    assert m.get("beta") is not None, f"{period}: beta is None"
    assert m.get("alpha_pct") is not None, f"{period}: alpha_pct is None"
    assert m["beta"] > 0.1, f"{period}: beta={m['beta']} too small"
    assert m["alpha_pct"] != 0.0, f"{period}: alpha_pct is exactly 0 (suspicious)"
