# -*- coding: utf-8 -*-
"""
美股交易助手后端：持久化交易/出入金、拉取 Yahoo 股价、计算真实收益与资产配置。
运行：pip install -r requirements.txt && python server.py
"""

import bisect
import json
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
from pathlib import Path

import pandas as pd
import yfinance as yf
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS

app = Flask(__name__, static_folder=".")
CORS(app)

# 数据文件路径（与 server.py 同目录下的 data 文件夹）
BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
FUND_FILE = DATA_DIR / "fund_records.json"
TRADES_FILE = DATA_DIR / "trades.json"

# 纳指基准代码（Yahoo）
BENCHMARK_SYMBOL = "^IXIC"
# 无风险利率：美国3个月期国债年化收益率（用于夏普、Alpha），单位小数
RISK_FREE_RATE = 0.021

# ===== 天府 v1.3.1 常量 =====
YEARLY_RESERVE_INJECT = 40000  # 每年 1 月 1 日注入备弹池
INITIAL_CAPITAL = 50000        # 初始备弹池（首年，即 2025 年）
MONTHLY_BASE = 2000            # 月定投基数
MODEL_STATE_FILE = DATA_DIR / "model_state.json"

# 价格缓存：文件持久化，同一天内所有请求使用同一份数据，避免刷新时数据变化
PRICE_CACHE_FILE = DATA_DIR / "price_cache.json"
_CACHE_VERSION = 6  # 升级时递增，使旧缓存失效（6：各端点统一 fetch 区间键，命中同一 price_cache）

# 分位数引擎缓存：文件持久化，避免服务重启后冷启动拉取 15 秒
QUANTILE_CACHE_FILE = DATA_DIR / "quantile_cache.json"

# 公司行为类交易类型：仅改股数、不改现金成本（MWRR/汇总/加仓散点等需排除）
TYPE_DIVIDEND = "分红"
TYPE_CORP_SPLIT = "合股拆股"
ALLOWED_TRADE_TYPES = frozenset(
    {"定投", "投弹", "投机", "现金管理", TYPE_DIVIDEND, TYPE_CORP_SPLIT}
)

# 分红再投资模型默认参数：对齐 IB 对美股非居民 DRIP 的实际口径
# - 预扣税率 0.30：美国对非居民默认税率（有 W-8BEN 协定时可在 UI 改成 0.10）
# - 付息日偏移 5：Invesco / SPDR 等常见 ETF 的 ex-date → pay-date 近似工作日数
DEFAULT_DIVIDEND_WITHHOLDING_RATE = 0.30
DEFAULT_DIVIDEND_REINVEST_OFFSET_BD = 5


def _is_corp_action(t):
    """分红 / 合股拆股：不计入 MWRR 现金流与佣金汇总；成本侧仅调整股数。"""
    tp = (t.get("type") or "").strip()
    return tp in (TYPE_DIVIDEND, TYPE_CORP_SPLIT)


def _normalize_trade_type(raw):
    s = (raw or "定投").strip()
    return s if s in ALLOWED_TRADE_TYPES else "定投"


