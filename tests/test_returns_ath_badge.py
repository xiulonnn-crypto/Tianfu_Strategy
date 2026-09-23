# -*- coding: utf-8 -*-
"""历史新高横幅须与「发布以来」收益卡片使用同一正式累计收益。"""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_ath_badge_uses_since_card_pct_not_chart_tail():
    """曲线末点可能因起点对齐而与卡片 TWR 略有偏差，横幅应复用卡片值。"""
    source = (ROOT / "js" / "tabs" / "returns.js").read_text(encoding="utf-8")
    start = source.index("function updateAthBadge")
    end = source.index("\n    // ===== 策略驱动力", start)
    badge_function = source[start:end]

    assert "data.cards.since.pct" in badge_function
    assert "since.my[since.my.length - 1]" not in badge_function
