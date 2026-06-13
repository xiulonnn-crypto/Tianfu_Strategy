# -*- coding: utf-8 -*-
"""三期新增端点与脱敏回归。"""

import pytest

from compute import sanitize
from server import app


@pytest.fixture
def client():
    return app.test_client()


def test_monthly_returns_structure(client):
    resp = client.get("/api/monthly-returns")
    assert resp.status_code == 200
    data = resp.get_json()
    assert "rows" in data
    assert data.get("method") == "TWR"
    if data["rows"]:
        row = data["rows"][0]
        assert "year" in row
        assert "months" in row
        assert len(row["months"]) == 12


def test_signal_history_endpoint(client):
    resp = client.get("/api/signal-history")
    assert resp.status_code == 200
    data = resp.get_json()
    assert "entries" in data
    assert isinstance(data["entries"], list)


def test_sanitize_signal_history_passthrough():
    raw = {
        "entries": [
            {
                "date": "2026-06-13",
                "S": 0.62,
                "vix_3y_pctile": 0.82,
                "triggers": {"M1": {"triggered": False}},
                "backfilled": False,
            }
        ],
        "version": 1,
    }
    out = sanitize("signal-history.json", raw)
    assert out["entries"][0]["S"] == 0.62
    assert out["entries"][0]["vix_3y_pctile"] == 0.82


def test_index_html_es_module_and_methodology():
    from pathlib import Path
    text = Path(__file__).resolve().parents[1] / "index.html"
    content = text.read_text(encoding="utf-8")
    assert 'type="module" src="js/main.js"' in content
    assert 'id="modalMethodology"' in content
    assert 'id="globalStatusBar"' in content
    assert 'id="monthlyHeatTable"' in content
    assert 'id="tradeCalendarGrid"' in content
    assert 'id="chartSignalHistory"' in content
