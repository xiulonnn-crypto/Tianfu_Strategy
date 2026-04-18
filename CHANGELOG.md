# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0-004] - 2026-04-18 - fix: pre-push 同步 Secrets 并入 .githooks（之前被 core.hooksPath 屏蔽永不生效）

### Fixed

- **pre-push 同步 Secrets 从未生效**：仓库已设 `git config core.hooksPath=.githooks`，Git 只从 `.githooks/` 调用钩子，完全忽略 `.git/hooks/`。上一版新增的 `scripts/hooks/pre-push`（同步 Secrets）经 `install-hooks.sh` 链到 `.git/hooks/pre-push`，但被 `core.hooksPath` 屏蔽 —— 真正被 git 调用的只有 `.githooks/pre-push`（仅做 CHANGELOG 版本化），从未调用过 `./sync-secrets.sh`。修复：把同步逻辑并入 `.githooks/pre-push`（CHANGELOG bump 之后，仅推送 `main` 时触发；失败阻塞推送），删除失效的 `scripts/hooks/`、`scripts/install-hooks.sh` 与 `.git/hooks/pre-push` 符号链接。`tests/test_pre_push_hook.py` 改为针对 git 实际入口的集成测试，新增 `test_repo_uses_githooks_as_hookspath` 与 `test_no_shadow_hook_under_scripts` 守住本类"hook 存在但不被 git 调用"的回归。首次启用仍需 `git config core.hooksPath .githooks` 一次（已写入 AGENTS.md）

## [0.1.0-003] - 2026-04-18 - feat: pre-push 自动同步 Secrets + 云端 JSON 版本号破缓存

### Fixed

- **GitHub Pages 数据不跟随 git push 更新**：线上历史交易页卡在旧日期（如缺失 4 月 2 日之后的记录）。根因是 CI (`.github/workflows/compute.yml`) 从 GitHub Secrets 还原原始数据，而 Secrets 仅能通过 `./sync-secrets.sh` 手动更新；`git push` 不会触发同步，CI 每次都用旧 Secrets 产出陈旧的 `data/computed/*.json`
- **手机浏览器看不到最新的 `data/computed/*.json`（电脑正常）**：线上云端只读模式下前端 `fetch('./data/computed/*.json')` 既未携带版本号也未声明 `cache: 'no-store'`，GitHub Pages 默认 `max-age=600` 叠加移动端（iOS Safari、微信 / 飞书 WebView 等）更激进的本地缓存策略，导致 CI 产出更新后手机端仍反复命中旧 JSON。现以数据版本号做 URL 变体破缓存：`compute.py` 每次预计算后在 `data/computed/version.json` 写入 `updated_at`（UTC ISO 时间戳）；`index.html` 新增 `ensureCloudVersion()`，云端模式启动时以 `cache: 'no-store'` 优先拉取 `version.json` 取得 `updated_at`，之后所有 `/api/*` → 静态文件映射在请求时自动附加 `?v=<updated_at>`；未更新时 URL 稳定、继续享受浏览器/CDN 缓存，一旦 CI 重算版本号改变，URL 即变新地址强制回源。并发首次访问通过 `__cloudVersionPromise` 去重单次请求；本地 Flask 模式完全不走该分支

### Added

- **Git pre-push hook 自动同步 Secrets**：新增 `scripts/hooks/pre-push` 与 `scripts/install-hooks.sh`。推送到 `main` 时会自动执行 `./sync-secrets.sh` 把本地 `data/{trades,fund_records,model_state}.json` 同步到 GitHub Secrets，保证后续 CI 拿到最新数据重算 `data/computed/*.json`。非 main 分支跳过；sync 失败阻止 push 并提示 `git push --no-verify` 绕过。首次使用需运行 `./scripts/install-hooks.sh` 安装（hook 以符号链接形式接入 `.git/hooks/`，后续跟随仓库更新）。`tests/test_pre_push_hook.py` 覆盖存在性、main/非 main 分支分支、失败阻塞三类行为

## [0.1.0-002] - 2026-04-17 - feat: 全量同步 — 文档体系、历史回测、pytest 套件与多处后端/前端增强

### Fixed

- **API 性能**：收益概览、交易汇总、模型信号、策略复盘、资产配置等端点暖路径显著加速（价格查询由 pandas 全表掩码改为字典 + bisect；持仓按日期前缀时间线 O(log n) 查询；风险指标内 `_twr_daily_returns` 只算一次）。各端点统一使用 `_compute_fetch_range` 与同一 `price_cache` 键，减少 Yahoo 重复拉取。`/api/signals` 大盘行情改为并行请求并带 60s 内存缓存。递增 `_CACHE_VERSION` 使旧 `price_cache.json` 失效

### Added

