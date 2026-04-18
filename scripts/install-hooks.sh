#!/bin/bash
# 安装项目内版本化的 git hooks 到当前 .git/hooks/ 目录（使用符号链接，便于跟随更新）。
# 用法：./scripts/install-hooks.sh
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HOOKS_SRC="$SCRIPT_DIR/hooks"
HOOKS_DST="$REPO_ROOT/.git/hooks"

if [ ! -d "$HOOKS_DST" ]; then
  echo "❌ 未找到 $HOOKS_DST；请在 git 仓库内运行。" >&2
  exit 1
fi

installed=0
for src in "$HOOKS_SRC"/*; do
  [ -f "$src" ] || continue
  name="$(basename "$src")"
  dst="$HOOKS_DST/$name"
  chmod +x "$src"
  ln -sf "$src" "$dst"
  echo "✓ 安装 $name → $dst"
  installed=$((installed + 1))
done

if [ "$installed" -eq 0 ]; then
  echo "（scripts/hooks/ 下没有可安装的 hook）"
else
  echo ""
  echo "完成。已安装 $installed 个 hook。"
  echo "临时绕过：git push --no-verify"
fi
