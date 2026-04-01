# -*- coding: utf-8 -*-
"""
预计算脚本：复用 server.py 的全部业务逻辑，通过 Flask test client
调用所有 GET 端点，将 JSON 响应保存为静态文件供 GitHub Pages 使用。

用法：python3 compute.py
输出：data/computed/*.json
"""

import json
import sys
from pathlib import Path

from server import app

OUTPUT_DIR = Path(__file__).resolve().parent / "data" / "computed"


def save(name, data):
    path = OUTPUT_DIR / name
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
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
