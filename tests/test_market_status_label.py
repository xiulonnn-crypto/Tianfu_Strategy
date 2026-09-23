"""全局行情状态仅展示实际用于计算的行情基准日。"""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_global_market_status_uses_data_as_of_as_market_reference():
    source = (ROOT / "js" / "main.js").read_text(encoding="utf-8")

    start = source.index("function updateGlobalStatusBar")
    end = source.index("\n    function _heatColor", start)
    status_function = source[start:end]

    assert "行情基准日：" in status_function
    assert "缓存拉取：" not in status_function
    assert "opts.dataAsOf" in status_function
    assert "行情更新：" not in status_function
