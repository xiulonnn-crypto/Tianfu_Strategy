# DESIGN.md — 页面样式与交互规范

> 相关文档：[CLAUDE.md](CLAUDE.md) 项目说明书 · [ARCHITECTURE.md](ARCHITECTURE.md) 系统架构 · [TECHNICAL.md](TECHNICAL.md) 技术细节

---

## 1. 设计风格

整体采用 **Vanguard / Morningstar 风格的轻奢紫金主题**，目标感：专业、克制、可信赖。

- **风格定位**：金融工具类 UI，信息密度高，强调数据可读性
- **主色调**：深紫（专业感）+ 香槟金（高端感）
- **字体**：中英文混排，系统字体优先，无自定义字体引入

---

## 2. 颜色规范

### 2.1 CSS 设计变量（`:root`）

| 变量 | 色值 | 用途 |
|------|------|------|
| `--deep-purple` | `#4A3D7C` | 主色调：导航栏底色、标题文字、主按钮底色、左边线强调、图表线条 |
| `--light-purple-bg` | `#F5F3FB` | 页面背景色、卡片内嵌区块底色、表格表头底色 |
| `--champagne-gold` | `#BFA960` | 强调色：Logo、活跃 Tab 下划线、资金利用率数值、移动端 Tab Bar active |
| `--benchmark-gray` | `#8A9199` | 辅助文字、图表标签、次要数据、Tooltip 图标 |
| `--down-red` | `#D64545` | 下跌/亏损/高优先级警示、错误状态 |

### 2.2 扩展语义色（内联使用）

| 色值 | 用途场景 |
|------|----------|
| `#2d2a3e` | body 正文色、主要数字 |
| `#2d8a5e` | 上涨/盈利/低优先级信号（绿）|
| `#0d9488` | 定投区域标识色（青绿）|
| `#6B5CA5` | 渐变紫底色（决策摘要大卡片）|
| `#dc2626` | Tailwind red-600（警告 Banner 文字）|
| `#fef2f2` | 警告区域底色（浅红）|
| `#fffbeb` | 黄色警告区底色 |
| `#fbbf24` | 黄色警告图标色 |
| `rgba(74,61,124,0.06)` | 卡片默认阴影 |
| `rgba(74,61,124,0.08)` | 卡片 hover 阴影 |
| `rgba(245,243,251,0.8)` | 表格行 hover 底色 |

### 2.3 Chart.js 图表配色序列

| 序号 | 色值 | 用途 |
|------|------|------|
| 1 | `#4A3D7C`（深紫）| 主策略收益线 |
| 2 | `#BFA960`（香槟金）| 基准对比线（纳指）|
| 3 | `#0d9488`（青绿）| 定投对比线 |
| 4 | `#D64545`（红）| 回撤区域填充 |
| 5 | `#8A9199`（灰）| 次要辅助线 |
| 6 | 透明度 0.15 填充 | 面积图填充层 |

---

## 3. 字体规范

### 字体栈

```css
font-family: 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
```

Windows 优先 Segoe UI，Mac/iOS 优先 PingFang SC，兼顾中英文混排。

### 字号层级

| 层级 | 大小 | Tailwind 类 | 用途 |
|------|------|-------------|------|
| 超大数字 | 28–32px | `text-3xl` / `text-4xl` | 核心指标（收益率、总资产）|
| 大标题 | 20–24px | `text-xl` / `text-2xl` | Section 标题、卡片主值 |
| 中标题 | 16–18px | `text-base` / `text-lg` | Zone 标题、子标题 |
| 正文 | 14px | `text-sm` | 主要文字内容 |
| 辅助 | 12px | `text-xs` | 标签、注释、表格辅助文字 |
| 微型 | 11px | `text-[11px]` | Tooltip 气泡、版本号 |

### 字重

- `font-semibold`（600）：卡片数值、表头
- `font-bold`（700）：关键指标数字、重要警示
- `font-medium`（500）：按钮文字、标签
- 默认（400）：正文、辅助说明

---

## 4. 页面结构

### 4.1 整体骨架

