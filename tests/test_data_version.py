"""数据版本状态条应在本地、云端均提供可追溯的有效版本。"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path

import server


ROOT = Path(__file__).resolve().parents[1]


def test_version_endpoint_reports_latest_local_data_file_mtime(tmp_path, monkeypatch):
    """本地模式不能只返回能力开关，否则状态条永远只能显示 --。"""
    paths = []
    for name, timestamp in (("trades.json", 1_700_000_000), ("price_cache.json", 1_700_000_123)):
        path = tmp_path / name
        path.write_text("{}", encoding="utf-8")
        os.utime(path, (timestamp, timestamp))
        paths.append(path)

    monkeypatch.setattr(server, "TRADES_FILE", paths[0])
    monkeypatch.setattr(server, "FUND_FILE", tmp_path / "missing-funds.json")
    monkeypatch.setattr(server, "MODEL_STATE_FILE", tmp_path / "missing-model.json")
    monkeypatch.setattr(server, "PRICE_CACHE_FILE", paths[1])

    payload = server.app.test_client().get("/api/version").get_json()

    expected = datetime.fromtimestamp(1_700_000_123, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    assert payload["updated_at"] == expected


def test_frontend_refreshes_cloud_version_and_retains_recent_version_on_failure():
    """每次载入都探测远端版本；网络失败才使用最近成功版本。"""
    source = (ROOT / "js" / "main.js").read_text(encoding="utf-8")

    assert "window.__localDataVersion" in source
    assert "ensureLocalVersion" in source
    assert "fetch(u, { cache: 'no-store' })" in source
    assert "(Date.now() - cv.t) < _CC_VER_TTL" not in source
