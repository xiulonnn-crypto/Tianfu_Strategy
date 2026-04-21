# CLAUDE.md — 项目说明书

美股交易助手：个人美股投资管理工具，基于 Flask + 纯前端单页，提供收益计算、资产配置、天府模型信号、策略复盘（含前瞻压测：极端情景与蒙特卡洛）等功能。支持本地全功能模式和 GitHub Pages 只读展示模式。

> 相关文档：[ARCHITECTURE.md](ARCHITECTURE.md) 系统架构 · [DESIGN.md](DESIGN.md) 页面样式 · [TECHNICAL.md](TECHNICAL.md) 技术细节

---

## 项目风格

- **单体架构**：`server.py`（~2800 行）+ `index.html` 单文件，极简依赖，无构建工具
- **纯 Python 后端**：不引入 Node.js / npm / 任何前端构建链
- **前端无框架**：原生 JS，CDN 引入 Tailwind CSS、Chart.js、Font Awesome
- **JSON 文件存储**：无数据库，数据量极小（百条交易记录级别）
- **双模式运行**：本地开发模式（Flask 全功能）+ GitHub Pages 只读展示模式（预计算静态 JSON）
- **轻奢紫金风格**：UI 主题为 Vanguard / Morningstar 风格，CSS 变量统一管控配色

---

## 命名规范

| 层面 | 规范 | 示例 |
|------|------|------|
| Python 变量/函数 | `snake_case` | `get_fund_records`, `load_model_state` |
| Python 常量 | `UPPER_SNAKE_CASE` | `YEARLY_RESERVE_INJECT`, `_CACHE_VERSION` |
| API 路径 | `kebab-case` | `/api/fund-records`, `/api/trade-summary` |
| 前端 JS 变量/函数 | `camelCase` | `chartReturns`, `renderAllocation` |
| 前端 JS 私有全局 | `__camelCase` 双下划线前缀 | `__isCloudMode`, `__sensitiveHidden` |
| CSS 自定义变量 | `--kebab-case` | `--deep-purple`, `--champagne-gold` |
| CSS 自定义类 | `kebab-case` | `returns-card`, `zone-group`, `priority-high` |
| HTML id | `camelCase` | `sectionReturns`, `modalFund` |
| 数据文件 | `snake_case.json` | `fund_records.json`, `model_state.json` |
| 预计算文件 | `kebab-case.json` | `trade-summary-all.json`, `returns-overview.json` |

---

## 禁止做什么

- **绝对不要**将原始交易数据（`trades.json`、`fund_records.json`、`model_state.json`）提交到仓库
- **不要**使用 `yf.download(["A","B"])` 批量拉取行情，会产生 MultiIndex 问题
- **不要**使用 PUT / DELETE HTTP 方法（macOS 和部分代理环境会拦截），统一用 POST
- **不要**将端口改为 5000 或 5001（5000 被 macOS 隔空播放占用），固定使用 **1001**
- **不要**引入 Node.js / npm / webpack / vite 等前端构建工具
- **不要**删除 `/api/version` 接口（前端依赖它做能力探测和本地/云端模式判断）
- **不要**在根目录 `/Users/soul/Documents/Cursor/server.py` 做任何修改（已是存档）
- **不要**在 `compute.py` 预计算时输出含敏感字段（price、shares、commission、amount、avg_cost）的数据
- **不要**在测试中直接读写真实的 `data/*.json` 文件，使用测试 fixture 隔离

---

## 必须做什么

- 改动 `server.py` 后必须重启服务（Ctrl+C → `python3 server.py`）
- 新增 GET 端点后必须同步更新 `compute.py` 的端点列表与脱敏逻辑
- 新增含敏感字段的 API 响应后必须在 `compute.py` 中添加对应的脱敏函数
- 所有写操作（增删改）统一使用 POST + 语义化子路径（`/api/xxx/update`、`/api/xxx/delete`）
- 修改价格缓存相关逻辑后递增 `_CACHE_VERSION` 使旧缓存失效
- 所有改动只在 `us-stock-trading-assistant/` 子目录中进行

---

## 常用命令

```bash
# 进入项目目录（所有命令的前提）
cd ~/Documents/Cursor/us-stock-trading-assistant

# 安装依赖
pip3 install -r requirements.txt

# 安装开发依赖（含测试工具）
pip3 install -r requirements-dev.txt

# 启动本地服务
python3 server.py
# 服务地址：http://localhost:1001

# 一键启动（安装依赖 + 启动 + 打开浏览器）
python3 run.py
# 或
./run.sh

# 运行测试（迁移后）
python3 -m pytest tests/ -v

# 运行旧版冒烟测试
python3 test_edit_delete.py

# 运行预计算（生成 data/computed/*.json）
python3 compute.py

# 同步 Secrets 到 GitHub（需先安装 gh CLI）
./sync-secrets.sh

# 查看测试覆盖率
python3 -m pytest tests/ --cov=server --cov-report=term-missing
```

