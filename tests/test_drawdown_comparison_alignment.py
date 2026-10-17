"""回撤图的比较曲线必须与含期初点的回撤序列对齐。"""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_drawdown_comparison_prepends_the_period_start_point():
    """QQQ/DCA 累计收益少一个期初点，不能导致最新交易日缺失。"""
    source = (ROOT / "js" / "main.js").read_text(encoding="utf-8")
    start = source.index("function buildDrawdownChart")
    end = source.index("function renderTop3Drawdowns", start)
    drawdown_chart = source[start:end]

    assert "var comparisonValues = [0].concat(chartData[seriesKey]);" in drawdown_chart
    assert "comparisonValues.slice(0, ds.labels.length)" in drawdown_chart
    assert "return [0].concat(values || []).slice(0, ds.labels.length)" in drawdown_chart
