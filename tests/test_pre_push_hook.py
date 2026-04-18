"""校验 pre-push hook 及其安装脚本存在，且在非 main 分支时不会触发同步。"""

from __future__ import annotations

import os
import stat
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HOOK_SRC = ROOT / "scripts" / "hooks" / "pre-push"
INSTALLER = ROOT / "scripts" / "install-hooks.sh"


def _is_exec(p: Path) -> bool:
    return p.is_file() and bool(p.stat().st_mode & stat.S_IXUSR)


def test_hook_file_exists_and_executable():
    assert HOOK_SRC.is_file(), f"missing {HOOK_SRC}"
    assert _is_exec(HOOK_SRC), f"{HOOK_SRC} must be executable"


def test_installer_exists_and_executable():
    assert INSTALLER.is_file(), f"missing {INSTALLER}"
    assert _is_exec(INSTALLER), f"{INSTALLER} must be executable"


def test_hook_skips_non_main_push(tmp_path, monkeypatch):
    """推送非 main 分支时 hook 必须快速退出 0，且不调用 sync-secrets.sh。"""
    fake_root = tmp_path / "repo"
    fake_root.mkdir()
    (fake_root / "sync-secrets.sh").write_text(
        "#!/bin/bash\necho SYNC_CALLED >&2\nexit 0\n",
        encoding="utf-8",
    )
    os.chmod(fake_root / "sync-secrets.sh", 0o755)

    hook_copy = fake_root / "pre-push"
    hook_copy.write_bytes(HOOK_SRC.read_bytes())
    os.chmod(hook_copy, 0o755)

    result = subprocess.run(
        [str(hook_copy), "origin", "git@github.com:x/y.git"],
        cwd=fake_root,
        input="refs/heads/dev abc refs/heads/dev def\n",
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode == 0, f"stdout={result.stdout} stderr={result.stderr}"
    assert "SYNC_CALLED" not in result.stderr, (
        f"hook should NOT sync on non-main push; stderr={result.stderr}"
    )


def test_hook_triggers_sync_on_main_push(tmp_path):
    """推送 main 分支时 hook 必须调用 ./sync-secrets.sh。"""
    fake_root = tmp_path / "repo"
    fake_root.mkdir()
    (fake_root / "sync-secrets.sh").write_text(
        "#!/bin/bash\necho SYNC_CALLED >&2\nexit 0\n",
        encoding="utf-8",
    )
    os.chmod(fake_root / "sync-secrets.sh", 0o755)

    hook_copy = fake_root / "pre-push"
    hook_copy.write_bytes(HOOK_SRC.read_bytes())
    os.chmod(hook_copy, 0o755)

    result = subprocess.run(
        [str(hook_copy), "origin", "git@github.com:x/y.git"],
        cwd=fake_root,
        input="refs/heads/main abc refs/heads/main def\n",
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode == 0, f"stdout={result.stdout} stderr={result.stderr}"
    assert "SYNC_CALLED" in result.stderr, (
        f"hook should sync on main push; stderr={result.stderr}"
    )


def test_hook_blocks_push_when_sync_fails(tmp_path):
    """若 sync-secrets.sh 返回非 0，hook 必须以非 0 退出，阻止 push。"""
    fake_root = tmp_path / "repo"
    fake_root.mkdir()
    (fake_root / "sync-secrets.sh").write_text(
        "#!/bin/bash\necho SYNC_FAILED >&2\nexit 1\n",
        encoding="utf-8",
    )
    os.chmod(fake_root / "sync-secrets.sh", 0o755)

    hook_copy = fake_root / "pre-push"
    hook_copy.write_bytes(HOOK_SRC.read_bytes())
    os.chmod(hook_copy, 0o755)

    result = subprocess.run(
        [str(hook_copy), "origin", "git@github.com:x/y.git"],
        cwd=fake_root,
        input="refs/heads/main abc refs/heads/main def\n",
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode != 0, (
        f"hook should fail when sync fails; stdout={result.stdout} stderr={result.stderr}"
    )
