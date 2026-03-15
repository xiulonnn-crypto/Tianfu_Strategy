# -*- coding: utf-8 -*-
"""
一键运行：安装依赖、启动后端、自动打开浏览器。
直接执行：python run.py  或双击 run.bat / run.sh
"""
import os
import sys
import time
import webbrowser
import subprocess

def main():
    # 切换到脚本所在目录，保证 server 与 data 路径正确
    base = os.path.dirname(os.path.abspath(__file__))
    os.chdir(base)

    print("正在安装依赖...")
    subprocess.check_call(
        [sys.executable, "-m", "pip", "install", "-q", "-r", "requirements.txt"],
        cwd=base,
    )

    print("正在启动服务（端口 5001）...")
    proc = subprocess.Popen(
        [sys.executable, "-u", "server.py"],
        cwd=base,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.STDOUT,
    )

    time.sleep(2)
    url = "http://localhost:5001"
    print("正在打开浏览器:", url)
    webbrowser.open(url)

    print("服务已运行，按 Ctrl+C 停止。")
    try:
        proc.wait()
    except KeyboardInterrupt:
        proc.terminate()
        proc.wait()
        print("已停止。")

if __name__ == "__main__":
    main()