def load_json(path, default):
    """读取 JSON 文件，失败时返回 default。"""
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def save_json(path, data):
    """写入 JSON 文件。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def get_fund_records():
    return load_json(FUND_FILE, [])


def get_trades():
    return load_json(TRADES_FILE, [])


def positions_at_date(trades, on_date, position_timeline=None, timeline_dates=None):
    """
    计算在 on_date 当日收盘时的持仓（按标的汇总股数）。
    买入增加股数，卖出减少股数；仅统计 date <= on_date 的交易。
    若提供 position_timeline + timeline_dates（由 _build_positions_timeline 生成），则 O(log n) 查表。
    """
    if position_timeline is not None and timeline_dates is not None and timeline_dates:
        i = bisect.bisect_right(timeline_dates, on_date) - 1
        if i >= 0:
            return dict(position_timeline[timeline_dates[i]])
        return {}
    by_symbol = {}
    for t in trades:
        if (t.get("date") or "") > on_date:
            continue
        sym = (t.get("symbol") or "").strip().upper()
        if not sym:
            continue
        action = t.get("action") or ""
        shares = float(t.get("shares") or 0)
        if action == "买入":
            by_symbol[sym] = by_symbol.get(sym, 0) + shares
        elif action == "卖出":
            by_symbol[sym] = by_symbol.get(sym, 0) - shares
    return {s: q for s, q in by_symbol.items() if q > 0}


def _build_positions_timeline(trades, trading_dates):
    """
    对每个关键日期（交易日 ∪ 交易日历上有交易的日期）记录收盘持仓，供 O(log n) 查询。
    返回 (timeline_dict, sorted_date_list)；timeline_dict[date] = {sym: qty}。
    """
    trade_dates = {(t.get("date") or "")[:10] for t in trades if (t.get("date") or "")[:10]}
    all_dates = sorted(set(trading_dates or []) | trade_dates)
    if not all_dates:
        return {}, []
    indexed = list(enumerate(trades))
    indexed.sort(key=lambda x: ((x[1].get("date") or "")[:10], x[0]))
    by_symbol = {}
    ti = 0
    n = len(indexed)
    timeline = {}
    for d in all_dates:
        while ti < n:
            _, t = indexed[ti]
            td = (t.get("date") or "")[:10]
            if td > d:
                break
            sym = (t.get("symbol") or "").strip().upper()
            if not sym:
                ti += 1
                continue
            action = t.get("action") or ""
            try:
                shares = float(t.get("shares") or 0)
            except (TypeError, ValueError):
                ti += 1
                continue
            if action == "买入":
                by_symbol[sym] = by_symbol.get(sym, 0) + shares
            elif action == "卖出":
                by_symbol[sym] = by_symbol.get(sym, 0) - shares
            ti += 1
        timeline[d] = {s: q for s, q in by_symbol.items() if q > 0}
    return timeline, all_dates


def _build_price_index(history_cache):
    """
    将 {symbol: DataFrame} 转为 bisect 友好的 {symbol: (sorted_dates, {date: price})}。
    """
    idx = {}
    for sym, df in (history_cache or {}).items():
        if df is None or df.empty:
            continue
        prices = {}
        for ts in df.index:
            d = str(pd.Timestamp(ts).date()) if ts is not None else ""
            if not d:
                d = str(ts)[:10]
            try:
                val = df.at[ts, "Close"]
                px = float(val.iloc[0]) if hasattr(val, "iloc") else float(val)
                prices[d] = px
            except Exception:
                continue
        if not prices:
            continue
        dates = sorted(prices.keys())
        idx[sym] = (dates, prices)
    return idx


def get_price_on_date_fast(symbol, date_str, price_index):
    """O(log n) 取 <= date_str 的最近收盘价；price_index 来自 _build_price_index。"""
    if not symbol or not date_str or not price_index:
        return None
    sym = symbol.strip().upper() if isinstance(symbol, str) else symbol
    if sym not in price_index:
        return None
    dates, prices = price_index[sym]
    ds = date_str[:10]
    if ds in prices:
        return prices[ds]
    i = bisect.bisect_right(dates, ds) - 1
    if i < 0:
        return None
    return prices.get(dates[i])


def _compute_fetch_range(trades_list):
    """
    统一各端点 Yahoo 拉取区间，使 _load_price_cache 键一致、避免互相覆盖。
    与收益概览 api_returns_overview 的窗口定义对齐。
    """
    dt = datetime.now()
    since_date = min((t["date"][:10] for t in trades_list), default=dt.strftime("%Y-%m-%d"))
    year_start = dt.replace(month=1, day=1).strftime("%Y-%m-%d")
    one_year_ago_with_buffer = (dt - timedelta(days=395)).strftime("%Y-%m-%d")
    end_fetch = (dt + timedelta(days=1)).strftime("%Y-%m-%d")
    start_fetch = min(since_date, one_year_ago_with_buffer, year_start)
    return start_fetch, end_fetch


def build_perf_bundle(trades_list, history_cache, bench_cache, trading_dates):
    """一次构建价格索引 + 持仓时间线，供收益/复盘等热路径复用。"""
    merged = {}
    if history_cache:
        merged.update(history_cache)
    if bench_cache:
        merged.update(bench_cache)
    price_index = _build_price_index(merged)
    position_timeline, timeline_dates = _build_positions_timeline(trades_list, trading_dates)
    return {
        "price_index": price_index,
        "position_timeline": position_timeline,
        "timeline_dates": timeline_dates,
    }


def get_all_symbols(trades):
    """从交易记录中收集所有出现过的标的代码。"""
    syms = set()
    for t in trades:
        s = (t.get("symbol") or "").strip().upper()
        if s:
            syms.add(s)
    return list(syms)


def yf_symbol(symbol):
    """Yahoo 中 BRK.B 需写成 BRK-B 等，yfinance 一般接受点号。"""
    return symbol.replace(".", "-") if symbol else symbol


# 实时行情内存缓存（秒级 TTL），减轻 signals 等端点连续刷新时的 Yahoo 延迟
_REALTIME_QUOTE_TTL_SEC = 60.0
_REALTIME_QUOTE_CACHE = {}


def fetch_realtime_quote(symbol):
    """
    拉取单标的实时（或最近可用）行情。使用 yfinance 最近 5 日数据取最新收盘与涨跌。
    返回 {"symbol": str, "name": str, "price": float, "prev_close": float, "change": float, "change_pct": float}，
    失败时返回 None。
    """
    if not symbol or not isinstance(symbol, str):
        return None
    now_m = time.monotonic()
    cached = _REALTIME_QUOTE_CACHE.get(symbol)
    if cached is not None:
        t0, data = cached
        if now_m - t0 < _REALTIME_QUOTE_TTL_SEC and data is not None:
            return data
    sy = yf_symbol(symbol.strip())
    # 展示用名称（指数保留 ^ 前缀）
    display_symbol = symbol.strip().upper()
    names = {"QQQ": "纳斯达克100", "^VIX": "恐慌指数", "GLD": "黄金ETF", "^TNX": "10Y国债"}
    name = names.get(display_symbol, display_symbol)
    try:
        ticker = yf.Ticker(sy)
        hist = ticker.history(period="5d", auto_adjust=False)
        if hist is None or hist.empty or "Close" not in hist.columns:
            _REALTIME_QUOTE_CACHE[symbol] = (time.monotonic(), None)
            return None
        # 取最近两日：最新价与前一收盘
        closes = hist["Close"].dropna()
        if len(closes) < 1:
            _REALTIME_QUOTE_CACHE[symbol] = (time.monotonic(), None)
            return None
        price = float(closes.iloc[-1])
        prev_close = float(closes.iloc[-2]) if len(closes) >= 2 else price
        change = round(price - prev_close, 4)
        change_pct = round((change / prev_close * 100), 2) if prev_close and prev_close != 0 else 0.0
        result = {
            "symbol": display_symbol,
            "name": name,
            "price": round(price, 2),
            "prev_close": round(prev_close, 2),
            "change": round(change, 2),
            "change_pct": change_pct,
        }
        _REALTIME_QUOTE_CACHE[symbol] = (time.monotonic(), result)
        return result
    except Exception:
        _REALTIME_QUOTE_CACHE[symbol] = (time.monotonic(), None)
        return None


def get_price_on_date(symbol, date_str, history_cache, price_index=None):
    """
    从已拉取的 history_cache[symbol] (DataFrame, index=Date) 中取 date_str 当日或之前最近一日的收盘价。
    若提供 price_index（_build_price_index 结果），走 O(log n) 路径。
    """
    if price_index is not None:
        return get_price_on_date_fast(symbol, date_str, price_index)
    if symbol not in history_cache or history_cache[symbol] is None:
        return None
    df = history_cache[symbol]
    if df is None or df.empty:
        return None
    try:
        target = pd.Timestamp(date_str[:10])
    except Exception:
        return None
    # 若索引带时区，将 target 也转为相同时区再比较
    idx = df.index
    if hasattr(idx, "tz") and idx.tz is not None:
        target = target.tz_localize(idx.tz)
    # 取 <= target 的日期中的最后一行
    mask = idx <= target
    if not mask.any():
        return None
    try:
        val = df.loc[mask].iloc[-1]["Close"]
        # 兼容 pandas 新版：iloc[-1]["Close"] 可能返回 Series，取标量
        return float(val.iloc[0]) if hasattr(val, "iloc") else float(val)
    except Exception:
        return None


def _extract_close_series(data):
    """
    从 yfinance 返回的 DataFrame 中提取 Close 列（仅未复权收盘价），兼容 MultiIndex 与普通列。
    明确排除 Adj Close，避免 Yahoo 复权错误导致价格翻倍等异常（如 BOXX）。
    返回单列 DataFrame，列名为 'Close'，便于后续 get_price_on_date 统一访问。
    """
    if data is None or data.empty:
        return None
    for col in data.columns:
        if col == "Close" or (isinstance(col, tuple) and len(col) > 0 and col[0] == "Close"):
            out = data[[col]].copy()
            out.columns = ["Close"]
            return out
    return None


def _yfinance_repair_available():
    """yfinance repair 依赖 scipy，未安装时禁用 repair 避免 ModuleNotFoundError"""
    try:
        import scipy  # noqa: F401
        return True
    except ImportError:
        return False


def _fetch_histories_raw(symbols, start_date, end_date):
    """
    拉取多标的从 start_date 到 end_date 的日线，返回 {symbol: DataFrame}，DataFrame 含 Close 列、日期索引。
    使用 Ticker(symbol).history() 逐标的拉取，避免 yf.download 多标的下可能的数据串扰/错位。
    若 Ticker.history() 失败（Yahoo API 间歇性返回 None），回退到 yf.download。
    """
    if not symbols:
        return {}
    use_repair = _yfinance_repair_available()
    out = {}
    for s in symbols:
        sy = yf_symbol(s)
        data = None
        try:
            ticker = yf.Ticker(sy)
            data = ticker.history(
                start=start_date,
                end=end_date,
                auto_adjust=False,
                repair=use_repair,
            )
        except Exception:
            data = None
        if data is None or data.empty:
            try:
                data = yf.download(sy, start=start_date, end=end_date,
                                   progress=False, auto_adjust=False)
            except Exception:
                data = None
        out[s] = _extract_close_series(data)
    return out


def _history_to_json(history_cache):
    """将 {symbol: DataFrame} 转为可 JSON 序列化的 {symbol: {date: price}}，按 symbol 排序写入保证可复现"""
    out = {}
    for sym in sorted((history_cache or {}).keys()):
        df = history_cache[sym]
        if df is None or df.empty:
            continue
        out[sym] = {}
        for idx, row in df.iterrows():
            try:
                d = str(idx)[:10]
                v = float(row["Close"]) if "Close" in row else float(row.iloc[0])
                out[sym][d] = v
            except Exception:
                pass
    return out


def _json_to_history(data):
    """将 {symbol: {date: price}} 转为 {symbol: DataFrame}"""
    out = {}
    for sym, dates in (data or {}).items():
        if not dates:
            out[sym] = None
            continue
        rows = [(d, p) for d, p in dates.items() if d and p is not None]
        if not rows:
            out[sym] = None
            continue
        rows.sort(key=lambda x: x[0])
        df = pd.DataFrame([r[1] for r in rows], index=pd.DatetimeIndex([r[0] for r in rows]), columns=["Close"])
        out[sym] = df
    return out


def _load_price_cache(symbols, start_date, end_date):
    """
    从文件加载价格缓存。若缓存有效（同一天、版本匹配、日期范围一致、请求标的为缓存标的的子集）
    则返回 (history, bench, trading_dates)，保证同一天内多次刷新使用同一份数据，价格不随刷新变化。
    """
    today = datetime.now().strftime("%Y-%m-%d")
    try:
        raw = load_json(PRICE_CACHE_FILE, None)
        if not raw or not isinstance(raw, dict):
            return None
        if raw.get("version") != _CACHE_VERSION:
            return None
        if raw.get("cache_date") != today:
            return None
        cached_syms = set(raw.get("symbols", []))
        requested_syms = set(symbols)
        # 允许请求标的为缓存标的的子集，避免因删减标的导致缓存失效、重新拉取出现价格波动
        if not requested_syms <= cached_syms:
            return None
        if raw.get("start") != start_date or raw.get("end") != end_date:
            return None
        history_full = _json_to_history(raw.get("history"))
        bench = _json_to_history({BENCHMARK_SYMBOL: raw.get("bench", {})})
        trading_dates = raw.get("trading_dates") or []
        if not trading_dates:
            return None
        # 按请求标的显式取数，避免迭代顺序导致 symbol→价格 错位
        history = {sym: history_full[sym] for sym in requested_syms if sym in history_full}
        return history, bench, trading_dates
    except Exception:
        return None


def _save_price_cache(symbols, start_date, end_date, history_cache, bench_cache, trading_dates):
    """将价格数据写入缓存文件"""
    bench_data = {}
    if BENCHMARK_SYMBOL in bench_cache and bench_cache[BENCHMARK_SYMBOL] is not None:
        df = bench_cache[BENCHMARK_SYMBOL]
        if df is not None and not df.empty:
            for idx, row in df.iterrows():
                try:
                    bench_data[str(idx)[:10]] = float(row["Close"])
                except Exception:
                    pass
    data = {
        "version": _CACHE_VERSION,
        "cache_date": datetime.now().strftime("%Y-%m-%d"),
        "symbols": sorted(symbols),
        "start": start_date,
        "end": end_date,
        "history": _history_to_json(history_cache),
        "bench": bench_data,
        "trading_dates": trading_dates,
    }
    save_json(PRICE_CACHE_FILE, data)


def fetch_histories(symbols, start_date, end_date):
    """
    拉取多标的历史行情。优先从文件缓存读取（同一天内数据一致），否则从 Yahoo 拉取并写入缓存。
    """
    cached = _load_price_cache(symbols, start_date, end_date)
    if cached:
        return cached[0]
    data = _fetch_histories_raw(symbols, start_date, end_date)
    return data


def fetch_histories_with_bench(symbols, start_date, end_date):
    """
    拉取标的 + 纳指基准，返回 (history_cache, bench_cache, trading_dates)。
    统一入口，保证收益概览与资产配置使用同一份数据。
    """
    all_syms = sorted(set(symbols) | {BENCHMARK_SYMBOL})
    cached = _load_price_cache(all_syms, start_date, end_date)
    if cached:
        hist, bench, dates = cached
        hist_only = {k: v for k, v in hist.items() if k != BENCHMARK_SYMBOL}
        return hist_only, bench, dates
    history_cache = _fetch_histories_raw(symbols, start_date, end_date)
    bench_cache = _fetch_histories_raw([BENCHMARK_SYMBOL], start_date, end_date)
    trading_dates = get_trading_dates_from_cache(history_cache, bench_cache)
    if trading_dates:
        merged = dict(history_cache)
        merged.update(bench_cache)
        _save_price_cache(all_syms, start_date, end_date, merged, bench_cache, trading_dates)
    return history_cache, bench_cache, trading_dates


def portfolio_value_with_prices(positions, prices):
    """根据持仓 {symbol: qty} 与价格字典 {symbol: price} 计算总市值，价格为 None 则跳过。"""
    total = 0.0
    for sym, qty in positions.items():
        p = prices.get(sym)
        if p is not None and p > 0:
            total += qty * p
    return total


def prices_at(symbols, history_cache, date_str, price_index=None):
    """从 history_cache 取各标的在 date_str 当日或之前最近交易日的收盘价，返回 {symbol: float or None}。"""
    return {sym: get_price_on_date(sym, date_str, history_cache, price_index) for sym in symbols}


def compute_cost_basis(trades):
    """
    平均成本法计算各标的当前持仓的成本。
    买入时累计成本（含手续费），卖出时按比例释放成本。
    分红 / 合股拆股：只调整股数，不改变 total_cost（现金成本），使 avg_cost 随除权一致。
    返回 {symbol: {'shares', 'avg_cost', 'total_cost'}}，只含有持仓的标的。
    """
    holdings = {}
    for t in sorted(trades, key=lambda x: (x.get("date") or "", x.get("symbol") or "")):
        sym = (t.get("symbol") or "").strip().upper()
        if not sym:
            continue
        tp = (t.get("type") or "").strip()
        action = t.get("action") or ""
        try:
            shares = float(t.get("shares") or 0)
            price = float(t.get("price") or 0)
            commission = float(t.get("commission") or 0)
        except (TypeError, ValueError):
            continue
        if shares <= 0:
            continue

        if tp == TYPE_DIVIDEND:
            if action == "买入":
                if sym not in holdings:
                    holdings[sym] = {"shares": 0.0, "total_cost": 0.0}
                holdings[sym]["shares"] += shares
            continue

        if tp == TYPE_CORP_SPLIT:
            if sym not in holdings:
                holdings[sym] = {"shares": 0.0, "total_cost": 0.0}
            if action == "买入":
                holdings[sym]["shares"] += shares
            elif action == "卖出":
                holdings[sym]["shares"] = max(0.0, holdings[sym]["shares"] - shares)
            continue

        if action == "买入":
            if sym not in holdings:
                holdings[sym] = {"shares": 0.0, "total_cost": 0.0}
            holdings[sym]["shares"] += shares
            holdings[sym]["total_cost"] += price * shares + commission
        elif action == "卖出":
            if sym in holdings and holdings[sym]["shares"] > 1e-9:
                ratio = min(shares, holdings[sym]["shares"]) / holdings[sym]["shares"]
                holdings[sym]["total_cost"] *= (1.0 - ratio)
                holdings[sym]["shares"] = max(0.0, holdings[sym]["shares"] - shares)
    result = {}
    for sym, h in holdings.items():
        if h["shares"] > 1e-6:
            result[sym] = {
                "shares": round(h["shares"], 4),
                "avg_cost": round(h["total_cost"] / h["shares"], 4),
                "total_cost": round(h["total_cost"], 2),
            }
    return result


def get_trading_dates_from_cache(history_cache, bench_cache):
    """
    从历史缓存中汇总交易日字符串，返回升序列表。
    优先以纳指基准的日期为准，保证收益计算不因个别标的拉取失败而波动。
    """
    # 纳指交易日最完整，作为主日历
    bench_dates = set()
    for df in bench_cache.values():
        if df is not None and not df.empty:
            for idx in df.index:
                try:
                    bench_dates.add(str(idx)[:10])
                except Exception:
                    pass
    if bench_dates:
        return sorted(bench_dates)
    # 无基准时回退到持仓标的
    all_dates = set()
    for df in list(history_cache.values()) + list(bench_cache.values()):
        if df is not None and not df.empty:
            for idx in df.index:
                try:
                    all_dates.add(str(idx)[:10])
                except Exception:
                    pass
    return sorted(all_dates)


def parse_date(s):
    try:
        return datetime.strptime(s[:10], "%Y-%m-%d")
    except Exception:
        return None


def _npv_mwr(r, v0, v_end, cf_list, t_list):
    """
    资金加权收益率 NPV：-V0 + sum(CF_i/(1+r)^t_i) + V_end/(1+r)。
    cf_list 为期间内出入金列表（入金为正、出金为负），t_list 为对应时间占比 [0,1]。
    """
    if r <= -1.0:
        return float("inf")
    val = -v0 + v_end / (1.0 + r)
    for cf, t in zip(cf_list, t_list):
        val += cf / ((1.0 + r) ** t)
    return val


def compute_mwr(trades_list, fund_records, history_cache, period_start, period_end, all_trading_dates, perf=None):
    """
    资金加权收益率（MWRR / IRR）计算。

    现金流模型：以交易记录为现金流来源。
    - 买入 = 投资者投入现金（负现金流）：-price×shares - commission
    - 卖出 = 投资者回收现金（正现金流）：+price×shares - commission
    - 期末证券市值 = 终值（正现金流）
    求内部收益率 r 使 NPV = 0。
    返回 MWRR 百分比（float）。
    """
    p_start_dt = parse_date(period_start)
    p_end_dt = parse_date(period_end)
    if not p_start_dt or not p_end_dt:
        return None
    T_days = (p_end_dt - p_start_dt).days
    if T_days <= 0:
        return None

    pix = (perf or {}).get("price_index")
    tl = (perf or {}).get("position_timeline")
    tds = (perf or {}).get("timeline_dates")
    # 期初持仓市值视为 t=0 的投入（负现金流）
    pos_start = positions_at_date(trades_list, period_start, tl, tds)
    syms_start = list(pos_start.keys()) if pos_start else []
    v0 = portfolio_value_with_prices(
        pos_start, prices_at(syms_start, history_cache, period_start, pix),
    ) if pos_start else 0.0

    # 期末持仓市值视为 t=1 的回收（正现金流）
    pos_end = positions_at_date(trades_list, period_end, tl, tds)
    syms_end = list(pos_end.keys()) if pos_end else []
    v_end = portfolio_value_with_prices(
        pos_end, prices_at(syms_end, history_cache, period_end, pix),
    ) if pos_end else 0.0

    # 从交易记录构建现金流：仅 (period_start, period_end] 内的交易
    # 买入 → 投入现金 → 负；卖出 → 收回现金 → 正
    cf_list = []
    t_list = []
    for t in trades_list:
        d = (t.get("date") or "")[:10]
        if not d or d <= period_start or d > period_end:
            continue
        if _is_corp_action(t):
            continue
        action = t.get("action") or ""
        try:
            price = float(t.get("price") or 0)
            shares = float(t.get("shares") or 0)
            commission = float(t.get("commission") or 0)
        except (TypeError, ValueError):
            continue
        trade_val = price * shares
        if action == "买入":
            cf = -(trade_val + commission)
        elif action == "卖出":
            cf = trade_val - commission
        else:
            continue
        t_dt = parse_date(d)
        if not t_dt:
            continue
        d_days = (t_dt - p_start_dt).days
        t_i = d_days / T_days
        t_i = max(0.0, min(1.0, t_i))
        cf_list.append(cf)
        t_list.append(t_i)

    def f(r):
        return _npv_mwr(r, v0, v_end, cf_list, t_list)

    if not cf_list and v0 > 1e-6 and v_end >= 0:
        return round(((v_end / v0) - 1.0) * 100, 2)
    if not cf_list and v0 < 1e-6:
        return None

    try:
        from scipy.optimize import brentq
        r_lo, r_hi = -0.99, 10.0
        f_lo, f_hi = f(r_lo), f(r_hi)
        if f_lo * f_hi > 0:
            return round(((v_end / v0) - 1.0) * 100, 2) if v0 > 1e-6 else None
        r = brentq(f, r_lo, r_hi)
        return round(r * 100, 2)
    except Exception:
        return round(((v_end / v0) - 1.0) * 100, 2) if v0 > 1e-6 else None


def compute_twr(trades_list, history_cache, period_start, period_end, all_trading_dates, perf=None):
    """
    时间加权收益率（TWR）计算。

    原理：将 [period_start, period_end] 划分为若干连续子区间，
    每个子区间内持仓保持不变（以每个交易日收盘后的持仓为准），
    计算各子区间价格涨跌幅，最后连乘得到 TWR，消除外部现金流（买卖）影响。

    返回 TWR 百分比（float），如 3.25 表示 +3.25%。
    """
    # 期间内所有有行情数据的交易日
    dates_in_range = [d for d in all_trading_dates if period_start <= d <= period_end]
    if not dates_in_range:
        return 0.0

    # 构建日期链：若 period_start 是交易日则直接从它开始；否则用前一个交易日作为锚定。
    # 当链中只有 1 个日期（如月初只有一天行情）时，始终回溯前一个交易日，否则无法计算涨跌。
    dates_before = [d for d in all_trading_dates if d < period_start]
    if period_start in all_trading_dates:
        chain = dates_in_range
    else:
        anchor = dates_before[-1] if dates_before else None
        chain = ([anchor] if anchor else []) + dates_in_range
    if len(chain) < 2 and dates_before:
        chain = [dates_before[-1]] + chain
    if len(chain) < 2:
        return 0.0

    pix = (perf or {}).get("price_index")
    tl = (perf or {}).get("position_timeline")
    tds = (perf or {}).get("timeline_dates")
    cumulative_factor = 1.0
    for i in range(1, len(chain)):
        prev_d, curr_d = chain[i - 1], chain[i]
        # 使用 prev_d 收盘时（含当日交易）的持仓
        pos = positions_at_date(trades_list, prev_d, tl, tds)
        if not pos:
            continue
        syms = list(pos.keys())
        v_prev = portfolio_value_with_prices(pos, prices_at(syms, history_cache, prev_d, pix))
        v_curr = portfolio_value_with_prices(pos, prices_at(syms, history_cache, curr_d, pix))
        # 用同一批持仓估值，排除现金流干扰
        if v_prev > 1e-6:
            cumulative_factor *= (v_curr / v_prev)

    return round((cumulative_factor - 1) * 100, 2)


def compute_twr_chart(trades_list, history_cache, bench_cache,
                      period_start, period_end, all_trading_dates, perf=None):
    """
    生成时段内每个交易日的累计 TWR 走势 + DCA 基准。

    my：组合累计 TWR（%）；bench：纳指涨跌幅（%）；dca：等额定投收益（%）。
    DCA 模拟：将时段内实际总买入金额均匀分配到每个交易日，按组合加权价格买入。
    """
    dates_in_range = [d for d in all_trading_dates if period_start <= d <= period_end]
    if not dates_in_range:
        return {"labels": [], "my": [], "bench": [], "dca": []}

    dates_before = [d for d in all_trading_dates if d < period_start]
    if period_start in all_trading_dates:
        chain = dates_in_range
    else:
        anchor = dates_before[-1] if dates_before else None
        chain = ([anchor] if anchor else []) + dates_in_range
    if len(chain) < 2 and dates_before:
        chain = [dates_before[-1]] + chain

    pix = (perf or {}).get("price_index")
    tl = (perf or {}).get("position_timeline")
    tds = (perf or {}).get("timeline_dates")
    b_base = get_price_on_date(BENCHMARK_SYMBOL, chain[0], bench_cache, pix) or 1.0

    # 计算时段内实际总买入金额（用于 DCA 模拟）；排除分红/拆股等非现金买入
    total_buy_amount = sum(
        float(t.get("price", 0)) * float(t.get("shares", 0))
        for t in trades_list
        if (t.get("action") or "") == "买入"
        and period_start <= (t.get("date") or "")[:10] <= period_end
        and not _is_corp_action(t)
    )
    n_days = len(dates_in_range)
    daily_dca_amount = total_buy_amount / n_days if n_days > 0 and total_buy_amount > 0 else 0

    labels, my_series, bench_series, dca_series = [], [], [], []
    cumulative_factor = 1.0
    dca_cum_shares = 0.0
    dca_cum_cost = 0.0

    for i in range(1, len(chain)):
        prev_d, curr_d = chain[i - 1], chain[i]
        pos = positions_at_date(trades_list, prev_d, tl, tds)
        if pos:
            syms = list(pos.keys())
            v_prev = portfolio_value_with_prices(pos, prices_at(syms, history_cache, prev_d, pix))
            v_curr = portfolio_value_with_prices(pos, prices_at(syms, history_cache, curr_d, pix))
            if v_prev > 1e-6:
                cumulative_factor *= (v_curr / v_prev)

        if curr_d >= period_start:
            b_curr = get_price_on_date(BENCHMARK_SYMBOL, curr_d, bench_cache, pix) or b_base
            labels.append(curr_d[5:])
            my_series.append(round((cumulative_factor - 1) * 100, 2))
            bench_series.append(round((b_curr / b_base - 1) * 100, 2) if b_base > 0 else 0.0)

            # DCA：每日等额买入，用 QQQM 价格模拟
            qqqm_p = get_price_on_date("QQQM", curr_d, history_cache, pix)
            dca_price = qqqm_p if qqqm_p and qqqm_p > 0 else (b_curr if b_curr > 0 else 1)
            if daily_dca_amount > 0 and dca_price > 0:
                dca_cum_shares += daily_dca_amount / dca_price
                dca_cum_cost += daily_dca_amount
                dca_value = dca_cum_shares * dca_price
                dca_ret = round((dca_value / dca_cum_cost - 1) * 100, 2) if dca_cum_cost > 0 else 0
                dca_series.append(dca_ret)
            else:
                dca_series.append(0)

    # 收集时段内的买入事件（仅风险资产，排除 BOXX 等现金管理标的）
    CASH_TICKERS_CHART = {"BOXX"}
    buy_markers = []
    for t in trades_list:
        td = (t.get("date") or "")[:10]
        sym = (t.get("symbol") or "").upper()
        if (t.get("action") or "") != "买入" or td < period_start or td > period_end:
            continue
        if _is_corp_action(t):
            continue
        if sym in CASH_TICKERS_CHART:
            continue
        label_key = td[5:]
        if label_key in labels:
            idx = labels.index(label_key)
            buy_markers.append({
                "idx": idx, "label": label_key,
                "type": t.get("type") or "定投",
                "symbol": sym,
                "price_shares": round(float(t.get("price", 0)) * float(t.get("shares", 0)), 0),
            })

    return {"labels": labels, "my": my_series, "bench": bench_series, "dca": dca_series, "buy_markers": buy_markers}


def _twr_daily_returns(trades_list, history_cache, bench_cache, dates_in_range, perf=None):
    """返回 (r_port_list, r_bench_list) 日 TWR 收益，仅含前一日有持仓的区间。"""
    pix = (perf or {}).get("price_index")
    tl = (perf or {}).get("position_timeline")
    tds = (perf or {}).get("timeline_dates")
    r_port = []
    r_bench = []
    for i in range(1, len(dates_in_range)):
        prev_d, curr_d = dates_in_range[i - 1], dates_in_range[i]
        pos = positions_at_date(trades_list, prev_d, tl, tds)
        if not pos:
            continue
        syms = list(pos.keys())
        v_prev = portfolio_value_with_prices(pos, prices_at(syms, history_cache, prev_d, pix))
        v_curr = portfolio_value_with_prices(pos, prices_at(syms, history_cache, curr_d, pix))
        if not v_prev or v_prev <= 1e-6:
            continue
        r_port.append((v_curr / v_prev) - 1.0)
        b_prev = get_price_on_date(BENCHMARK_SYMBOL, prev_d, bench_cache, pix) or 0.0
        b_curr = get_price_on_date(BENCHMARK_SYMBOL, curr_d, bench_cache, pix) or 0.0
        r_bench.append((b_curr / b_prev) - 1.0 if b_prev and b_prev > 1e-6 else 0.0)
    return r_port, r_bench


def _build_drawdown_series(r_port_list, dates_with_returns):
    """
    根据日 TWR 收益序列构建回撤序列，并识别 Top-3 回撤区间。
    dates_with_returns: 与 r_port_list 对应的日期列表（长度 = len(r_port_list)+1，首元素为起始日）。
    返回 (dd_pct_series, top3_drawdowns)
      dd_pct_series: 每日回撤百分比列表（负值），与 dates_with_returns 等长
      top3_drawdowns: 最大三段回撤 [{peak_date, trough_date, recovery_date, drawdown_pct, duration_days, recovery_days}]
    """
    if not r_port_list:
        return [], []

    cum = 1.0
    cum_series = [1.0]
    for r in r_port_list:
        cum *= (1.0 + r)
        cum_series.append(cum)

    # 每日回撤百分比（从峰值到当前）
    peak = cum_series[0]
    dd_pct_series = []
    for v in cum_series:
        if v > peak:
            peak = v
        dd = (v / peak - 1.0) * 100 if peak > 1e-12 else 0.0
        dd_pct_series.append(round(dd, 2))

    # 识别所有回撤区间：从峰值开始下跌 → 回到（或超过）峰值
    # 状态机：追踪 peak_idx → trough_idx → recovery_idx
    n = len(cum_series)
    intervals = []
    i = 0
    while i < n:
        # 找下一个开始下跌的点
        while i < n - 1 and cum_series[i + 1] >= cum_series[i]:
            i += 1
        if i >= n - 1:
            break
        peak_idx = i
        peak_val = cum_series[peak_idx]
        # 找谷底
        trough_idx = peak_idx + 1
        j = trough_idx + 1
        while j < n and cum_series[j] < peak_val:
            if cum_series[j] < cum_series[trough_idx]:
                trough_idx = j
            j += 1
        # j 现在是恢复点（或序列末尾）
        recovery_idx = j if j < n else None
        dd_val = (cum_series[trough_idx] / peak_val - 1.0) * 100 if peak_val > 1e-12 else 0.0
        intervals.append({
            "peak_idx": peak_idx,
            "trough_idx": trough_idx,
            "recovery_idx": recovery_idx,
            "dd_pct": dd_val,
        })
        i = j if j < n else n

    # 按回撤幅度（绝对值）降序取 Top-3
    intervals.sort(key=lambda x: x["dd_pct"])
    top3 = intervals[:3]

    top3_result = []
    for seg in top3:
        pi, ti, ri = seg["peak_idx"], seg["trough_idx"], seg["recovery_idx"]
        peak_date = dates_with_returns[pi] if pi < len(dates_with_returns) else None
        trough_date = dates_with_returns[ti] if ti < len(dates_with_returns) else None
        recovery_date = dates_with_returns[ri] if ri is not None and ri < len(dates_with_returns) else None
        p_dt = parse_date(peak_date) if peak_date else None
        t_dt = parse_date(trough_date) if trough_date else None
        r_dt = parse_date(recovery_date) if recovery_date else None
        duration_days = (t_dt - p_dt).days if p_dt and t_dt else None
        recovery_days = (r_dt - t_dt).days if t_dt and r_dt else None
        top3_result.append({
            "peak_date": peak_date,
            "trough_date": trough_date,
            "recovery_date": recovery_date,
            "drawdown_pct": round(seg["dd_pct"], 1),
            "duration_days": duration_days,
            "recovery_days": recovery_days,
        })

    return dd_pct_series, top3_result


def compute_risk_metrics(trades_list, history_cache, bench_cache,
                         period_start, effective_end_date, all_trading_dates, perf=None):
    """
    风险指标（纳指为基准），均按所选时段 [period_start, effective_end_date] 计算：
    - 最大回撤 + 回撤序列 + Top-3 回撤明细（Duration / Recovery）。
    - 夏普比 = (年化收益 - 2.1%) / 年化波动率（按 252 日年化）。
    - Beta = cov(组合日收益, 基准日收益) / var(基准日收益)。
    - Alpha（超额收益）= 组合区间收益 − β×基准区间收益。
    """
    try:
        import numpy as np
    except ImportError:
        return {"max_drawdown_pct": None, "sharpe_ratio": None, "alpha_pct": None, "beta": None,
                "drawdown_series": None, "top3_drawdowns": None}

    empty = {"max_drawdown_pct": None, "sharpe_ratio": None, "alpha_pct": None, "beta": None,
             "drawdown_series": None, "top3_drawdowns": None}
    if not parse_date(effective_end_date):
        return dict(empty)

    dates_in_period = [d for d in all_trading_dates if period_start <= d <= effective_end_date]

    # 日收益序列只算一次（原实现重复 3 次 _twr_daily_returns）
    r_port_once = r_bench_once = None
    if len(dates_in_period) >= 2:
        r_port_once, r_bench_once = _twr_daily_returns(
            trades_list, history_cache, bench_cache, dates_in_period, perf
        )

    # ---------- 1. 回撤分析：净值曲线 → 回撤序列 + Top3 ----------
    max_drawdown_pct = None
    drawdown_series = None
    drawdown_labels = None
    top3_drawdowns = None
    if len(dates_in_period) >= 2 and r_port_once is not None:
        r_port = r_port_once
        if len(r_port) >= 1:
            dd_series, top3 = _build_drawdown_series(r_port, dates_in_period)
            max_drawdown_pct = round(min(dd_series) * -1, 1) if dd_series else None
            drawdown_series = dd_series
            drawdown_labels = [d[5:] for d in dates_in_period]
            top3_drawdowns = top3

    # ---------- 2. 夏普比、Alpha、Beta ----------
    sharpe_ratio = None
    alpha_pct = None
    beta = None
    if len(dates_in_period) >= 2 and r_port_once is not None and r_bench_once is not None:
        r_port_period, r_bench_period = r_port_once, r_bench_once
        if len(r_port_period) >= 2 and len(r_port_period) == len(r_bench_period):
            rp = np.array(r_port_period, dtype=float)
            rb = np.array(r_bench_period, dtype=float)
            n = len(rp)
            R_period = float(np.prod(1.0 + rp) - 1.0)
            R_ann = (1.0 + R_period) ** (252.0 / n) - 1.0 if n else 0.0
            sigma_ann = float(np.std(rp)) * (252 ** 0.5)
            if sigma_ann > 1e-12:
                sharpe_ratio = round((R_ann - RISK_FREE_RATE) / sigma_ann, 1)
            var_b = float(np.var(rb))
            if var_b > 1e-12:
                cov_pb = float(np.cov(rp, rb)[0, 1])
                beta = round(cov_pb / var_b, 1)
            R_bench_period_val = float(np.prod(1.0 + rb) - 1.0)
            if beta is not None:
                alpha_period = R_period - beta * R_bench_period_val
                alpha_pct = round(alpha_period * 100, 1)

    bench_max_drawdown_pct = None
    if len(dates_in_period) >= 2 and r_bench_once:
        r_bench_dd = r_bench_once
        bench_dd_series, _ = _build_drawdown_series(r_bench_dd, dates_in_period)
        bench_max_drawdown_pct = round(min(bench_dd_series) * -1, 1) if bench_dd_series else None

    return {
        "max_drawdown_pct": max_drawdown_pct,
        "bench_max_drawdown_pct": bench_max_drawdown_pct,
        "sharpe_ratio": sharpe_ratio,
        "alpha_pct": alpha_pct,
        "beta": beta,
        "drawdown_series": {"labels": drawdown_labels or [], "values": drawdown_series or []},
        "top3_drawdowns": top3_drawdowns or [],
    }


def compute_value_growth_chart(trades_list, history_cache, bench_cache,
                               period_start, period_end, all_trading_dates, perf=None):
    """
    生成时段内每个交易日的「市值相对期初增长%」走势，用于资金加权收益率下的图表展示。
    my：组合市值 (V(t)/V_start - 1)*100；bench：纳指相对 period_start 的简单涨跌幅（%）。
    """
    dates_in_range = [d for d in all_trading_dates if period_start <= d <= period_end]
    if not dates_in_range:
        return {"labels": [], "my": [], "bench": []}

    pix = (perf or {}).get("price_index")
    tl = (perf or {}).get("position_timeline")
    tds = (perf or {}).get("timeline_dates")
    pos_start = positions_at_date(trades_list, period_start, tl, tds)
    syms_start = list(pos_start.keys()) if pos_start else []
    v_start = portfolio_value_with_prices(
        pos_start,
        prices_at(syms_start, history_cache, period_start, pix),
    ) if pos_start else 0.0
    if v_start < 1e-6:
        v_start = 1.0

    b_base = get_price_on_date(BENCHMARK_SYMBOL, period_start, bench_cache, pix) or 1.0
    labels, my_series, bench_series = [], [], []

    for d in dates_in_range:
        pos = positions_at_date(trades_list, d, tl, tds)
        v_t = portfolio_value_with_prices(
            pos,
            prices_at(list(pos.keys()), history_cache, d, pix),
        ) if pos else 0.0
        my_series.append(round((v_t / v_start - 1.0) * 100, 2))
        b_curr = get_price_on_date(BENCHMARK_SYMBOL, d, bench_cache, pix) or b_base
        bench_series.append(round((b_curr / b_base - 1) * 100, 2) if b_base > 0 else 0.0)
        labels.append(d[5:])

    return {"labels": labels, "my": my_series, "bench": bench_series}


@app.route("/")
def index():
    """前端单页"""
    return send_from_directory(".", "index.html")


@app.route("/data/backtest/<path:filename>", methods=["GET"])
def serve_backtest_static(filename: str):
    """历史回测预生成 JSON 直出。
    本地模式下前端 fetch('./data/backtest/v1.3.1-*-{summary,nav,trades}.json')
    需有此路由；云端（GitHub Pages）由静态托管直接服务。
    send_from_directory 内置 safe_join，会阻止 '..' 跨目录访问。
    """
    return send_from_directory(BASE_DIR / "data" / "backtest", filename)


@app.route("/favicon.ico", methods=["GET"])
def favicon():
    """避免浏览器自动请求 favicon 时产生 404 日志"""
    return "", 204


@app.route("/api/version", methods=["GET"])
def api_version():
    """用于前端判断当前后端是否支持编辑/删除（避免 404 时误判）"""
    return jsonify({"edit_delete": True, "corp_actions": True})


@app.route("/api/fund-records", methods=["GET"])
def api_fund_records():
    """出入金记录列表"""
    return jsonify(get_fund_records())


@app.route("/api/fund-records", methods=["POST"])
def api_fund_records_post():
    """新增一条出入金记录"""
    data = request.get_json() or {}
    date = (data.get("date") or "").strip()
    amount = data.get("amount")
    note = (data.get("note") or "").strip()
    if not date:
        return jsonify({"error": "缺少 date"}), 400
    try:
        amount = float(amount)
    except (TypeError, ValueError):
        return jsonify({"error": "amount 需为数字"}), 400
    records = get_fund_records()
    records.append({"date": date, "amount": amount, "note": note})
    save_json(FUND_FILE, records)
    return jsonify({"ok": True})


@app.route("/api/fund-records/delete", methods=["POST"])
def api_fund_records_delete():
    """按索引删除一条出入金记录（POST body: {"index": 0}）"""
    data = request.get_json() or {}
    try:
        idx = int(data.get("index", -1))
    except (TypeError, ValueError):
        return jsonify({"error": "索引须为整数"}), 400
    records = get_fund_records()
    if idx < 0 or idx >= len(records):
        return jsonify({"error": "索引无效"}), 404
    records.pop(idx)
    save_json(FUND_FILE, records)
    return jsonify({"ok": True})


@app.route("/api/fund-records/update", methods=["POST"])
def api_fund_records_update():
    """按索引编辑一条出入金记录（POST body: {"index": 0, "date", "amount", "note"}）"""
    data = request.get_json() or {}
    try:
        idx = int(data.get("index", -1))
    except (TypeError, ValueError):
        return jsonify({"error": "索引须为整数"}), 400
    records = get_fund_records()
    if idx < 0 or idx >= len(records):
        return jsonify({"error": "索引无效"}), 404
    date = (data.get("date") or "").strip()
    amount = data.get("amount")
    note = (data.get("note") or "").strip()
    if not date:
        return jsonify({"error": "缺少 date"}), 400
    try:
        amount = float(amount)
    except (TypeError, ValueError):
        return jsonify({"error": "amount 需为数字"}), 400
    records[idx] = {"date": date, "amount": amount, "note": note}
    save_json(FUND_FILE, records)
    return jsonify({"ok": True})


@app.route("/api/trades", methods=["GET"])
def api_trades():
    """交易明细列表"""
    return jsonify(get_trades())


@app.route("/api/trades", methods=["POST"])
def api_trades_post():
    """新增一条交易"""
    data = request.get_json() or {}
    row, err = _trade_row_from_request(data)
    if err:
        return jsonify({"error": err}), 400
    trades_list = get_trades()
    trades_list.append(row)
    save_json(TRADES_FILE, trades_list)
    return jsonify({"ok": True})


@app.route("/api/trades/delete", methods=["POST"])
def api_trades_delete():
    """按索引删除一条交易（POST body: {"index": 0}）"""
    data = request.get_json() or {}
    try:
        idx = int(data.get("index", -1))
    except (TypeError, ValueError):
        return jsonify({"error": "索引须为整数"}), 400
    trades_list = get_trades()
    if idx < 0 or idx >= len(trades_list):
        return jsonify({"error": "索引无效"}), 404
    trades_list.pop(idx)
    save_json(TRADES_FILE, trades_list)
    return jsonify({"ok": True})


@app.route("/api/trades/update", methods=["POST"])
def api_trades_update():
    """按索引编辑一条交易（POST body: {"index", "date", "symbol", "action", "price", "shares", ...}）

    分红 / 合股拆股记录默认禁止手动新建，但允许编辑由同步流程自动生成的既有记录：
    当原记录 auto=True 时，自动保留 auto 标记与元数据（withholding_rate 等），
    使用户可以对照 IB 的实际股数做小幅校准。
    """
    data = request.get_json() or {}
    try:
        idx = int(data.get("index", -1))
    except (TypeError, ValueError):
        return jsonify({"error": "索引须为整数"}), 400
    trades_list = get_trades()
    if idx < 0 or idx >= len(trades_list):
        return jsonify({"error": "索引无效"}), 404
    existing = trades_list[idx] or {}
    if existing.get("auto") is True:
        data = dict(data)
        data["auto"] = True
    row, err = _trade_row_from_request(data)
    if err:
        return jsonify({"error": err}), 400
    if existing.get("auto") is True:
        for k in (
            "source", "split_ratio", "div_per_share", "withholding_rate",
            "pay_date", "reinvest_price", "gross_dividend_usd",
        ):
            if k in existing and k not in row:
                row[k] = existing[k]
    trades_list[idx] = row
    save_json(TRADES_FILE, trades_list)
    return jsonify({"ok": True})


@app.route("/api/corp-actions/sync", methods=["POST"])
def api_corp_actions_sync():
    """从 yfinance 同步分红、拆股到交易记录（body 可选 {\"symbol\": \"QQQM\"}，缺省为全部持仓标的）。"""
    data = request.get_json() or {}
    sym = (data.get("symbol") or "").strip() or None
    out = sync_corp_actions_from_yfinance(symbol_filter=sym)
    return jsonify({"ok": True, **out})


@app.route("/api/trade-summary", methods=["GET"])
def api_trade_summary():
    """交易汇总统计：总入金、总佣金、资金利用率。支持 ?period=year|month|all 筛选。"""
    period = request.args.get("period", "all")
    now = datetime.now()
    fund_records = get_fund_records()
    trades_list = get_trades()

    if period == "year":
        year_prefix = now.strftime("%Y")
        funds = [r for r in fund_records if (r.get("date") or "")[:4] == year_prefix]
        tds = [t for t in trades_list if (t.get("date") or "")[:4] == year_prefix]
    elif period == "month":
        month_prefix = now.strftime("%Y-%m")
        funds = [r for r in fund_records if (r.get("date") or "")[:7] == month_prefix]
        tds = [t for t in trades_list if (t.get("date") or "")[:7] == month_prefix]
    else:
        funds = fund_records
        tds = trades_list

    # 出入金中备注含"出金"的 amount 取反
    total_inflow = 0.0
    total_outflow = 0.0
    for r in funds:
        amt = float(r.get("amount") or 0)
        note = (r.get("note") or "").lower()
        if "出金" in note and amt > 0:
            total_outflow += amt
        elif amt > 0:
            total_inflow += amt
        elif amt < 0:
            total_outflow += abs(amt)

    total_commission = round(
        sum(float(t.get("commission") or 0) for t in tds if not _is_corp_action(t)),
        2,
    )

    # 资金利用率需要当前持仓数据
    all_trades = get_trades()
    all_symbols = get_all_symbols(all_trades)
    cash_util = 0.0
    if all_symbols:
        dt = datetime.now()
        start_f, end_f = _compute_fetch_range(all_trades)
        hc, bc, td_dates = fetch_histories_with_bench(all_symbols, start_f, end_f)
        eff_date = td_dates[-1] if td_dates else dt.strftime("%Y-%m-%d")
        perf = build_perf_bundle(all_trades, hc, bc, td_dates)
        pix = perf["price_index"]
        pos = positions_at_date(all_trades, eff_date, perf["position_timeline"], perf["timeline_dates"])
        tv = 0.0
        boxx_v = 0.0
        for sym, qty in pos.items():
            p = get_price_on_date(sym, eff_date, hc, pix) or 0
            v = qty * p
            tv += v
            if sym.upper() == "BOXX":
                boxx_v += v
        cash_util = round((1 - boxx_v / tv) * 100, 1) if tv > 0 else 0

    return jsonify({
        "period": period,
        "total_inflow": round(total_inflow, 2),
        "total_outflow": round(total_outflow, 2),
        "net_inflow": round(total_inflow - total_outflow, 2),
        "total_commission": total_commission,
        "trade_count": len(tds),
        "cash_utilization_pct": cash_util,
    })


@app.route("/api/returns-overview", methods=["GET"])
def api_returns_overview():
    """
    收益概览与走势图：采用时间加权收益率（TWR），按相邻交易日分段连乘，
    消除入金/出金对收益率的影响，反映纯持仓涨跌。

    end_fetch 取今日（exclusive），不含盘中实时价，保证每次刷新数据稳定。
    """
    trades_list = get_trades()
    symbols = get_all_symbols(trades_list)
    empty_risk = {"max_drawdown_pct": None, "sharpe_ratio": None, "alpha_pct": None, "beta": None}
    empty_resp = {
        "cards": {k: {"pct": 0, "usd": 0} for k in ["1d", "1m", "1y", "1y_roll", "since"]},
        "chart": {k: {"labels": [], "my": [], "bench": []} for k in ["1d", "1m", "1y", "1y_roll", "since"]},
        "risk_metrics": {k: dict(empty_risk) for k in ["1d", "1m", "1y", "1y_roll", "since"]},
    }
    if not symbols or not trades_list:
        return jsonify(empty_resp)

    dt = datetime.now()
    since_date = min(t["date"][:10] for t in trades_list)
    month_start = dt.replace(day=1).strftime("%Y-%m-%d")
    year_start = dt.replace(month=1, day=1).strftime("%Y-%m-%d")
    # 近1年(1y_roll)按「最后交易日」往前推 365 天，故拉取起点需多留缓冲，避免周末/节假日导致无数据
    one_year_ago = (dt - timedelta(days=365)).strftime("%Y-%m-%d")
    start_fetch, end_fetch = _compute_fetch_range(trades_list)

    # 拉取历史行情（统一文件缓存，同一天内收益与资产配置数据完全一致）
    history_cache, bench_cache, trading_dates = fetch_histories_with_bench(symbols, start_fetch, end_fetch)
    if not trading_dates:
        return jsonify(empty_resp)

    perf = build_perf_bundle(trades_list, history_cache, bench_cache, trading_dates)
    pix = perf["price_index"]

    # 以最后一个有行情的交易日为基准，保证每次刷新结果一致（配合价格缓存）
    effective_end_date = trading_dates[-1]
    prev_trading_date = trading_dates[-2] if len(trading_dates) >= 2 else trading_dates[-1]
    effective_end_dt = datetime.strptime(effective_end_date, "%Y-%m-%d")

    # 当前持仓与市值（全部基于交易历史 + 真实行情计算）
    current_pos = positions_at_date(
        trades_list, effective_end_date, perf["position_timeline"], perf["timeline_dates"],
    )
    if not current_pos:
        return jsonify(empty_resp)

    v_end = portfolio_value_with_prices(
        current_pos,
        prices_at(list(current_pos.keys()), history_cache, effective_end_date, pix),
    )

    # 各时段起始日定义：1D 保留日级涨跌语义；其他时段取「自然起始日」与「组合第一次持仓日期」
    # 的较晚者（max），保证起点不早于 since_date，避免在无持仓区间计算收益。
    one_year_ago_str = (effective_end_dt - timedelta(days=365)).strftime("%Y-%m-%d")
    periods = {
        "1d":      prev_trading_date,
        "1m":      max(month_start, since_date),
        "1y":      max(year_start, since_date),
        "1y_roll": max(one_year_ago_str, since_date),
        "since":   since_date,
    }

    # "since" 期的总成本基准（用于 USD 收益计算）
    cost_basis_map = compute_cost_basis(trades_list)
    total_cost = sum(cb["total_cost"] for cb in cost_basis_map.values()) or v_end

    fund_records = get_fund_records()
    cards = {}
    chart = {}

    for key, p_start in periods.items():
        # TWR（时间加权）
        twr_pct = compute_twr(trades_list, history_cache, p_start, effective_end_date, trading_dates, perf)
        # MWRR（金额加权）
        mwrr_pct = compute_mwr(trades_list, fund_records, history_cache, p_start, effective_end_date, trading_dates, perf)

        # USD 收益
        if key == "since":
            usd = round(v_end - total_cost, 2)
        else:
            pos_start = positions_at_date(trades_list, p_start, perf["position_timeline"], perf["timeline_dates"])
            v_start = portfolio_value_with_prices(
                pos_start,
                prices_at(list(pos_start.keys()), history_cache, p_start, pix),
            ) if pos_start else 0.0
            usd = round(v_start * twr_pct / 100, 2) if v_start > 1e-6 else round(v_end - total_cost, 2)

        cards[key] = {"pct": twr_pct, "mwr_pct": mwrr_pct, "usd": usd}

        # 走势图
        if key == "1d":
            b0 = get_price_on_date(BENCHMARK_SYMBOL, prev_trading_date, bench_cache, pix) or 1.0
            b1 = get_price_on_date(BENCHMARK_SYMBOL, effective_end_date, bench_cache, pix) or b0
            bench_1d = round((b1 / b0 - 1) * 100, 2) if b0 > 0 else 0.0
            twr_1d = twr_pct if twr_pct is not None else 0.0
            chart[key] = {
                "labels": [prev_trading_date[5:], effective_end_date[5:]],
                "my": [0, twr_1d],
                "bench": [0, bench_1d],
                "dca": [0, 0],
                "buy_markers": [],
            }
        else:
            chart[key] = compute_twr_chart(
                trades_list, history_cache, bench_cache,
                p_start, effective_end_date, trading_dates, perf,
            )

    # 风险指标（含回撤序列 + Top3 回撤明细）
    risk_metrics = {}
    for key, p_start in periods.items():
        risk_metrics[key] = compute_risk_metrics(
            trades_list, history_cache, bench_cache,
            p_start, effective_end_date, trading_dates, perf,
        )

    # ===== 策略驱动力归因（Since Inception）— PnL 贡献法 =====
    since_card = cards.get("since", {})
    total_return_pct = since_card.get("pct", 0) or 0

    # 按交易类型汇总实际盈亏
    def _collect_pnl(trade_type):
        pnl_total = 0.0
        details = []
        for t in trades_list:
            if (t.get("type") or "") != trade_type or (t.get("action") or "") != "买入":
                continue
            sym = (t.get("symbol") or "").upper()
            bp = float(t.get("price") or 0)
            bs = float(t.get("shares") or 0)
            if bp <= 0 or bs <= 0:
                continue
            cur_p = get_price_on_date(sym, effective_end_date, history_cache, pix)
            if cur_p:
                pnl = (cur_p - bp) * bs
                pnl_total += pnl
                details.append({
                    "symbol": sym,
                    "date": t.get("date", ""),
                    "buy_price": round(bp, 2),
                    "current_price": round(cur_p, 2),
                    "shares": bs,
                    "pnl": round(pnl, 2),
                    "return_pct": round((cur_p / bp - 1) * 100, 2),
                })
        return pnl_total, details

    toundan_pnl, toundan_details = _collect_pnl("投弹")
    dingtou_pnl, dingtou_details = _collect_pnl("定投")

    # 现金管理（BOXX）：需同时计算已实现盈亏（买卖配对）和未实现盈亏（仍持有）
    cash_pnl = 0.0
    cash_details = []
    cash_buys = []
    for t in trades_list:
        if (t.get("type") or "") != "现金管理":
            continue
        sym = (t.get("symbol") or "").upper()
        bp = float(t.get("price") or 0)
        bs = float(t.get("shares") or 0)
        action = t.get("action") or ""
        if bp <= 0 or bs <= 0:
            continue
        if action == "买入":
            cash_buys.append({"sym": sym, "date": t.get("date", ""), "price": bp, "shares": bs})
        elif action == "卖出":
            remaining = bs
            while remaining > 0 and cash_buys:
                lot = cash_buys[0]
                matched = min(remaining, lot["shares"])
                pnl = (bp - lot["price"]) * matched
                cash_pnl += pnl
                cash_details.append({
                    "symbol": lot["sym"], "date": lot["date"] + " → " + t.get("date", ""),
                    "buy_price": round(lot["price"], 2), "current_price": round(bp, 2),
                    "shares": matched, "pnl": round(pnl, 2),
                    "return_pct": round((bp / lot["price"] - 1) * 100, 2),
                    "status": "已卖出",
                })
                lot["shares"] -= matched
                remaining -= matched
                if lot["shares"] <= 1e-9:
                    cash_buys.pop(0)
    for lot in cash_buys:
        if lot["shares"] <= 1e-9:
            continue
        cur_p = get_price_on_date(lot["sym"], effective_end_date, history_cache, pix)
        if cur_p:
            pnl = (cur_p - lot["price"]) * lot["shares"]
            cash_pnl += pnl
            cash_details.append({
                "symbol": lot["sym"], "date": lot["date"],
                "buy_price": round(lot["price"], 2), "current_price": round(cur_p, 2),
                "shares": lot["shares"], "pnl": round(pnl, 2),
                "return_pct": round((cur_p / lot["price"] - 1) * 100, 2),
                "status": "持有中",
            })

    toundan_pct = round(toundan_pnl / v_end * 100, 2) if v_end > 1e-6 else 0
    dingtou_pct = round(dingtou_pnl / v_end * 100, 2) if v_end > 1e-6 else 0
    cash_pct = round(cash_pnl / v_end * 100, 2) if v_end > 1e-6 else 0
    known_pnl_pct = round((toundan_pnl + dingtou_pnl + cash_pnl) / v_end * 100, 2) if v_end > 1e-6 else 0
    other_pct = round(total_return_pct - known_pnl_pct, 2)

    strategy_driver = {
        "total_pct": total_return_pct,
        "dingtou_pct": dingtou_pct,
        "toundan_pct": toundan_pct,
        "cash_pct": cash_pct,
        "other_pct": other_pct,
        "total_pnl_pct": known_pnl_pct,
        "toundan_details": toundan_details,
        "toundan_total_pnl": round(toundan_pnl, 2),
        "dingtou_details": dingtou_details,
        "dingtou_total_pnl": round(dingtou_pnl, 2),
        "cash_details": cash_details,
        "cash_total_pnl": round(cash_pnl, 2),
        "v_end": round(v_end, 2),
    }

    return jsonify({
        "cards": cards,
        "chart": chart,
        "data_as_of": effective_end_date,
        "method": "MWRR",
        "risk_metrics": risk_metrics,
        "strategy_driver": strategy_driver,
    })


@app.route("/api/allocation", methods=["GET"])
def api_allocation():
    """
    当前资产配置：持仓股数、最新价格（历史最后收盘日）、持仓金额、占比、平均成本。

    end 取今日（exclusive）而非明日，确保只使用已完成交易日的收盘价，
    避免盘中实时价导致每次刷新价格不一致的问题。
    """
    trades_list = get_trades()
    symbols = get_all_symbols(trades_list)
    if not symbols:
        return jsonify([])

    dt = datetime.now()
    start_fetch, end_fetch = _compute_fetch_range(trades_list)
    # 与收益概览使用完全相同的日期范围，保证命中同一缓存
    history_cache, bench_cache, trading_dates = fetch_histories_with_bench(symbols, start_fetch, end_fetch)
    effective_end_date = trading_dates[-1] if trading_dates else dt.strftime("%Y-%m-%d")

    perf = build_perf_bundle(trades_list, history_cache, bench_cache, trading_dates)
    pix = perf["price_index"]
    pos = positions_at_date(
        trades_list, effective_end_date, perf["position_timeline"], perf["timeline_dates"],
    )
    cost_basis_map = compute_cost_basis(trades_list)

    rows = []
    for sym, qty in pos.items():
        price = get_price_on_date(sym, effective_end_date, history_cache, pix)
        if price is None:
            price = 0.0
        amount = qty * price
        cb = cost_basis_map.get(sym, {})
        avg_cost = cb.get("avg_cost", 0.0)
        rows.append({
            "symbol": sym,
            "shares": round(qty, 4),
            "price": round(price, 2),
            "amount": round(amount, 2),
            "avg_cost": round(avg_cost, 2),
        })
    total = sum(r["amount"] for r in rows)
    # 风险资产归一化：排除 BOXX 等现金类标的
    CASH_TICKERS = {"BOXX"}
    TARGET_PCT = {"QQQM": 60, "BRK.B": 25, "IAU": 15}
    risk_total = sum(r["amount"] for r in rows if r["symbol"] not in CASH_TICKERS)
    qqqm_effective_pct = 0
    for r in rows:
        r["pct"] = round(r["amount"] / total * 100, 1) if total else 0
        r["is_cash"] = r["symbol"] in CASH_TICKERS
        if r["avg_cost"] and r["avg_cost"] > 0:
            r["gain_pct"] = round((r["price"] - r["avg_cost"]) / r["avg_cost"] * 100, 2)
        else:
            r["gain_pct"] = 0.0
        if r["is_cash"]:
            r["effective_pct"] = None
            r["target_pct"] = 0
            r["deviation_pct"] = 0
        else:
            r["effective_pct"] = round(r["amount"] / risk_total * 100, 1) if risk_total > 0 else 0
            r["target_pct"] = TARGET_PCT.get(r["symbol"], 0)
            r["deviation_pct"] = round(r["effective_pct"] - r["target_pct"], 1)
        if r["symbol"] == "QQQM":
            qqqm_effective_pct = r["effective_pct"] or 0
    rows.sort(key=lambda r: r["amount"], reverse=True)
    return jsonify({
        "rows": rows,
        "data_as_of": effective_end_date,
        "total_value": round(total, 2),
        "risk_total": round(risk_total, 2),
        "qqqm_warning": qqqm_effective_pct < 45,
        "qqqm_pct": round(qqqm_effective_pct, 1),
    })


@app.route("/api/asset-analysis/<symbol>", methods=["GET"])
def api_asset_analysis(symbol):
    """
    单标的盈亏归因分析：价格序列、VWAC 动态成本线、加仓散点、性能指标。
    价格数据源与 /api/allocation 使用同一套缓存，确保最新价与表格一致。
    """
    symbol = symbol.strip().upper()
    trades_list = get_trades()
    all_symbols = get_all_symbols(trades_list)

    dt = datetime.now()
    one_year_ago = (dt - timedelta(days=395)).strftime("%Y-%m-%d")
    # 取最近一年与该标的最早交易日的孰晚者（不展示交易前的空白区间）
    sym_trades_dates = [
        (t.get("date") or "")[:10] for t in trades_list
        if (t.get("symbol") or "").upper() == symbol and (t.get("date") or "")[:10] > "2000"
    ]
    earliest_trade = min(sym_trades_dates) if sym_trades_dates else one_year_ago
    start_fetch = max(one_year_ago, earliest_trade)
    # 额外多拉 30 天缓冲，确保 EMA / 均价计算有前置数据
    start_fetch_buffered = (parse_date(start_fetch) - timedelta(days=30)).strftime("%Y-%m-%d") if parse_date(start_fetch) else start_fetch
    end_fetch = (dt + timedelta(days=1)).strftime("%Y-%m-%d")

    # 使用与 /api/allocation 相同的缓存拿价格，保证最新价一致
    alloc_since = min((t["date"][:10] for t in trades_list), default=dt.strftime("%Y-%m-%d"))
    alloc_start = min(alloc_since, (dt - timedelta(days=365)).strftime("%Y-%m-%d"), dt.replace(month=1, day=1).strftime("%Y-%m-%d"))
    alloc_end = (dt + timedelta(days=1)).strftime("%Y-%m-%d")
    alloc_cache, _, alloc_trading_dates = fetch_histories_with_bench(all_symbols, alloc_start, alloc_end)
    alloc_end_date = alloc_trading_dates[-1] if alloc_trading_dates else dt.strftime("%Y-%m-%d")
    # allocation 一致的当前价和成本
    alloc_price = get_price_on_date(symbol, alloc_end_date, alloc_cache)
    alloc_cost_map = compute_cost_basis(trades_list)
    alloc_cb = alloc_cost_map.get(symbol, {})
    alloc_avg_cost = alloc_cb.get("avg_cost", 0.0)
    alloc_shares = alloc_cb.get("shares", 0.0)

    # 图表用的历史序列单独拉（可能范围更广）；若 Yahoo API 间歇性失败则回退用 alloc_cache
    raw = _fetch_histories_raw([symbol], start_fetch_buffered, end_fetch)
    df = raw.get(symbol)
    if df is None or df.empty:
        df = alloc_cache.get(symbol)
    if df is None or df.empty:
        return jsonify({"error": f"无法获取 {symbol} 的历史数据"}), 404

    closes = df["Close"].dropna()
    dates = [str(idx)[:10] for idx in closes.index]
    prices = [round(float(v), 2) for v in closes.values]

    # 筛选该标的所有交易，按日期排序
    sym_trades = sorted(
        [t for t in trades_list if (t.get("symbol") or "").upper() == symbol],
        key=lambda x: x.get("date") or ""
    )

    # --- VWAC 动态成本流 ---
    cum_cost = 0.0
    cum_shares = 0.0
    # 按日期建立交易索引：{date: [{action, price, shares, commission, type}, ...]}
    trade_by_date = {}
    for t in sym_trades:
        d = (t.get("date") or "")[:10]
        trade_by_date.setdefault(d, []).append(t)

    cost_series = []
    for i, d in enumerate(dates):
        if d in trade_by_date:
            for t in trade_by_date[d]:
                action = t.get("action") or ""
                p = float(t.get("price") or 0)
                s = float(t.get("shares") or 0)
                c = float(t.get("commission") or 0)
                tp = (t.get("type") or "").strip()
                if tp == TYPE_DIVIDEND:
                    if action == "买入" and s > 0:
                        cum_shares += s
                    continue
                if tp == TYPE_CORP_SPLIT:
                    if action == "买入" and s > 0:
                        cum_shares += s
                    elif action == "卖出" and s > 0:
                        cum_shares = max(0.0, cum_shares - s)
                    continue
                if action == "买入" and s > 0:
                    cum_cost += p * s + c
                    cum_shares += s
                elif action == "卖出" and cum_shares > 1e-9 and s > 0:
                    ratio = min(s, cum_shares) / cum_shares
                    cum_cost *= (1.0 - ratio)
                    cum_shares = max(0.0, cum_shares - s)
        vwac = round(cum_cost / cum_shares, 2) if cum_shares > 1e-6 else None
        cost_series.append(vwac)

    # --- 加仓散点 ---
    buy_points = []
    for t in sym_trades:
        if (t.get("action") or "") != "买入":
            continue
        if _is_corp_action(t):
            continue
        tp = t.get("type") or "定投"
        label = "投弹" if tp == "投弹" else ("投机" if tp == "投机" else "月投")
        buy_points.append({
            "date": (t.get("date") or "")[:10],
            "price": round(float(t.get("price") or 0), 2),
            "shares": round(float(t.get("shares") or 0), 2),
            "type": tp,
            "label": label,
        })

    # --- 性能指标（使用与 allocation 表格一致的价格和成本）---
    current_price = round(alloc_price, 2) if alloc_price else (prices[-1] if prices else 0)
    avg_cost = round(alloc_avg_cost, 2) if alloc_avg_cost > 0 else (round(cum_cost / cum_shares, 2) if cum_shares > 1e-6 else 0)
    yoc_pct = round((current_price / avg_cost - 1) * 100, 2) if avg_cost > 0 else 0

    # 策略贡献度 Alpha：投弹买入价 vs 后 30 个交易日均价
    strategy_alpha = {}
    for tp in ("投弹", "定投"):
        alphas = []
        for bp in buy_points:
            if bp["type"] != tp:
                continue
            bd = bp["date"]
            bp_price = bp["price"]
            if bp_price <= 0:
                continue
            # 找到买入日之后的 30 个交易日
            try:
                idx_start = dates.index(bd)
            except ValueError:
                continue
            future_30 = prices[idx_start + 1: idx_start + 31]
            if len(future_30) >= 5:
                avg_30 = sum(future_30) / len(future_30)
                # 正值 = 买入价低于后续均价 = 买到了便宜货
                alpha = round((avg_30 / bp_price - 1) * 100, 2)
                alphas.append(alpha)
        if alphas:
            strategy_alpha[tp] = round(sum(alphas) / len(alphas), 2)

    # 最大浮亏：(close - VWAC) / VWAC 的最小值
    max_dd_pct = 0.0
    max_dd_start = None
    max_dd_end = None
    for i, (p, c) in enumerate(zip(prices, cost_series)):
        if c is not None and c > 0:
            pnl = (p - c) / c * 100
            if pnl < max_dd_pct:
                max_dd_pct = round(pnl, 2)
                max_dd_end = dates[i]
                # 回溯找峰值点（最近一次盈利或起始）
                for j in range(i, -1, -1):
                    cj = cost_series[j]
                    if cj is not None and cj > 0 and prices[j] >= cj:
                        max_dd_start = dates[j]
                        break
                if not max_dd_start:
                    max_dd_start = dates[0]

    # --- 按交易类型的盈亏归因明细 ---
    trade_attribution = []
    for t in sym_trades:
        if (t.get("action") or "") != "买入":
            continue
        if _is_corp_action(t):
            continue
        tp = t.get("type") or "定投"
        bp_val = float(t.get("price") or 0)
        bs_val = float(t.get("shares") or 0)
        if bp_val <= 0 or bs_val <= 0:
            continue
        trade_attribution.append({
            "date": (t.get("date") or "")[:10],
            "type": tp,
            "type_label": "投弹" if tp == "投弹" else ("现金管理" if tp == "现金管理" else "月投"),
            "buy_price": round(bp_val, 2),
            "current_price": current_price,
            "shares": bs_val,
            "pnl": round((current_price - bp_val) * bs_val, 2),
            "return_pct": round((current_price / bp_val - 1) * 100, 2),
        })

    return jsonify({
        "symbol": symbol,
        "data_as_of": alloc_end_date,
        "price_series": [{"date": d, "close": p} for d, p in zip(dates, prices)],
        "cost_series": [{"date": d, "vwac": c} for d, c in zip(dates, cost_series)],
        "buy_points": buy_points,
        "trade_attribution": trade_attribution,
        "metrics": {
            "current_price": current_price,
            "avg_cost": avg_cost,
            "total_shares": round(cum_shares, 4),
            "yoc_pct": yoc_pct,
            "strategy_alpha": strategy_alpha,
            "max_drawdown_pct": max_dd_pct,
            "max_drawdown_period": {"start": max_dd_start, "end": max_dd_end} if max_dd_end else None,
        },
    })


def _trade_row_from_request(data):
    """
    从 POST body 构建一条交易 dict。分红/合股拆股仅允许 auto=true（同步写入）。
    返回 (row, error_message)；error_message 非空表示应返回 400。
    """
    required = ["date", "symbol", "action", "price", "shares"]
    for k in required:
        if k not in data:
            return None, f"缺少 {k}"
    try:
        price = float(data["price"])
        shares = float(data["shares"])
        commission = float(data.get("commission") or 0)
    except (TypeError, ValueError):
        return None, "price/shares/commission 需为数字"
    tp = _normalize_trade_type(data.get("type"))
    if tp in (TYPE_DIVIDEND, TYPE_CORP_SPLIT) and not data.get("auto"):
        return None, "分红与合股拆股仅可通过「同步分红/拆股」自动生成"
    row = {
        "date": data["date"].strip(),
        "symbol": data["symbol"].strip(),
        "action": data["action"].strip(),
        "price": price,
        "shares": shares,
        "commission": commission,
        "type": tp,
    }
    if data.get("auto") is True:
        row["auto"] = True
    sr = data.get("split_ratio")
    if sr is not None:
        try:
            row["split_ratio"] = float(sr)
        except (TypeError, ValueError):
            pass
    src = (data.get("source") or "").strip()
    if src:
        row["source"] = src
    return row, None


def _yf_event_date(idx):
    try:
        return str(pd.Timestamp(idx).date())
    except Exception:
        return str(idx)[:10]


def _has_manual_corp(trades_list, sym, ex_d, kind_type):
    for t in trades_list:
        if (t.get("symbol") or "").strip().upper() != sym:
            continue
        if (t.get("date") or "")[:10] != ex_d:
            continue
        if (t.get("type") or "").strip() != kind_type:
            continue
        if not t.get("auto"):
            return True
    return False


def _dividend_auto_exists(trades_list, sym, ex_d):
    return any(
        (t.get("symbol") or "").strip().upper() == sym
        and (t.get("date") or "")[:10] == ex_d
        and (t.get("type") or "").strip() == TYPE_DIVIDEND
        and t.get("auto") is True
        for t in trades_list
    )


def _split_auto_pair_exists(trades_list, sym, ex_d, ratio):
    rows = [
        t
        for t in trades_list
        if (t.get("symbol") or "").strip().upper() == sym
        and (t.get("date") or "")[:10] == ex_d
        and (t.get("type") or "").strip() == TYPE_CORP_SPLIT
        and t.get("auto") is True
        and abs(float(t.get("split_ratio") or 0) - ratio) < 1e-6
    ]
    return len(rows) >= 2


def _next_nth_weekday_after(date_str, n):
    """返回 date_str 之后第 n 个工作日（M–F，不含假日，近似交易日）。

    n=0 时返回原日期；n>0 时逐日递增，跳过周末。用于估算付息日。
    """
    try:
        d = parse_date(date_str)
    except Exception:
        return date_str
    if d is None:
        return date_str
    if n <= 0:
        return d.strftime("%Y-%m-%d")
    cnt = 0
    while cnt < n:
        d = d + timedelta(days=1)
        if d.weekday() < 5:
            cnt += 1
    return d.strftime("%Y-%m-%d")


def _fetch_open_price_on_or_after(symbol, date_str):
    """拉取 symbol 在 date_str 当日或之后第一个交易日的开盘价。

    独立于 _fetch_histories_raw 的 Close-only 缓存，避免改动现有价格缓存结构。
    出错/无数据时返回 None，由调用方回退到收盘价近似。
    """
    try:
        target = parse_date(date_str)
    except Exception:
        return None
    if target is None:
        return None
    start = date_str[:10]
    end = (target + timedelta(days=15)).strftime("%Y-%m-%d")
    use_repair = _yfinance_repair_available()
    try:
        df = yf.Ticker(yf_symbol(symbol)).history(
            start=start, end=end, auto_adjust=False, repair=use_repair
        )
    except Exception:
        return None
    if df is None or df.empty or "Open" not in df.columns:
        return None
    idx = df.index
    try:
        target_ts = pd.Timestamp(date_str[:10])
        if hasattr(idx, "tz") and idx.tz is not None:
            target_ts = target_ts.tz_localize(idx.tz)
        mask = idx >= target_ts
        if not mask.any():
            return None
        val = df.loc[mask].iloc[0]["Open"]
        return float(val.iloc[0]) if hasattr(val, "iloc") else float(val)
    except Exception:
        return None


def sync_corp_actions_from_yfinance(symbol_filter=None):
    """
    从 yfinance 拉取分红、拆股并追加写入 trades.json。

    分红股数（对齐 IB DRIP 口径）：
        shares = (每股分红 × 除息日前夜持仓 × (1 - 预扣税率)) / 付息日开盘价
    - 预扣税率：model_state.settings.dividend_withholding_rate，默认 0.30
    - 付息日偏移：model_state.settings.dividend_reinvest_offset_bd，默认 5 工作日
    - 付息日开盘价拉取失败时回退到除息日收盘价（仍应用预扣税率）

    拆股：同日一条卖出旧股数 + 一条买入新股数（新股数 = 旧股数 × Yahoo 比例），不改变 total_cost。
    """
    settings = _get_settings()
    wh_rate = float(settings.get(
        "dividend_withholding_rate", DEFAULT_DIVIDEND_WITHHOLDING_RATE))
    wh_rate = max(0.0, min(0.5, wh_rate))
    offset_bd = int(settings.get(
        "dividend_reinvest_offset_bd", DEFAULT_DIVIDEND_REINVEST_OFFSET_BD))
    offset_bd = max(0, min(10, offset_bd))

    trades_list = get_trades()
    inserted = []
    skipped = []

    if symbol_filter:
        s = (symbol_filter or "").strip().upper()
        symbols = [s] if s else []
    else:
        symbols = sorted(get_all_symbols(trades_list))

    if not symbols:
        return {"inserted": [], "skipped": [{"reason": "无标的，请先添加交易"}]}

    dt = datetime.now()
    end_fetch = (dt + timedelta(days=1)).strftime("%Y-%m-%d")

    for sym in symbols:
        sy = yf_symbol(sym)
        try:
            tk = yf.Ticker(sy)
            divs = tk.dividends
            spls = tk.splits
        except Exception as e:
            skipped.append({"symbol": sym, "reason": f"yfinance: {e!s}"})
            continue

        events = []
        if divs is not None and len(divs) > 0:
            for idx, val in divs.items():
                ex_d = _yf_event_date(idx)
                try:
                    dv = float(val)
                except (TypeError, ValueError):
                    continue
                if dv <= 0:
                    continue
                events.append(("div", ex_d, dv, None))
        if spls is not None and len(spls) > 0:
            for idx, val in spls.items():
                ex_d = _yf_event_date(idx)
                try:
                    ratio = float(val)
                except (TypeError, ValueError):
                    continue
                if abs(ratio - 1.0) < 1e-12:
                    continue
                events.append(("split", ex_d, ratio, None))

        events.sort(key=lambda x: (x[1], 0 if x[0] == "div" else 1))

        sym_dates = [ex_d for _, ex_d, _, _ in events]
        if not sym_dates:
            continue
        start_fetch = (
            parse_date(min(sym_dates)) - timedelta(days=45)
        ).strftime("%Y-%m-%d") if parse_date(min(sym_dates)) else min(sym_dates)

        hist_one = _fetch_histories_raw([sym], start_fetch, end_fetch)
        hist_cache = hist_one if hist_one else {}

        for kind, ex_d, val, _ in events:
            if kind == "div":
                div_per = val
                if _has_manual_corp(trades_list, sym, ex_d, TYPE_DIVIDEND):
                    skipped.append({"symbol": sym, "date": ex_d, "kind": "div", "reason": "同日存在手动分红"})
                    continue
                if _dividend_auto_exists(trades_list, sym, ex_d):
                    skipped.append({"symbol": sym, "date": ex_d, "kind": "div", "reason": "已存在自动分红"})
                    continue
                pos = positions_at_date(trades_list, ex_d)
                shares_held = float(pos.get(sym, 0) or 0)
                if shares_held <= 1e-12:
                    skipped.append({"symbol": sym, "date": ex_d, "kind": "div", "reason": "除息日无持仓"})
                    continue
                close_p = get_price_on_date(sym, ex_d, hist_cache)
                if close_p is None or close_p <= 0:
                    skipped.append({"symbol": sym, "date": ex_d, "kind": "div", "reason": "无法取得收盘价"})
                    continue
                pay_d = _next_nth_weekday_after(ex_d, offset_bd)
                pay_open = _fetch_open_price_on_or_after(sym, pay_d) if offset_bd > 0 else close_p
                reinvest_p = pay_open if pay_open and pay_open > 0 else close_p
                gross_cash = div_per * shares_held
                net_cash = gross_cash * (1.0 - wh_rate)
                shares_added = net_cash / reinvest_p
                if shares_added <= 1e-12:
                    skipped.append({"symbol": sym, "date": ex_d, "kind": "div", "reason": "再投资股数过小"})
                    continue
                row = {
                    "date": ex_d,
                    "symbol": sym,
                    "action": "买入",
                    "price": 0.0,
                    "shares": round(shares_added, 6),
                    "commission": 0.0,
                    "type": TYPE_DIVIDEND,
                    "auto": True,
                    "source": "yfinance",
                    "div_per_share": div_per,
                    "withholding_rate": wh_rate,
                    "pay_date": pay_d,
                    "reinvest_price": round(reinvest_p, 4),
                    "gross_dividend_usd": round(gross_cash, 4),
                }
                trades_list.append(row)
                inserted.append(row)
            else:
                ratio = val
                if _has_manual_corp(trades_list, sym, ex_d, TYPE_CORP_SPLIT):
                    skipped.append({"symbol": sym, "date": ex_d, "kind": "split", "reason": "同日存在手动合股拆股"})
                    continue
                if _split_auto_pair_exists(trades_list, sym, ex_d, ratio):
                    skipped.append({"symbol": sym, "date": ex_d, "kind": "split", "reason": "已存在自动拆股"})
                    continue
                old_sh = float(positions_at_date(trades_list, ex_d).get(sym, 0) or 0)
                if old_sh <= 1e-12:
                    skipped.append({"symbol": sym, "date": ex_d, "kind": "split", "reason": "除权日无持仓"})
                    continue
                new_sh = round(old_sh * ratio, 6)
                sell_r = {
                    "date": ex_d,
                    "symbol": sym,
                    "action": "卖出",
                    "price": 0.0,
                    "shares": round(old_sh, 6),
                    "commission": 0.0,
                    "type": TYPE_CORP_SPLIT,
                    "auto": True,
                    "source": "yfinance",
                    "split_ratio": ratio,
                }
                buy_r = {
                    "date": ex_d,
                    "symbol": sym,
                    "action": "买入",
                    "price": 0.0,
                    "shares": new_sh,
                    "commission": 0.0,
                    "type": TYPE_CORP_SPLIT,
                    "auto": True,
                    "source": "yfinance",
                    "split_ratio": ratio,
                }
                trades_list.extend([sell_r, buy_r])
                inserted.extend([sell_r, buy_r])

    if inserted:
        save_json(TRADES_FILE, trades_list)
    return {"inserted": inserted, "skipped": skipped}


# =====================================================================
#  天府 v1.0  ——  核心算法引擎
# =====================================================================

# ---------- 1.5 模型状态持久化 ----------

def _default_model_state():
    return {
        "last_toundan_prices": {},
        "monthly_toundan_count": {"QQQM": 0, "IAU": 0},
        "daily_toundan": {},
        "yearly_m3_used": False,
        "qqqm_below_35pct_days": 0,
        "state_month": datetime.now().strftime("%Y-%m"),
        "state_year": datetime.now().strftime("%Y"),
        "last_updated": datetime.now().strftime("%Y-%m-%d"),
        "s_history": [],
        "put_position": None,
        "annual_premium_spent": 0,
    }


def load_model_state():
    raw = load_json(MODEL_STATE_FILE, None)
    if not raw or not isinstance(raw, dict):
        return _default_model_state()
    now = datetime.now()
    cur_month = now.strftime("%Y-%m")
    cur_year = now.strftime("%Y")
    if raw.get("state_month") != cur_month:
        raw["monthly_toundan_count"] = {"QQQM": 0, "IAU": 0}
        raw["daily_toundan"] = {}
        raw["state_month"] = cur_month
    if raw.get("state_year") != cur_year:
        raw["yearly_m3_used"] = False
        raw["annual_premium_spent"] = 0
        raw["state_year"] = cur_year
    # v1.0 -> v1.3.1 迁移兼容
    if "yearly_m4_used" in raw:
        del raw["yearly_m4_used"]
    if "s_history" not in raw:
        raw["s_history"] = []
    if "put_position" not in raw:
        raw["put_position"] = None
    if "annual_premium_spent" not in raw:
        raw["annual_premium_spent"] = 0
    return raw


def save_model_state(state):
    state["last_updated"] = datetime.now().strftime("%Y-%m-%d")
    save_json(MODEL_STATE_FILE, state)


def compute_reserve_pool(trades_list, cash_position_value=0, fund_records=None):
    """
    备弹池采用现金流恒等式：

        net_inflow          = 总入金（出入金净额，备注含"出金"或 amount<0 视为出金）
        monthly_used        = "定投" 净买入（买入 - 卖出，按 price × shares）
        total_toundan_used  = "投弹" 净买入（同上）
        total_injected      = net_inflow - monthly_used        （投弹池规模 = 已投 + 未投）
        reserve_pool        = total_injected - total_toundan_used  （投弹池中尚未投出的部分）
        year_max_reserve    = total_injected                   （用于 T 公式分母）

    语义说明：
    - "定投"通道的资金不属于投弹池，应直接从总入金中扣除。
    - "投弹"通道的已投出部分依然属于投弹池（只是从现金形态变成持仓形态），
      所以从 total_injected 进入 total_toundan_used，但不再出现在 reserve_pool 里。
    - BOXX / "现金管理" 类买卖视作通道内腾挪，不影响任何指标。

    关键差异 vs 旧实现：
    - 旧：reserve_pool 来自 BOXX 当前市值，依赖标的现价与持仓；
          入金后必须等用户手动建仓 BOXX 才能反映。
    - 新：所有数字来自现金流恒等式，入金登记后立即反映；不再依赖任何标的市值。

    cash_position_value 形参保留向后兼容，新公式不再使用。
    fund_records 缺省为空 → total_injected = 0，便于历史调用方在过渡期内运行
    （但下游数字会全部为 0，请务必传入完整的 fund_records 列表）。
    """
    del cash_position_value  # 形参保留，新公式不再依赖

    fund_records = fund_records or []

    net_inflow = 0.0
    for r in fund_records:
        amt = float(r.get("amount") or 0)
        note = (r.get("note") or "").lower()
        if "出金" in note and amt > 0:
            net_inflow -= amt
        else:
            net_inflow += amt

    def _net_buy_for_type(target_type):
        net = 0.0
        for t in trades_list:
            if (t.get("type") or "") != target_type:
                continue
            shares = float(t.get("shares") or 0)
            price = float(t.get("price") or 0)
            action = t.get("action") or ""
            if action == "买入":
                net += shares * price
            elif action == "卖出":
                net -= shares * price
        return net

    monthly_used = _net_buy_for_type("定投")
    total_toundan_used = _net_buy_for_type("投弹")
    total_injected = net_inflow - monthly_used
    reserve_pool = total_injected - total_toundan_used

    return {
        "reserve_pool": round(reserve_pool, 2),
        "year_max_reserve": round(total_injected, 2),
        "total_injected": round(total_injected, 2),
        "total_toundan_used": round(total_toundan_used, 2),
    }


def _toundan_stats_from_trades(trades_list):
    """
    直接从交易明细中统计投弹次数和最近投弹价格（权威数据源，不依赖 model_state 手动维护）。
    返回 {
      "monthly_count": {"QQQM": n, "IAU": n},
      "daily_count":   {"QQQM": n, "IAU": n},
      "last_prices":   {"QQQM": price, "IAU": price},
      "yearly_m3_used": bool,  -- 本年是否已使用 M3（VIX>50 年度 QQQM）
    }
    """
    today_str = datetime.now().strftime("%Y-%m-%d")
    cur_month = datetime.now().strftime("%Y-%m")
    cur_year = datetime.now().strftime("%Y")

    monthly_count = {"QQQM": 0, "IAU": 0}
    daily_count = {"QQQM": 0, "IAU": 0}
    last_prices = {}
    yearly_m3 = False

    for t in trades_list:
        if (t.get("type") or "") != "投弹":
            continue
        sym = (t.get("symbol") or "").upper()
        d = (t.get("date") or "")[:10]
        price = float(t.get("price") or 0)

        if sym in ("QQQM", "IAU") and price > 0:
            last_prices[sym] = price

        if d[:7] == cur_month and sym in ("QQQM", "IAU"):
            monthly_count[sym] = monthly_count.get(sym, 0) + 1

        if d == today_str and sym in ("QQQM", "IAU"):
            daily_count[sym] = daily_count.get(sym, 0) + 1

        # M3 年度 QQQM（v1.3.1: VIX>50 场景，标记为 M3 投弹的 QQQM）
        if d[:4] == cur_year and sym == "QQQM" and (t.get("note") or "").startswith("M3"):
            yearly_m3 = True

    return {
        "monthly_count": monthly_count,
        "daily_count": daily_count,
        "last_prices": last_prices,
        "yearly_m3_used": yearly_m3,
    }


# ---------- 1.1 分位数引擎 ----------

_quantile_cache = {"date": None, "data": None}
_quantile_lock = threading.Lock()


def compute_quantile_engine():
    """
    拉取 3 年 + 缓冲日线，计算所有分位数指标。
    同一天内缓存结果，避免重复拉取。优先读取文件缓存，服务重启后仍可快速返回。
    使用线程锁确保并发请求等待第一次计算完成，不重复拉取 Yahoo Finance。
    """
    import numpy as np

    today_str = datetime.now().strftime("%Y-%m-%d")

    # 快速路径：进程内存缓存命中（无需加锁）
    if _quantile_cache["date"] == today_str and _quantile_cache["data"]:
        return _quantile_cache["data"]

    # 慢路径：需要计算。加锁确保同一进程内只有一个线程执行 Yahoo 拉取，
    # 其他线程等待锁释放后直接从内存/文件缓存命中。
    with _quantile_lock:
        # 双检锁：拿到锁后先再确认（另一线程可能已完成）
        if _quantile_cache["date"] == today_str and _quantile_cache["data"]:
            return _quantile_cache["data"]

        # 文件缓存检查：服务重启后直接读文件，无需重新拉取 15 秒
        try:
            raw_file = load_json(QUANTILE_CACHE_FILE, None)
            if raw_file and raw_file.get("date") == today_str and raw_file.get("data"):
                _quantile_cache["date"] = today_str
                _quantile_cache["data"] = raw_file["data"]
                return raw_file["data"]
        except Exception:
            pass

        dt = datetime.now()
        start_3y = (dt - timedelta(days=3 * 365 + 60)).strftime("%Y-%m-%d")
        end_d = (dt + timedelta(days=1)).strftime("%Y-%m-%d")
    
        # 需要拉取的标的：QQQM、^VIX、^TNX（10年期国债收益率）、IAU、SPY（PE 代理）
        tickers_needed = ["QQQM", "^VIX", "^TNX", "IAU", "SPY"]
        raw = _fetch_histories_raw(tickers_needed, start_3y, end_d)
    
        result = {
            "qqqm_price": None, "qqqm_prev_close": None, "qqqm_change_pct": None,
            "qqqm_drop_3y_pctile": None,
            "vix_price": None, "vix_3y_pctile": None,
            "qqqm_ema200": None, "qqqm_above_ema200": None,
            "qqqm_ema20": None, "qqqm_above_ema20": None,
            "qqqm_low20": None,
            "tnx_yield": None,
            "iau_price": None, "iau_prev_close": None, "iau_change_pct": None,
            "pe_10y_pctile": None, "pe_3y_pctile": None,
            "ema200_deviation_3y_pctile": None,
            "ema20_deviation_3y_pctile": None,
            "vix_3y_median_s": None,
        }
    
        # --- QQQM ---
        df_qqqm = raw.get("QQQM")
        if df_qqqm is not None and not df_qqqm.empty and len(df_qqqm) > 5:
            closes = df_qqqm["Close"].dropna()
            if len(closes) > 1:
                result["qqqm_price"] = round(float(closes.iloc[-1]), 2)
                result["qqqm_prev_close"] = round(float(closes.iloc[-2]), 2)
                pct_chg = (closes.iloc[-1] / closes.iloc[-2] - 1) * 100
                result["qqqm_change_pct"] = round(float(pct_chg), 2)
    
                # 日收益率序列
                daily_ret = closes.pct_change().dropna()
                if len(daily_ret) > 10:
                    today_ret = float(daily_ret.iloc[-1])
                    # 当日跌幅在 3 年历史日收益中的分位（越低 = 跌幅越罕见 = 分位值越高）
                    rank = float((daily_ret <= today_ret).sum()) / len(daily_ret)
                    # 反转：跌幅越深 → rank 越小 → (1-rank) 越大 → 分位越高
                    result["qqqm_drop_3y_pctile"] = round(1.0 - rank, 4)
    
                # 200 日 EMA
                if len(closes) > 200:
                    ema200 = closes.ewm(span=200, adjust=False).mean()
                    result["qqqm_ema200"] = round(float(ema200.iloc[-1]), 2)
                    result["qqqm_above_ema200"] = bool(closes.iloc[-1] > ema200.iloc[-1])
    
                    # 200 日偏离分位：(price/ema200 - 1) 在 3 年中的分位
                    deviation_200 = (closes / ema200 - 1.0).dropna()
                    if len(deviation_200) > 10:
                        cur_dev = float(deviation_200.iloc[-1])
                        pctile = float((deviation_200 <= cur_dev).sum()) / len(deviation_200)
                        result["ema200_deviation_3y_pctile"] = round(pctile, 4)
    
                # 20 日 EMA
                if len(closes) > 20:
                    ema20 = closes.ewm(span=20, adjust=False).mean()
                    result["qqqm_ema20"] = round(float(ema20.iloc[-1]), 2)
                    result["qqqm_above_ema20"] = bool(closes.iloc[-1] > ema20.iloc[-1])
    
                    deviation_20 = (closes / ema20 - 1.0).dropna()
                    if len(deviation_20) > 10:
                        cur_dev20 = float(deviation_20.iloc[-1])
                        pctile20 = float((deviation_20 <= cur_dev20).sum()) / len(deviation_20)
                        result["ema20_deviation_3y_pctile"] = round(pctile20, 4)
    
                # 20 日最低价
                if len(closes) >= 20:
                    result["qqqm_low20"] = round(float(closes.iloc[-20:].min()), 2)
    
        # --- VIX ---
        df_vix = raw.get("^VIX")
        if df_vix is not None and not df_vix.empty and len(df_vix) > 5:
            vix_closes = df_vix["Close"].dropna()
            if len(vix_closes) > 1:
                result["vix_price"] = round(float(vix_closes.iloc[-1]), 2)
                rank_vix = float((vix_closes <= vix_closes.iloc[-1]).sum()) / len(vix_closes)
                result["vix_3y_pctile"] = round(rank_vix, 4)
    
        # --- ^TNX（10 年期国债收益率，作为 TIPS 近似）---
        df_tnx = raw.get("^TNX")
        if df_tnx is not None and not df_tnx.empty:
            tnx_closes = df_tnx["Close"].dropna()
            if len(tnx_closes) > 0:
                result["tnx_yield"] = round(float(tnx_closes.iloc[-1]), 2)
    
        # --- IAU ---
        df_iau = raw.get("IAU")
        if df_iau is not None and not df_iau.empty and len(df_iau) > 2:
            iau_closes = df_iau["Close"].dropna()
            if len(iau_closes) > 1:
                result["iau_price"] = round(float(iau_closes.iloc[-1]), 2)
                result["iau_prev_close"] = round(float(iau_closes.iloc[-2]), 2)
                iau_pct = (iau_closes.iloc[-1] / iau_closes.iloc[-2] - 1) * 100
                result["iau_change_pct"] = round(float(iau_pct), 2)
    
        # --- PE 分位（用 SPY 价格/收益 简化代理：价格水位的百分位排名）---
        df_spy = raw.get("SPY")
        if df_spy is not None and not df_spy.empty and len(df_spy) > 20:
            spy_closes = df_spy["Close"].dropna()
            if len(spy_closes) > 20:
                cur_spy = float(spy_closes.iloc[-1])
                # 10 年分位：使用全部可用数据
                result["pe_10y_pctile"] = round(float((spy_closes <= cur_spy).sum()) / len(spy_closes), 4)
                # 3 年分位：截取最近 ~756 个交易日
                spy_3y = spy_closes.iloc[-756:] if len(spy_closes) > 756 else spy_closes
                result["pe_3y_pctile"] = round(float((spy_3y <= cur_spy).sum()) / len(spy_3y), 4)
    
        # --- 月投合成信号 S 的 3 年中位数（用于 M 计算）---
        # 简化：用当前 S 的组成因子估算历史中位，实际中 S ≈ 0.5 附近波动
        result["vix_3y_median_s"] = 0.5
    
        _quantile_cache["date"] = today_str
        _quantile_cache["data"] = result
        # 写入文件缓存，服务重启后可直接读取，无需重新拉取
        try:
            save_json(QUANTILE_CACHE_FILE, {"date": today_str, "data": result})
        except Exception:
            pass
        return result


# ---------- 1.2 风险预算 R → RR → K → T ----------

def _get_settings():
    """从 model_state 读取可调参数，不存在时返回默认值。"""
    state = load_json(MODEL_STATE_FILE, {})
    s = state.get("settings", {})
    return {
        "K_MAX_CAP": s.get("K_MAX_CAP", 0.12),
        "MONTHLY_BASE_OVERRIDE": s.get("MONTHLY_BASE_OVERRIDE", MONTHLY_BASE),
        "m1_vix_threshold": s.get("m1_vix_threshold", 18),
        "m2_vix_threshold": s.get("m2_vix_threshold", 22),
        "m3_vix_threshold": s.get("m3_vix_threshold", 50),
        "qqqm_soft_pct": s.get("qqqm_soft_pct", 70),
        "qqqm_hard_pct": s.get("qqqm_hard_pct", 85),
        "insurance_budget_pct": s.get("insurance_budget_pct", 0.02),
        "dividend_withholding_rate": s.get(
            "dividend_withholding_rate", DEFAULT_DIVIDEND_WITHHOLDING_RATE),
        "dividend_reinvest_offset_bd": s.get(
            "dividend_reinvest_offset_bd", DEFAULT_DIVIDEND_REINVEST_OFFSET_BD),
    }


def compute_risk_budget(qe, reserve_pool, year_max_reserve, trigger_level=None):
    """
    天府 v1.3.1 风险预算：T = year_max_reserve * min(K, 0.12)。
    trigger_level: "M1"/"M2"/"M3"/None，M1 时 K 固定 0.05。
    """
    settings = _get_settings()
    qqqm_drop_pctile = qe.get("qqqm_drop_3y_pctile") or 0
    vix_pctile = qe.get("vix_3y_pctile") or 0

    R = max(0, min(1, 0.6 * qqqm_drop_pctile + 0.4 * vix_pctile))

    S_ema = 1.1 if qe.get("qqqm_above_ema200") else 0.9
    RR = max(0, min(1, R * S_ema))

    if trigger_level == "M1":
        K = 0.05
    elif RR < 0.25:
        K = 0.05
    elif RR < 0.7:
        K = 0.10
    else:
        q = max(0.5, min(1.0, 0.5 + 0.5 * vix_pctile))
        K = (0.1 + 0.1 * RR) * q

    K = min(K, settings["K_MAX_CAP"])

    T = year_max_reserve * min(K, 0.12)
    T = min(T, reserve_pool)

    return {
        "R": round(R, 4), "S_ema": S_ema, "RR": round(RR, 4),
        "K": round(K, 4), "T": round(T, 2),
    }


# ---------- 1.3 触发判断引擎 ----------

def evaluate_triggers(qe, model_state, reserve_pool, year_max_reserve, trades_list):
    """
    天府 v1.3.1 触发判断：M1/M2/M3/IAU（移除 M4/QLD）。
    M1: VIX<18 且跌>=2%  M2: VIX>=22 立即触发  M3: VIX>50 年度1次QQQM
    """
    settings = _get_settings()
    vix = qe.get("vix_price") or 0
    qqqm_price = qe.get("qqqm_price") or 0
    qqqm_chg = qe.get("qqqm_change_pct") or 0
    iau_chg = qe.get("iau_change_pct") or 0

    stats = _toundan_stats_from_trades(trades_list)
    monthly = stats["monthly_count"]
    daily_count = stats["daily_count"]

    qqqm_month_ok = monthly.get("QQQM", 0) < 2
    qqqm_day_ok = daily_count.get("QQQM", 0) < 1
    iau_month_ok = monthly.get("IAU", 0) < 1
    iau_day_ok = daily_count.get("IAU", 0) < 1

    triggers = {}

    def _status(triggered, month_ok, day_ok):
        if not month_ok:
            return "month_exhausted"
        if triggered and not day_ok:
            return "day_exhausted"
        if triggered and month_ok and day_ok:
            return "can_fire"
        return "idle"

    # --- M1: VIX < 18 且 QQQM 单日跌幅 <= -2% ---
    m1_vix = settings["m1_vix_threshold"]
    m1_threshold = qe.get("qqqm_prev_close", 0) * 0.98 if qe.get("qqqm_prev_close") else 0
    m1_triggered = vix < m1_vix and qqqm_chg <= -2.0
    m1_budget = compute_risk_budget(qe, reserve_pool, year_max_reserve, trigger_level="M1")
    m1_can = m1_triggered and qqqm_month_ok and qqqm_day_ok
    m1_status = _status(m1_triggered, qqqm_month_ok, qqqm_day_ok)
    distance_m1 = round((qqqm_price / m1_threshold - 1) * 100, 2) if m1_threshold > 0 else None
    triggers["M1"] = {
        "triggered": m1_triggered, "can_fire": m1_can, "status": m1_status,
        "condition": f"VIX<{m1_vix}（当前{vix}）且单日跌幅≤-2%（当前{qqqm_chg}%）",
        "threshold_price": round(m1_threshold, 2),
        "distance_pct": distance_m1,
        "K": m1_budget["K"], "T": m1_budget["T"],
    }

    # --- M2: VIX >= 22 立即触发（简化：不再依赖价格条件）---
    m2_vix = settings["m2_vix_threshold"]
    m2_triggered = vix >= m2_vix
    m2_budget = compute_risk_budget(qe, reserve_pool, year_max_reserve, trigger_level="M2")
    m2_can = m2_triggered and qqqm_month_ok and qqqm_day_ok
    m2_status = _status(m2_triggered, qqqm_month_ok, qqqm_day_ok)
    triggers["M2"] = {
        "triggered": m2_triggered, "can_fire": m2_can, "status": m2_status,
        "condition": f"VIX≥{m2_vix}（当前{vix}）",
        "threshold_price": None,
        "distance_pct": None,
        "K": m2_budget["K"], "T": m2_budget["T"],
    }

    # --- M3: VIX > 50，年度 1 次买 QQQM（不平仓、不占 M1/M2 月度次数）---
    m3_vix = settings["m3_vix_threshold"]
    m3_used = stats["yearly_m3_used"]
    m3_triggered = vix > m3_vix
    m3_budget = compute_risk_budget(qe, reserve_pool, year_max_reserve, trigger_level="M3")
    m3_can = m3_triggered and not m3_used
    m3_status = "year_exhausted" if m3_used else ("can_fire" if m3_triggered else "idle")
    triggers["M3"] = {
        "triggered": m3_triggered, "can_fire": m3_can, "status": m3_status,
        "condition": f"VIX>{m3_vix}（当前{vix}），年度1次QQQM",
        "threshold_price": None,
        "distance_pct": None,
        "K": m3_budget["K"], "T": m3_budget["T"],
        "yearly_used": m3_used,
    }

    # --- IAU: 单日跌幅 <= -5% ---
    iau_threshold = qe.get("iau_prev_close", 0) * 0.95 if qe.get("iau_prev_close") else 0
    iau_triggered = iau_chg <= -5.0
    iau_budget = compute_risk_budget(qe, reserve_pool, year_max_reserve, trigger_level="M1")
    iau_can = iau_triggered and iau_month_ok and iau_day_ok
    iau_status = _status(iau_triggered, iau_month_ok, iau_day_ok)
    distance_iau = round((qe.get("iau_price", 0) / iau_threshold - 1) * 100, 2) if iau_threshold > 0 else None
    triggers["IAU"] = {
        "triggered": iau_triggered, "can_fire": iau_can, "status": iau_status,
        "condition": f"IAU单日跌幅≤-5%（当前{iau_chg}%）",
        "threshold_price": round(iau_threshold, 2),
        "distance_pct": distance_iau,
        "K": iau_budget["K"], "T": iau_budget["T"],
    }

    triggers["_constraints"] = {
        "qqqm_monthly_count": monthly.get("QQQM", 0),
        "qqqm_monthly_limit": 2,
        "iau_monthly_count": monthly.get("IAU", 0),
        "iau_monthly_limit": 1,
        "qqqm_today_count": daily_count.get("QQQM", 0),
        "iau_today_count": daily_count.get("IAU", 0),
    }

    THRESHOLD_CRITICAL = 1.0
    for lv in ["M1", "M2", "M3", "IAU"]:
        t = triggers.get(lv, {})
        dist = t.get("distance_pct")
        is_near = (t.get("status") == "idle"
                   and dist is not None
                   and 0 < dist <= THRESHOLD_CRITICAL)
        t["near_critical"] = is_near

    return triggers


# ---------- 1.4 月投倍率 S / M（v1.3.1: 去掉 RRF，S_median 滚动 36 月）----------

def compute_monthly_multiplier(qe, reserve_pool, has_toundan_this_month, model_state):
    """
    v1.3.1: 计算合成信号 S、滚动 36 月 S_median、月投倍率 M。
    移除 RRF（不再使用 ^TNX）。M 范围扩展至 [0.25, 2.0]。
    倍投上限 2000。
    """
    pe_10y = qe.get("pe_10y_pctile") or 0.5
    pe_3y = qe.get("pe_3y_pctile") or 0.5
    vix_3y = qe.get("vix_3y_pctile") or 0.5
    ema200_dev = qe.get("ema200_deviation_3y_pctile") or 0.5
    ema20_dev = qe.get("ema20_deviation_3y_pctile") or 0.5

    S = (0.20 * (1 - pe_10y)
         + 0.15 * (1 - pe_3y)
         + 0.45 * vix_3y
         + 0.10 * (1 - ema200_dev)
         + 0.10 * (1 - ema20_dev))

    # 滚动 36 月 S 中位数（从 model_state.s_history 读取）
    s_history = model_state.get("s_history", [])
    if len(s_history) >= 2:
        sorted_s = sorted(entry["value"] for entry in s_history)
        mid = len(sorted_s) // 2
        s_median = (sorted_s[mid] + sorted_s[mid - 1]) / 2 if len(sorted_s) % 2 == 0 else sorted_s[mid]
    else:
        s_median = 0.5

    M = max(0.25, min(2.0, 1 + 2 * (S - s_median)))

    settings = _get_settings()
    base = settings["MONTHLY_BASE_OVERRIDE"]
    monthly_amount = round(base * M, 2)

    # 备弹池倍投：当月无投弹时翻倍，翻倍部分最多 2000 且不超过备弹池
    double_up_amount = 0.0
    double_up_from_reserve = False
    if not has_toundan_this_month:
        extra = min(monthly_amount, 2000, reserve_pool)
        if extra > 0:
            double_up_amount = round(extra, 2)
            double_up_from_reserve = True

    return {
        "S": round(S, 4), "S_median": round(s_median, 4), "M": round(M, 4),
        "monthly_amount": monthly_amount,
        "double_up_amount": double_up_amount,
        "double_up_from_reserve": double_up_from_reserve,
        "total_invest": round(monthly_amount + double_up_amount, 2),
    }


# ---------- 1.5 Put 保险引擎（v1.3.1 新增）----------

def _compute_insurance(qe, model_state, total_value):
    """
    Put 保险：VIX<12 时建议开仓，3 阶段止盈，DTE<30 天滚仓提醒。
    返回当前保险状态（用于信号页展示），同时更新 model_state。
    """
    settings = _get_settings()
    vix = qe.get("vix_price") or 0
    put_pos = model_state.get("put_position")
    annual_spent = model_state.get("annual_premium_spent", 0)
    budget_pct = settings["insurance_budget_pct"]
    annual_budget = total_value * budget_pct if total_value > 0 else 0

    result = {
        "has_position": put_pos is not None,
        "position": put_pos,
        "annual_budget": round(annual_budget, 2),
        "annual_spent": round(annual_spent, 2),
        "budget_utilization": round(annual_spent / annual_budget * 100, 1) if annual_budget > 0 else 0,
        "action": None,
        "action_detail": None,
    }

    if put_pos is None:
        # 开仓条件：VIX < 12 且年度预算未超支
        if vix < 12 and annual_spent < annual_budget:
            remaining_budget = annual_budget - annual_spent
            suggested_premium = min(remaining_budget * 0.25, total_value * 0.005)
            result["action"] = "open"
            result["action_detail"] = {
                "reason": f"VIX={vix} < 12，低波动窗口适合买入 Put 保护",
                "suggested_premium": round(suggested_premium, 2),
                "suggested_strike": "SPY ATM -5%",
                "suggested_dte": "90-120 天",
            }
    else:
        dte = put_pos.get("dte", 0)
        entry_cost = put_pos.get("entry_cost", 0)
        current_value = put_pos.get("current_value", entry_cost)
        pnl_pct = ((current_value / entry_cost) - 1) * 100 if entry_cost > 0 else 0

        result["position_pnl_pct"] = round(pnl_pct, 1)

        # 3 阶段止盈
        if pnl_pct >= 100:
            result["action"] = "close_full"
            result["action_detail"] = {"reason": f"盈利 {pnl_pct:.0f}% >= 100%，建议全部平仓锁利"}
        elif pnl_pct >= 75:
            result["action"] = "close_75"
            result["action_detail"] = {"reason": f"盈利 {pnl_pct:.0f}% >= 75%，建议平仓 75%"}
        elif pnl_pct >= 50:
            result["action"] = "close_50"
            result["action_detail"] = {"reason": f"盈利 {pnl_pct:.0f}% >= 50%，建议平仓 50%"}
        elif dte <= 30:
            result["action"] = "roll"
            result["action_detail"] = {"reason": f"DTE={dte} <= 30 天，建议滚仓至远月"}

    return result


# ---------- 1.6 重构 /api/signals ----------

@app.route("/api/signals", methods=["GET"])
def api_signals():
    """
    天府 v1.3.1 决策信号中心。
    合并分位数引擎、风险预算、触发判断、月投倍率、渐进熔断、仓位风控、Put 保险。
    """
    from calendar import monthrange
    import math

    trades_list = get_trades()
    model_state = load_model_state()
    settings = _get_settings()

    # 当前持仓与占比（先算持仓，再用 BOXX 市值驱动备弹池）
    symbols = get_all_symbols(trades_list)
    perf_sig = None
    pix_sig = None
    if not symbols:
        history_cache = {}
        effective_end_date = datetime.now().strftime("%Y-%m-%d")
    else:
        dt = datetime.now()
        start_fetch, end_fetch = _compute_fetch_range(trades_list)
        history_cache, bench_cache_sig, trading_dates = fetch_histories_with_bench(symbols, start_fetch, end_fetch)
        effective_end_date = trading_dates[-1] if trading_dates else dt.strftime("%Y-%m-%d")
        perf_sig = build_perf_bundle(trades_list, history_cache, bench_cache_sig, trading_dates)
        pix_sig = perf_sig["price_index"]

    pos = positions_at_date(
        trades_list, effective_end_date,
        (perf_sig or {}).get("position_timeline"),
        (perf_sig or {}).get("timeline_dates"),
    )
    total_value = 0.0
    qqqm_value = 0.0
    risk_value = 0.0
    CASH_TICKERS = {"BOXX"}
    sym_values = {}
    for sym, qty in pos.items():
        p = get_price_on_date(sym, effective_end_date, history_cache, pix_sig)
        if p is None:
            p = 0.0
        v = qty * p
        total_value += v
        sym_values[sym.upper()] = v
        if sym.upper() not in CASH_TICKERS:
            risk_value += v
        if sym.upper() == "QQQM":
            qqqm_value += v

    # ===== 备弹池（现金流恒等式：总入金 - 月投净买入 - 投弹净买入）=====
    fund_records_sig = get_fund_records()
    rp_info = compute_reserve_pool(trades_list, fund_records=fund_records_sig)
    reserve_pool = rp_info["reserve_pool"]
    year_max_reserve = rp_info["year_max_reserve"]
    total_toundan_used = rp_info["total_toundan_used"]
    qqqm_ratio = (qqqm_value / risk_value * 100) if risk_value > 0 else 0

    # ===== 分位数引擎 =====
    qe = compute_quantile_engine()

    # ===== 风险预算 =====
    risk_budget = compute_risk_budget(qe, reserve_pool, year_max_reserve)

    # ===== 触发判断 =====
    triggers = evaluate_triggers(qe, model_state, reserve_pool, year_max_reserve, trades_list)

    # ===== 月投倍率 =====
    td_stats = _toundan_stats_from_trades(trades_list)
    has_toundan = td_stats["monthly_count"].get("QQQM", 0) > 0 or \
                  td_stats["monthly_count"].get("IAU", 0) > 0
    monthly_signal = compute_monthly_multiplier(qe, reserve_pool, has_toundan, model_state)

    # ===== 下次定投（渐进熔断 v1.3.1）=====
    now = datetime.now()
    _, last_day = monthrange(now.year, now.month)
    next_ding_date = f"{now.year}-{now.month:02d}-{last_day}"
    if now.day >= last_day:
        next_m = now.month + 1 if now.month < 12 else 1
        next_y = now.year if now.month < 12 else now.year + 1
        _, last_day = monthrange(next_y, next_m)
        next_ding_date = f"{next_y}-{next_m:02d}-{last_day}"

    M_amount = monthly_signal["monthly_amount"]

    # 渐进熔断：70%~85% 线性 fade
    soft_pct = settings["qqqm_soft_pct"]
    hard_pct = settings["qqqm_hard_pct"]
    if qqqm_ratio <= soft_pct:
        fade = 0.0
    elif qqqm_ratio >= hard_pct:
        fade = 1.0
    else:
        fade = (qqqm_ratio - soft_pct) / (hard_pct - soft_pct)
    fuse_active = fade > 0

    # 线性混合：正常 60/25/15 <-> 熔断 BRK-B+IAU 按 2.5:1.5（即 62.5/37.5）
    qqqm_pct = 60 * (1 - fade)
    brk_pct = 25 * (1 - fade) + 62.5 * fade
    iau_pct = 15 * (1 - fade) + 37.5 * fade
    ding_allocation = []
    if qqqm_pct > 0.5:
        ding_allocation.append({"symbol": "QQQM", "pct": round(qqqm_pct, 1),
                                "amount": round(M_amount * qqqm_pct / 100, 2)})
    ding_allocation.append({"symbol": "BRK.B", "pct": round(brk_pct, 1),
                            "amount": round(M_amount * brk_pct / 100, 2)})
    ding_allocation.append({"symbol": "IAU", "pct": round(iau_pct, 1),
                            "amount": round(M_amount * iau_pct / 100, 2)})

    next_dingtou = {
        "date": next_ding_date,
        "total_usd": round(M_amount, 2),
        "description": f"每月定投（月末），倍率 M={monthly_signal['M']}",
        "allocation": ding_allocation,
        "fuse_active": fuse_active,
        "fade": round(fade, 3),
    }

    # ===== 投弹预估 =====
    toundan_estimate = []
    for lv, sym in [("M1", "QQQM"), ("M2", "QQQM"), ("M3", "QQQM"), ("IAU", "IAU")]:
        tr_item = triggers[lv]
        T_val = tr_item["T"]
        latest_p = qe.get("qqqm_price") if sym == "QQQM" else qe.get("iau_price")
        shares = round(math.ceil(T_val / latest_p * 10) / 10, 1) if latest_p and latest_p > 0 else 0
        order_text = f"[天府计划] {lv}触发：买入 {sym} @ ${latest_p}，数量 {shares}股，额度 ${T_val:,.2f}" if latest_p else ""
        toundan_estimate.append({
            "symbol": sym, "level": lv,
            "condition": tr_item["condition"],
            "k": tr_item["K"], "max_usd": T_val,
            "triggered": tr_item["triggered"], "can_fire": tr_item["can_fire"],
            "status": tr_item["status"], "near_critical": tr_item.get("near_critical", False),
            "latest_price": latest_p, "shares_to_buy": shares, "order_text": order_text,
        })

    # ===== 大盘现状 =====（并行拉取，降低串行 Yahoo 延迟）
    market_syms = ("QQQ", "^VIX", "GLD", "^TNX")
    market_overview = []
    results_mkt = {}
    with ThreadPoolExecutor(max_workers=4) as ex:
        future_to_sym = {ex.submit(fetch_realtime_quote, s): s for s in market_syms}
        for fut in as_completed(future_to_sym):
            sym = future_to_sym[fut]
            try:
                q = fut.result()
                if q:
                    results_mkt[sym] = q
            except Exception:
                pass
    for sym in market_syms:
        if sym in results_mkt:
            market_overview.append(results_mkt[sym])

    # ===== 仓位风控 =====
    if qqqm_ratio < 35:
        model_state["qqqm_below_35pct_days"] = model_state.get("qqqm_below_35pct_days", 0) + 1
    else:
        model_state["qqqm_below_35pct_days"] = 0

    rebalance_alert = None
    if model_state.get("qqqm_below_35pct_days", 0) >= 3:
        rebalance_alert = {
            "type": "downside_rebalance",
            "message": "QQQM 占比连续 3 日低于 35%，建议卖出 BRK.B/IAU 补足 QQQM 至 60:25:15",
            "days_below": model_state["qqqm_below_35pct_days"],
            "current_ratio": round(qqqm_ratio, 1),
        }

    reserve_health_pct = round(reserve_pool / total_value * 100, 1) if total_value > 0 else 0
    next_estimated_T = risk_budget["T"]
    reserve_warning = reserve_pool < next_estimated_T or reserve_pool < monthly_signal.get("double_up_amount", 0)

    position_alerts = {
        "qqqm_ratio": round(qqqm_ratio, 1),
        "fuse_active": fuse_active,
        "fade": round(fade, 3),
        "soft_pct": soft_pct,
        "hard_pct": hard_pct,
        "rebalance_alert": rebalance_alert,
        "reserve_health_pct": reserve_health_pct,
        "reserve_warning": reserve_warning,
    }

    # ===== history_7d 追踪 S 和 RR =====
    today_str_h = datetime.now().strftime("%Y-%m-%d")
    h7 = model_state.get("history_7d", {"S": [], "RR": []})
    if not isinstance(h7, dict):
        h7 = {"S": [], "RR": []}
    for key, val in [("S", monthly_signal.get("S")), ("RR", risk_budget.get("RR"))]:
        entries = h7.get(key, [])
        if not entries or entries[-1].get("date") != today_str_h:
            entries.append({"date": today_str_h, "value": val})
        else:
            entries[-1]["value"] = val
        h7[key] = entries[-7:]
    model_state["history_7d"] = h7

    # ===== S 历史（滚动 36 月中位数）=====
    cur_month_str = now.strftime("%Y-%m")
    s_history = model_state.get("s_history", [])
    if not s_history or s_history[-1].get("month") != cur_month_str:
        s_history.append({"month": cur_month_str, "value": monthly_signal["S"]})
    else:
        s_history[-1]["value"] = monthly_signal["S"]
    model_state["s_history"] = s_history[-36:]

    # ===== 备弹池消耗速率预测（输出预计支撑至日期，最晚 12/31）=====
    cutoff_90d = (now - timedelta(days=90)).strftime("%Y-%m-%d")
    recent_toundan_amount = sum(
        float(t.get("price", 0)) * float(t.get("shares", 0))
        for t in trades_list
        if (t.get("type") or "") == "投弹" and (t.get("date") or "") >= cutoff_90d
    )
    forecast_date = None
    if recent_toundan_amount > 0:
        daily_burn = recent_toundan_amount / 90.0
        days_remaining = round(reserve_pool / daily_burn) if daily_burn > 0 else None
        if days_remaining is not None:
            raw_date = now + timedelta(days=days_remaining)
            year_end = now.replace(month=12, day=31)
            capped = min(raw_date, year_end)
            forecast_date = f"{capped.month}月{capped.day}日"
    else:
        daily_burn = 0
        days_remaining = None
    position_alerts["reserve_forecast"] = {
        "daily_burn_rate": round(daily_burn, 2),
        "days_remaining": days_remaining,
        "forecast_date": forecast_date,
    }

    # ===== Put 保险 =====
    insurance = _compute_insurance(qe, model_state, total_value)

    # 持久化状态
    save_model_state(model_state)

    single_T = risk_budget["T"] if risk_budget["T"] > 0 else 1
    max_toundan_times = int(reserve_pool / single_T) if single_T > 0 else 0

    return jsonify({
        "model_name": "天府 v1.3.1",
        "version": "1.3.1",
        "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "computed_at": datetime.now().isoformat(),
        "market_overview": market_overview,
        "next_dingtou": next_dingtou,
        "toundan_estimate": toundan_estimate,
        "reserve_pool": round(reserve_pool, 2),
        "year_max_reserve": round(year_max_reserve, 2),
        "total_toundan_used": round(total_toundan_used, 2),
        "total_injected": rp_info["total_injected"],
        "max_toundan_times": max_toundan_times,
        "quantile_engine": qe,
        "risk_budget": risk_budget,
        "triggers": triggers,
        "monthly_signal": monthly_signal,
        "position_alerts": position_alerts,
        "history_7d": h7,
        "insurance": insurance,
    })


@app.route("/api/strategy-review", methods=["GET"])
def api_strategy_review():
    """
    策略复盘：纪律分、Alpha、投弹效率、资金安全系数、备弹池消耗率、AI 反思结论。
    ?period=1m|3m|all
    """
    period = request.args.get("period", "all")
    dt = datetime.now()
    if period == "1m":
        cutoff = dt.replace(day=1).strftime("%Y-%m-%d")
    elif period == "3m":
        quarter_month = ((dt.month - 1) // 3) * 3 + 1
        cutoff = dt.replace(month=quarter_month, day=1).strftime("%Y-%m-%d")
    else:
        cutoff = "2000-01-01"
    period_label = {"1m": "本月", "3m": "本季度", "all": "全部"}.get(period, period)

    trades_list = get_trades()
    # 期间内投弹记录
    period_bombs = [
        t for t in trades_list
        if (t.get("type") or "") == "投弹" and (t.get("date") or "")[:10] >= cutoff
    ]
    total_bombs = len(period_bombs)

    # 纪律分：当前无触发日志，以实际执行率 100% 为默认
    discipline_score = 100

    # Alpha：实际 MWRR vs DCA
    symbols = get_all_symbols(trades_list)
    excess_return = 0
    dca_return = 0
    real_mwrr = 0
    real_twr = 0
    avg_cost_delta = 0
    bomb_efficiency = None
    safety_ratio = None
    burn_rate = 0

    if symbols and trades_list:
        since_date = min(t["date"][:10] for t in trades_list)
        start_f, end_f = _compute_fetch_range(trades_list)
        hc, bc, td = fetch_histories_with_bench(symbols, start_f, end_f)
        eff_end = td[-1] if td else dt.strftime("%Y-%m-%d")
        perf_sr = build_perf_bundle(trades_list, hc, bc, td)
        pix = perf_sr["price_index"]

        # 周期起点统一取 max(cutoff, since_date)，保证起点不早于第一次持仓日期；
        # 与首页 returns-overview 的 periods 定义规则一致，使两处同一周期的 DCA/MWRR 可直接对比。
        chart_start = max(cutoff, since_date)
        chart_data = compute_twr_chart(trades_list, hc, bc, chart_start, eff_end, td, perf_sr)
        if chart_data["my"]:
            real_twr = chart_data["my"][-1]
        if chart_data.get("dca"):
            dca_return = chart_data["dca"][-1]
        # 使用 MWRR 作为主指标
        fund_records = get_fund_records()
        mwrr_val = compute_mwr(trades_list, fund_records, hc, chart_start, eff_end, td, perf_sr)
        real_mwrr = mwrr_val if mwrr_val is not None else real_twr
        excess_return = round(real_mwrr - dca_return, 2)

        # 投弹效率：QQQM 投弹均价 vs 期间 QQQM 最低价
        qqqm_bombs = [t for t in period_bombs if (t.get("symbol") or "").upper() == "QQQM"]
        if qqqm_bombs:
            avg_bomb_price = sum(float(t.get("price", 0)) for t in qqqm_bombs) / len(qqqm_bombs)
            # 最低价范围取投弹交易日区间（首笔到末笔），而非整个筛选期间
            bomb_dates = sorted((t.get("date") or "")[:10] for t in qqqm_bombs)
            bomb_start = bomb_dates[0]
            bomb_end = bomb_dates[-1]
            dates_in = [d for d in td if bomb_start <= d <= bomb_end]
            if dates_in:
                lows = [get_price_on_date("QQQM", d, hc, pix) for d in dates_in]
                lows = [p for p in lows if p and p > 0]
                period_low = min(lows) if lows else avg_bomb_price
                bomb_efficiency = round((avg_bomb_price / period_low - 1) * 100, 2) if period_low > 0 else None

        # 资金安全系数：备弹池 / 压力情景回撤金额（假设 -20% 回撤）
        pos = positions_at_date(trades_list, eff_end, perf_sr["position_timeline"], perf_sr["timeline_dates"])
        rp_info = compute_reserve_pool(trades_list, fund_records=fund_records)
        reserve_pool = rp_info["reserve_pool"]
        tv = sum((get_price_on_date(s, eff_end, hc, pix) or 0) * q for s, q in pos.items())
        max_dd_amount = tv * 0.15 if tv > 0 else 1
        safety_ratio = round(reserve_pool / max_dd_amount, 2) if max_dd_amount > 0 else None

        # 备弹池消耗率（分母为年度注入累计）
        period_toundan_amount = sum(
            float(t.get("price", 0)) * float(t.get("shares", 0)) for t in period_bombs
        )
        total_injected = rp_info["total_injected"]
        burn_rate = round(period_toundan_amount / total_injected * 100, 1) if total_injected > 0 else 0

    # ===== 配置一致性 / 合规分（Drift）=====
    compliance_score = 100
    max_drift = 0
    avg_drift = 0
    CASH_TICKERS = {"BOXX"}
    TARGET_PCT = {"QQQM": 60, "BRK.B": 25, "IAU": 15}
    qqqm_max_pct = 0
    if symbols and trades_list:
        pos_now = positions_at_date(trades_list, eff_end, perf_sr["position_timeline"], perf_sr["timeline_dates"])
        risk_val = sum((get_price_on_date(s, eff_end, hc, pix) or 0) * q for s, q in pos_now.items() if s.upper() not in CASH_TICKERS)
        if risk_val > 0:
            drifts = []
            for sym in TARGET_PCT:
                qty = pos_now.get(sym, 0)
                p = get_price_on_date(sym, eff_end, hc, pix) or 0
                eff_pct = qty * p / risk_val * 100 if risk_val > 0 else 0
                drift = abs(eff_pct - TARGET_PCT[sym])
                drifts.append(drift)
                if sym == "QQQM":
                    qqqm_max_pct = round(eff_pct, 1)
            max_drift = round(max(drifts) if drifts else 0, 1)
            avg_drift = round(sum(drifts) / len(drifts) if drifts else 0, 1)
            compliance_score = max(0, round(100 - max_drift * 2))

    # VIX 环境（v1.3.1: M2 阈值 22）
    qe_data = compute_quantile_engine()
    vix_now = qe_data.get("vix_price") or 0
    vix_env = "低波动" if vix_now < 18 else ("中等波动" if vix_now < 22 else "高波动")

    # ===== AI 反思结论（归因分析风格）=====
    parts = []
    # 纪律维度
    if discipline_score >= 100:
        parts.append("执行纪律完美")
    elif discipline_score >= 90:
        parts.append(f"执行纪律良好（{discipline_score}%）")
    else:
        parts.append(f"执行力偏差（{discipline_score}%），建议启用强提醒或自动化脚本")

    # 超额收益归因
    if excess_return > 0.5:
        parts.append(f"策略跑赢纯定投 +{excess_return}%")
        if total_bombs > 0 and bomb_efficiency is not None and bomb_efficiency < 5:
            parts.append("超额收益主要由投弹策略在{}环境下精准出击贡献".format(vix_env))
    elif excess_return < -0.5:
        parts.append(f"策略暂落后纯定投 {excess_return}%，投弹成本优化空间较大")
    else:
        parts.append("策略与纯定投收益接近，投弹尚未产生显著差异")

    # 投弹效率
    if bomb_efficiency is not None:
        if bomb_efficiency < 3:
            parts.append("投弹精准（偏离最低价仅 {:.1f}%）".format(bomb_efficiency))
        elif bomb_efficiency < 8:
            parts.append("投弹效率良好（偏离 {:.1f}%）".format(bomb_efficiency))
        else:
            parts.append("投弹偏离较大（{:.1f}%），可优化入场时机".format(bomb_efficiency))

    # 弹药消耗
    if burn_rate > 70:
        parts.append("弹药消耗过快（{:.0f}%），建议下调 K 值或增加备弹".format(burn_rate))
    elif burn_rate > 40:
        parts.append("弹药消耗适中（{:.0f}%）".format(burn_rate))

    # 合规与集中度
    if qqqm_max_pct > 55:
        settings = _get_settings()
        parts.append(f"注意：QQQM 风险敞口达 {qqqm_max_pct}%，逼近 {settings['qqqm_soft_pct']}% 渐进缩减起始线 / {settings['qqqm_hard_pct']}% 硬停线，关注组合集中度风险")
    if max_drift > 15:
        parts.append(f"配置偏离较大（最大偏离 {max_drift}%），建议适时再平衡")

    # 资金安全
    if safety_ratio is not None and safety_ratio < 1.5:
        parts.append("资金安全系数偏低（{:.1f}×），需提高月投基数或减少高阶投弹额度".format(safety_ratio))

    conclusion = "。".join(parts) + "。"

    # ===== 参数建议（指令 A 增强逻辑）=====
    suggestions = []
    if discipline_score < 90:
        suggestions.append({"type": "discipline", "priority": "high",
            "text": "执行力偏差是当前最大的风险点，建议启用「自动投弹脚本」或设置「强提醒」"})
    if burn_rate > 50 and bomb_efficiency is not None and bomb_efficiency < 0.5:
        suggestions.append({"type": "k_force_down", "priority": "high",
            "text": "投弹过于频繁且未能有效拉低均价，建议强制下调 K 封顶值"})
    elif burn_rate > 50:
        suggestions.append({"type": "k_down", "priority": "medium",
            "text": f"备弹消耗率 {burn_rate}%，建议适度下调 K 封顶值"})
    if safety_ratio is not None and safety_ratio < 1.5:
        suggestions.append({"type": "safety", "priority": "high",
            "text": f"资金安全系数仅 {safety_ratio}×，需提高月投基数或减少 M3 等高阶投弹额度"})

    settings = _get_settings()

    return jsonify({
        "period": period,
        "period_label": period_label,
        "discipline_score": discipline_score,
        "total_bombs": total_bombs,
        "excess_return": excess_return,
        "real_mwrr": round(real_mwrr, 2),
        "real_twr": round(real_twr, 2),
        "dca_return": round(dca_return, 2),
        "bomb_efficiency": bomb_efficiency,
        "safety_ratio": safety_ratio,
        "burn_rate": burn_rate,
        "compliance_score": compliance_score,
        "max_drift": max_drift,
        "avg_drift": avg_drift,
        "qqqm_risk_pct": qqqm_max_pct,
        "vix_env": vix_env,
        "conclusion": conclusion,
        "suggestions": suggestions,
        "settings": settings,
    })


@app.route("/api/update-settings", methods=["POST"])
def api_update_settings():
    """更新可调参数，写入 model_state.json。"""
    data = request.get_json() or {}
    state = load_model_state()
    s = state.get("settings", {})
    param_rules = {
        "K_MAX_CAP":                   (0.01, 0.5),
        "MONTHLY_BASE_OVERRIDE":       (500, 10000),
        "m1_vix_threshold":            (10, 30),
        "m2_vix_threshold":            (15, 40),
        "m3_vix_threshold":            (30, 80),
        "qqqm_soft_pct":               (40, 90),
        "qqqm_hard_pct":               (50, 95),
        "insurance_budget_pct":        (0.005, 0.05),
        "dividend_withholding_rate":   (0.0, 0.5),
        "dividend_reinvest_offset_bd": (0, 10),
    }
    int_keys = {"dividend_reinvest_offset_bd"}
    for key, (lo, hi) in param_rules.items():
        if key in data:
            try:
                v = float(data[key])
                v = max(lo, min(hi, v))
                s[key] = int(round(v)) if key in int_keys else v
            except (TypeError, ValueError):
                pass
    state["settings"] = s
    save_model_state(state)
    return jsonify({"ok": True, "settings": s})


@app.route("/api/stress-test", methods=["GET"])
def api_stress_test():
    """
    压力测试：模拟 QQQ 单月 -20%、VIX 飙升至 40 场景下，
    按当前投弹逻辑（M1~M3 连续触发）计算组合总回撤与现金占用。
    同时基于过去 5 年日收益数据，蒙特卡洛模拟未来 30 天收益概率分布（95% CI）。
    """
    try:
        import numpy as np
    except ImportError:
        return jsonify({"error": "numpy 未安装"}), 500

    trades_list = get_trades()
    symbols = get_all_symbols(trades_list)

    if not symbols:
        return jsonify({"stress": None, "monte_carlo": None})

    dt = datetime.now()
    start_fetch, end_fetch = _compute_fetch_range(trades_list)
    history_cache, bench_cache, trading_dates = fetch_histories_with_bench(symbols, start_fetch, end_fetch)
    effective_end_date = trading_dates[-1] if trading_dates else dt.strftime("%Y-%m-%d")

    perf_st = build_perf_bundle(trades_list, history_cache, bench_cache, trading_dates)
    pos = positions_at_date(
        trades_list, effective_end_date,
        perf_st["position_timeline"], perf_st["timeline_dates"],
    )
    prices_now = prices_at(list(pos.keys()), history_cache, effective_end_date, perf_st["price_index"])

    fund_records_st = get_fund_records()
    rp_info = compute_reserve_pool(trades_list, fund_records=fund_records_st)
    reserve_pool = rp_info["reserve_pool"]
    year_max_reserve = rp_info["year_max_reserve"]
    v_now = portfolio_value_with_prices(pos, prices_now)

    # ===== 压力测试：QQQ -20%，VIX=40 =====
    # 估算各标的在此极端场景下的跌幅（基于历史 beta 近似）
    # QQQM 与 QQQ 高度相关 → -20%；BRK.B 防御 → ~-8%；IAU 避险 → +3%；VIG → -12%；IVV → -15%；BOXX → 0%
    stress_shocks = {
        "QQQM": -0.20, "QQQ": -0.20, "BRK.B": -0.08, "BRK-B": -0.08,
        "IAU": 0.03, "VIG": -0.12, "IVV": -0.15, "BOXX": 0.0,
    }
    default_shock = -0.15

    v_stressed = 0.0
    stress_detail = []
    for sym, qty in pos.items():
        p = prices_now.get(sym) or 0
        shock = stress_shocks.get(sym.upper(), default_shock)
        p_stressed = p * (1 + shock)
        val_before = qty * p
        val_after = qty * p_stressed
        stress_detail.append({
            "symbol": sym, "shock_pct": round(shock * 100, 1),
            "value_before": round(val_before, 2), "value_after": round(val_after, 2),
        })
        v_stressed += val_after

    portfolio_drawdown_pct = round((1 - v_stressed / v_now) * 100, 1) if v_now > 1e-6 else 0.0

    # 投弹逻辑模拟（v1.3.1）：T = year_max_reserve * min(K, 0.12)
    toundan_rounds = [
        {"level": "M1", "k": 0.05},
        {"level": "M2", "k": 0.10},
        {"level": "M3", "k": 0.12},
    ]
    remaining_pool = reserve_pool
    total_cash_deployed = 0.0
    toundan_sim = []
    for rd in toundan_rounds:
        deploy = min(year_max_reserve * min(rd["k"], 0.12), remaining_pool)
        toundan_sim.append({"level": rd["level"], "k": rd["k"], "deployed_usd": round(deploy, 2)})
        total_cash_deployed += deploy
        remaining_pool -= deploy

    stress_result = {
        "scenario": "QQQ 单月 -20%，VIX=40",
        "portfolio_value_before": round(v_now, 2),
        "portfolio_value_after": round(v_stressed, 2),
        "portfolio_drawdown_pct": portfolio_drawdown_pct,
        "detail": stress_detail,
        "toundan_simulation": toundan_sim,
        "total_cash_deployed": round(total_cash_deployed, 2),
        "remaining_reserve": round(remaining_pool, 2),
    }

    # ===== 蒙特卡洛：过去 5 年日收益 → 模拟 30 天 =====
    mc_result = None
    try:
        five_yr_ago = (dt - timedelta(days=5 * 365 + 30)).strftime("%Y-%m-%d")
        mc_end = (dt + timedelta(days=1)).strftime("%Y-%m-%d")
        mc_raw = _fetch_histories_raw(list(pos.keys()), five_yr_ago, mc_end)
        bench_raw = _fetch_histories_raw([BENCHMARK_SYMBOL], five_yr_ago, mc_end)

        # 计算组合历史日收益（用持仓权重加权各标的日收益）
        weights = {}
        for sym, qty in pos.items():
            p = prices_now.get(sym) or 0
            weights[sym] = qty * p / v_now if v_now > 1e-6 else 0

        # 收集各标的日收益序列
        sym_returns = {}
        all_dates_set = None
        for sym in pos.keys():
            df = mc_raw.get(sym)
            if df is None or df.empty:
                continue
            closes = df["Close"].dropna()
            if len(closes) < 10:
                continue
            rets = closes.pct_change().dropna()
            dates_idx = set(str(d)[:10] for d in rets.index)
            sym_returns[sym] = {str(d)[:10]: float(rets.loc[d]) for d in rets.index}
            all_dates_set = dates_idx if all_dates_set is None else all_dates_set & dates_idx

        if all_dates_set and len(all_dates_set) > 100:
            sorted_dates = sorted(all_dates_set)
            port_daily_returns = []
            for d in sorted_dates:
                r_day = sum(weights.get(sym, 0) * sym_returns[sym].get(d, 0.0) for sym in sym_returns)
                port_daily_returns.append(r_day)

            port_daily_returns = np.array(port_daily_returns)
            mu = float(np.mean(port_daily_returns))
            sigma = float(np.std(port_daily_returns))

            n_sims = 5000
            n_days = 30
            rng = np.random.default_rng(42)
            sim_returns = rng.normal(mu, sigma, (n_sims, n_days))
            sim_cum = np.cumprod(1 + sim_returns, axis=1)
            final_returns = (sim_cum[:, -1] - 1.0) * 100

            percentiles = [2.5, 10, 25, 50, 75, 90, 97.5]
            pct_vals = {str(p): round(float(np.percentile(final_returns, p)), 2) for p in percentiles}

            # 概率密度直方图数据
            hist_counts, hist_edges = np.histogram(final_returns, bins=40)
            hist_labels = [round(float((hist_edges[i] + hist_edges[i+1]) / 2), 1) for i in range(len(hist_counts))]
            hist_values = [int(c) for c in hist_counts]

            mc_result = {
                "n_simulations": n_sims,
                "n_days": n_days,
                "daily_mu_pct": round(mu * 100, 4),
                "daily_sigma_pct": round(sigma * 100, 4),
                "n_history_days": len(port_daily_returns),
                "percentiles": pct_vals,
                "histogram": {"labels": hist_labels, "counts": hist_values},
                "ci_95_low": pct_vals["2.5"],
                "ci_95_high": pct_vals["97.5"],
            }
    except Exception:
        mc_result = None

    return jsonify({"stress": stress_result, "monte_carlo": mc_result})


if __name__ == "__main__":
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    def _warmup_quantile():
        """後台预热：服务启动时异步拉取分位数数据和市场行情，避免首次访问等待。
        持有 _quantile_lock，使并发的首次请求等待本线程完成而非重复拉取 Yahoo。
        """
        try:
            compute_quantile_engine()
        except Exception:
            pass
        # 同步预热市场实时行情（api/signals 大盘概况区，4 并发约 3s）
        market_syms = ("QQQ", "^VIX", "GLD", "^TNX")
        try:
            with ThreadPoolExecutor(max_workers=4) as ex:
                futures = [ex.submit(fetch_realtime_quote, s) for s in market_syms]
                for f in futures:
                    try:
                        f.result()
                    except Exception:
                        pass
        except Exception:
            pass

    threading.Thread(target=_warmup_quantile, daemon=True).start()
    app.run(host="0.0.0.0", port=1001, debug=True)
