# AGENTS.md — AI 协作关键约定

美股交易助手：Flask + 纯前端单页，个人美股投资管理工具。

> 完整文档：[CLAUDE.md](CLAUDE.md) 项目说明书 · [ARCHITECTURE.md](ARCHITECTURE.md) 系统架构 · [DESIGN.md](DESIGN.md) 页面样式 · [TECHNICAL.md](TECHNICAL.md) 技术细节

---

## 必须遵守（禁止项）

- **绝对不要**提交 `data/trades.json`、`data/fund_records.json`、`data/model_state.json`（含敏感数据，已 .gitignore）
- **不要**用 PUT/DELETE（改用 POST + `/update`/`/delete` 子路径）
- **不要**批量 `yf.download(["A","B"])`（改为逐标的循环拉取）
- **不要**改端口，固定 **1001**
- **不要**引入 Node.js / npm / 构建工具
- **不要**删除 `/api/version` 接口

## 必须遵守（必做项）

- 改 `server.py` 后需重启服务（Ctrl+C → `python3 server.py`）
- 新增 GET 端点时需同步更新 `compute.py` 的端点列表与脱敏逻辑
- 所有改动只在 `us-stock-trading-assistant/` 子目录中进行
- **新 clone 或换机器后**运行一次 `git config core.hooksPath .githooks` 启用项目内的 pre-push 钩子；它负责 ① CHANGELOG 自动版本化 ② 推送 `main` 时调用 `./sync-secrets.sh` 同步原始数据到 GitHub Secrets。未启用时推送不会同步 Secrets，CI 重算 `data/computed/*.json` 会长期用旧数据

## 运行环境

- macOS，用 `python3` / `pip3`，端口 **1001**
- 启动：`cd us-stock-trading-assistant && python3 server.py`

## 架构速览

```
浏览器
  ├─ 本地模式 → http://localhost:1001/api/* → Flask → data/*.json
  └─ 云端模式 → ./data/computed/*.json（静态，只读）

CI (GitHub Actions)
  git push main → .githooks/pre-push → ① CHANGELOG 版本化 + ② ./sync-secrets.sh（需 gh CLI 已登录）
  Secrets(base64) → data/*.json → compute.py → data/computed/*.json → [skip ci] 提交
```

**说明：** 原始数据在 `.gitignore` 中，仓库里只有预计算结果。CI 只能从 Secrets 还原 `data/*.json`；若只 `git push` 而不更新 Secrets，预计算仍用旧数据。项目通过 `git config core.hooksPath .githooks` 启用 `.githooks/pre-push`，它仅在推送 **refs/heads/main** 时调用 `./sync-secrets.sh`；其他分支跳过。同步失败会阻止 push，紧急可用 `git push --no-verify` 绕过（不推荐，云端仍会旧）。注意：`.git/hooks/` 在本项目已被 `core.hooksPath` 屏蔽，不要往那里放脚本（不会被调用）。

## API 一览

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/version` | 能力探测 |
| GET/POST | `/api/fund-records` | 出入金列表 / 新增 |
| POST | `/api/fund-records/delete` | 删除出入金 |
| POST | `/api/fund-records/update` | 修改出入金 |
| GET/POST | `/api/trades` | 交易列表 / 新增 |
| POST | `/api/trades/delete` | 删除交易 |
| POST | `/api/trades/update` | 修改交易 |
| GET | `/api/trade-summary?period=` | 交易汇总（all/year/month）|
| GET | `/api/returns-overview` | 收益概览（TWR/MWRR/对比/回撤）|
| GET | `/api/allocation` | 资产配置 |
| GET | `/api/asset-analysis/<symbol>` | 单标的分析 |
| GET | `/api/signals` | 天府模型信号与决策中心 |
| GET | `/api/strategy-review?period=` | 策略复盘 |
| （静态） | `./data/backtest/v1.3.1-*-{summary,nav,trades}.json` | 历史回测（前端直接 `fetch`，无 API；由 `scripts/import_backtest.py` 生成） |
| POST | `/api/update-settings` | 更新模型设置 |
| GET | `/api/stress-test` | 压力测试 + 蒙特卡洛 |
| POST | `/api/corp-actions/sync` | 从 Yahoo 同步分红、拆股至交易记录（body 可选 `{"symbol":"QQQM"}`） |

## 业务约定

- **分红 / 合股拆股**：由 `POST /api/corp-actions/sync` 写入，`type` 为 `分红` 或 `合股拆股`，`auto: true`。`分红` 仅增加股数、不增加现金成本；`合股拆股` 为同日「卖出旧股数 + 买入新股数」成对记录，亦不改变 `total_cost`。MWRR、交易汇总佣金、收益图加仓散点等会排除此类记录；持仓与平均成本仍按规则重算。

- **收益率周期起点统一规则**：首页 `/api/returns-overview` 与策略复盘 `/api/strategy-review` 的各周期收益率（TWR/MWRR/DCA）起点统一取 `max(时段起始日, since_date)`，保证起点不早于第一次持仓日期；`1D` 卡片除外，保留日级涨跌语义
- **策略复盘周期定义**：`1m` = 本月初，`3m` = 本季初，`all` = 全部；与首页 `periods` 字典使用同一历法概念，确保跨页同周期数据可直接对比

- **历史回测收益率曲线（静态 JSON）**：`data/backtest/*-nav.json` 经 `scripts/import_backtest.py --enrich-benchmark` 可写入 `port_ret_pct`（组合累计 %，按相对首日净值形状线性缩放到与 `summary.metrics.cumulative_return_pct` 一致，以便与 Excel 汇总一致；非逐笔日度 TWR）、`qqq_bh_pct` / `qqq_dca_pct`（QQQ 对比；QQQ IPO 前用 `^IXIC` 缩放拼接 proxy；DCA 为初始资金按日历月数均摊、每月首个有效交易日买入）。`summary.benchmark` 记录 `proxy_days`、`portfolio_curve` 等元数据

## 测试

- 现有冒烟测试：`python3 test_edit_delete.py`
- 规划迁移至 pytest，见 [TECHNICAL.md](TECHNICAL.md#5-测试)
