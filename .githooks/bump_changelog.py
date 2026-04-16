#!/usr/bin/env python3
"""
CHANGELOG 版本自动更新脚本
由 .githooks/pre-push 调用，在推送前将 [Unreleased] 块版本化。

用法：
    python3 bump_changelog.py [NEXT_VERSION]

    NEXT_VERSION  显式指定版本号（如 0.2.0）；省略则自动递增
                  也可通过环境变量 NEXT_VERSION 传递

版本命名规则（无显式输入时）：
    0.1.0 → 0.1.0-002 → 0.1.0-003 → ...
    使用 NEXT_VERSION=0.2.0 重置基础版本：0.2.0 → 0.2.0-002 → ...

CHANGELOG 标题格式（内联链接）：
    ## [Unreleased](compare_url)
    ## [0.1.0](release_url) - 2026-04-08
"""

import os
import re
import sys
import subprocess
from datetime import date
from pathlib import Path
from typing import Optional, Tuple

SCRIPT_DIR = Path(__file__).parent
PROJECT_ROOT = SCRIPT_DIR.parent
CHANGELOG_PATH = PROJECT_ROOT / "CHANGELOG.md"

# 匹配含或不含内联链接的 Unreleased 标题
# 例：## [Unreleased]  或  ## [Unreleased](https://...)
_RE_UNRELEASED_HEADING = re.compile(
    r"## \[Unreleased\](?:\([^)]*\))?",
    re.IGNORECASE,
)

# 匹配版本标题（含或不含内联链接及日期）
# 例：## [0.1.0] - 2026-04-08  或  ## [0.1.0](url) - 2026-04-08
_RE_VERSION_HEADING = re.compile(
    r"## \[(\d+\.\d+\.\d+(?:-\d{3})?)\](?:\([^)]*\))?",
)


# ---------------------------------------------------------------------------
# 读写
# ---------------------------------------------------------------------------

def read_changelog() -> str:
    return CHANGELOG_PATH.read_text(encoding="utf-8")


def write_changelog(content: str) -> None:
    CHANGELOG_PATH.write_text(content, encoding="utf-8")


# ---------------------------------------------------------------------------
# 解析
# ---------------------------------------------------------------------------

def has_unreleased_content(content: str) -> bool:
    """检查 [Unreleased] 部分是否有实质性内容（非空行）"""
    m = _RE_UNRELEASED_HEADING.search(content)
    if not m:
        return False

    after = content[m.end():]
    next_ver = _RE_VERSION_HEADING.search(after)
    section = after[: next_ver.start()] if next_ver else after

    lines = [ln.strip() for ln in section.splitlines() if ln.strip()]
    return bool(lines)


def get_latest_version(content: str) -> Optional[str]:
    """返回最新的已发布版本号（跳过 Unreleased）"""
    matches = _RE_VERSION_HEADING.findall(content)
    return matches[0] if matches else None


# ---------------------------------------------------------------------------
# 版本计算
# ---------------------------------------------------------------------------

def compute_next_version(latest: Optional[str], explicit: Optional[str]) -> str:
    """
    计算下一个版本号。
      - explicit 非空：直接使用（去掉前缀 v）
      - latest 为 None：返回 '0.1.0'
      - latest 无后缀（如 '0.1.0'）：返回 '0.1.0-002'
      - latest 有后缀（如 '0.1.0-002'）：返回 '0.1.0-003'
    """
    if explicit:
        return explicit.lstrip("v")

    if latest is None:
        return "0.1.0"

    m = re.match(r"^(\d+\.\d+\.\d+)(?:-(\d+))?$", latest)
    if not m:
        return latest + "-002"

    base, suffix = m.group(1), m.group(2)
    return f"{base}-002" if suffix is None else f"{base}-{int(suffix) + 1:03d}"


# ---------------------------------------------------------------------------
# 提交摘要
# ---------------------------------------------------------------------------

def get_commit_summary() -> str:
    """获取本次推送新增提交的一句话摘要"""
    def _run(args):
        try:
            r = subprocess.run(args, capture_output=True, text=True, timeout=5)
            return r.stdout.strip() if r.returncode == 0 else ""
        except Exception:
            return ""

    for remote_ref in ("origin/main", "origin/master"):
        out = _run(["git", "log", f"{remote_ref}..HEAD", "--oneline", "--no-decorate"])
        if out:
            lines = out.splitlines()
            summary = re.sub(r"^[a-f0-9]+ ", "", lines[0])
            if len(lines) > 1:
                summary += f"（共 {len(lines)} 个提交）"
            return summary

    out = _run(["git", "log", "--oneline", "-1", "--no-decorate"])
    return re.sub(r"^[a-f0-9]+ ", "", out) if out else "日常更新"


# ---------------------------------------------------------------------------
# 构建新标题
# ---------------------------------------------------------------------------

def build_unreleased_heading() -> str:
    """生成新的 [Unreleased] 标题（纯文本，无链接）"""
    return "## [Unreleased]"


def build_version_heading(new_ver: str, today: str, summary: Optional[str] = None) -> str:
    """生成新版本标题（纯文本，无链接）；有摘要时附在日期后"""
    heading = f"## [{new_ver}] - {today}"
    if summary:
        heading += f" - {summary}"
    return heading


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

def bump(explicit_version: Optional[str] = None) -> Optional[Tuple[str, str]]:
    """
    执行 CHANGELOG 版本更新。

    返回 (new_version, summary) 如果做了更新；
    返回 None 如果 [Unreleased] 为空（跳过）。
    """
    content = read_changelog()

    if not has_unreleased_content(content):
        print("[CHANGELOG] [Unreleased] 部分无内容，跳过版本更新")
        return None

    prev_ver = get_latest_version(content)
    new_ver = compute_next_version(prev_ver, explicit_version)
    today = date.today().isoformat()
    summary = None if explicit_version else get_commit_summary()

    # 构建新标题
    unreleased_heading = build_unreleased_heading()
    version_heading = build_version_heading(new_ver, today, summary)

    # 替换旧 Unreleased 标题 → 新 Unreleased 标题 + 版本标题（两者之间空一行）
    old_unreleased = _RE_UNRELEASED_HEADING.search(content)
    if not old_unreleased:
        print("[CHANGELOG] 未找到 [Unreleased] 标题，跳过")
        return None

    new_block = f"{unreleased_heading}\n\n{version_heading}"
    content = content[: old_unreleased.start()] + new_block + content[old_unreleased.end():]

    write_changelog(content)

    msg = f"[CHANGELOG] 已更新 [{new_ver}] - {today}"
    if summary:
        msg += f"  |  {summary}"
    print(msg)

    return new_ver, summary


if __name__ == "__main__":
    explicit = (
        sys.argv[1]
        if len(sys.argv) > 1
        else os.environ.get("NEXT_VERSION")
    )
    bump(explicit)
    sys.exit(0)
