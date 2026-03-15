#!/bin/bash
# 一键运行（Mac / Linux）：安装依赖、启动服务、打开页面
cd "$(dirname "$0")"
if command -v python3 >/dev/null 2>&1; then
  python3 run.py
else
  python run.py
fi
