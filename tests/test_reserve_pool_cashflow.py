# -*- coding: utf-8 -*-
"""备弹池现金流恒等式测试。

新公式（用户决策）：
    total_injected      = 总入金 - 定投净买入       （= 投弹池规模：已投 + 未投）
    total_toundan_used  = 投弹净买入                 （= 已投出的部分）
    reserve_pool        = total_injected - total_toundan_used
                        = 总入金 - 定投净买入 - 投弹净买入  （= 还没投出去的部分）
    year_max_reserve    = total_injected             （用于 T 公式分母）

关键差异 vs 旧公式：
- 旧：reserve_pool = BOXX 当前市值（依赖 BOXX 持仓与现价）
- 新：所有数字来自现金流恒等式，不再依赖任何标的的市值
- 入金登记后立即反映，无须等用户手动建仓 BOXX
"""

import server


def _make_fund(date, amount, note):
    return {"date": date, "amount": amount, "note": note}


def _make_trade(date, symbol, t_type, action, shares, price):
    return {
        "date": date,
        "symbol": symbol,
        "type": t_type,
        "action": action,
        "shares": shares,
        "price": price,
        "commission": 0.0,
    }


# ---------------------------------------------------------------------------
# 1. 仅入金、无任何交易：备弹池 = 全部净入金
# ---------------------------------------------------------------------------

def test_only_deposits_no_trades():
    """无任何买入 → total_injected 等于全部净入金，reserve_pool 同值。"""
    funds = [
        _make_fund("2026-01-01", 20000, "入金 USD 定投"),
        _make_fund("2026-05-06", 10000, "入金 USD 投弹"),
    ]
    trades = []
    rp = server.compute_reserve_pool(trades, fund_records=funds)
    assert rp["total_injected"] == 30000.0, rp
    assert rp["total_toundan_used"] == 0.0, rp
    assert rp["reserve_pool"] == 30000.0, rp
    assert rp["year_max_reserve"] == 30000.0, rp


# ---------------------------------------------------------------------------
# 2. 用户复现场景：今天入金 10000 投弹，尚未建仓 → 必须立即纳入备弹池
# ---------------------------------------------------------------------------

def test_today_pending_toundan_deposit_counted_immediately():
    """今天入金 10000 USD 投弹，没有任何配套买入交易 -> total_injected 立刻 +10000。

    这是用户在 #signals 页面提出的核心问题：刚入金的 10000 是否被计入。
    """
    funds = [
        _make_fund("2026-01-15", 50000, "入金 USD 投弹"),
        _make_fund("2026-05-06", 10000, "入金 USD 投弹"),  # 今日入金，待建仓
    ]
    trades = [
        _make_trade("2026-01-20", "QQQM", "投弹", "买入", 100, 280),
    ]
    rp = server.compute_reserve_pool(trades, fund_records=funds)
    assert rp["total_injected"] == 60000.0, rp
    assert rp["total_toundan_used"] == 28000.0, rp
    assert rp["reserve_pool"] == 60000.0 - 28000.0, rp
    assert rp["year_max_reserve"] == 60000.0, rp


# ---------------------------------------------------------------------------
# 3. 出金扣减入金（备注含"出金"或 amount<0）
# ---------------------------------------------------------------------------

def test_outflow_reduces_total_injected():
    """出金（备注含'出金'或 amount<0）应从总入金中扣减。"""
    funds = [
        _make_fund("2026-01-01", 30000, "入金 USD 投弹"),
        _make_fund("2026-03-01", 5000, "出金 USD"),
        _make_fund("2026-04-01", -2000, "出金 USD"),
    ]
    trades = []
    rp = server.compute_reserve_pool(trades, fund_records=funds)
    assert rp["total_injected"] == 23000.0, rp
    assert rp["reserve_pool"] == 23000.0, rp


# ---------------------------------------------------------------------------
# 4. 月投/定投 净买入扣减备弹池，但不进入 total_toundan_used
# ---------------------------------------------------------------------------

def test_monthly_buys_reduce_total_injected_and_pool():
    """定投净买入应同时扣减 total_injected 和 reserve_pool（定投资金不属于投弹池）。"""
    funds = [
        _make_fund("2026-01-01", 50000, "入金 USD 定投"),
    ]
    trades = [
        _make_trade("2026-01-31", "QQQM", "定投", "买入", 10, 280),
        _make_trade("2026-02-28", "QQQM", "定投", "买入", 10, 290),
    ]
    rp = server.compute_reserve_pool(trades, fund_records=funds)
    monthly_net = 10 * 280 + 10 * 290
    assert rp["total_toundan_used"] == 0.0, rp
    assert rp["total_injected"] == 50000.0 - monthly_net, rp
    assert rp["reserve_pool"] == 50000.0 - monthly_net, rp
    assert rp["year_max_reserve"] == 50000.0 - monthly_net, rp


