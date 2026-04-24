"""守护 `.github/workflows/compute.yml` 的 cron 时刻表足以覆盖美股盘中。

背景：
    GitHub Pages 上 `#returns` 的数据由 `Compute Data` 工作流产出。只要 cron
    覆盖美股盘中 + 收盘后，页面就能在盘中拉到今天的盘中价（yfinance 在盘中
    会返回当日行情作为最后一行），从而解决「数据基准日 = 昨天」的问题。

本测试断言：
    1. cron 列表可解析、仅在工作日（dow=1-5）触发；
    2. 盘中任意 60 分钟滑动窗口内至少触发一次（容忍 ±5 min 漂移）；
    3. 覆盖 EDT（美东夏令时，UTC-4，行情 13:30-20:00 UTC）与
       EST（美东标准时，UTC-5，行情 14:30-21:00 UTC）两种情况；
    4. 保留收盘后终版快照（≥ 22:00 UTC 一次），避免盘中最后一次 cron
       落在收盘前、导致最终收盘价被遗漏。
"""

from __future__ import annotations

from pathlib import Path
from typing import Iterable

import pytest
import yaml

WORKFLOW_PATH = (
    Path(__file__).resolve().parent.parent / ".github" / "workflows" / "compute.yml"
)


def _expand_field(expr: str, lo: int, hi: int) -> set[int]:
    """展开 cron 单字段：支持 `*`、`a-b`、`*/n`、`a,b,c`、`a-b/n`。"""
    out: set[int] = set()
    for part in expr.split(","):
        step = 1
        if "/" in part:
            head, s = part.split("/", 1)
            step = int(s)
            part = head
        if part == "*":
            start, end = lo, hi
        elif "-" in part:
            a, b = part.split("-", 1)
            start, end = int(a), int(b)
        else:
            start = end = int(part)
        out.update(range(start, end + 1, step))
    return {v for v in out if lo <= v <= hi}


def _cron_fires_on_weekday(expr: str) -> set[tuple[int, int]]:
    """返回 cron 在工作日（Mon-Fri）会触发的 (utc_hour, utc_minute) 集合。"""
    minute_f, hour_f, dom_f, mon_f, dow_f = expr.split()
    minutes = _expand_field(minute_f, 0, 59)
    hours = _expand_field(hour_f, 0, 23)
    dows = _expand_field(dow_f, 0, 7)  # 0 和 7 都表示周日
    if not ({1, 2, 3, 4, 5} & (dows or {0, 1, 2, 3, 4, 5, 6, 7})):
        return set()
    return {(h, m) for h in hours for m in minutes}


def _load_cron_list() -> list[str]:
    data = yaml.safe_load(WORKFLOW_PATH.read_text(encoding="utf-8"))
    # on.schedule 可能被解析成 'on' 或 True（YAML 的 on 关键字），两种都兼容
    trigger = data.get("on") or data.get(True)
    assert trigger, "compute.yml 未配置 on 触发器"
    schedules = trigger.get("schedule", [])
    return [s["cron"] for s in schedules if "cron" in s]


def _all_fire_slots() -> set[tuple[int, int]]:
    slots: set[tuple[int, int]] = set()
    for expr in _load_cron_list():
        slots |= _cron_fires_on_weekday(expr)
    return slots


def _window_has_fire(slots: Iterable[tuple[int, int]], start_min: int, end_min: int) -> bool:
    """`start_min`/`end_min` 以一日内分钟数表示（0-1439）。"""
    for h, m in slots:
        t = h * 60 + m
        if start_min <= t <= end_min:
            return True
    return False


# ---------------- 结构守护 ----------------


def test_cron_all_weekday_only() -> None:
    for expr in _load_cron_list():
        assert expr.split()[-1] == "1-5", (
            f"cron 必须仅在工作日触发，避免周末/节假日无行情浪费运行："
            f"expr={expr!r}"
        )


