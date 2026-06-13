# -*- coding: utf-8 -*-
"""
逐日重算可精确复原的分位数（VIX 3y、QQQM 跌幅、EMA 偏离等），回填 signal_history。
触发态/金额字段留空，条目标记 backfilled=true。

数据源优先级：
  1) price_cache.json（离线、确定性，CI 友好）——仅当其中含 ^VIX 时可用；
  2) 回退：按 3 年窗口实时拉取 ^VIX / QQQM（与分位数引擎同一抓取通道）。
  主价格缓存只存权益/基准标的、从不含 ^VIX，故本地多数情况下走回退路径。

用法：python3 scripts/backfill_signal_history.py
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server import (  # noqa: E402
    PRICE_CACHE_FILE,
    _fetch_histories_raw,
    _signal_s,
    compute_risk_budget,
    load_json,
    load_signal_history,
    save_signal_history,
)


def _pctile_rank(series: pd.Series, value: float) -> float | None:
    if series is None or series.empty:
        return None
    return round(float((series <= value).sum()) / len(series), 4)


def _history_closes(cache: dict, sym: str) -> pd.Series | None:
    hist = (cache or {}).get("history") or {}
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


def _series_from_df(df) -> pd.Series | None:
    """将 _fetch_histories_raw 返回的 DataFrame 转为 Close Series。
    yfinance 返回 tz-aware 索引，统一归一化为 tz-naive 午夜日期，
    与 price_cache 字符串日期索引一致，确保跨标的（^VIX/QQQM）成员判断与切片对齐。"""
    if df is None or getattr(df, "empty", True):
        return None
    if "Close" not in df.columns:
        return None
    s = df["Close"].dropna()
    if s.empty:
        return None
    idx = pd.DatetimeIndex(s.index)
    if idx.tz is not None:
        idx = idx.tz_localize(None)
    s.index = idx.normalize()
    return s[~s.index.duplicated(keep="last")]


# 回填覆盖范围：尽量回溯「全部」可算信号。QQQM 自 2020-10 上市起才有股价分量，
# 故时间线起点 ≈ QQQM 上市日。VIX 多拉 ~9 年，使最早的 QQQM 日仍有 3 年 VIX 分位上下文。
_VIX_QQQM_LOOKBACK_DAYS = 9 * 365 + 60


def _resolve_series() -> tuple[pd.Series | None, pd.Series | None, pd.Series | None, str]:
    """返回 (vix, qqqm, iau, source)。优先 price_cache，缺 ^VIX 时回退到实时长窗拉取（覆盖 QQQM 全历史）。
    IAU 用于回放 IAU 投弹（单日跌≤-5%）的历史触发。"""
    cache = load_json(PRICE_CACHE_FILE, None)
    if isinstance(cache, dict):
        vix = _history_closes(cache, "^VIX")
        if vix is not None and not vix.empty:
            return (vix, _history_closes(cache, "QQQM"),
                    _history_closes(cache, "IAU"), "price_cache")

    dt = datetime.now()
    start = (dt - timedelta(days=_VIX_QQQM_LOOKBACK_DAYS)).strftime("%Y-%m-%d")
    end_d = (dt + timedelta(days=1)).strftime("%Y-%m-%d")
    raw = _fetch_histories_raw(["^VIX", "QQQM", "IAU"], start, end_d)
    return (_series_from_df(raw.get("^VIX")), _series_from_df(raw.get("QQQM")),
            _series_from_df(raw.get("IAU")), "yfinance")


def _deviation_pctile(closes: pd.Series, dt, span: int, window_start: str) -> float | None:
    """EMA 偏离分位：(price/ema-1) 当日值在 3 年窗口内的分位。需窗口内 >span 个交易日。"""
    if closes is None or dt not in closes.index:
        return None
    win = closes.loc[closes.index >= window_start]
    win = win.loc[win.index <= dt]
    if len(win) <= span:
        return None
    ema = win.ewm(span=span, adjust=False).mean()
    dev = (win / ema - 1.0).dropna()
    if len(dev) <= 10:
        return None
    return _pctile_rank(dev, float(dev.iloc[-1]))


def _above_ema200(closes: pd.Series, dt, window_start: str) -> bool | None:
    """当日 QQQM 收盘是否在 EMA200 之上（用于风险预算 K 的 S_ema 系数）。"""
    if closes is None or dt not in closes.index:
        return None
    win = closes.loc[(closes.index >= window_start) & (closes.index <= dt)]
    if len(win) <= 200:
        return None
    ema = win.ewm(span=200, adjust=False).mean()
    return bool(float(win.iloc[-1]) > float(ema.iloc[-1]))


def _bomb_k(qqqm_drop_pctile, vix_pctile, above_ema200, level) -> float | None:
    """复现线上口径的投弹风险预算 K（占年度备弹上限的比例）。K 仅依赖分位数与档位，
    与备弹池/年度上限无关（后两者只影响 T 金额），故历史可复原。"""
    qe = {
        "qqqm_drop_3y_pctile": qqqm_drop_pctile,
        "vix_3y_pctile": vix_pctile,
        "qqqm_above_ema200": above_ema200,
    }
    budget_level = "M1" if level in ("M1", "IAU") else level
    rb = compute_risk_budget(qe, 1e12, 1.0, trigger_level=budget_level)
    return round(rb["K"], 4)


def _pe_pctiles(spy: pd.Series | None, dt) -> tuple[float | None, float | None]:
    """PE（SPY 价位代理）10y/3y 分位，复刻 server.compute_quantile_engine 的口径：
    10y = SPY 在 [dt-10y, dt] 窗口内 ≤ 当日价的占比；3y = 该窗口末 756 个交易日内的占比。"""
    if spy is None or spy.empty:
        return None, None
    s_up = spy.loc[spy.index <= dt]
    if len(s_up) <= 20:
        return None, None
    win_start = (dt - pd.Timedelta(days=10 * 365 + 60))
    win10 = s_up.loc[s_up.index >= win_start]
    if len(win10) <= 20:
        return None, None
    cur = float(s_up.loc[dt]) if dt in s_up.index else float(s_up.iloc[-1])
    pe10 = _pctile_rank(win10, cur)
    win3 = win10.iloc[-756:] if len(win10) > 756 else win10
    pe3 = _pctile_rank(win3, cur)
    return pe10, pe3


def _fetch_spy_long() -> pd.Series | None:
    """拉取 ~19 年 SPY 收盘，使最早的 QQQM 日（~2020-10）也能回看 10 年算 PE 分位。"""
    dt = datetime.now()
    start = (dt - timedelta(days=19 * 365 + 60)).strftime("%Y-%m-%d")
    end_d = (dt + timedelta(days=1)).strftime("%Y-%m-%d")
    raw = _fetch_histories_raw(["SPY"], start, end_d)
    return _series_from_df(raw.get("SPY"))


def backfill_from_price_cache() -> int:
    vix, qqqm, iau, source = _resolve_series()
    if vix is None or vix.empty:
        print("  ✗ 无可用 ^VIX 数据（price_cache 与实时拉取均失败），跳过回填")
        return 1
    spy = _fetch_spy_long()
    print(f"  · 数据源：{source}，^VIX {len(vix)} 个交易日"
          + (f"，SPY {len(spy)} 个交易日" if spy is not None else "，SPY 不可用（PE 分位按中性兜底）")
          + (f"，IAU {len(iau)} 个交易日" if iau is not None else "，IAU 不可用（IAU 投弹不回放）"))

    hist = load_signal_history()
    entries = {e.get("date"): e for e in hist.get("entries", []) if e.get("date")}
    added = 0

    cur_month = None

    # 以 QQQM 交易日为驱动：信号含股价分量，故仅回填 QQQM 有数据之后的日期
    # （避免 2020 上市前产生只有 VIX、其余分量按 0.5 兜底的失真信号点）。
    driver = qqqm if (qqqm is not None and not qqqm.empty) else vix
    for dt in driver.index:
        date_str = str(dt)[:10]
        if dt not in vix.index:
            continue
        window_start = (dt - pd.Timedelta(days=3 * 365)).strftime("%Y-%m-%d")
        vix_win = vix.loc[vix.index >= window_start]
        vix_win = vix_win.loc[vix_win.index <= dt]
        if len(vix_win) < 30:
            continue
        vix_val = float(vix.loc[dt])
        vix_pct = _pctile_rank(vix_win, vix_val)

        qqqm_drop_pct = None
        if qqqm is not None and dt in qqqm.index:
            q_win = qqqm.loc[qqqm.index >= window_start]
            q_win = q_win.loc[q_win.index <= dt]
            if len(q_win) >= 5:
                q_val = float(qqqm.loc[dt])
                drops = (q_win / q_win.cummax() - 1.0) * 100
                cur_drop = (q_val / q_win.cummax().iloc[-1] - 1.0) * 100 if len(q_win) else 0
                qqqm_drop_pct = _pctile_rank(drops, cur_drop)

        # QQQM 单日涨跌幅（用于投弹档位 M1 急跌判定：单日跌幅≤-2%）
        qqqm_chg = None
        if qqqm is not None and dt in qqqm.index:
            _pos = qqqm.index.get_loc(dt)
            if isinstance(_pos, int) and _pos > 0:
                _prev = float(qqqm.iloc[_pos - 1])
                if _prev:
                    qqqm_chg = round((float(qqqm.iloc[_pos]) / _prev - 1.0) * 100, 2)

        ema200_dev = _deviation_pctile(qqqm, dt, 200, window_start)
        ema20_dev = _deviation_pctile(qqqm, dt, 20, window_start)
        pe10, pe3 = _pe_pctiles(spy, dt)

        # 合成信号 S 仅由分位数决定（与线上同口径），故历史可精确复原；
        # 缺失分位由 _signal_s 内部按中性 0.5 兜底。
        s_val = round(
            _signal_s(
                {
                    "pe_10y_pctile": pe10,
                    "pe_3y_pctile": pe3,
                    "vix_3y_pctile": vix_pct,
                    "ema200_deviation_3y_pctile": ema200_dev,
                    "ema20_deviation_3y_pctile": ema20_dev,
                }
            ),
            4,
        )

        # 月投事件占位（端点会按"月末交易日"重定位）
        ym = date_str[:7]
        monthly_event = ym != cur_month
        cur_month = ym

        # 每日推荐投弹预算 K（RR 风险预算，trigger_level=None），作为"信号建议比例"。
        # 投弹事件由实际投弹订单日锚定（端点处理），不再按规则回放触发日。
        above200 = _above_ema200(qqqm, dt, window_start)
        day_k = _bomb_k(qqqm_drop_pct, vix_pct, above200, None)

        snap = {
            "date": date_str,
            "S": s_val,
            "RR": None,
            "K": day_k,
            "R": None,
            "vix": round(vix_val, 2),
            "qqqm_change_pct": qqqm_chg,
            "qqqm_above_ema200": above200,
            "vix_3y_pctile": vix_pct,
            "pe_10y_pctile": pe10,
            "pe_3y_pctile": pe3,
            "ema200_deviation_3y_pctile": ema200_dev,
            "ema20_deviation_3y_pctile": ema20_dev,
            "qqqm_drop_3y_pctile": qqqm_drop_pct,
            "triggers": {},
            "monthly_event": monthly_event,
            "backfilled": True,
        }
        if date_str in entries:
            existing = entries[date_str]
            if not existing.get("backfilled"):
                continue
            merged_entry = {**existing, **{k: v for k, v in snap.items() if v is not None}}
            merged_entry["monthly_event"] = monthly_event
            entries[date_str] = merged_entry
        else:
            entries[date_str] = snap
            added += 1

    merged = sorted(entries.values(), key=lambda x: x.get("date") or "")
    hist["entries"] = merged
    hist["updated_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    save_signal_history(hist)
    print(f"  ✓ 回填完成：新增 {added} 条，合计 {len(merged)} 条（每日推荐投弹 K 已写入）")
    return 0


if __name__ == "__main__":
    raise SystemExit(backfill_from_price_cache())
