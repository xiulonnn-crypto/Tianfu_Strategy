# -*- coding: utf-8 -*-
"""持仓时间线与 positions_at_date 对拍。"""

import random

import pytest

import server


def test_timeline_matches_scan_random_dates():
    trades = [
        {"date": "2026-01-10", "symbol": "QQQM", "action": "买入", "shares": 10, "price": 100, "type": "定投"},
        {"date": "2026-01-15", "symbol": "QQQM", "action": "买入", "shares": 5, "price": 99, "type": "定投"},
        {"date": "2026-01-20", "symbol": "QQQM", "action": "卖出", "shares": 3, "price": 102, "type": "定投"},
    ]
    trading_dates = [
        "2026-01-09", "2026-01-10", "2026-01-13", "2026-01-15", "2026-01-16",
        "2026-01-20", "2026-01-21",
    ]
    tl, tdates = server._build_positions_timeline(trades, trading_dates)
    random.seed(7)
    for _ in range(50):
        day = f"2026-01-{random.randint(10, 25):02d}"
        a = server.positions_at_date(trades, day)
        b = server.positions_at_date(trades, day, tl, tdates)
        assert a == b, (day, a, b)
