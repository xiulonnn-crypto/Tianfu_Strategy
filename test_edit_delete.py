# -*- coding: utf-8 -*-
"""
模拟「编辑、删除」接口流程并校验，通过后退出码为 0。
运行：python test_edit_delete.py（需在项目根目录，与 server.py 同目录）
"""
import sys
from pathlib import Path

# 保证从脚本所在目录加载 server
BASE = Path(__file__).resolve().parent
if str(BASE) not in sys.path:
    sys.path.insert(0, str(BASE))

def main():
    from server import app

    client = app.test_client()
    ok = True

    # ---------- 出入金：删除 ----------
    r = client.get("/api/fund-records")
    if r.status_code != 200:
        print("FAIL: GET /api/fund-records status", r.status_code)
        ok = False
    else:
        data = r.get_json()
        if not isinstance(data, list):
            print("FAIL: fund-records 非列表")
            ok = False
        else:
            n_before = len(data)
            if n_before == 0:
                client.post("/api/fund-records", json={"date": "2025-01-01", "amount": 1, "note": "test"}, content_type="application/json")
                n_before = 1
            r_del = client.post("/api/fund-records/delete", json={"index": 0}, content_type="application/json")
            if r_del.status_code != 200:
                print("FAIL: POST /api/fund-records/delete status", r_del.status_code, r_del.get_data(as_text=True))
                ok = False
            else:
                r2 = client.get("/api/fund-records")
                n_after = len(r2.get_json() or [])
                if n_after != n_before - 1:
                    print("FAIL: 删除后条数应为", n_before - 1, "实际", n_after)
                    ok = False
                else:
                    print("OK: 出入金删除")

    # ---------- 出入金：编辑 ----------
    r = client.get("/api/fund-records")
    data = r.get_json() or []
    if len(data) == 0:
        client.post("/api/fund-records", json={"date": "2025-06-01", "amount": 100, "note": "edit-test"}, content_type="application/json")
        data = client.get("/api/fund-records").get_json() or []
    if data:
        r_put = client.post("/api/fund-records/update", json={"index": 0, "date": "2025-06-02", "amount": 200, "note": "已编辑"}, content_type="application/json")
        if r_put.status_code != 200:
            print("FAIL: POST /api/fund-records/update status", r_put.status_code)
            ok = False
        else:
            updated = (client.get("/api/fund-records").get_json() or [])[0]
            if updated.get("amount") != 200 or updated.get("note") != "已编辑":
                print("FAIL: 编辑后数据未更新", updated)
                ok = False
            else:
                print("OK: 出入金编辑")

    # ---------- 交易：删除 ----------
    r = client.get("/api/trades")
    if r.status_code != 200:
        print("FAIL: GET /api/trades status", r.status_code)
        ok = False
    else:
        data = r.get_json()
        if not isinstance(data, list):
            print("FAIL: trades 非列表")
            ok = False
        else:
            n_before = len(data)
            if n_before == 0:
                client.post("/api/trades", json={"date": "2025-01-01", "symbol": "QQQ", "action": "买入", "price": 100, "shares": 1}, content_type="application/json")
                n_before = 1
            r_del = client.post("/api/trades/delete", json={"index": 0}, content_type="application/json")
            if r_del.status_code != 200:
                print("FAIL: POST /api/trades/delete status", r_del.status_code)
                ok = False
            else:
                r2 = client.get("/api/trades")
                n_after = len(r2.get_json() or [])
                if n_after != n_before - 1:
                    print("FAIL: 交易删除后条数应为", n_before - 1, "实际", n_after)
                    ok = False
                else:
                    print("OK: 交易删除")

    # ---------- 交易：编辑 ----------
    r = client.get("/api/trades")
    data = r.get_json() or []
    if len(data) == 0:
        client.post("/api/trades", json={"date": "2025-01-01", "symbol": "QQQ", "action": "买入", "price": 100, "shares": 1}, content_type="application/json")
        data = client.get("/api/trades").get_json() or []
    if data:
        r_put = client.post("/api/trades/update", json={"index": 0, "date": "2025-07-01", "symbol": "QQQ", "action": "卖出", "price": 105, "shares": 1, "commission": 0, "type": "投机"}, content_type="application/json")
        if r_put.status_code != 200:
            print("FAIL: POST /api/trades/update status", r_put.status_code)
            ok = False
        else:
            updated = (client.get("/api/trades").get_json() or [])[0]
            if updated.get("action") != "卖出" or updated.get("date") != "2025-07-01":
                print("FAIL: 交易编辑后数据未更新", updated)
                ok = False
            else:
                print("OK: 交易编辑")

    if ok:
        print("--- 全部通过（模拟点击确认后的接口流程）---")
        return 0
    print("--- 存在失败项 ---")
    return 1


if __name__ == "__main__":
    sys.exit(main())