# ---------------------------------------------------------------------------
# 5. 投弹 卖出 减少 total_toundan_used 并归还备弹池
# ---------------------------------------------------------------------------

def test_toundan_sell_returns_to_pool():
    """投弹卖出应减少 total_toundan_used，并归还到 reserve_pool；total_injected 不变。"""
    funds = [
        _make_fund("2026-01-01", 40000, "入金 USD 投弹"),
    ]
    trades = [
        _make_trade("2026-01-20", "QQQM", "投弹", "买入", 100, 280),
        _make_trade("2026-04-20", "QQQM", "投弹", "卖出", 30, 300),
    ]
    rp = server.compute_reserve_pool(trades, fund_records=funds)
    toundan_net = 100 * 280 - 30 * 300
    assert rp["total_injected"] == 40000.0, rp
    assert rp["total_toundan_used"] == toundan_net, rp
    assert rp["reserve_pool"] == 40000.0 - toundan_net, rp


# ---------------------------------------------------------------------------
# 6. BOXX (现金管理) 买卖 对备弹池/total_toundan_used 无影响
# ---------------------------------------------------------------------------

def test_boxx_cash_management_does_not_affect_pool():
    """BOXX/现金管理 类买卖视作通道内腾挪，不影响任何指标。"""
    funds = [
        _make_fund("2026-01-01", 30000, "入金 USD 投弹"),
    ]
    trades = [
        _make_trade("2026-01-05", "BOXX", "现金管理", "买入", 200, 115),
        _make_trade("2026-04-01", "BOXX", "现金管理", "卖出", 50, 116),
    ]
    rp = server.compute_reserve_pool(trades, fund_records=funds)
    assert rp["total_injected"] == 30000.0, rp
    assert rp["total_toundan_used"] == 0.0, rp
    assert rp["reserve_pool"] == 30000.0, rp


# ---------------------------------------------------------------------------
# 7. 分红/合股拆股 不应进入任何金额累计
# ---------------------------------------------------------------------------

def test_corp_actions_excluded():
    """分红/合股拆股不应进入任何金额累计。"""
    funds = [
        _make_fund("2026-01-01", 20000, "入金 USD 投弹"),
    ]
    trades = [
        _make_trade("2026-02-15", "QQQM", server.TYPE_DIVIDEND, "买入", 1, 50),
        _make_trade("2026-03-15", "QQQM", server.TYPE_CORP_SPLIT, "买入", 100, 0),
    ]
    rp = server.compute_reserve_pool(trades, fund_records=funds)
    assert rp["total_injected"] == 20000.0, rp
    assert rp["total_toundan_used"] == 0.0, rp
    assert rp["reserve_pool"] == 20000.0, rp


# ---------------------------------------------------------------------------
# 8. 综合场景：用户当前真实数据快照
# ---------------------------------------------------------------------------

def test_realistic_mixed_scenario():
    """模拟用户真实账本：

    总入金     = 117034.03 (含今日 10000 投弹通道)
    定投净买入 =  57558.67 (账户内全部 type=='定投' 净买入)
    投弹净买入 =  29226.76 (账户内全部 type=='投弹' 净买入)

    新公式：
      total_injected     = 117034.03 - 57558.67          = 59475.36
      total_toundan_used = 29226.76
      reserve_pool       = 59475.36  - 29226.76          = 30248.60
    """
    funds = [
        _make_fund("2026-01-01", 117034.03 - 10000.00, "入金 USD 投弹"),
        _make_fund("2026-05-06", 10000.00, "入金 USD 投弹"),
    ]
    trades = [
        _make_trade("2026-01-15", "QQQM", "定投", "买入", 1000, 57.55867),
        _make_trade("2026-01-20", "QQQM", "投弹", "买入", 100, 292.2676),
    ]
    rp = server.compute_reserve_pool(trades, fund_records=funds)
    assert rp["total_injected"] == 59475.36, rp
    assert rp["total_toundan_used"] == 29226.76, rp
    assert rp["reserve_pool"] == 30248.60, rp
    assert rp["year_max_reserve"] == 59475.36, rp


# ---------------------------------------------------------------------------
# 9. 向后兼容：保留 cash_position_value 形参（call sites 暂不删，但被忽略）
# ---------------------------------------------------------------------------

def test_legacy_cash_position_value_arg_is_ignored():
    """旧调用方还可能传 cash_position_value，新公式不再使用此入参，但不报错。"""
    funds = [_make_fund("2026-01-01", 10000, "入金 USD 投弹")]
    trades = []
    rp_with = server.compute_reserve_pool(trades, cash_position_value=99999, fund_records=funds)
    rp_without = server.compute_reserve_pool(trades, fund_records=funds)
    assert rp_with == rp_without
