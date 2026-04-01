# 美股交易助手

根据交易历史与 Yahoo Finance 股价计算真实收益，模型信号展示下次定投与投弹预估。

## 一键运行（推荐）

先进入项目目录（按你实际路径二选一）：
```bash
cd ~/Documents/Cursor/us-stock-trading-assistant
# 或
cd /Users/soul/Documents/Cursor/us-stock-trading-assistant
```

- **Windows**：双击 `run.bat`
- **Mac / Linux**：终端执行 `./run.sh` 或 `python3 run.py`（Mac 通常用 `python3`）

会自动安装依赖、启动服务并打开浏览器访问 http://localhost:5000 。

## 手动运行

```bash
pip install -r requirements.txt
python server.py
```

然后在浏览器打开 http://localhost:5000 。

## 文件夹说明

| 文件/夹       | 说明 |
|---------------|------|
| `run.py`      | 一键运行脚本（安装依赖 + 启动 + 打开浏览器） |
| `run.sh`      | Mac/Linux 启动脚本 |
| `run.bat`     | Windows 启动脚本 |
| `server.py`   | 后端服务 |
| `index.html` | 前端页面 |
| `data/`       | 出入金与交易明细数据（JSON） |
| `requirements.txt` | Python 依赖 |

停止服务：在运行窗口按 **Ctrl+C**（或关闭运行窗口）。

---

## Mac 报错 `xcrun: error: invalid active developer path`

说明本机 **Xcode 命令行工具**未安装或损坏。在终端执行：

```bash
xcode-select --install
```

按提示完成安装后，重新打开终端再运行 `python3 run.py`。若已用 Homebrew 安装 Python，可改用：

```bash
/opt/homebrew/bin/python3 run.py
```