```
┌──────────────────────────────────────────────┐
│  Header（height: auto，深紫底色）              │
│  ├─ Logo + 标题（左）                          │
│  └─ 横向导航按钮组（右，桌面端显示）             │
├──────────────────────────────────────────────┤
│  Main（container-main，max-width: 1280px 居中）│
│  ├─ section-returns   （收益概览，默认显示）     │
│  ├─ section-allocation（资产配置，hidden）      │
│  ├─ section-history   （交易历史，hidden）      │
│  ├─ section-signals   （模型信号，hidden）      │
│  └─ section-review    （策略复盘，hidden；含前瞻压测子面板）│
├──────────────────────────────────────────────┤
│  Footer（居中文字 + 上边线分隔）               │
├──────────────────────────────────────────────┤
│  Mobile Tab Bar（fixed bottom，仅移动端）      │
└──────────────────────────────────────────────┘
```

单页多 Section 结构，通过 JS 切换 `hidden` 类控制显示/隐藏，切换时滚动回顶部。

### 4.2 导航系统

**桌面端（≥640px）**：Header 内横向按钮组（`id="mainNav"`），当前页按钮以 `bg-white/20` 半透明白色底色高亮，`data-section` 属性对应 Section ID。

**移动端（<640px）**：隐藏 Header 导航，底部固定 Tab Bar（5 个图标 + 文字），active 状态变为香槟金色（`style="color: var(--champagne-gold)"`）。使用 `env(safe-area-inset-bottom)` 适配 iPhone 刘海屏安全区。

### 4.3 五大 Section 布局

#### 收益概览 `section-returns`

```
策略说明横幅（紫色左边线 .priority-low 改为固定左边线）
↓
5 张收益卡片（.returns-card）
  桌面：grid grid-cols-5；移动：grid-cols-2，最后一张 col-span-2
  点击切换时间周期 → 高亮卡片加 .card-highlight（紫色边框）
↓
收益率对比行（TWR + MWRR 双数值 + 同期基准）
↓
4 格风险指标（最大回撤 / 夏普比 / Alpha / Beta）
  每格右上角带 .info-tip 悬浮解释气泡
↓
走势图（Chart.js canvas #chartReturns，h-80/200px）
  3 种对比模式切换按钮（.chart-cmp-btn）
↓
策略驱动力归因（环形图 #chartStrategyDriver + 标签列表）
  可展开交易明细（点击行展开）
↓
回撤走势图（#chartDrawdown，h-48/140px）+ Top-3 历史最大回撤卡片
```

#### 资产配置 `section-allocation`

```
预警 Banner（仓位超限时条件显示，.priority-high 红色左边线）
↓
双饼图并排（总资产 #chartAllocation / 风险资产 #chartRiskAllocation）
  桌面：flex gap；移动：2 列 w-28→w-48 响应式
↓
持仓明细表（6~7 列）
  含当前比例 vs 目标比例的进度条（.bg-deep-purple 填充色）
  点击表行展开单标的盈亏归因面板
↓
单标的归因面板（条件显示）
  面积图 #chartAssetAnalysis + 侧边指标卡 + 交易明细表
```

#### 交易历史 `section-history`

```
后端升级提示 Banner（版本不足时条件显示）
↓
标题行 + "一键隐藏" 按钮（.btn-toggle-sensitive）
  云端模式下按钮禁用（始终隐藏）
↓
5 格交易汇总统计
  入金 / 出金 / 佣金 / 资金利用率（.champagne-gold 强调）/ 周期切换（.sum-period-btn）
  移动端：最后一格独占整行
↓
子标签切换（出入金记录 / 交易明细）
  .tab-active = 金色下划线 + 深紫文字
↓
数据表格（#tableFund / #tableTrades）
  可排序表头、编辑/删除操作列
  云端模式：.cloud-hide-col 列隐藏
  移动端：.col-shares / .col-avg 等次要列隐藏
```

#### 模型信号 `section-signals`（决策中心）

```
预警 Banner（下行强补信号时条件显示，.priority-high）
↓
标题 + 版本号 v1.3.1 + 更新时间
↓
一句话决策摘要（渐变紫色大卡片，background: linear-gradient(135deg, #4A3D7C, #6B5CA5)）
↓
指标区（.zone-group，全宽）
  ├─ 大盘现状（4 格卡片：指数/VIX/QQQM 仓位/备弹池）
  ├─ 分位数引擎（6 格：各标的当前分位 + 信号颜色）
  └─ 风险预算（R→K→T 链路数值展示）
↓
三列横排（.zone-row-3，桌面 3 等分，移动端堆叠）
  ├─ 投弹区（.zone-c-red 红色左边线）
  │   触发预警列表 + 备弹池健康度进度条 + 投弹预估金额
  ├─ 定投区（.zone-c-teal 青绿左边线）
  │   月投仪表盘（已投/计划/剩余）+ 下次定投时间
  └─ 风控区（.zone-c-gold 金色左边线）
      QQQM 仓位熔断状态 + Put 保险建议
```