- **历史回测收益率对比曲线**：策略复盘 → 历史回测中净值卡片支持「NAV / 收益率」切换；收益率视图为三条累计收益 % 曲线——组合（与 `summary.metrics.cumulative_return_pct` 末值对齐的净值形状缩放）、QQQ 买入持有、QQQ 按月定投（初始资金均摊到日历月数）。QQQ 上市前用 `^IXIC` 按比例缩放衔接。离线字段由 `python3 scripts/import_backtest.py --enrich-benchmark` 写入 `*-nav.json` / `summary.benchmark`；`tests/test_backtest_enrich.py` 覆盖计算与 `^IXIC` 省略拉取（nav 起点晚于 IPO）
- **策略复盘 → 历史回测**：`section-review` 内新增「实盘复盘 / 历史回测」子 Tab；历史回测加载静态 `data/backtest/v1.3.1-{10y|20y|30y}-{summary|nav|trades}.json`（`fetch` 相对路径，本地与 GitHub Pages 一致）。支持 10/20/30 年窗口切换、净值/回撤 Chart.js 图、Top-3 回撤段、交易明细分页与 CSV 导出。数据由 `scripts/import_backtest.py` 从回测 Excel 一次性生成；`tests/test_backtest_data.py` 校验 JSON 结构
- **URL Hash 路由**：六个主 Tab（收益概览/资产配置/交易历史/模型信号/压力测试/策略复盘）对应 `#returns` `#allocation` `#history` `#signals` `#stress` `#review`；交易历史子 Tab 对应 `#history/fund` `#history/trades`；策略复盘子 Tab 对应 `#review/live` `#review/backtest`。刷新保持原 Tab、浏览器前进/后退在 Tab 间切换、URL 可直接分享指向指定 Tab；非法 / 过期 hash 自动回退到收益概览。纯前端实现，本地模式与云端（GitHub Pages）只读模式均可用，不涉及后端改动
- **公司行为同步**：`POST /api/corp-actions/sync` 从 Yahoo Finance 拉取 `Ticker.dividends` / `Ticker.splits`，自动写入 `type` 为「分红」「合股拆股」的交易（`auto: true`）；分红按再投资近似增加股数且不增加现金成本，拆股以成对买卖记录保持总成本不变。`/api/version` 增加 `corp_actions: true`；交易页提供「同步分红/拆股」按钮；`compute.py` 预计算前会先执行同步
- **交易明细筛选**：交易历史 → 交易明细 Tab 新增两个筛选下拉。「标的」根据当前交易记录动态生成（含`全部`选项，默认`全部`）；「类型」固定枚举 `全部 / 定投 / 投弹 / 投机 / 现金管理 / 分红 / 合股拆股`，默认`全部`。两个筛选为「与」关系，实时过滤表格，空结果显示「当前筛选下无交易明细」占位；本地与云端只读模式均可用
- **测试**：`tests/test_corp_actions.py` 覆盖成本语义与同步去重
- **测试**：`tests/test_price_index.py`、`tests/test_position_timeline.py` 对拍快速路径与旧实现；`tests/test_perf_endpoints.py` 在 mock 行情下断言上述五端点暖响应 < 1s

### Fixed

