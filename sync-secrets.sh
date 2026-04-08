#!/bin/bash
# 将本地原始数据同步到 GitHub Secrets（需要已安装 gh CLI 并登录）
set -e

cd "$(dirname "$0")"

GH="${GH:-$(command -v gh || echo "$HOME/bin/gh")}"

echo "同步 trades.json ..."
base64 -i data/trades.json | "$GH" secret set TRADES_B64

echo "同步 fund_records.json ..."
base64 -i data/fund_records.json | "$GH" secret set FUND_RECORDS_B64

echo "同步 model_state.json ..."
base64 -i data/model_state.json | "$GH" secret set MODEL_STATE_B64

echo "✓ 全部 Secrets 已同步。"
