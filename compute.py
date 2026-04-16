# -*- coding: utf-8 -*-
"""
预计算脚本：复用 server.py 的全部业务逻辑，通过 Flask test client
调用所有 GET 端点，将 JSON 响应保存为静态文件供 GitHub Pages 使用。
输出前自动脱敏，剔除金额/股数/成本等敏感字段。

用法：python3 compute.py
输出：data/computed/*.json
"""

import copy
import json
import sys
from pathlib import Path

from server import app

OUTPUT_DIR = Path(__file__).resolve().parent / "data" / "computed"


# --------------- 脱敏 ---------------

def _nullify(d, keys):
    """将 dict d 中指定 keys 的值置为 None。"""
    for k in keys:
        if k in d:
            d[k] = None


def _sanitize_trades(data):
    for row in data:
        _nullify(row, ("price", "shares", "commission", "gross_dividend_usd"))
    return data


def _sanitize_fund_records(data):
    for row in data:
        _nullify(row, ("amount",))
    return data


def _sanitize_allocation(data):
    if isinstance(data, list):
        for row in data:
            _nullify(row, ("amount", "avg_cost", "shares"))
        return data
    _nullify(data, ("total_value", "risk_total"))
    for row in data.get("rows", []):
        _nullify(row, ("amount", "avg_cost", "shares"))
    return data


def _sanitize_returns_overview(data):
    for card in data.get("cards", {}).values():
        _nullify(card, ("usd",))
    for period_chart in data.get("chart", {}).values():
        for marker in period_chart.get("buy_markers", []):
            _nullify(marker, ("price_shares",))
    sd = data.get("strategy_driver")
    if sd:
        _nullify(sd, ("dingtou_total_pnl", "toundan_total_pnl",
                       "cash_total_pnl", "v_end"))
        for detail_key in ("dingtou_details", "toundan_details", "cash_details"):
            for row in sd.get(detail_key, []):
                _nullify(row, ("buy_price", "current_price", "shares", "pnl"))
    return data


def _sanitize_signals(data):
    _nullify(data, ("reserve_pool", "total_toundan_used", "total_injected"))
    ms = data.get("monthly_signal")
    if ms:
        _nullify(ms, ("monthly_amount", "double_up_amount", "total_invest"))
    nd = data.get("next_dingtou")
    if nd:
        _nullify(nd, ("total_usd",))
        for alloc in nd.get("allocation", []):
            _nullify(alloc, ("amount",))
    rb = data.get("risk_budget")
    if rb:
        _nullify(rb, ("T",))
    for level_data in data.get("triggers", {}).values():
        if isinstance(level_data, dict):
            _nullify(level_data, ("T",))
    for est in data.get("toundan_estimate", []):
        _nullify(est, ("max_usd", "shares_to_buy", "order_text"))
    ins = data.get("insurance")
    if ins:
        _nullify(ins, ("annual_budget", "annual_spent"))
    pa = data.get("position_alerts")
    if pa:
        rf = pa.get("reserve_forecast")
        if rf:
            _nullify(rf, ("daily_burn_rate",))
    return data


def _sanitize_trade_summary(data):
    _nullify(data, ("total_inflow", "total_outflow", "total_commission",
                     "net_inflow"))
    return data


def _sanitize_stress_test(data):
    st = data.get("stress")
    if st:
        _nullify(st, ("portfolio_value_before", "portfolio_value_after",
                       "remaining_reserve", "total_cash_deployed"))
        for detail in st.get("detail", []):
            _nullify(detail, ("value_before", "value_after"))
        for sim in st.get("toundan_simulation", []):
            _nullify(sim, ("deployed_usd",))
    return data


def _sanitize_strategy_review(data):
    settings = data.get("settings")
    if settings:
        _nullify(settings, ("MONTHLY_BASE_OVERRIDE",))
    return data


def _sanitize_asset_analysis(data):
    metrics = data.get("metrics")
    if metrics:
        _nullify(metrics, ("avg_cost", "total_shares"))
    for row in data.get("trade_attribution", []):
        _nullify(row, ("shares", "pnl"))
    for bp in data.get("buy_points", []):
        _nullify(bp, ("shares",))
    for cs in data.get("cost_series", []):
        _nullify(cs, ("vwac",))
    return data


