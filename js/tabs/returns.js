// ========== 收益概览：从后端拉取并渲染卡片 + 图表 ==========
    function formatPct(num) {
      if (num == null || isNaN(num)) return '--';
      const s = num >= 0 ? '+' + num.toFixed(2) : num.toFixed(2);
      return s + '%';
    }
    function formatUsd(num) {
      if (num == null || isNaN(num)) return '--';
      const s = num >= 0 ? '+$' + Number(num).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '-$' + Math.abs(num).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      return s;
    }
    function updateReturnsCards(cards) {
      if (!cards) return;
      const dataValuePrefix = { '1d': '1d', '1m': '1m', '1y': '1y', '1y_roll': '1y-roll', 'since': 'since' };
      Object.keys(dataValuePrefix).forEach(function (k) {
        const c = cards[k];
        const prefix = dataValuePrefix[k];
        const pctEl = document.querySelector('[data-value="' + prefix + '-pct"]');
        if (pctEl) {
          pctEl.textContent = formatPct(c && c.pct);
          pctEl.style.color = (c && c.pct != null && c.pct < 0) ? '#D64545' : '#2d2a3e';
        }
      });
    }
    function buildReturnsChart(period) {
      try {
        var ph = document.getElementById('chartReturnsPlaceholder');
        if (typeof Chart === 'undefined') { if (ph) ph.style.display = 'flex'; return; }
        var chartKey = period === '1y-roll' ? '1y_roll' : period;
        var data = returnsOverview && returnsOverview.chart && returnsOverview.chart[chartKey]
          ? returnsOverview.chart[chartKey] : { labels: [], my: [], bench: [], dca: [], buy_markers: [] };
        var ctx = document.getElementById('chartReturns');
        if (!ctx) { if (ph) ph.style.display = 'flex'; return; }
        if (chartReturns) chartReturns.destroy();
        var hasChartData = (data.labels && data.labels.length) > 0;
        if (ph) ph.style.display = hasChartData ? 'none' : 'flex';

        // DCA 说明文字
        var dcaNote = document.getElementById('dcaExplainNote');
        var mode = chartCompareMode || 'bench';
        if (dcaNote) dcaNote.classList.toggle('hidden', mode === 'bench');

        var datasets = [
          { label: 'Portfolio (TWR)', data: data.my || [], borderColor: '#4A3D7C', backgroundColor: 'rgba(74,61,124,0.06)', fill: true, tension: 0.3, borderWidth: 2, pointRadius: 0 },
        ];
        if (mode === 'bench' || mode === 'all') {
          datasets.push({ label: 'Nasdaq (Benchmark)', data: data.bench || [], borderColor: '#8A9199', backgroundColor: 'rgba(138,145,153,0.04)', fill: true, tension: 0.3, borderWidth: 1.5, pointRadius: 0 });
        }
        if (mode === 'dca' || mode === 'all') {
          datasets.push({ label: '等额定投 (DCA)', data: data.dca || [], borderColor: '#BFA960', backgroundColor: 'rgba(191,169,96,0.04)', fill: false, tension: 0.3, borderWidth: 1.5, borderDash: [6, 3], pointRadius: 0 });
        }

        // 定投/投弹散点标记（叠加在 Portfolio 线上）
        var markers = data.buy_markers || [];
        if (markers.length > 0 && data.my) {
          var toundanLine = new Array(data.labels.length).fill(null);
          var dingtouLine = new Array(data.labels.length).fill(null);
          var toundanMeta = {}, dingtouMeta = {};
          markers.forEach(function(m) {
            var val = data.my[m.idx];
            if (val == null) return;
            if (m.type === '投弹') { toundanLine[m.idx] = val; toundanMeta[m.idx] = m; }
            else { dingtouLine[m.idx] = val; dingtouMeta[m.idx] = m; }
          });
          datasets.push({
            label: '投弹', data: toundanLine, borderColor: 'transparent', backgroundColor: '#dc2626',
            pointStyle: 'triangle', pointRadius: 6, pointHoverRadius: 8, showLine: false, order: 0, _meta: toundanMeta,
          });
          datasets.push({
            label: '定投', data: dingtouLine, borderColor: 'transparent', backgroundColor: '#4A3D7C',
            pointStyle: 'circle', pointRadius: 4, pointHoverRadius: 6, showLine: false, order: 0, _meta: dingtouMeta,
          });
        }

        chartReturns = new Chart(ctx, {
        type: 'line',
          data: { labels: data.labels || [], datasets: datasets },
        options: {
            responsive: true, maintainAspectRatio: false,
          interaction: { intersect: false, mode: 'index' },
          plugins: {
            legend: { position: 'top', labels: { color: '#2d2a3e', usePointStyle: true } },
            tooltip: {
                mode: 'index', intersect: false,
                filter: function(item) { return item.raw != null; },
              callbacks: {
                label: function (c) {
                    if (c.dataset._meta && c.dataset._meta[c.dataIndex]) {
                      var m = c.dataset._meta[c.dataIndex];
                      return m.type + ' ' + m.symbol + ' ' + _m('$' + m.price_shares);
                    }
                    return c.dataset.label + ': ' + (c.parsed.y != null ? c.parsed.y : '--') + '%';
                  }
              }
            }
          },
          scales: {
              x: { grid: { display: false }, ticks: { color: '#8A9199', maxTicksLimit: 10 } },
            y: { grid: { color: 'rgba(138,145,153,0.15)' }, ticks: { color: '#8A9199' }, beginAtZero: true }
          }
        }
      });
      } catch (err) {}
    }
    function setReturnsCardsNoData() {
      var prefixes = ['1d', '1m', '1y', '1y-roll', 'since'];
      prefixes.forEach(function (p) {
        var pctEl = document.querySelector('[data-value="' + p + '-pct"]');
        if (pctEl) pctEl.textContent = '暂无数据';
      });
    }
    function periodToRiskKey(p) { return p === '1y-roll' ? '1y_roll' : (p || '1y'); }

    // ===== Drawdown 图表 =====
    var chartDrawdown = null;
    function buildDrawdownChart(risk) {
      var ph = document.getElementById('chartDrawdownPlaceholder');
      var ctx = document.getElementById('chartDrawdown');
      if (!ctx || typeof Chart === 'undefined') { if (ph) ph.style.display = 'flex'; return; }
      if (chartDrawdown) chartDrawdown.destroy();
      var ds = risk && risk.drawdown_series;
      var bds = risk && risk.bench_drawdown_series;
      var hasData = ds && ds.labels && ds.labels.length > 0;
      if (ph) ph.style.display = hasData ? 'none' : 'flex';
      if (!hasData) return;
      var datasets = [{ label: '组合回撤 %', data: ds.values, borderColor: '#D64545', backgroundColor: 'rgba(214,69,69,0.12)', fill: true, tension: 0.2, borderWidth: 1.5, pointRadius: 0, order: 1 }];
      var hasBench = bds && bds.values && bds.values.length === ds.values.length && bds.values.some(function(v) { return v != null; });
      if (hasBench) {
        datasets.push({ label: '纳指回撤 %', data: bds.values, borderColor: '#8A9199', backgroundColor: 'transparent', fill: false, tension: 0.2, borderWidth: 1.5, borderDash: [5, 4], pointRadius: 0, order: 0 });
      }
      chartDrawdown = new Chart(ctx, {
        type: 'line',
        data: { labels: ds.labels, datasets: datasets },
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: { intersect: false, mode: 'index' },
          plugins: {
            legend: { display: hasBench, position: 'top', align: 'end', labels: { boxWidth: 16, color: '#8A9199', font: { size: 11 }, usePointStyle: true } },
            tooltip: { callbacks: { label: function(c) { return c.dataset.label + '：' + c.parsed.y + '%'; } } }
          },
          scales: {
            x: { grid: { display: false }, ticks: { color: '#8A9199', maxTicksLimit: 8 } },
            y: { grid: { color: 'rgba(214,69,69,0.1)' }, ticks: { color: '#8A9199' }, max: 0 }
          }
        }
      });
    }
    function renderTop3Drawdowns(top3) {
      var el = document.getElementById('top3DrawdownList');
      if (!el) return;
      if (!top3 || !top3.length) { el.innerHTML = '<p class="text-sm col-span-full" style="color:var(--benchmark-gray);">该时段内无明显回撤</p>'; return; }
      el.innerHTML = top3.map(function(d, i) {
        var recStr = d.recovery_date ? d.recovery_date : '<span style="color:var(--down-red);">未恢复</span>';
        var recDays = d.recovery_days != null ? d.recovery_days + '天' : '—';
        return '<div class="rounded-xl p-4 priority-high" style="background:#fff;box-shadow:0 2px 12px rgba(214,69,69,0.08);">'
          + '<div class="text-sm font-medium" style="color:var(--down-red);">#' + (i+1) + '  ' + d.drawdown_pct + '%</div>'
          + '<div class="text-xs mt-1" style="color:var(--benchmark-gray);">峰值 → 谷底：' + (d.peak_date||'') + ' → ' + (d.trough_date||'') + '</div>'
          + '<div class="text-xs" style="color:var(--benchmark-gray);">Duration：' + (d.duration_days != null ? d.duration_days+'天' : '—') + '</div>'
          + '<div class="text-xs" style="color:var(--benchmark-gray);">Recovery：' + recDays + '（' + recStr + '）</div>'
          + '</div>';
      }).join('');
    }

    // ===== 收益率对比行 =====
    /** 与后端 RISK_FREE_RATE_FALLBACK×100 大致同步 — 占位用；请以接口 risk_free_rate_pct 为准 */
    var DEFAULT_RISK_FREE_PCT_FALLBACK = 3.73;

    /** 与后端 risk_free_rate_pct 对齐的无风险利率展示（% 数字不含百分号后缀） */
    function formatRiskFreePctLabel(rfPct) {
      var n = (rfPct != null && rfPct !== '' && !isNaN(Number(rfPct))) ? Number(rfPct) : DEFAULT_RISK_FREE_PCT_FALLBACK;
      return (Math.round(n * 100) / 100).toString();
    }

    function updateMwrrCompare(cards, periodKey) {
      var c = cards && cards[periodKey];
      var twrEl = document.getElementById('mwrrTwrValue');
      var mwrrEl = document.getElementById('mwrrMwrrValue');
      if (twrEl) {
        twrEl.textContent = (c && c.pct != null) ? formatPct(c.pct) : '--';
        twrEl.style.color = (c && c.pct != null && c.pct < 0) ? '#D64545' : '#2d2a3e';
      }
      if (mwrrEl) {
        mwrrEl.textContent = (c && c.mwr_pct != null) ? formatPct(c.mwr_pct) : '--';
        mwrrEl.style.color = (c && c.mwr_pct != null && c.mwr_pct < 0) ? '#D64545' : 'var(--benchmark-gray)';
      }
    }

    function updateRiskMetricsTexts(risk, rfPct) {
      var elDD = document.getElementById('riskMaxDrawdown');
      var elSharpe = document.getElementById('riskSharpe');
      var elSharpeNote = document.getElementById('riskSharpeNote');
      var elSortino = document.getElementById('riskSortino');
      var elSortinoBench = document.getElementById('riskSortinoBench');
      var elAlpha = document.getElementById('riskAlpha');
      var elBeta = document.getElementById('riskBeta');
      var elDDCompare = document.getElementById('riskDDCompare');
      var elAlphaNote = document.getElementById('riskAlphaNote');
      var elBetaNote = document.getElementById('riskBetaNote');
      var rfLbl = formatRiskFreePctLabel(rfPct);

      if (elDD) elDD.textContent = (risk && risk.max_drawdown_pct != null) ? '−' + risk.max_drawdown_pct + '%' : '--';
      if (elDDCompare) {
        if (risk && risk.bench_max_drawdown_pct != null) {
          elDDCompare.textContent = '同期基准回撤 −' + risk.bench_max_drawdown_pct + '%';
        } else { elDDCompare.textContent = '--'; }
      }

      if (elSharpe) elSharpe.textContent = (risk && risk.sharpe_ratio != null) ? risk.sharpe_ratio : '--';
      if (elSharpeNote) {
        var benchSharpeStr = (risk && risk.bench_sharpe_ratio != null) ? String(risk.bench_sharpe_ratio) : '—';
        if (risk && risk.sharpe_ratio != null) {
          var s = Number(risk.sharpe_ratio);
          var label = s >= 1 ? '优秀' : s >= 0.5 ? '良好' : s >= 0 ? '一般' : '偏弱';
          elSharpeNote.textContent = label + ' · 同期基准夏普 ' + benchSharpeStr;
        } else { elSharpeNote.textContent = '同期基准夏普 ' + benchSharpeStr; }
      }

      if (elSortino) elSortino.textContent = (risk && risk.sortino_ratio != null) ? String(risk.sortino_ratio) : '--';
      if (elSortinoBench) {
        if (risk && risk.bench_sortino_ratio != null) {
          elSortinoBench.textContent = '同期纳指 ' + risk.bench_sortino_ratio;
        } else { elSortinoBench.textContent = '同期纳指 —'; }
      }

      if (elAlpha) {
        if (risk && risk.alpha_pct != null) {
          elAlpha.textContent = (risk.alpha_pct >= 0 ? '+' : '') + risk.alpha_pct + '%';
          elAlpha.style.color = risk.alpha_pct >= 0 ? '#0d9488' : '#dc2626';
        } else { elAlpha.textContent = '--'; elAlpha.style.color = '#2d2a3e'; }
      }
      if (elAlphaNote) {
        if (risk && risk.alpha_pct != null) {
          elAlphaNote.textContent = (risk.alpha_pct > 0 ? '优于 CAPM 预期' : risk.alpha_pct < 0 ? '劣于 CAPM 预期' : '符合 CAPM 预期')
            + ' · 无风险 ' + rfLbl + '%';
        } else { elAlphaNote.textContent = 'CAPM（含美国1Y ' + rfLbl + '%）相对纳指，%'; }
      }

      if (elBeta) elBeta.textContent = (risk && risk.beta != null) ? risk.beta : '--';
      if (elBetaNote) {
        var calStr = (risk && risk.calmar_ratio != null) ? String(risk.calmar_ratio) : '—';
        if (risk && risk.beta != null) {
          var b = risk.beta;
          var bLabel = b > 1.2 ? '高波动' : b >= 0.8 ? '同步市场' : b >= 0 ? '低波动' : '反向';
          elBetaNote.textContent = bLabel + '，Calmar ' + calStr;
        } else {
          elBetaNote.textContent = '—，Calmar ' + calStr;
        }
      }
    }
    function updateRiskMetricsCharts(risk) {
      buildDrawdownChart(risk);
      renderTop3Drawdowns(risk && risk.top3_drawdowns);
    }
    function updateRiskMetrics(risk, rfPct) {
      updateRiskMetricsTexts(risk, rfPct);
      updateRiskMetricsCharts(risk);
    }
    /** 首屏先铺文字，下一帧再跑 Chart.js，避免阻塞 LCP/可交互时间 */
    function scheduleReturnsChartWork(fn) {
      if (typeof requestAnimationFrame !== 'undefined') {
        requestAnimationFrame(function() { requestAnimationFrame(fn); });
      } else { setTimeout(fn, 0); }
    }
    async function loadReturnsOverview() {
      const data = await apiGet('/api/returns-overview');
      if (!data) {
        setReturnsCardsNoData();
        updateRiskMetricsTexts(null, null);
        updateMwrrCompare(null, null);
        scheduleReturnsChartWork(function() {
          updateRiskMetricsCharts(null);
          buildReturnsChart(currentPeriod);
          renderStrategyDriver(null);
        });
        return;
      }
      returnsOverview = data;
      var rk = periodToRiskKey(currentPeriod);
      updateReturnsCards(data.cards || {});
      updateRiskMetricsTexts(data.risk_metrics ? data.risk_metrics[rk] : null, data.risk_free_rate_pct);
      updateMwrrCompare(data.cards, rk);
      var asOfEl = document.getElementById('returnsDataAsOf');
      if (asOfEl) {
        var _fmtSh = window.__formatAsShanghaiGMT8;
        var _tsRet = (data.price_fetched_at && typeof _fmtSh === 'function') ? _fmtSh(data.price_fetched_at) : '';
        var _line = _tsRet ? ('数据更新时间：' + _tsRet) : (data.data_as_of ? ('数据更新时间：' + data.data_as_of) : '');
        asOfEl.textContent = _line + (data.method ? ' | 方法: ' + data.method : '');
      }
      var hAsOf = document.getElementById('historyDataAsOf');
      if (hAsOf) {
        var _fmt = window.__formatAsLocal;
        var _ts = (data.price_fetched_at && typeof _fmt === 'function') ? _fmt(data.price_fetched_at) : '';
        hAsOf.textContent = '最新更新时间：' + (_ts || data.data_as_of || '--');
      }
      updateGlobalStatusBar({ priceFetchedAt: data.price_fetched_at, dataAsOf: data.data_as_of });
      updateAthBadge(data);
      loadMonthlyReturns();
      scheduleReturnsChartWork(function() {
        buildReturnsChart(currentPeriod);
        updateRiskMetricsCharts(data.risk_metrics ? data.risk_metrics[rk] : null);
        renderStrategyDriver(data.strategy_driver);
      });
    }

    // 判断最新累计收益率是否为历史新高（since 期累计 TWR 序列的最大值 == 最新值）
    function isAllTimeHigh(data) {
      var s = data && data.chart && data.chart.since && data.chart.since.my;
      if (!Array.isArray(s) || s.length < 2) return false;
      var last = s[s.length - 1];
      if (last == null || isNaN(last) || last <= 0) return false;
      var maxVal = -Infinity;
      for (var i = 0; i < s.length; i++) {
        var v = s[i];
        if (v != null && !isNaN(v) && v > maxVal) maxVal = v;
      }
      return last + 1e-6 >= maxVal;
    }

    // 俏皮祝贺文案（简短适配移动端，每次随机挑一条）
    var __ATH_MESSAGES = [
      '新高冲破云霄 ٩(•̀ᴗ•́)و',
      '新高达成 (＊°▽°＊) 复利狂飙',
      'ATH 新高！(๑>◡<๑) 定投有回报',
      '新高登顶 ✧ 天府号就位',
      '再创新高 (•̀ㅁ•́ฅ) 稳住节奏'
    ];
    function pickAthMessage() {
      return __ATH_MESSAGES[Math.floor(Math.random() * __ATH_MESSAGES.length)];
    }

    function updateAthBadge(data) {
      var el = document.getElementById('returnsAthBadge');
      if (!el) return;
      if (!isAllTimeHigh(data)) { el.style.display = 'none'; el.innerHTML = ''; return; }
      var since = data.chart.since;
      var last = since.my[since.my.length - 1];
      var pctTxt = (last >= 0 ? '+' : '') + Number(last).toFixed(2) + '%';
      var msg = pickAthMessage();
      el.innerHTML = '<span class="ath-spark">✦</span>'
        + '<span>历史新高 ' + pctTxt + '</span>'
        + '<span class="ath-kaomoji">·</span>'
        + '<span>' + msg + '</span>';
      el.style.display = 'inline-flex';
      el.title = '累计 TWR 创 Since Inception 以来新高';
    }

    // ===== 策略驱动力饼图（PnL 贡献法）=====
    var _driverData = null;
    var _driverActiveKey = null;

    function _fmtPnl(v) { if (window.__sensitiveHidden) return '***'; return (v >= 0 ? '+$' : '−$') + Math.abs(v).toFixed(2); }
    function _fmtPct(v) { return (v >= 0 ? '+' : '') + v + '%'; }

    function renderStrategyDriver(sd) {
      var labelsEl = document.getElementById('driverLabels');
      var ctx = document.getElementById('chartStrategyDriver');
      var detailPanel = document.getElementById('driverDetailPanel');
      if (detailPanel) { detailPanel.classList.add('hidden'); detailPanel.innerHTML = ''; }
      _driverData = sd;
      _driverActiveKey = null;
      if (!sd || !ctx || typeof Chart === 'undefined') {
        if (labelsEl) labelsEl.innerHTML = '<p class="text-xs" style="color:var(--benchmark-gray);">暂无数据</p>';
        return;
      }
      if (chartStrategyDriver) chartStrategyDriver.destroy();

      var chartLabels = ['月投（压舱石）', '投弹（加速器）', '现金管理（BOXX）'];
      var chartVals = [Math.abs(sd.dingtou_pct || 0), Math.abs(sd.toundan_pct || 0), Math.abs(sd.cash_pct || 0)];
      var chartColors = ['#4A3D7C', '#BFA960', '#2d8a5e'];
      if (sd.other_pct && Math.abs(sd.other_pct) >= 0.01) {
        chartLabels.push('其他/差异');
        chartVals.push(Math.abs(sd.other_pct));
        chartColors.push('#8A9199');
      }
      var total = chartVals.reduce(function(a, b) { return a + b; }, 0) || 1;

      chartStrategyDriver = new Chart(ctx, {
        type: 'doughnut',
        data: {
          labels: chartLabels,
          datasets: [{ data: chartVals, backgroundColor: chartColors, borderWidth: 0 }]
        },
        options: {
          responsive: true, maintainAspectRatio: true,
          plugins: { legend: { display: false }, tooltip: { callbacks: { label: function(c) { return c.label + ': ' + c.raw.toFixed(2) + '%'; } } } }
        }
      });

      if (labelsEl) {
        var items = [
          {key: 'dingtou', name: '月投（系统压舱石）', val: sd.dingtou_pct, pnl: sd.dingtou_total_pnl, color: '#4A3D7C', clickable: true},
          {key: 'toundan', name: '投弹（利润加速器）', val: sd.toundan_pct, pnl: sd.toundan_total_pnl, color: '#BFA960', clickable: true},
          {key: 'cash', name: '现金管理（BOXX）', val: sd.cash_pct, pnl: sd.cash_total_pnl, color: '#2d8a5e', clickable: true},
        ];
        if (sd.other_pct && Math.abs(sd.other_pct) >= 0.01) {
          items.push({key: 'other', name: '其他/差异', val: sd.other_pct, pnl: null, color: '#8A9199', clickable: false});
        }
        var cols = items.length <= 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-4';
        labelsEl.innerHTML = '<div class="grid grid-cols-1 '+cols+' gap-3">' + items.map(function(it) {
          var vc = it.val >= 0 ? '#0d9488' : '#dc2626';
          var sub = (it.clickable && !window.__isCloudMode) ? '点击查看详情' : (it.key === 'other' ? '含佣金、口径差异等' : '');
          return '<div class="rounded-lg p-3 transition' + (it.clickable ? ' cursor-pointer hover:shadow-md' : '') + '" style="background:var(--light-purple-bg);border:2px solid transparent;" data-driver-key="'+it.key+'"' + (it.clickable ? ' onclick="window.__toggleDriverDetail(\''+it.key+'\')"' : '') + '>'
            + '<div class="flex items-center gap-2"><div style="width:10px;height:10px;border-radius:50%;background:'+it.color+';"></div><span class="text-xs" style="color:var(--benchmark-gray);">'+it.name+'</span></div>'
            + '<div class="text-lg font-bold mt-1" style="color:'+vc+';">'+_fmtPct(it.val)+'</div>'
            + '<div class="text-xs" style="color:var(--benchmark-gray);">'+sub+'</div>'
            + '</div>';
        }).join('') + '</div>';
      }
    }

    function _renderTradeTable(rows, totalPnl, pctVal, borderColor, title) {
      var html = '<div class="rounded-lg p-4" style="background:var(--light-purple-bg);border-left:3px solid '+borderColor+';">'
        + '<h4 class="text-sm font-semibold mb-2" style="color:#2d2a3e;">'+title+'</h4>'
        + '<p class="text-xs mb-2" style="color:var(--benchmark-gray);">公式：交易盈亏合计 / 组合总市值 = 贡献%</p>';
      if (rows.length) {
        html += '<div style="overflow-x:auto;"><table class="w-full text-xs"><thead><tr style="border-bottom:1px solid rgba(138,145,153,0.2);">'
          + '<th class="py-1 text-left" style="color:var(--benchmark-gray);">标的</th>'
          + '<th class="py-1 text-left" style="color:var(--benchmark-gray);">日期</th>'
          + '<th class="py-1 text-right" style="color:var(--benchmark-gray);">买入价</th>'
          + '<th class="py-1 text-right" style="color:var(--benchmark-gray);">现价</th>'
          + '<th class="py-1 text-right" style="color:var(--benchmark-gray);">股数</th>'
          + '<th class="py-1 text-right" style="color:var(--benchmark-gray);">盈亏</th>'
          + '<th class="py-1 text-right" style="color:var(--benchmark-gray);">收益率</th>'
          + '</tr></thead><tbody>';
        rows.forEach(function(r) {
          var pc = r.pnl >= 0 ? '#0d9488' : '#dc2626';
          html += '<tr style="border-bottom:1px solid rgba(138,145,153,0.1);">'
            + '<td class="py-1 font-medium">'+r.symbol+'</td>'
            + '<td class="py-1">'+r.date+'</td>'
            + '<td class="py-1 text-right">'+_m('$'+r.buy_price.toFixed(2))+'</td>'
            + '<td class="py-1 text-right">'+_m('$'+r.current_price.toFixed(2))+'</td>'
            + '<td class="py-1 text-right">'+_m(r.shares)+'</td>'
            + '<td class="py-1 text-right font-medium" style="color:'+pc+';">'+_fmtPnl(r.pnl)+'</td>'
            + '<td class="py-1 text-right" style="color:'+pc+';">'+_fmtPct(r.return_pct)+'</td>'
            + '</tr>';
        });
        html += '</tbody></table></div>';
        var tc = totalPnl >= 0 ? '#0d9488' : '#dc2626';
        var sd = _driverData;
        html += '<div class="flex justify-between items-center mt-2 pt-2" style="border-top:1px solid rgba(138,145,153,0.2);">'
          + '<span class="text-xs" style="color:var(--benchmark-gray);">盈亏合计 '+_fmtPnl(totalPnl)+' / 总市值 '+_m('$'+(sd.v_end||0).toFixed(0))+'</span>'
          + '<span class="text-sm font-bold" style="color:'+tc+';">= '+_fmtPct(pctVal)+'</span>'
          + '</div>';
      } else {
        html += '<p class="text-xs" style="color:var(--benchmark-gray);">暂无交易记录</p>';
      }
      html += '</div>';
      return html;
    }

    function _renderCashTable(rows, totalPnl, pctVal) {
      var sd = _driverData;
      var html = '<div class="rounded-lg p-4" style="background:var(--light-purple-bg);border-left:3px solid #2d8a5e;">'
        + '<h4 class="text-sm font-semibold mb-2" style="color:#2d2a3e;">现金管理盈亏贡献详情</h4>'
        + '<p class="text-xs mb-2" style="color:var(--benchmark-gray);">公式：（已实现 + 未实现）盈亏合计 / 组合总市值 = 贡献%</p>';
      if (rows.length) {
        html += '<div style="overflow-x:auto;"><table class="w-full text-xs"><thead><tr style="border-bottom:1px solid rgba(138,145,153,0.2);">'
          + '<th class="py-1 text-left" style="color:var(--benchmark-gray);">标的</th>'
          + '<th class="py-1 text-left" style="color:var(--benchmark-gray);">日期</th>'
          + '<th class="py-1 text-right" style="color:var(--benchmark-gray);">买入价</th>'
          + '<th class="py-1 text-right" style="color:var(--benchmark-gray);">卖出/现价</th>'
          + '<th class="py-1 text-right" style="color:var(--benchmark-gray);">股数</th>'
          + '<th class="py-1 text-right" style="color:var(--benchmark-gray);">盈亏</th>'
          + '<th class="py-1 text-center" style="color:var(--benchmark-gray);">状态</th>'
          + '</tr></thead><tbody>';
        rows.forEach(function(r) {
          var pc = r.pnl >= 0 ? '#0d9488' : '#dc2626';
          var st = r.status || '持有中';
          var stColor = st === '已卖出' ? 'var(--benchmark-gray)' : '#4A3D7C';
          html += '<tr style="border-bottom:1px solid rgba(138,145,153,0.1);">'
            + '<td class="py-1 font-medium">'+r.symbol+'</td>'
            + '<td class="py-1">'+r.date+'</td>'
            + '<td class="py-1 text-right">'+_m('$'+r.buy_price.toFixed(2))+'</td>'
            + '<td class="py-1 text-right">'+_m('$'+r.current_price.toFixed(2))+'</td>'
            + '<td class="py-1 text-right">'+_m(r.shares)+'</td>'
            + '<td class="py-1 text-right font-medium" style="color:'+pc+';">'+_fmtPnl(r.pnl)+'</td>'
            + '<td class="py-1 text-center" style="color:'+stColor+';font-size:10px;">'+st+'</td>'
            + '</tr>';
        });
        html += '</tbody></table></div>';
        var tc = totalPnl >= 0 ? '#0d9488' : '#dc2626';
        html += '<div class="flex justify-between items-center mt-2 pt-2" style="border-top:1px solid rgba(138,145,153,0.2);">'
          + '<span class="text-xs" style="color:var(--benchmark-gray);">盈亏合计 '+_fmtPnl(totalPnl)+' / 总市值 '+_m('$'+(sd.v_end||0).toFixed(0))+'</span>'
          + '<span class="text-sm font-bold" style="color:'+tc+';">= '+_fmtPct(pctVal)+'</span>'
          + '</div>';
      } else {
        html += '<p class="text-xs" style="color:var(--benchmark-gray);">暂无现金管理交易记录</p>';
      }
      html += '</div>';
      return html;
    }

    function _renderDriverDetail(key) {
      var panel = document.getElementById('driverDetailPanel');
      if (!panel || !_driverData) return;
      var sd = _driverData;
      var html = '';
      if (key === 'dingtou') {
        html = _renderTradeTable(sd.dingtou_details || [], sd.dingtou_total_pnl, sd.dingtou_pct, '#4A3D7C', '月投盈亏贡献详情');
      }
      if (key === 'toundan') {
        html = _renderTradeTable(sd.toundan_details || [], sd.toundan_total_pnl, sd.toundan_pct, '#BFA960', '投弹盈亏贡献详情');
      }
      if (key === 'cash') {
        html = _renderCashTable(sd.cash_details || [], sd.cash_total_pnl, sd.cash_pct);
      }
      panel.innerHTML = html;
      panel.classList.remove('hidden');
    }

    window.__toggleDriverDetail = function(key) {
      if (key === 'other') return;
      var panel = document.getElementById('driverDetailPanel');
      document.querySelectorAll('[data-driver-key]').forEach(function(el) {
        el.style.borderColor = el.dataset.driverKey === key && _driverActiveKey !== key ? 'var(--deep-purple)' : 'transparent';
      });
      if (_driverActiveKey === key) {
        _driverActiveKey = null;
        if (panel) { panel.classList.add('hidden'); panel.innerHTML = ''; }
        return;
      }
      _driverActiveKey = key;
      _renderDriverDetail(key);
    };

    // ========== 收益卡片与周期按钮联动 ==========
    function setPeriod(p) {
      currentPeriod = p;
      document.querySelectorAll('.returns-card').forEach(function (el) {
        el.classList.remove('card-highlight');
        if (el.dataset.period === p) el.classList.add('card-highlight');
      });
      document.querySelectorAll('.period-btn').forEach(function (el) {
        el.classList.remove('active');
        if (el.dataset.period === p) el.classList.add('active');
      });
      buildReturnsChart(p);
      var rk = periodToRiskKey(p);
      updateRiskMetrics(returnsOverview && returnsOverview.risk_metrics ? returnsOverview.risk_metrics[rk] : null, returnsOverview && returnsOverview.risk_free_rate_pct);
      updateMwrrCompare(returnsOverview && returnsOverview.cards, rk);
    }
