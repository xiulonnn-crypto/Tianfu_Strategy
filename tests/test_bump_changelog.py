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
    """Theme 存在时优先用 Theme 做摘要；Theme 行同时被剥离。"""
    changelog = tmp_path / "CHANGELOG.md"
    changelog.write_text(
        "# Changelog\n\n"
        "## [Unreleased]\n\n"
        "> Theme: 云端推送更稳\n\n"
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
        lambda: "feat: 这是不会被用到的 commit subject",
    )

    result = bump_module.bump(explicit_version=None)
    assert result is not None, "有内容时 bump() 应执行版本化"

    after = changelog.read_text(encoding="utf-8")

    assert "> Theme:" not in after, (
        "违规 B：晋升后 released block 头顶绝不应遗留 `> Theme:` 行"
    )
    assert "feat:" not in after, "CHANGELOG 不应保留 Conventional Commits 前缀"
    assert "云端推送更稳" in after, "Theme 内容应作为摘要进入标题"
    assert "commit subject" not in after, (
        "Theme 存在时，commit subject 不应用作摘要来源"
    )
    assert "## [Unreleased]\n\n## [0.1.0-" in after


def test_bump_falls_back_to_commit_subject_when_no_theme(tmp_path, monkeypatch):
    """无 Theme 时使用剥前缀后的 commit subject 作为摘要。"""
    changelog = tmp_path / "CHANGELOG.md"
    changelog.write_text(
        "# Changelog\n\n"
        "## [Unreleased]\n\n"
        "### Changed\n\n"
        "- **示例**：X\n\n"
        "## [0.1.0] - 2026-04-08 - 初版\n\n"
        "### Added\n\n"
        "- **初版**：上线\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(bump_module, "CHANGELOG_PATH", changelog)
    monkeypatch.setattr(
        bump_module,
        "get_commit_summary",
        lambda: "feat: 云端推送顺序更稳",
    )

    bump_module.bump(explicit_version=None)
    after = changelog.read_text(encoding="utf-8")
    assert "feat:" not in after
    assert "云端推送顺序更稳" in after


def test_sanitize_summary_truncates_long_text():
    """超长摘要按 Unicode 字符截断，末尾补省略号。"""
    long_text = "这是一段很长的主题文字" * 10
    out = bump_module.sanitize_summary(long_text)
    assert out is not None
    assert len(out) <= bump_module._SUMMARY_MAX_CHARS
    assert out.endswith("…")


def test_sanitize_summary_rejects_bullet_leakage():
    """摘要里出现 `**` 粗体标记时判定为 bullet 泄漏，返回 None。"""
    leaked = "**回程日景点与多段交通被整段漏抓**：像最后一天只在新宿"
    assert bump_module.sanitize_summary(leaked) is None


def test_sanitize_summary_handles_edge_cases():
    assert bump_module.sanitize_summary(None) is None
    assert bump_module.sanitize_summary("") is None
    assert bump_module.sanitize_summary("   ") is None
    assert bump_module.sanitize_summary("单句  带  连续空白") == "单句 带 连续空白"


def test_bump_drops_bullet_leaked_commit_subject(tmp_path, monkeypatch):
    """commit subject 若以粗体开头（说明是从 bullet 裁的），应被丢弃不入标题。"""
    changelog = tmp_path / "CHANGELOG.md"
    changelog.write_text(
        "# Changelog\n\n"
        "## [Unreleased]\n\n"
        "### Fixed\n\n"
        "- **回程日景点漏抓**：详细描述\n\n"
        "## [0.1.0] - 2026-04-08\n\n"
        "### Added\n\n- **初版**：上线\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(bump_module, "CHANGELOG_PATH", changelog)
    monkeypatch.setattr(
        bump_module,
        "get_commit_summary",
        lambda: "**回程日景点漏抓**：详细描述",
    )

    bump_module.bump(explicit_version=None)
    after = changelog.read_text(encoding="utf-8")
    assert "**回程日景点漏抓**" not in after.split("## [0.1.0]")[0].split("\n## [Unreleased]")[0], (
        "bullet-leaked subject 不应进入新版本标题"
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