---

## 环境

- **操作系统**：macOS（主要开发环境）
- **Python**：使用 `python3` / `pip3`，不是 `python` / `pip`
- **端口**：固定 **1001**（`server.py` 末尾 `app.run(port=1001)`）
- **项目目录**：`~/Documents/Cursor/us-stock-trading-assistant/`（所有命令须在此目录执行）
- **Python 版本**：≥3.11（CI 使用 3.11）

macOS 特殊处理：
- 若报 `xcrun: error: invalid active developer path`，执行 `xcode-select --install`
- 5000 端口被隔空播放（AirPlay Receiver）占用，不要使用

---

## 部署方式

### 本地全功能模式

```
浏览器 → http://localhost:1001/api/* → Flask(server.py) → data/*.json
```

完整功能，支持读写。

### GitHub Pages 只读展示模式

```
浏览器 → https://<user>.github.io/<repo>/data/computed/*.json
```

前端通过域名检测自动切换，仅展示脱敏后的预计算数据，不支持写操作。

### CI 预计算流水线

```
触发：push to main | 定时 UTC 22:00 周一-五 | 手动 workflow_dispatch
  ↓
GitHub Actions: checkout → pip install → 从 Secrets 恢复 data/*.json
  ↓
python3 compute.py（调用所有 GET 端点 → 脱敏 → 写入 data/computed/）
  ↓
git commit data/computed/ → git push（[skip ci]）
```

GitHub Secrets 管理：`TRADES_B64`、`FUND_RECORDS_B64`、`MODEL_STATE_B64`（base64 编码），通过 `sync-secrets.sh` 同步。

---

## 编码习惯与偏好

### 后端

- **JSON 文件 I/O**：统一通过 `load_json(path)` / `save_json(path, data)` 封装，不直接 `open()`
- **yfinance 行情**：逐标的循环拉取 `yf.Ticker(sym).history(...)`，不批量下载
- **价格缓存**：`price_cache.json` 存储日级行情，`_CACHE_VERSION` 递增触发全量失效
- **基准**：纳斯达克指数 `^IXIC`，常量 `BENCHMARK_SYMBOL`
- **错误处理**：API 返回 `{"error": "..."}` + HTTP 4xx/5xx，不抛出未处理异常
- **数值精度**：金融计算保留足够小数位，输出给前端时根据场景 round

### 前端

- **模式检测**：`window.location.hostname` 判断是否为 `github.io`，设置 `__isCloudMode`
- **API 调用**：本地模式走 `/api/*`，云端模式走 `./data/computed/*.json`
- **敏感数据切换**：`__sensitiveHidden` 控制金额/股数列显示，云端模式默认隐藏
- **图表实例**：先 `destroy()` 再 `new Chart()` 防止重复渲染

---

## 测试规范

> 详细测试方案见 [TECHNICAL.md](TECHNICAL.md#测试)，测试架构见 [ARCHITECTURE.md](ARCHITECTURE.md#测试架构)

### 框架与工具

- **框架**：pytest（迁移自脚本式 `test_edit_delete.py`）
- **配置**：`pytest.ini` + `conftest.py`
- **覆盖率**：pytest-cov，目标 ≥40%（起步），逐步提高至 ≥60%
- **Lint**：ruff（检查 + 格式化）

### 核心原则

- **数据隔离**：使用 `tmp_path` fixture + `tests/fixtures/` 样本数据，绝不读写真实 `data/*.json`
- **外部依赖 Mock**：使用 `unittest.mock.patch` Mock yfinance API，确保离线可运行
- **测试分层**：
  - 单元测试：纯函数（TWR/MWRR、分位数引擎、风险指标等）
  - API 测试：Flask `test_client()` 测试所有端点
  - 集成测试：`compute.py` 预计算 + 脱敏验证

### 目录结构（规划）

```
tests/
  conftest.py          # fixture：tmp_path 数据隔离、Mock yfinance
  fixtures/
    trades.json        # 标准化样本交易数据
    fund_records.json  # 标准化样本出入金数据
    model_state.json   # 标准化样本模型状态
  test_crud.py         # 出入金 + 交易增删改查测试
  test_readonly_api.py # 全部 GET 端点测试
  test_business.py     # 核心业务逻辑单元测试
  test_compute.py      # compute.py 脱敏与预计算测试
```
