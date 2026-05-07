# -*- coding: utf-8 -*-
"""price_cache 写入须包含 fetched_at（UTC），且不得因未导入 timezone 而崩溃。"""

import json
from pathlib import Path

import pytest


@pytest.fixture()
def isolated_price_cache(monkeypatch, tmp_path):
    import server

    p = tmp_path / "price_cache.json"
    monkeypatch.setattr(server, "PRICE_CACHE_FILE", p)
    return server, p


def test_save_price_cache_writes_fetched_at_utc(isolated_price_cache):
    server, path = isolated_price_cache
    server._save_price_cache(
        ["QQQM"],
        "2025-01-01",
        "2025-06-01",
        {},
        {},
        ["2025-03-01"],
    )
    raw = json.loads(path.read_text(encoding="utf-8"))
    assert "fetched_at" in raw
    fa = raw["fetched_at"]
    assert fa.endswith("Z"), fa
    assert "T" in fa
    parts = fa.replace("Z", "").split("T", 1)
    assert len(parts) == 2
    hms = parts[1].split(":")
    assert len(hms) == 3, fa