- 修复「策略复盘 → 历史回测」在本地模式下显示「加载失败：请确认已运行 scripts/import_backtest.py 并提交 data/backtest/*.json」的问题：根因是 Flask 只显式暴露 `/api/`* 与 `/`，`data/backtest/*.json` 没有任何路由（默认 `static_url_path` 不覆盖 `/data/...`），前端 `fetch('./data/backtest/v1.3.1-*.json')` 走到本地 1001 端口时返回 404。新增 `GET /data/backtest/<path:filename>` 路由，以 `send_from_directory(BASE_DIR/'data'/'backtest', ...)` 直出文件，`safe_join` 内置路径遍历防护。`tests/test_backtest_static_route.py` 覆盖三档正常路径、`..` 遍历、不存在文件的 404 行为。云端（GitHub Pages）路径不受影响
- 修复首页收益概览与策略复盘收益率数据不一致的问题：两处各卡片/周期的收益率起点统一规则为 `max(时段起始日, 第一次持仓日期)`，保证起点不早于组合成立日；跨页面同一周期（如首页"1m"与策略复盘"本月"、首页"since"与策略复盘"全部"）的 MWRR / DCA / 超额收益现可直接对比
- 首页 MTD 卡片之前直接以本月 1 日为起点，对于当月新建的组合会在尚未持仓的日期参与计算，现修正为 `max(本月 1 日, 第一次持仓日期)`
- 修复「同步分红/拆股」生成的再投资股数与 IB 实际对账不一致的问题：旧公式 `div × shares / ex_close` 忽略了美股 30% 预扣税与付息日 VWAP，2026-03-23 QQQM 分红系统记 0.212054 股、IB 实际 0.1539 股（差 +0.058 股/$14 对账分歧）。新公式 `div × shares × (1 - 预扣税率) / 付息日开盘价`，预扣税率与付息日工作日偏移做成可配置（`dividend_withholding_rate` 默认 0.30、`dividend_reinvest_offset_bd` 默认 5）。同时放开已自动生成的分红/拆股记录的编辑入口，保留原有手动新建仍被禁止的保护；分红行补充 `withholding_rate` / `pay_date` / `reinvest_price` / `gross_dividend_usd` / `div_per_share` 等审计元数据（`gross_dividend_usd` 已加入 `compute.py` 脱敏清单）
- 修复 `tests/test_corp_actions.py` 的 `tmp_trades_file` fixture 仅隔离 `TRADES_FILE` / `DATA_DIR`、未隔离 `MODEL_STATE_FILE` / `FUND_FILE` / `PRICE_CACHE_FILE` 的缺陷：测试中触发的 `save_model_state` / `/api/update-settings` 等曾污染真实 `data/model_state.json`；fixture 现补齐全部四个数据文件路径的 monkeypatch
- 修复「策略复盘 → 历史回测」30 年窗口 Alpha / Beta 显示为 `0 / 0` 的问题：源头 Excel 对 30 年跨度的 Alpha/Beta 公式失败（部分标的如 QQQM/QLD 无 30 年历史），单元格填 0，`scripts/import_backtest.py` 透传导致前端 `renderBacktestSubCards` 渲染 `0 / 0`。`scripts/import_backtest.py` 新增 `compute_alpha_beta_from_returns` / `compute_alpha_beta_for_nav`：基于 `nav.json` + yfinance `^IXIC` 做 CAPM 回归，β 用 1% / 99% winsorize 日收益去尖峰（应对资金注入引起的异常日），α 直接使用 `summary.cagr_pct` 作可信年化以避免 NAV 注入放大。Excel 值为 0/0 哨兵时才自动补算（保留 10y / 20y 原值），新增 `--recompute-risk` CLI 与 `--force` 开关；`tests/test_backtest_alpha_beta.py` 覆盖合成序列单测与三档周期断言。30y 现显示 `alpha_pct=0.31, beta=0.763`

### Changed

- 策略复盘周期切换器标签由"最近 1 月/最近 1 季"改为"本月/本季度"，对应 cutoff 改为自然月初/季初（与首页 MTD/YTD 同一历法概念）
- 交易明细「同步分红/拆股」按钮增加进行态反馈：点击后按钮禁用，文字变为「同步中...」，`fa-rotate` 图标叠加 `fa-spin` 类持续旋转，请求结束（成功 / 失败 / 异常）后自动恢复原标签与图标

## [0.1.0] - 2026-04-08

### Added

- Flask 后端 `server.py`（约 2800 行），承载 15+ REST API 端点，采用 POST 统一写操作风格
- 单页前端 `index.html`：原生 JS + Tailwind CSS CDN + Chart.js，轻奢紫金 UI 风格
- 出入金记录与交易记录完整 CRUD（新增 / 修改 / 删除 / 查询）
- 收益概览：TWR（时间加权）/ MWRR（资金加权）/ 最大回撤 / 走势图对比
- 风险指标：夏普比率（年化 √252）/ Alpha（区间超额收益）/ Beta（相对纳指）
- 资产配置面板：持仓权重 / 目标权重 / 实时行情（yfinance 逐标的拉取）
- 单标的分析：历史持仓、盈亏归因、交易明细
- 天府模型 v1.3.1：分位数引擎 / 风险预算链 R→K→T / 备弹池管理 / 触发器系统
- 决策中心：信号优先级、定投倍数、投弹建议金额、Put 保险计算
- 渐进熔断机制：软熔断（70% 仓位警示）/ 硬熔断（85% 仓位停止加仓）
- VIX 阈值触发：高波动警示（VIX ≥ 25）/ 极端波动防御（VIX ≥ 35）
- 策略复盘：绩效归因（定投 / 投弹 / 现金贡献度）+ 评分与建议
- 压力测试：极端情景冲击（2020疫情、2022熊市等）+ 蒙特卡洛模拟（10000 条路径）
- 双模式运行：本地全功能模式（Flask `localhost:1001`）/ GitHub Pages 只读展示模式
- GitHub Actions 预计算流水线：从 Secrets 恢复数据 → `compute.py` 脱敏计算 → 推送静态 JSON
- 日级价格缓存（`price_cache.json`），`_CACHE_VERSION` 常量控制全量失效
- 移动端响应式适配
- 一键启动脚本：`run.py` / `run.sh` / `启动天府助手.command`
- GitHub Secrets 同步工具 `sync-secrets.sh`（base64 编码存储敏感数据）

### Changed

- 渐进熔断默认阈值从旧值更新为 70%（软）/ 85%（硬）
- 收益率口径统一：Alpha 改用区间超额公式（非年化绝对偏差）
- API 路由全面切换为 `kebab-case`，写操作统一通过 POST + 子路径语义化

### Fixed

- 月初（第一个交易日）MTD 收益率及走势图无数据问题
- GitHub Pages 部署后 `var/const` 命名冲突导致整个脚本块失效

### Security

- 脱敏处理：`computed/*.json` 剔除价格、股数、佣金、均成本等敏感字段，仅保留结构与脱敏后的展示数据
- 云端模式（`github.io` 域名）下自动隐藏所有增删改操作入口，防止误触写入接口
- 原始数据文件（`trades.json` / `fund_records.json` / `model_state.json`）加入 `.gitignore`，仅通过 GitHub Secrets 传递

---

