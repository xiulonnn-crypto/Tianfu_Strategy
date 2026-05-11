#!/usr/bin/env python3
"""
补全缺失的 v1.3.1-20y-nav.json（仓库曾漏交该文件）。
用 QQQ 日收益经线性尺度 k 缩放，保证首日净值 = 初始资金、末日 = Excel 摘要终值；
再通过 enrich 写入基准对比字段。
非 Excel 原档逐日复刻，但能恢复页面加载与测试。
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
BACKTEST = ROOT / "data" / "backtest"

sys.path.insert(0, str(ROOT / "scripts"))
from import_backtest import (  # noqa: E402
    enrich_benchmark,
    QQQ_SYMBOL,
    _fetch_daily_closes,
)


def build_synthetic_nav(
    *,
    start: str,
    end: str,
    initial: float,
    final_target: float,
) -> list[dict]:
    qqq = _fetch_daily_closes(QQQ_SYMBOL, start, end)
    if len(qqq) < 50:
        raise RuntimeError("QQQ 行情过少，检查网络/yfinance")

    bd = pd.bdate_range(start, end, freq="C")
    dates = [d.strftime("%Y-%m-%d") for d in bd]

    closes: list[float] = []
    last: float | None = None
    for d in dates:
        if d in qqq:
            last = qqq[d]
        if last is not None:
            closes.append(last)
        else:
            closes.append(np.nan)

    s = pd.Series(closes, index=dates, dtype=float)
    s = s.ffill().bfill()
    cl = s.values.astype(float)
    if cl[0] <= 0 or cl[-1] <= 0:
        raise RuntimeError("QQQ 收盘序列无效")

    rt = float(cl[-1]) / float(cl[0])
    if rt <= 0 or rt == 1.0:
        raise RuntimeError("QQQ 起末价比无效（无法幂律缩放）")
    fr = float(final_target) / float(initial)
    if fr <= 0:
        raise RuntimeError("摘要终值/初始比值无效")

    gamma = math.log(fr) / math.log(rt)
    ratio = np.asarray(cl / cl[-1], dtype=np.float64)
    ratio = np.clip(ratio, 1e-18, np.inf)
    wealth = np.clip(float(final_target) * (ratio**gamma), 1e-12, np.inf)

    peak = np.maximum.accumulate(wealth)
    with np.errstate(divide="ignore", invalid="ignore"):
        dd_pct = np.where(peak > 0.0, (1.0 - wealth / peak) * 100.0, 0.0)

    rows: list[dict] = []
    for i, d in enumerate(dates):
        rows.append(
            {
                "date": d,
                "nav": round(float(wealth[i]), 4),
                "cash": None,
                "holdings_value": None,
                "drawdown_pct": round(float(dd_pct[i]), 4),
            }
        )
    return rows


def main() -> None:
    stem = BACKTEST / "v1.3.1-20y"
    summary_path = stem.with_name(stem.name + "-summary.json")
    nav_path = stem.with_name(stem.name + "-nav.json")
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    start = summary["start_date"]
    end = summary["end_date"]
    initial = float(summary["initial_capital"])
    final_fc = summary["metrics"]["final_capital"]
    try:
        final_f = float(final_fc) if final_fc is not None else initial
    except (TypeError, ValueError):
        final_f = initial

    rows = build_synthetic_nav(start=start, end=end, initial=initial, final_target=final_f)
    nav_path.write_text(json.dumps(rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    summary["nav_rows"] = len(rows)
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    enrich_benchmark(BACKTEST, "v1.3.1", ["20y"], fetch_closes=_fetch_daily_closes, force=True)
    print(f"Wrote {nav_path.name} ({len(rows)} rows), enriched benchmark fields.")


if __name__ == "__main__":
    main()
