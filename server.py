# -*- coding: utf-8 -*-
"""
美股交易助手后端：持久化交易/出入金、拉取 Yahoo 股价、计算真实收益与资产配置。
运行：pip install -r requirements.txt && python server.py
"""

import json
import os
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

# 价格缓存：文件持久化，同一天内所有请求使用同一份数据，避免刷新时数据变化
PRICE_CACHE_FILE = DATA_DIR / "price_cache.json"
_CACHE_VERSION = 5  # 升级时递增，使旧缓存失效（5：收益概览拉取区间含 1y_roll 缓冲，近1年有数据）


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


def positions_at_date(trades, on_date):
    """
    计算在 on_date 当日收盘时的持仓（按标的汇总股数）。
    买入增加股数，卖出减少股数；仅统计 date <= on_date 的交易。
    """
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


def get_price_on_date(symbol, date_str, history_cache):
    """
    从已拉取的 history_cache[symbol] (DataFrame, index=Date) 中取 date_str 当日或之前最近一日的收盘价。
    """
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
    有 scipy 时使用 repair=True 尝试修正 Yahoo 的漏调/错调。
    """
    if not symbols:
        return {}
    use_repair = _yfinance_repair_available()
    out = {}
    for s in symbols:
        sy = yf_symbol(s)
        try:
            ticker = yf.Ticker(sy)
            data = ticker.history(
                start=start_date,
                end=end_date,
                auto_adjust=False,
                repair=use_repair,
            )
            out[s] = _extract_close_series(data)
        except Exception:
            out[s] = None
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


def prices_at(symbols, history_cache, date_str):
    """从 history_cache 取各标的在 date_str 当日或之前最近交易日的收盘价，返回 {symbol: float or None}。"""
    return {sym: get_price_on_date(sym, date_str, history_cache) for sym in symbols}


def compute_cost_basis(trades):
    """
    平均成本法计算各标的当前持仓的成本。
    买入时累计成本（含手续费），卖出时按比例释放成本。
    返回 {symbol: {'shares', 'avg_cost', 'total_cost'}}，只含有持仓的标的。
    """
    holdings = {}
    for t in sorted(trades, key=lambda x: (x.get("date") or "", x.get("symbol") or "")):
        sym = (t.get("symbol") or "").strip().upper()
        if not sym:
            continue
        action = t.get("action") or ""
        try:
            shares = float(t.get("shares") or 0)
            price = float(t.get("price") or 0)
            commission = float(t.get("commission") or 0)
        except (TypeError, ValueError):
            continue
        if shares <= 0:
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


def compute_twr(trades_list, history_cache, period_start, period_end, all_trading_dates):
    """
    时间加权收益率（TWR）计算。

    原理：将 [period_start, period_end] 划分为若干连续子区间，
    每个子区间内持仓保持不变（以每个交易日收盘后的持仓为准），
    计算各子区间价格涨跌幅，最后连乘得到 TWR，消除外部现金流（买卖）影响。

    返回 TWR 百分比（float），如 3.25 表示 +3.25%。
    """
    # 确定期初锚定日：period_start 之前最近有行情数据的交易日
    dates_before = [d for d in all_trading_dates if d < period_start]
    anchor = dates_before[-1] if dates_before else None

    # 期间内所有有行情数据的交易日
    dates_in_range = [d for d in all_trading_dates if period_start <= d <= period_end]
    if not dates_in_range:
        return 0.0

    # 构建子区间链：[anchor, d1, d2, ..., period_end]
    chain = ([anchor] if anchor else []) + dates_in_range
    if len(chain) < 2:
        return 0.0

    cumulative_factor = 1.0
    for i in range(1, len(chain)):
        prev_d, curr_d = chain[i - 1], chain[i]
        # 使用 prev_d 收盘时（含当日交易）的持仓
        pos = positions_at_date(trades_list, prev_d)
        if not pos:
            continue
        syms = list(pos.keys())
        v_prev = portfolio_value_with_prices(pos, prices_at(syms, history_cache, prev_d))
        v_curr = portfolio_value_with_prices(pos, prices_at(syms, history_cache, curr_d))
        # 用同一批持仓估值，排除现金流干扰
        if v_prev > 1e-6:
            cumulative_factor *= (v_curr / v_prev)

    return round((cumulative_factor - 1) * 100, 2)


def compute_twr_chart(trades_list, history_cache, bench_cache,
                      period_start, period_end, all_trading_dates):
    """
    生成时段内每个交易日的累计 TWR 走势，用于图表展示。

    my：我的组合累计 TWR（%）；bench：纳指相对 period_start 的简单涨跌幅（%）。
    返回 {"labels": [...], "my": [...], "bench": [...]}
    """
    dates_before = [d for d in all_trading_dates if d < period_start]
    anchor = dates_before[-1] if dates_before else None

    dates_in_range = [d for d in all_trading_dates if period_start <= d <= period_end]
    if not dates_in_range:
        return {"labels": [], "my": [], "bench": []}

    chain = ([anchor] if anchor else []) + dates_in_range

    # 纳指基准价：period_start（或之前最近交易日）的收盘价
    b_base = get_price_on_date(BENCHMARK_SYMBOL, period_start, bench_cache) or 1.0

    labels, my_series, bench_series = [], [], []
    cumulative_factor = 1.0

    for i in range(1, len(chain)):
        prev_d, curr_d = chain[i - 1], chain[i]
        pos = positions_at_date(trades_list, prev_d)
        if pos:
            syms = list(pos.keys())
            v_prev = portfolio_value_with_prices(pos, prices_at(syms, history_cache, prev_d))
            v_curr = portfolio_value_with_prices(pos, prices_at(syms, history_cache, curr_d))
            if v_prev > 1e-6:
                cumulative_factor *= (v_curr / v_prev)

        # 只输出 period_start 之后（含）的数据点
        if curr_d >= period_start:
            b_curr = get_price_on_date(BENCHMARK_SYMBOL, curr_d, bench_cache) or b_base
            labels.append(curr_d[5:])  # MM-DD 格式
            my_series.append(round((cumulative_factor - 1) * 100, 2))
            bench_series.append(round((b_curr / b_base - 1) * 100, 2) if b_base > 0 else 0.0)

    return {"labels": labels, "my": my_series, "bench": bench_series}


@app.route("/")
def index():
    """前端单页"""
    return send_from_directory(".", "us-stock-trading-assistant.html")


@app.route("/favicon.ico", methods=["GET"])
def favicon():
    """避免浏览器自动请求 favicon 时产生 404 日志"""
    return "", 204


@app.route("/api/version", methods=["GET"])
def api_version():
    """用于前端判断当前后端是否支持编辑/删除（避免 404 时误判）"""
    return jsonify({"edit_delete": True})


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
    required = ["date", "symbol", "action", "price", "shares"]
    for k in required:
        if k not in data:
            return jsonify({"error": f"缺少 {k}"}), 400
    try:
        price = float(data["price"])
        shares = float(data["shares"])
        commission = float(data.get("commission") or 0)
    except (TypeError, ValueError):
        return jsonify({"error": "price/shares/commission 需为数字"}), 400
    trades_list = get_trades()
    trades_list.append({
        "date": data["date"].strip(),
        "symbol": data["symbol"].strip(),
        "action": data["action"].strip(),
        "price": price,
        "shares": shares,
        "commission": commission,
        "type": (data.get("type") or "定投").strip(),
    })
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
    """按索引编辑一条交易（POST body: {"index", "date", "symbol", "action", "price", "shares", ...}）"""
    data = request.get_json() or {}
    try:
        idx = int(data.get("index", -1))
    except (TypeError, ValueError):
        return jsonify({"error": "索引须为整数"}), 400
    trades_list = get_trades()
    if idx < 0 or idx >= len(trades_list):
        return jsonify({"error": "索引无效"}), 404
    required = ["date", "symbol", "action", "price", "shares"]
    for k in required:
        if k not in data:
            return jsonify({"error": f"缺少 {k}"}), 400
    try:
        price = float(data["price"])
        shares = float(data["shares"])
        commission = float(data.get("commission") or 0)
    except (TypeError, ValueError):
        return jsonify({"error": "price/shares/commission 需为数字"}), 400
    trades_list[idx] = {
        "date": data["date"].strip(),
        "symbol": data["symbol"].strip(),
        "action": data["action"].strip(),
        "price": price,
        "shares": shares,
        "commission": commission,
        "type": (data.get("type") or "定投").strip(),
    }
    save_json(TRADES_FILE, trades_list)
    return jsonify({"ok": True})


@app.route("/api/returns-overview", methods=["GET"])
def api_returns_overview():
    """
    收益概览与走势图：所有时段统一使用时间加权收益率（TWR）计算。

    TWR 原理：将持有期分割为若干子区间（每两个相邻交易日为一段），
    每段内持仓不变（使用前一日收盘后的实际持仓），子区间收益率连乘，
    消除外部现金流（买入/卖出操作）对收益率的干扰，真实反映策略表现。

    end_fetch 取今日（exclusive），不含盘中实时价，保证每次刷新数据稳定。
    """
    trades_list = get_trades()
    symbols = get_all_symbols(trades_list)
    empty_resp = {
        "cards": {k: {"pct": 0, "usd": 0} for k in ["1d", "1m", "1y", "1y_roll", "since"]},
        "chart": {k: {"labels": [], "my": [], "bench": []} for k in ["1d", "1m", "1y", "1y_roll", "since"]},
    }
    if not symbols or not trades_list:
        return jsonify(empty_resp)

    dt = datetime.now()
    since_date = min(t["date"][:10] for t in trades_list)
    month_start = dt.replace(day=1).strftime("%Y-%m-%d")
    year_start = dt.replace(month=1, day=1).strftime("%Y-%m-%d")
    # 近1年(1y_roll)按「最后交易日」往前推 365 天，故拉取起点需多留缓冲，避免周末/节假日导致无数据
    one_year_ago = (dt - timedelta(days=365)).strftime("%Y-%m-%d")
    one_year_ago_with_buffer = (dt - timedelta(days=395)).strftime("%Y-%m-%d")  # 多约 30 天，覆盖 1y_roll 起点
    start_fetch = min(since_date, one_year_ago_with_buffer, year_start)
    end_fetch = (dt + timedelta(days=1)).strftime("%Y-%m-%d")

    # 拉取历史行情（统一文件缓存，同一天内收益与资产配置数据完全一致）
    history_cache, bench_cache, trading_dates = fetch_histories_with_bench(symbols, start_fetch, end_fetch)
    if not trading_dates:
        return jsonify(empty_resp)

    # 以最后一个有行情的交易日为基准，保证每次刷新结果一致（配合价格缓存）
    effective_end_date = trading_dates[-1]
    prev_trading_date = trading_dates[-2] if len(trading_dates) >= 2 else trading_dates[-1]
    effective_end_dt = datetime.strptime(effective_end_date, "%Y-%m-%d")

    # 当前持仓与市值（全部基于交易历史 + 真实行情计算）
    current_pos = positions_at_date(trades_list, effective_end_date)
    if not current_pos:
        return jsonify(empty_resp)

    v_end = portfolio_value_with_prices(
        current_pos,
        prices_at(list(current_pos.keys()), history_cache, effective_end_date),
    )

    # 各时段起始日定义；YTD / 1Y 取「自然起始日」与「组合第一次交易日期」的较晚值，避免起始早于组合成立
    one_year_ago_str = (effective_end_dt - timedelta(days=365)).strftime("%Y-%m-%d")
    periods = {
        "1d":      prev_trading_date,
        "1m":      month_start,
        "1y":      max(year_start, since_date),
        "1y_roll": max(one_year_ago_str, since_date),
        "since":   since_date,
    }

    # "since" 期的总成本基准（用于 USD 收益计算）
    cost_basis_map = compute_cost_basis(trades_list)
    total_cost = sum(cb["total_cost"] for cb in cost_basis_map.values()) or v_end

    cards = {}
    chart = {}

    for key, p_start in periods.items():
        # TWR 百分比
        twr_pct = compute_twr(trades_list, history_cache, p_start, effective_end_date, trading_dates)

        # USD 收益：
        # - since：当前市值 - 总买入成本（真实盈亏）
        # - 其余时段：期初持仓市值 × TWR%（剔除现金流、只反映价格涨跌的盈亏）
        if key == "since":
            usd = round(v_end - total_cost, 2)
        else:
            pos_start = positions_at_date(trades_list, p_start)
            v_start = portfolio_value_with_prices(
                pos_start,
                prices_at(list(pos_start.keys()), history_cache, p_start),
            ) if pos_start else 0.0
            # 用 TWR% × 期初市值，避免期间新增资金虚增 USD 数字
            # 若期初无持仓（v_start≈0，说明该时段包含完整交易历史），退回用总成本法
            usd = round(v_start * twr_pct / 100, 2) if v_start > 1e-6 else round(v_end - total_cost, 2)

        cards[key] = {"pct": twr_pct, "usd": usd}

        # 走势图
        if key == "1d":
            # 1d 只展示前后两个数据点
            b0 = get_price_on_date(BENCHMARK_SYMBOL, prev_trading_date, bench_cache) or 1.0
            b1 = get_price_on_date(BENCHMARK_SYMBOL, effective_end_date, bench_cache) or b0
            bench_1d = round((b1 / b0 - 1) * 100, 2) if b0 > 0 else 0.0
            chart[key] = {
                "labels": [prev_trading_date[5:], effective_end_date[5:]],
                "my": [0, twr_pct],
                "bench": [0, bench_1d],
            }
        else:
            chart[key] = compute_twr_chart(
                trades_list, history_cache, bench_cache,
                p_start, effective_end_date, trading_dates,
            )

    # 标明数据基准日，便于追溯
    return jsonify({
        "cards": cards,
        "chart": chart,
        "data_as_of": effective_end_date,
        "method": "TWR",
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
    since_date = min((t["date"][:10] for t in trades_list), default=dt.strftime("%Y-%m-%d"))
    year_start = dt.replace(month=1, day=1).strftime("%Y-%m-%d")
    one_year_ago = (dt - timedelta(days=365)).strftime("%Y-%m-%d")
    start_fetch = min(since_date, one_year_ago, year_start)
    end_fetch = (dt + timedelta(days=1)).strftime("%Y-%m-%d")
    # 与收益概览使用完全相同的日期范围，保证命中同一缓存
    history_cache, bench_cache, trading_dates = fetch_histories_with_bench(symbols, start_fetch, end_fetch)
    effective_end_date = trading_dates[-1] if trading_dates else dt.strftime("%Y-%m-%d")

    pos = positions_at_date(trades_list, effective_end_date)
    cost_basis_map = compute_cost_basis(trades_list)

    rows = []
    for sym, qty in pos.items():
        price = get_price_on_date(sym, effective_end_date, history_cache)
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
    for r in rows:
        r["pct"] = round(r["amount"] / total * 100, 1) if total else 0
        # 持仓盈亏：(当前价 - 均价) / 均价 × 100
        if r["avg_cost"] and r["avg_cost"] > 0:
            r["gain_pct"] = round((r["price"] - r["avg_cost"]) / r["avg_cost"] * 100, 2)
        else:
            r["gain_pct"] = 0.0
    # 按持仓金额倒序
    rows.sort(key=lambda r: r["amount"], reverse=True)
    # 单标的盈亏率 = (现价/成本-1)，与 TWR 在无现金流时等价
    return jsonify({
        "rows": rows,
        "data_as_of": effective_end_date,
    })


@app.route("/api/signals", methods=["GET"])
def api_signals():
    """
    交易机会：仅展示下次定投与投弹预估，不展示策略详情。
    下次定投：每月最后一天 2k，按 50% QQQM / 35% BRK.B / 15% IAU（若 QQQM>65% 则 70% BRK.B / 30% IAU）。
    投弹预估：QQQM M1/M2/M3 触发时额度 T=备弹*K（上限 10000）；IAU -5% 时 K=0.05。
    """
    fund_records = get_fund_records()
    trades_list = get_trades()
    # 备弹池 ≈ 入金 - 出金 - 已用于投弹/定投的现金（此处简化为：年度入金 40k + 月入金 - 月定投支出，不逐笔算）
    total_in = sum(r["amount"] for r in fund_records if r["amount"] > 0)
    total_out = sum(abs(r["amount"]) for r in fund_records if r["amount"] < 0)
    # 简化：备弹池 = 总入金 - 总出金 的某个比例，或固定假设
    reserve_pool = max(0, total_in - total_out - 10000)  # 粗略
    # 月定投基数 2000
    monthly_base = 2000
    # 当前持仓占比（用于决定定投分配）：与资产配置/收益概览使用同一套日期范围与缓存，避免价格每次刷新变化
    symbols = get_all_symbols(trades_list)
    if not symbols:
        history_cache = {}
        effective_end_date = datetime.now().strftime("%Y-%m-%d")
    else:
        dt = datetime.now()
        since_date = min((t["date"][:10] for t in trades_list), default=dt.strftime("%Y-%m-%d"))
        one_year_ago = (dt - timedelta(days=365)).strftime("%Y-%m-%d")
        year_start = dt.replace(month=1, day=1).strftime("%Y-%m-%d")
        start_fetch = min(since_date, one_year_ago, year_start)
        end_fetch = (dt + timedelta(days=1)).strftime("%Y-%m-%d")
        history_cache, _, trading_dates = fetch_histories_with_bench(symbols, start_fetch, end_fetch)
        effective_end_date = trading_dates[-1] if trading_dates else dt.strftime("%Y-%m-%d")
    pos = positions_at_date(trades_list, effective_end_date)
    total_value = 0.0
    qqqm_value = 0.0
    for sym, qty in pos.items():
        p = get_price_on_date(sym, effective_end_date, history_cache)
        if p is None:
            p = 0.0
        v = qty * p
        total_value += v
        if sym.upper() == "QQQM":
            qqqm_value += v
    qqqm_ratio = (qqqm_value / total_value * 100) if total_value else 0

    # 下次定投：本月或下月最后一天
    from calendar import monthrange
    now = datetime.now()
    _, last_day = monthrange(now.year, now.month)
    next_ding_date = f"{now.year}-{now.month:02d}-{last_day}"
    if now.day >= last_day:
        next_m = now.month + 1 if now.month < 12 else 1
        next_y = now.year if now.month < 12 else now.year + 1
        _, last_day = monthrange(next_y, next_m)
        next_ding_date = f"{next_y}-{next_m:02d}-{last_day}"

    if qqqm_ratio > 65:
        ding_allocation = [{"symbol": "BRK.B", "pct": 70, "amount": round(monthly_base * 0.7, 2)},
                          {"symbol": "IAU", "pct": 30, "amount": round(monthly_base * 0.3, 2)}]
    else:
        ding_allocation = [
            {"symbol": "QQQM", "pct": 50, "amount": round(monthly_base * 0.5, 2)},
            {"symbol": "BRK.B", "pct": 35, "amount": round(monthly_base * 0.35, 2)},
            {"symbol": "IAU", "pct": 15, "amount": round(monthly_base * 0.15, 2)},
        ]

    # 投弹预估：K=0.05/0.10 等，T=min(备弹*K, 10000)
    k_qqqm_m1 = 0.05
    t_qqqm_m1 = min(reserve_pool * k_qqqm_m1, 10000)
    k_iau = 0.05
    t_iau = min(reserve_pool * k_iau, 10000)

    next_dingtou = {
        "date": next_ding_date,
        "total_usd": monthly_base,
        "description": "每月定投（月末）",
        "allocation": ding_allocation,
    }
    toundan_estimate = [
        {"symbol": "QQQM", "condition": "M1: VIX<20 且单日跌幅≤-2%", "k": 0.05, "max_usd": round(t_qqqm_m1, 2)},
        {"symbol": "QQQM", "condition": "M2/M3 触发", "k": "0.10~0.20", "max_usd": min(reserve_pool * 0.10, 10000)},
        {"symbol": "IAU", "condition": "单日跌幅≤-5%", "k": 0.05, "max_usd": round(t_iau, 2)},
    ]

    return jsonify({
        "model_name": "天府 v1.0",
        "version": "1.0.0",
        "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "next_dingtou": next_dingtou,
        "toundan_estimate": toundan_estimate,
    })


if __name__ == "__main__":
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    app.run(host="0.0.0.0", port=5001, debug=False)
