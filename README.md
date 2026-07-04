# 美股交易助手

根据交易历史与 Yahoo Finance 股价计算真实收益，模型信号展示下次定投与投弹预估。

## 一键运行（推荐）

先进入项目目录（按你实际路径二选一）：
```bash
cd ~/Documents/Cursor/us-stock-trading-assistant
# 或
cd /Users/soul/Documents/Cursor/us-stock-trading-assistant
```

- **Mac / Linux**：终端执行 `./run.sh` 或 `python3 run.py`（Mac 通常用 `python3`）
- **macOS 双击**：可运行 `启动天府助手.command`
- **Windows**：当前仓库未提交 `run.bat`，请在终端执行 `python run.py` 或 `python3 run.py`

会自动安装依赖、启动服务并打开浏览器访问 http://localhost:1001 。

## Python 版本

- 推荐使用 **Python 3.11**（GitHub Actions 预计算环境使用 3.11）。
- 本地仍以 `python3` / `pip3` 为准；当前代码在 macOS 自带 Python 3.9.6 下也可通过测试，但新机器建议优先安装 3.11。

## 手动运行

```bash
pip3 install -r requirements.txt
python3 server.py
```

然后在浏览器打开 http://localhost:1001 。

## 文件夹说明

| 文件/夹       | 说明 |
|---------------|------|
| `run.py`      | 一键运行脚本（安装依赖 + 启动 + 打开浏览器） |
| `run.sh`      | Mac/Linux 启动脚本 |
| `启动天府助手.command` | macOS 双击启动脚本 |
| `server.py`   | 后端服务 |
| `index.html` | 前端页面，实际加载 `js/main.js` |
| `js/common.js`、`js/tabs/*.js` | 前端源模块 |
| `js/main.js` | 前端拼接产物；修改源模块后运行 `python3 scripts/concat_js_modules.py` |
| `compute.py` | 预计算脚本，生成脱敏静态数据到 `data/computed/` |
| `data/`       | 原始敏感数据、脱敏静态数据和历史回测 JSON |
| `requirements.txt` | Python 依赖 |

停止服务：在运行窗口按 **Ctrl+C**（或关闭运行窗口）。

## 云端静态数据刷新

GitHub Pages 使用 `data/computed/*.json`，本地原始数据不会提交到仓库。需要手动刷新云端静态数据时：

```bash
python3 compute.py
pytest tests/test_cloud_sensitive.py
```

`compute.py` 会先同步 Yahoo 分红/拆股，再调用 Flask test client 生成所有 GET 端点对应的脱敏 JSON。若 `server.py` 有改动，按项目约定需重启本地服务。

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
