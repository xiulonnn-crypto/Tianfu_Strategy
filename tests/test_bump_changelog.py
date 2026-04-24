"""覆盖 `.githooks/bump_changelog.py` 的两条 skill 约束：

- **违规 B 守护**：`strip_theme_after_unreleased` 必须在晋升 `[Unreleased]`
  之前删除其下的 `> Theme: …` blockquote，否则 released block 会遗留重复摘要。
- **违规 C 守护**：`strip_commit_prefix` 必须从 commit subject 里剥离
  Conventional Commits 前缀（feat/fix/chore/docs/refactor/test/style/
  perf/build/ci/revert，含 scope 与 `!` 破坏标记），让 CHANGELOG 版本标题
  的摘要面向用户可读，而不是带 `feat:` 这种技术前缀。
- **集成守护**：`bump()` 端到端跑一遍，确认两条清洗都被调用到，并且晋升
  后的 released block 既无 Theme 行、也无 commit 前缀。
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
BUMP_PATH = ROOT / ".githooks" / "bump_changelog.py"


def _load_bump_module():
    spec = importlib.util.spec_from_file_location("bump_changelog", BUMP_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules["bump_changelog"] = module
    spec.loader.exec_module(module)
    return module


bump_module = _load_bump_module()


# ---------------------------------------------------------------------------
# strip_theme_after_unreleased —— 违规 B
# ---------------------------------------------------------------------------


def test_strip_theme_removes_block_with_standard_spacing():
    content = (
        "# Changelog\n\n"
        "## [Unreleased]\n\n"
        "> Theme: 这是一句主题\n\n"
        "### Changed\n\n"
        "- **X**：Y\n"
    )
    out = bump_module.strip_theme_after_unreleased(content)
    assert "> Theme:" not in out
    assert "## [Unreleased]\n\n### Changed" in out


def test_strip_theme_is_noop_when_no_theme():
    content = (
        "# Changelog\n\n"
        "## [Unreleased]\n\n"
        "### Changed\n\n"
        "- **X**：Y\n"
    )
    assert bump_module.strip_theme_after_unreleased(content) == content


def test_strip_theme_does_not_touch_blockquote_in_released_section():
    """只能剥离紧跟 [Unreleased] 的 Theme；其它位置的 blockquote 不应被误删。"""
    content = (
        "# Changelog\n\n"
        "## [Unreleased]\n\n"
        "### Changed\n\n"
        "- **A**：B\n\n"
        "## [0.1.0] - 2026-04-08 - 初版\n\n"
        "> 这是一个普通引用，不是 Theme 行\n\n"
        "### Added\n\n"
        "- **初版**：上线\n"
    )
    out = bump_module.strip_theme_after_unreleased(content)
    assert out == content


def test_strip_theme_handles_inline_link_in_unreleased_heading():
    """Unreleased 标题带内联 compare 链接时也能识别并剥离。"""
    content = (
        "# Changelog\n\n"
        "## [Unreleased](https://example.com/compare/main...HEAD)\n\n"
        "> Theme: 主题\n\n"
        "### Changed\n\n"
        "- **X**：Y\n"
    )
    out = bump_module.strip_theme_after_unreleased(content)
    assert "> Theme:" not in out


# ---------------------------------------------------------------------------
# strip_commit_prefix —— 违规 C
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw, want",
    [
        ("feat: 云端模式隐藏出入金 tab", "云端模式隐藏出入金 tab"),
        ("fix: pre-push 同步 Secrets 从未生效", "pre-push 同步 Secrets 从未生效"),
        ("chore: bump CHANGELOG to [0.1.1]", "bump CHANGELOG to [0.1.1]"),
        ("docs: 更新 README", "更新 README"),
        ("refactor: 重构归因模块", "重构归因模块"),
        ("test: 新增回归用例", "新增回归用例"),
        ("perf: 缓存优化", "缓存优化"),
        ("ci: 升级 workflow", "升级 workflow"),
        ("build: 锁定依赖", "锁定依赖"),
        ("revert: 回滚 xxx", "回滚 xxx"),
        ("style: 修格式", "修格式"),
        # 带 scope
        ("feat(api): 新增路由", "新增路由"),
        ("fix(frontend): 修样式", "修样式"),
        # 破坏性标记
        ("refactor!: 破坏性重构", "破坏性重构"),
        ("feat(core)!: 破坏性接口调整", "破坏性接口调整"),
        # 无前缀，原样
        ("直接写的摘要没有前缀", "直接写的摘要没有前缀"),
        # 仅带冒号但不是合法 type，不剥离
        ("wip: 草稿", "wip: 草稿"),
    ],
)
def test_strip_commit_prefix(raw: str, want: str):
    assert bump_module.strip_commit_prefix(raw) == want


# ---------------------------------------------------------------------------
# bump() 集成：B + C 同时生效
# ---------------------------------------------------------------------------


def test_bump_strips_theme_and_commit_prefix(tmp_path, monkeypatch):
    changelog = tmp_path / "CHANGELOG.md"
    changelog.write_text(
        "# Changelog\n\n"
        "## [Unreleased]\n\n"
        "> Theme: 主题应折叠进标题或被删除，绝不能遗留到 released block\n\n"
        "### Changed\n\n"
        "- **示例条目**：用于验证清洗\n\n"
        "## [0.1.0] - 2026-04-08 - 初版\n\n"
        "### Added\n\n"
        "- **初版**：上线\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(bump_module, "CHANGELOG_PATH", changelog)
    monkeypatch.setattr(
        bump_module,
        "get_commit_summary",
        lambda: "feat: 云端只读模式隐藏出入金 tab",
    )

    result = bump_module.bump(explicit_version=None)
    assert result is not None, "有内容时 bump() 应执行版本化"

    after = changelog.read_text(encoding="utf-8")

    assert "> Theme:" not in after, (
        "违规 B：晋升后 released block 头顶绝不应遗留 `> Theme:` 行"
    )

    assert "feat:" not in after, (
        "违规 C：CHANGELOG 版本标题不应保留 Conventional Commits 前缀"
    )
    assert "云端只读模式隐藏出入金 tab" in after, "摘要正文应被保留"

    assert "## [Unreleased]\n\n## [0.1.0-" in after, (
        "新 [Unreleased] 应紧接一个新版本标题"
    )


def test_bump_keeps_content_when_no_theme_and_no_prefix(tmp_path, monkeypatch):
    """无 Theme、commit 无前缀时，原有行为不受新增清洗影响。"""
    changelog = tmp_path / "CHANGELOG.md"
    changelog.write_text(
        "# Changelog\n\n"
        "## [Unreleased]\n\n"
        "### Changed\n\n"
        "- **示例**：内容\n\n"
        "## [0.1.0] - 2026-04-08 - 初版\n\n"
        "### Added\n\n"
        "- **初版**：上线\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(bump_module, "CHANGELOG_PATH", changelog)
    monkeypatch.setattr(
        bump_module, "get_commit_summary", lambda: "改进某处的行为"
    )

    result = bump_module.bump(explicit_version=None)
    assert result is not None

    after = changelog.read_text(encoding="utf-8")
    assert "改进某处的行为" in after, "无前缀的摘要应完整保留"
    assert "- **示例**：内容" in after, "已有条目不应被破坏"


def test_bump_skips_when_unreleased_is_empty(tmp_path, monkeypatch):
    """[Unreleased] 空时 bump() 返回 None，不应触发任何清洗或晋升。"""
    changelog = tmp_path / "CHANGELOG.md"
    original = (
        "# Changelog\n\n"
        "## [Unreleased]\n\n"
        "## [0.1.0] - 2026-04-08 - 初版\n\n"
        "### Added\n\n"
        "- **初版**：上线\n"
    )
    changelog.write_text(original, encoding="utf-8")
    monkeypatch.setattr(bump_module, "CHANGELOG_PATH", changelog)

    assert bump_module.bump(explicit_version=None) is None
    assert changelog.read_text(encoding="utf-8") == original
