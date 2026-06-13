# -*- coding: utf-8 -*-
"""
将当日 signals 快照追加到 data/signal_history.json。
可由 compute.py 在预计算流水线末尾调用；亦可在本地手动执行。

用法：python3 scripts/append_signal_history.py
"""

from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server import app, append_signal_history_entry, load_signal_history, save_signal_history  # noqa: E402


def main() -> int:
    client = app.test_client()
    resp = client.get("/api/signals")
    if resp.status_code != 200:
        print(f"  ✗ /api/signals → HTTP {resp.status_code}")
        return 1
    payload = resp.get_json() or {}
    append_signal_history_entry(payload)
    hist = load_signal_history()
    hist["updated_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    save_signal_history(hist)
    n = len(hist.get("entries", []))
    print(f"  ✓ signal_history.json（{n} 条）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