`.zone-row-3` 在 `≥1024px` 时生效 `grid-template-columns: repeat(3, 1fr)`。

#### 策略复盘 `section-review`

```
主导航子 Tab（实盘复盘 / 历史回测 / 前瞻压测，.tab-active = 金色下划线 + 深紫字）
↓
【实盘复盘】
  周期切换按钮组（1 月 / 1 季 / 全部，激活状态：深紫底白字）
  ↓
  5 格指标卡片
    纪律分 / 合规分 / 超额收益 / 投弹效率 / 安全系数
    每格含数值 + 趋势箭头 + 评语
  ↓
  AI 反思助手结论文本（带结论分级标识）
  ↓
  参数调整建议
    当前参数展示 + 偏差警告 + "立即调整" 操作按钮
↓
【历史回测】（静态数据 ./data/backtest/v1.3.1-*.json，无敏感字段）
  窗口切换（10 年 / 20 年 / 30 年，样式同 .sum-period-btn）
  ↓
  元信息横幅 .priority-low（标的、区间、初始资金、费率、滑点）
  ↓
  核心 5 格 .returns-card（累积收益 / 年化 / 最大回撤 / 夏普 / 最终资金）
  ↓
  次要 4 格（胜率 / 盈亏比 / 交易次数 / Alpha·Beta）
  ↓
  净值曲线 #chartBacktestNav（区间：全部 / 近 5 年 / 近 1 年；坐标：线性 / 对数）
  ↓
  回撤走势 #chartBacktestDrawdown + Top-3 回撤事件卡片（与首页回撤卡片样式一致）
  ↓
  交易明细分页表 + 下载 CSV
↓
【前瞻压测】（`#review/stress`，懒加载：点「运行压力测试」后请求 `/api/stress-test`）
  标题 + "运行压力测试" 按钮（主按钮样式）
  ↓
  极端情景结果（QQQ/VIX 情景、各标的冲击、投弹触发模拟、生存评估）
  ↓
  蒙特卡洛概率分布（canvas #chartMonteCarlo、分位数网格）
```

---

## 5. 组件规范

### 5.1 卡片

`.returns-card` / `.zone-group`

```css
background: #fff;
border-radius: 12px;
box-shadow: 0 2px 12px rgba(74, 61, 124, 0.08);
border: 2px solid transparent;
```

高亮状态 `.card-highlight`：`border: 2px solid var(--deep-purple)`。

### 5.2 按钮

| 类型 | 样式 | 最小尺寸 |
|------|------|----------|
| 主操作按钮 | 深紫底（`#4A3D7C`）白字，`rounded-lg px-4 py-2` | 高度 ≥36px（移动端触达保障）|
| 次要按钮 | 白底深紫描边（`border border-[#4A3D7C] text-[#4A3D7C]`），`rounded-lg px-4 py-2` | 高度 ≥36px |
| 切换/标签按钮 | 激活：深紫底白字；未激活：白底深紫文字 | 高度 ≥32px |
| 危险按钮（删除）| 红底（`bg-red-500`）白字或白底红色描边 | 高度 ≥32px |
| 图标按钮 | 透明底，hover 浅紫背景，图标色继承 | 最小 32×32px |

### 5.3 表格

```
表头（thead th）：background: var(--light-purple-bg)；color: var(--deep-purple)；font-weight: 600
行 hover：background: rgba(245, 243, 251, 0.8)
边框：border-b 淡灰分隔线
内边距：px-3 py-2（桌面）；px-2 py-1.5（移动端）
```

**移动端列隐藏策略**（按优先级）：

| 优先级 | 列类型 | 处理方式 |
|--------|--------|----------|
| 必须显示 | 日期、标的/金额、核心数值 | 始终显示 |
| 可隐藏 | 股数（.col-shares）、成本（.col-avg）、佣金（.col-commission）| `hidden sm:table-cell` |
| 按需隐藏 | 操作列（.cloud-hide-col）| 云端模式 `display: none` |