def test_cron_post_close_snapshot_kept() -> None:
    """必须保留 ≥ 22:00 UTC 的一次运行，产出当日终版快照（收盘后 2h）。"""
    slots = _all_fire_slots()
    assert any(h >= 22 for h, _ in slots), (
        "cron 中必须保留 ≥ 22:00 UTC 的一次运行以写入当日收盘后终版数据。"
    )


# ---------------- 覆盖性守护 ----------------

# EDT：美股行情 9:30-16:00 ET = 13:30-20:00 UTC（夏令，每年 3 月第二个周日至 11 月第一个周日）
# EST：美股行情 9:30-16:00 ET = 14:30-21:00 UTC（标准时，其他时段）
# 我们用「盘中+收盘那一刻」=[13:30, 21:00] UTC 作为必须覆盖的并集。
MARKET_START_UTC_MIN = 13 * 60 + 30
MARKET_END_UTC_MIN = 21 * 60  # 含收盘那一刻

WINDOW_MINUTES = 60  # 容忍 60 min 最大间隔


@pytest.mark.parametrize(
    "anchor_min",
    # 以半小时步长扫描整个盘中区间，验证每个滑窗都至少命中一次
    list(range(MARKET_START_UTC_MIN, MARKET_END_UTC_MIN + 1, 30)),
)
def test_cron_covers_market_hours(anchor_min: int) -> None:
    slots = _all_fire_slots()
    start = max(anchor_min - WINDOW_MINUTES // 2, 0)
    end = anchor_min + WINDOW_MINUTES // 2
    assert _window_has_fire(slots, start, end), (
        f"盘中 UTC {anchor_min // 60:02d}:{anchor_min % 60:02d} 前后 "
        f"{WINDOW_MINUTES} 分钟内没有 cron 触发；当前 cron 列表：{_load_cron_list()!r}"
    )


def test_cron_total_market_fires_at_least_10() -> None:
    """防御用下限：盘中（13:30-21:00 UTC）应至少有 10 次触发（约半小时一次）。"""
    slots = _all_fire_slots()
    in_market = [
        (h, m) for (h, m) in slots
        if MARKET_START_UTC_MIN <= h * 60 + m <= MARKET_END_UTC_MIN
    ]
    assert len(in_market) >= 10, (
        f"盘中 cron 触发次数 {len(in_market)} 次，低于 10 次下限；"
        f"slots={sorted(in_market)}"
    )


# ---------------- 并发安全守护 ----------------
#
# 高频 cron 下，run 的 `git push` 很容易与并发 push / hook bump / 相邻 cron
# 撞车被拒（remote fast-forward 失败）。必须有 retry + rebase 机制，否则一次
# race 就会让当次数据刷新失败。skill "Retry-wrap sequence rule" 要求 retry
# 必须覆盖整条 fragile 序列，这里至少守住静态结构。


def test_commit_step_has_push_retry() -> None:
    """Commit computed data 步骤必须具备 push 失败后 rebase + 重试的能力。"""
    raw = WORKFLOW_PATH.read_text(encoding="utf-8")
    data = yaml.safe_load(raw)
    jobs = data.get("jobs", {})
    compute = jobs.get("compute", {})
    steps = compute.get("steps", [])
    commit_step = next(
        (s for s in steps if s.get("name") == "Commit computed data"),
        None,
    )
    assert commit_step is not None, "compute.yml 中未找到 'Commit computed data' 步骤"
    body = commit_step.get("run", "")
    # 必须包含循环/重试、rebase、fetch 三个信号，才能在 push 被拒时恢复
    assert "for " in body or "while " in body, (
        "Commit computed data 缺少重试循环（for/while）——一次 race 就会整次失败"
    )
    assert "rebase" in body, (
        "Commit computed data 缺少 rebase；拒绝后需 git pull --rebase 才能前进"
    )
    assert "git fetch" in body or "pull --rebase" in body, (
        "Commit computed data 缺少对 origin 的拉取；retry 前必须先同步远端"
    )
