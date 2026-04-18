"""校验 git 实际会调用的 pre-push hook。

Git 以 `core.hooksPath` 指定的目录（本项目为 `.githooks/`）为唯一 hook 来源，
完全忽略 `.git/hooks/`。因此本测试必须针对 `.githooks/pre-push`（真实入口），
而不是仓库里任何其他看起来是 hook 但 git 不会调用的脚本，否则测试通过 ≠
行为生效。
"""

from __future__ import annotations

import os
import shutil
import stat
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HOOKS_DIR = ROOT / ".githooks"
ACTIVE_HOOK = HOOKS_DIR / "pre-push"
BUMP_SCRIPT = HOOKS_DIR / "bump_changelog.py"


def _is_exec(p: Path) -> bool:
    return p.is_file() and bool(p.stat().st_mode & stat.S_IXUSR)


def _materialize_sandbox(
    tmp_path: Path,
    sync_body: str,
    *,
    create_changelog: bool = True,
) -> Path:
    """在 tmp_path 中复刻一个最小仓库，挂载真实 hook 与桩 sync-secrets.sh。"""
    fake_root = tmp_path / "repo"
    fake_root.mkdir()

    hooks_dst = fake_root / ".githooks"
    hooks_dst.mkdir()
    shutil.copy2(ACTIVE_HOOK, hooks_dst / "pre-push")
    os.chmod(hooks_dst / "pre-push", 0o755)
    if BUMP_SCRIPT.exists():
        shutil.copy2(BUMP_SCRIPT, hooks_dst / "bump_changelog.py")

    if create_changelog:
        (fake_root / "CHANGELOG.md").write_text(
            "# Changelog\n\n## [Unreleased]\n\n",
            encoding="utf-8",
        )

    sync = fake_root / "sync-secrets.sh"
    sync.write_text(sync_body, encoding="utf-8")
    os.chmod(sync, 0o755)
    return fake_root


def _run_hook(fake_root: Path, stdin_line: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [str(fake_root / ".githooks" / "pre-push"), "origin", "git@x:x/x.git"],
        cwd=fake_root,
        input=stdin_line,
        capture_output=True,
        text=True,
        timeout=15,
    )


def test_active_hook_file_exists_and_executable():
    assert ACTIVE_HOOK.is_file(), (
        f"未找到实际会被 git 调用的 hook：{ACTIVE_HOOK}"
    )
    assert _is_exec(ACTIVE_HOOK), f"{ACTIVE_HOOK} 必须可执行"


def test_repo_uses_githooks_as_hookspath():
    """若改回默认 hooksPath，需同步更新本测试文件与 AGENTS.md。"""
    result = subprocess.run(
        ["git", "config", "--get", "core.hooksPath"],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, (
        "未设置 core.hooksPath；若改为默认 `.git/hooks/` 请同步调整测试。"
    )
    assert result.stdout.strip() == ".githooks", (
        f"core.hooksPath 期望 `.githooks`，实际为 `{result.stdout.strip()}`；"
        "本测试假设 git 走 .githooks/pre-push"
    )


def test_no_shadow_hook_under_scripts():
    """防止再引入一个 `scripts/hooks/pre-push` —— 它会被 core.hooksPath 屏蔽。"""
    shadow = ROOT / "scripts" / "hooks" / "pre-push"
    assert not shadow.exists(), (
        f"检测到 shadow hook：{shadow}\n"
        "git 启用了 core.hooksPath=.githooks，该文件不会被调用，容易误以为生效。"
        "请把逻辑并入 .githooks/pre-push。"
    )


def test_active_hook_syncs_on_main_push(tmp_path):
    fake_root = _materialize_sandbox(
        tmp_path,
        "#!/bin/bash\necho SYNC_CALLED >&2\nexit 0\n",
    )
    result = _run_hook(fake_root, "refs/heads/main abc refs/heads/main def\n")
    assert result.returncode == 0, (
        f"main 推送 + sync 成功时 hook 应 0 退出；stderr={result.stderr}"
    )
    assert "SYNC_CALLED" in result.stderr, (
        f"main 推送必须调用 ./sync-secrets.sh；stderr={result.stderr}"
    )


def test_active_hook_skips_sync_on_non_main_push(tmp_path):
    fake_root = _materialize_sandbox(
        tmp_path,
        "#!/bin/bash\necho SYNC_CALLED >&2\nexit 0\n",
    )
    result = _run_hook(fake_root, "refs/heads/dev abc refs/heads/dev def\n")
    assert result.returncode == 0, (
        f"非 main 推送时 hook 应 0 退出；stderr={result.stderr}"
    )
    assert "SYNC_CALLED" not in result.stderr, (
        f"非 main 推送不得触发 sync；stderr={result.stderr}"
    )


def test_active_hook_blocks_push_when_sync_fails(tmp_path):
    fake_root = _materialize_sandbox(
        tmp_path,
        "#!/bin/bash\necho SYNC_FAILED >&2\nexit 1\n",
    )
    result = _run_hook(fake_root, "refs/heads/main abc refs/heads/main def\n")
    assert result.returncode != 0, (
        "sync 失败时 hook 必须以非 0 退出阻止 push；"
        f"stdout={result.stdout} stderr={result.stderr}"
    )
    assert "SYNC_FAILED" in result.stderr
