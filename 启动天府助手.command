#!/bin/bash
cd "$(dirname "$0")"

echo "正在启动天府计划助手..."
echo "地址: http://localhost:1001"
echo ""

# 2 秒后自动打开浏览器
(sleep 2 && open "http://localhost:1001") &

# 启动 Flask 服务
python3 server.py
