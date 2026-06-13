# -*- coding: utf-8 -*-
"""
用 price_cache.json 逐日重算可精确复原的分位数（VIX 3y 等），回填 signal_history。
触发态/金额字段留空，条目标记 backfilled=true。

用法：python3 scripts/backfill_signal_history.py
"""

from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server import (  # noqa: E402
    PRICE_CACHE_FILE,
    load_json,
    load_signal_history,
    save_signal_history,
)


def _pctile_rank(series: pd.Series, value: float) -> float | None:
    if series is None or series.empty:
        return None
    return round(float((series <= value).sum()) / len(series), 4)


def _history_closes(cache: dict, sym: str) -> pd.Series | None:
    hist = cache.get("history") or {}
    sym_data = hist.get(sym) or {}
    if not sym_data:
        return None
    rows = []
    for d, c in sym_data.items():
        try:
            rows.append((d[:10], float(c)))
        except (TypeError, ValueError):
            continue
    if not rows:
        return None
    rows.sort(key=lambda x: x[0])
    idx = pd.DatetimeIndex([r[0] for r in rows])
    return pd.Series([r[1] for r in rows], index=idx).dropna()


def backfill_from_price_cache() -> int:
    cache = load_json(PRICE_CACHE_FILE, None)
    if not cache or not isinstance(cache, dict):
        print("  ✗ 无 price_cache.json，跳过回填")
        return 1

    vix = _history_closes(cache, "^VIX")
    qqqm = _history_closes(cache, "QQQM")
    if vix is None or vix.empty:
        print("  ✗ price_cache 无 ^VIX 数据")
        return 1

    hist = load_signal_history()
    entries = {e.get("date"): e for e in hist.get("entries", []) if e.get("date")}
    added = 0

    for dt in vix.index:
        date_str = str(dt)[:10]
        window_start = (dt - pd.Timedelta(days=3 * 365)).strftime("%Y-%m-%d")
        vix_win = vix.loc[vix.index >= window_start]
        if len(vix_win) < 30:
            continue
        vix_val = float(vix.loc[dt])
        vix_pct = _pctile_rank(vix_win, vix_val)

        qqqm_drop_pct = None
        if qqqm is not None and dt in qqqm.index:
            q_win = qqqm.loc[qqqm.index >= window_start]
            if len(q_win) >= 5:
                q_val = float(qqqm.loc[dt])
                drops = (q_win / q_win.cummax() - 1.0) * 100
                cur_drop = (q_val / q_win.cummax().iloc[-1] - 1.0) * 100 if len(q_win) else 0
                qqqm_drop_pct = _pctile_rank(drops, cur_drop)

        snap = {
            "date": date_str,
            "S": None,
            "RR": None,
            "K": None,
            "R": None,
            "vix_3y_pctile": vix_pct,
            "pe_10y_pctile": None,
            "pe_3y_pctile": None,
            "ema200_deviation_3y_pctile": None,
            "ema20_deviation_3y_pctile": None,
            "qqqm_drop_3y_pctile": qqqm_drop_pct,
            "triggers": {},
            "backfilled": True,
        }
        if date_str in entries:
            existing = entries[date_str]
            if not existing.get("backfilled"):
                continue
            entries[date_str] = {**existing, **{k: v for k, v in snap.items() if v is not None}}
        else:
            entries[date_str] = snap
            added += 1

    merged = sorted(entries.values(), key=lambda x: x.get("date") or "")
    hist["entries"] = merged
    hist["updated_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    save_signal_history(hist)
    print(f"  ✓ 回填完成：新增 {added} 条，合计 {len(merged)} 条")
    return 0


if __name__ == "__main__":
    raise SystemExit(backfill_from_price_cache())