### 5.4 弹窗（Modal）

3 个弹窗：出入金（`#modalFund`）、交易（`#modalTrade`）、智能粘贴（`#modalSmartPaste`）

```
遮罩：fixed inset-0 bg-black/50 z-50
面板：bg-white rounded-xl shadow-xl
  桌面：max-w-md（出入金）/ max-w-lg（交易）/ max-w-2xl（智能粘贴）
  移动：w-[calc(100%-2rem)]，接近满屏
内边距：p-6
关闭：右上角 × 按钮 + 遮罩点击关闭
```

### 5.5 Tooltip（信息气泡）

`.info-tip` + `.info-tip-text`

```
触发：hover（桌面）
气泡：暗色底 #2d2a3e，白字，font-size: 11px，line-height: 1.5
内边距：6px 10px，border-radius: 6px
位置：向上弹出（bottom: calc(100% + 6px)），水平居中
箭头：下三角，border-top-color: #2d2a3e
移动端：max-width: 220px 自动换行
```

### 5.6 优先级左边线

| 类 | 颜色 | 用途 |
|----|------|------|
| `.priority-high` | `border-left: 4px solid var(--down-red)` | 红色：高优先级信号、重要警示 |
| `.priority-mid` | `border-left: 4px solid var(--champagne-gold)` | 金色：中优先级信号 |
| `.priority-low` | `border-left: 4px solid #2d8a5e` | 绿色：低优先级、正常状态 |

### 5.7 Zone 区域色标

| 类 | 颜色 | 区域 |
|----|------|------|
| `.zone-c-red` | `border-left: 4px solid var(--down-red)` | 投弹区 |
| `.zone-c-teal` | `border-left: 4px solid #0d9488` | 定投区 |
| `.zone-c-gold` | `border-left: 4px solid var(--champagne-gold)` | 风控区 |
| `.zone-c-purple` | `border-left: 4px solid var(--deep-purple)` | 指标区 |

### 5.8 进度条

```
容器：bg-gray-200 rounded-full h-2（或 h-1.5）
填充：bg-[var(--deep-purple)] rounded-full，width 由 JS 动态设置
特殊：备弹池健康度进度条随值变色（绿/黄/红）
```

### 5.9 Loading / 空状态

- **加载中**：Section 内容区显示旋转图标（Font Awesome `fa-spinner fa-spin`）+ "加载中..."
- **加载失败**：红色警示文字 + 错误信息摘要
- **空数据**：灰色辅助文字说明（如"暂无交易记录"）

---

## 6. 响应式策略

| 断点 | Tailwind 前缀 | 行为 |
|------|---------------|------|
| `<640px`（移动端）| - | 隐藏 Header 导航 → 底部 Tab Bar；卡片 2 列；图表高度压缩；表格隐藏次要列并紧缩 padding；弹窗近满屏；按钮最小高度 36px |
| `640px–1023px`（平板）| `sm:` | Tailwind sm 响应式栅格生效 |
| `≥1024px`（桌面）| `lg:` | container-main 1280px 居中；决策中心三列布局（`.zone-row-3` grid）|

### 移动端特殊处理

```css
/* Tab Bar 留空间 */
body { padding-bottom: calc(64px + env(safe-area-inset-bottom)); }

/* 图表高度压缩 */
@media (max-width: 640px) {
  .h-80 { height: 200px; }
  .h-48 { height: 140px; }
  .h-64 { height: 180px; }
}
```

- 策略驱动力归因栅格移动端降为单列（`grid-cols-1`）
- 交易汇总统计最后一格独占整行（`col-span-2`）
- 双饼图移动端宽度 `w-28`（72px），桌面 `sm:w-48`（192px）

---

## 7. 云端模式 UI 差异

| 特性 | 本地模式 | 云端模式 |
|------|----------|----------|
| 金额/股数列 | 可显示/隐藏 | 默认隐藏（`__sensitiveHidden = true`）|
| 操作列（.cloud-hide-col）| 显示（编辑/删除按钮）| 隐藏（`display: none`）|
| "一键隐藏" 按钮 | 可点击切换 | 点击无效（数据始终隐藏）|
| 新增/编辑/删除弹窗 | 可用 | 不展示触发入口 |
| 数据来源 | `/api/*` Flask | `./data/computed/*.json` 静态文件 |
