"""收益页行情状态必须区分行情基准日与缓存拉取时间，不能将后者说成行情更新。"""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_global_market_status_uses_data_as_of_as_market_reference():
    source = (ROOT / "js" / "main.js").read_text(encoding="utf-8")

    start = source.index("function updateGlobalStatusBar")
    end = source.index("\n    function _heatColor", start)
    status_function = source[start:end]

    assert "行情基准日：" in status_function
    assert "缓存拉取：" in status_function
    assert "opts.dataAsOf" in status_function
    assert "行情更新：" not in status_function