_SANITIZERS = {
    "trades.json": _sanitize_trades,
    "fund-records.json": _sanitize_fund_records,
    "allocation.json": _sanitize_allocation,
    "returns-overview.json": _sanitize_returns_overview,
    "signals.json": _sanitize_signals,
    "stress-test.json": _sanitize_stress_test,
}


def sanitize(filename, data):
    """返回脱敏后的数据副本。不匹配任何规则的文件原样返回。"""
    data = copy.deepcopy(data)
    fn = _SANITIZERS.get(filename)
    if fn:
        return fn(data)
    if filename.startswith("trade-summary-"):
        return _sanitize_trade_summary(data)
    if filename.startswith("strategy-review-"):
        return _sanitize_strategy_review(data)
    if filename.startswith("asset-analysis-"):
        return _sanitize_asset_analysis(data)
    return data


# --------------- 保存 ---------------

def save(name, data):
    sanitized = sanitize(name, data)
    path = OUTPUT_DIR / name
    with open(path, "w", encoding="utf-8") as f:
        json.dump(sanitized, f, ensure_ascii=False, separators=(",", ":"))
    print(f"  ✓ {name}")


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    client = app.test_client()
    errors = []

    def get_json(path, filename):
        try:
            resp = client.get(path)
            if resp.status_code == 200:
                save(filename, resp.get_json())
            else:
                errors.append(f"{path} → HTTP {resp.status_code}")
                print(f"  ✗ {path} → {resp.status_code}")
        except Exception as e:
            errors.append(f"{path} → {e}")
            print(f"  ✗ {path} → {e}")

    print("=== 预计算开始 ===")

    # 预计算前先同步 Yahoo 分红/拆股到交易表（与本地「同步分红/拆股」一致）
    try:
        sync_resp = client.post("/api/corp-actions/sync", json={})
        if sync_resp.status_code != 200:
            print(f"  警告：/api/corp-actions/sync → HTTP {sync_resp.status_code}")
        else:
            try:
                sj = sync_resp.get_json() or {}
            except Exception:
                sj = {}
            ins = sj.get("inserted") or []
            print(f"  公司行为同步：新增 {len(ins)} 条")
    except Exception as ex:
        print(f"  警告：公司行为同步失败：{ex}")

    # 基础数据
    print("[1/8] 基础数据...")
    get_json("/api/version", "version.json")
    get_json("/api/fund-records", "fund-records.json")
    get_json("/api/trades", "trades.json")

    # 交易汇总（3 个时段）
    print("[2/8] 交易汇总...")
    for period in ("all", "year", "month"):
        get_json(f"/api/trade-summary?period={period}", f"trade-summary-{period}.json")

    # 收益概览
    print("[3/8] 收益概览...")
    get_json("/api/returns-overview", "returns-overview.json")

    # 资产配置
    print("[4/8] 资产配置...")
    resp = client.get("/api/allocation")
    if resp.status_code == 200:
        alloc_data = resp.get_json()
        save("allocation.json", alloc_data)

        # 遍历持仓标的计算归因分析
        print("[5/8] 资产归因...")
        rows = alloc_data.get("rows") if isinstance(alloc_data, dict) else alloc_data
        if isinstance(rows, list):
            for row in rows:
                sym = row.get("symbol", "")
                if sym:
                    get_json(f"/api/asset-analysis/{sym}", f"asset-analysis-{sym}.json")
    else:
        errors.append(f"/api/allocation → HTTP {resp.status_code}")
        print(f"  ✗ /api/allocation → {resp.status_code}")
        print("[5/8] 资产归因...跳过（无配置数据）")

    # 模型信号
    print("[6/8] 模型信号...")
    get_json("/api/signals", "signals.json")

    # 压力测试
    print("[7/8] 压力测试...")
    get_json("/api/stress-test", "stress-test.json")

    # 策略复盘（3 个时段）
    print("[8/8] 策略复盘...")
    for period in ("all", "1m", "3m"):
        get_json(f"/api/strategy-review?period={period}", f"strategy-review-{period}.json")

    print(f"\n=== 预计算完成 ===")
    if errors:
        print(f"警告：{len(errors)} 个端点失败：")
        for e in errors:
            print(f"  - {e}")
        sys.exit(1)
    else:
        print("全部成功。")


if __name__ == "__main__":
    main()
