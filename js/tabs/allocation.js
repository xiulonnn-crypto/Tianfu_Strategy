// ========== 资产配置：从后端拉取并渲染表格与环形图 ==========
    function renderAllocation() {
      const tbody = document.getElementById('allocationTableBody');
      const asOfEl = document.getElementById('allocationDataAsOf');
      if (asOfEl) asOfEl.textContent = allocationDataAsOf ? '(价格基准日: ' + allocationDataAsOf + ')' : '';
      if (!tbody) return;
      if (!allocationList.length) {
        tbody.innerHTML = '<tr><td colspan="7" class="p-3 text-center text-slate-500">暂无持仓</td></tr>';
        if (chartAllocation) { chartAllocation.data.labels = []; chartAllocation.data.datasets[0].data = []; chartAllocation.update(); }
        return;
      }
      const total = allocationList.reduce(function (s, r) { return s + (r.amount || 0); }, 0);
      tbody.innerHTML = allocationList.map(function (row) {
        const pctVal = row.pct != null ? Number(row.pct) : (total ? (row.amount / total * 100) : 0);
        const priceStr = row.price != null ? '$' + Number(row.price).toFixed(2) : '--';
        const avgStr = row.avg_cost != null && row.avg_cost > 0 ? '$' + Number(row.avg_cost).toFixed(2) : '--';
        const gainPct = row.gain_pct != null ? row.gain_pct : 0;
        const gainStyle = gainPct > 0 ? 'color:#2d8a5e' : gainPct < 0 ? 'color:#D64545' : 'color:#8A9199';
        const gainStr = gainPct > 0 ? '+' + gainPct.toFixed(2) + '%' : gainPct.toFixed(2) + '%';
        const hide = window.__sensitiveHidden;
        // 偏离进度条：仅风险资产显示，现金类标的只显示总占比
        var pctCell;
        if (row.is_cash) {
          pctCell = '<td class="p-3 text-right" style="min-width:140px;">'
            + '<span class="text-xs" style="color:var(--benchmark-gray);">' + pctVal.toFixed(1) + '%</span>'
            + '<span class="text-xs ml-1" style="color:var(--benchmark-gray);">（现金）</span></td>';
        } else {
          var effPct = row.effective_pct != null ? Number(row.effective_pct) : pctVal;
          var tgt = row.target_pct || 0;
          var dev = row.deviation_pct || 0;
          var absDev = Math.abs(dev);
          var barColor = absDev > 5 ? (dev < 0 ? '#f59e0b' : '#7c3aed') : 'var(--deep-purple)';
          var tgtMark = tgt > 0 ? '<div style="position:absolute;left:'+Math.min(tgt, 100)+'%;top:0;width:2px;height:100%;background:#BFA960;" title="目标'+tgt+'%"></div>' : '';
          pctCell = '<td class="p-3 text-right" style="min-width:140px;">'
            + '<div class="flex items-center justify-end gap-2"><span class="text-xs" style="white-space:nowrap;">'+effPct.toFixed(1)+'%</span>'
            + '<div style="position:relative;width:80px;height:10px;background:rgba(74,61,124,0.08);border-radius:5px;overflow:visible;">'
            + '<div style="width:'+Math.min(effPct, 100)+'%;height:100%;border-radius:5px;background:'+barColor+';"></div>'
            + tgtMark
            + '</div>'
            + (tgt > 0 ? '<span class="text-xs" style="color:'+barColor+';white-space:nowrap;">'+(dev>=0?'+':'')+dev.toFixed(1)+'</span>' : '')
            + '</div></td>';
        }
        return '<tr class="cursor-pointer hover:bg-purple-50 transition" data-symbol="' + row.symbol + '" onclick="if(window.__loadAssetAnalysis)window.__loadAssetAnalysis(\'' + row.symbol + '\')">'
          + '<td class="p-3 font-medium" style="color:var(--deep-purple);">' + row.symbol + (row.is_cash ? ' <span class="text-xs" style="color:var(--benchmark-gray);">现金</span>' : ' <i class="fas fa-chart-line text-xs" style="color:var(--benchmark-gray);"></i>') + '</td>'
          + '<td class="p-3 text-right col-shares">' + (hide ? '***' : row.shares) + '</td>'
          + '<td class="p-3 text-right col-avg text-slate-500">' + avgStr + '</td>'
          + '<td class="p-3 text-right">' + priceStr + '</td>'
          + '<td class="p-3 text-right col-amount">' + (hide ? '***' : (row.amount != null ? '$' + Number(row.amount).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2}) : '')) + '</td>'
          + '<td class="p-3 text-right" style="' + gainStyle + '">' + gainStr + '</td>'
          + pctCell
          + '</tr>';
      }).join('');

      // 饼图 A：总资产（含现金）
      var labels = allocationList.map(function (r) { return r.symbol; });
      var values = allocationList.map(function (r) { return total ? (r.amount / total * 100) : 0; });
      var ctx = document.getElementById('chartAllocation');
      if (ctx) {
        if (chartAllocation) chartAllocation.destroy();
        chartAllocation = new Chart(ctx, {
          type: 'doughnut',
          data: { labels: labels, datasets: [{ data: values, backgroundColor: ['#4A3D7C', '#BFA960', '#8A9199', '#6B5B95', '#9B8BB5', '#D4B896'], borderWidth: 0 }] },
          options: { responsive: true, maintainAspectRatio: true, plugins: { legend: { position: 'bottom', labels: { font: { size: 10 } } }, tooltip: { callbacks: { label: function(c) { return c.label+': '+c.parsed.toFixed(1)+'%'; } } } } }
        });
      }
      // 饼图 B：风险资产内部比例（排除 BOXX），叠加目标环
      var riskRows = allocationList.filter(function(r) { return !r.is_cash; });
      var riskLabels = riskRows.map(function(r) { return r.symbol; });
      var riskValues = riskRows.map(function(r) { return r.effective_pct || 0; });
      var targetValues = riskRows.map(function(r) { return r.target_pct || 0; });
      var ctx2 = document.getElementById('chartRiskAllocation');
      if (ctx2) {
        if (chartRiskAllocation) chartRiskAllocation.destroy();
        chartRiskAllocation = new Chart(ctx2, {
          type: 'doughnut',
          data: {
            labels: riskLabels,
            datasets: [
              { data: riskValues, backgroundColor: ['#4A3D7C', '#BFA960', '#8A9199', '#6B5B95'], borderWidth: 0, label: '实际' },
              { data: targetValues, backgroundColor: ['rgba(74,61,124,0.2)', 'rgba(191,169,96,0.2)', 'rgba(138,145,153,0.2)', 'rgba(107,91,149,0.2)'], borderWidth: 1, borderColor: ['#4A3D7C', '#BFA960', '#8A9199', '#6B5B95'], label: '目标' },
            ]
          },
          options: { responsive: true, maintainAspectRatio: true, plugins: { legend: { position: 'bottom', labels: { font: { size: 10 } } }, tooltip: { callbacks: { label: function(c) { return (c.datasetIndex===0?'实际':'目标')+' '+c.label+': '+c.parsed.toFixed(1)+'%'; } } } } }
        });
      }
    }
    async function loadAllocation() {
      const data = await apiGet('/api/allocation');
      allocationList = Array.isArray(data) ? data : (data && data.rows ? data.rows : []);
      allocationDataAsOf = (data && data.data_as_of) ? data.data_as_of : '';
      renderAllocation();
      // QQQM < 45% 警告 Banner（v1.3.1 目标 60%）
      var banner = document.getElementById('allocWarningBanner');
      if (banner) {
        if (data && data.qqqm_warning) {
          banner.innerHTML = 'QQQM 风险敞口 ' + (data.qqqm_pct || 0) + '% 低于 45%（基于风险资产归一化，排除 BOXX 现金），触发下行强补规则：建议调整至 60:25:15 目标比例';
          banner.classList.remove('hidden');
        } else {
          banner.classList.add('hidden');
        }
      }
      // 默认选中第一行标的，展开归因分析
      if (allocationList.length > 0 && !_analysisOpenSymbol) {
        loadAssetAnalysis(allocationList[0].symbol);
      }
    }

    function toggleSensitive() {
      if (window.__isCloudMode) return;
      window.__sensitiveHidden = !window.__sensitiveHidden;
      var label = window.__sensitiveHidden ? '显示敏感信息' : '一键隐藏';
      document.querySelectorAll('.btn-toggle-sensitive').forEach(function(b) { b.textContent = label; });
      refreshAllViews();
    }
    function refreshAllViews() {
      renderAllocation();
      if (_analysisTradeData) _renderAnalysisTradeTable(_analysisTradeData);
      renderFundTable();
      renderTradesTable();
      try { renderTradeCalendar(trades); }
      catch (e) { console.error('renderTradeCalendar 失败（已隔离）:', e); }
      buildReturnsChart(currentPeriod);
      if (_driverData) renderStrategyDriver(_driverData);
      if (_driverActiveKey) _renderDriverDetail(_driverActiveKey);
      var activeSumBtn = document.querySelector('.sum-period-btn[style*="var(--deep-purple)"]');
      loadTradeSummary(activeSumBtn ? activeSumBtn.dataset.period : 'all');
      loadSignals();
      __lazyLoaded.signals = true;
      var stressBlock = document.getElementById('stressResultBlock');
      if (stressBlock && !stressBlock.classList.contains('hidden')) loadStressTest();
      var activeRevBtn = document.querySelector('.review-period-btn.review-period-active');
      loadStrategyReview(activeRevBtn ? activeRevBtn.dataset.rp : 'all');
      __lazyLoaded.review = true;
    }

    // ========== 资产盈亏归因分析 ==========
    var chartAssetAnalysis = null;
    var _analysisOpenSymbol = null;
    var _analysisTradeData = null;

    function _renderAnalysisTradeTable(rows) {
      var tableEl = document.getElementById('analysisTradeTable');
      if (!tableEl || !rows || !rows.length) { if (tableEl) tableEl.innerHTML = ''; return; }
      var hide = window.__sensitiveHidden;
      var totalPnl = rows.reduce(function(s, r) { return s + r.pnl; }, 0);
      var typeColors = {'投弹': '#BFA960', '月投': '#4A3D7C', '现金管理': '#2d8a5e'};
      var typeOrder = ['月投', '投弹', '现金管理'];
      var byType = {};
      rows.forEach(function(r) {
        var k = r.type_label;
        if (!byType[k]) byType[k] = {pnl: 0, count: 0};
        byType[k].pnl += r.pnl;
        byType[k].count++;
      });
      var summaryHtml = '<div class="flex flex-wrap gap-3 mb-3">';
      typeOrder.forEach(function(k) {
        if (!byType[k]) return;
        var v = byType[k];
        var pc = v.pnl >= 0 ? '#0d9488' : '#dc2626';
        var pnlStr = hide ? '***' : (v.pnl>=0?'+$':'−$')+Math.abs(v.pnl).toFixed(2);
        summaryHtml += '<div class="flex items-center gap-2 text-xs"><div style="width:8px;height:8px;border-radius:50%;background:'+(typeColors[k]||'#8A9199')+';"></div><span style="color:var(--benchmark-gray);">'+k+' '+v.count+'笔</span><span style="font-weight:600;color:'+pc+';">'+pnlStr+'</span></div>';
      });
      var tpc = totalPnl >= 0 ? '#0d9488' : '#dc2626';
      var totalStr = hide ? '***' : (totalPnl>=0?'+$':'−$')+Math.abs(totalPnl).toFixed(2);
      summaryHtml += '<div class="flex items-center gap-1 text-xs ml-auto"><span style="color:var(--benchmark-gray);">合计</span><span style="font-weight:700;color:'+tpc+';">'+totalStr+'</span></div>';
      summaryHtml += '</div>';
      var tblHtml = summaryHtml + '<div style="overflow-x:auto;"><table class="w-full text-xs"><thead><tr style="border-bottom:1px solid rgba(138,145,153,0.2);">'
        + '<th class="py-1.5 text-left" style="color:var(--benchmark-gray);">日期</th>'
        + '<th class="py-1.5 text-center" style="color:var(--benchmark-gray);">类型</th>'
        + '<th class="py-1.5 text-right" style="color:var(--benchmark-gray);">买入价</th>'
        + '<th class="py-1.5 text-right" style="color:var(--benchmark-gray);">现价</th>'
        + '<th class="py-1.5 text-right" style="color:var(--benchmark-gray);">股数</th>'
        + '<th class="py-1.5 text-right" style="color:var(--benchmark-gray);">盈亏</th>'
        + '<th class="py-1.5 text-right" style="color:var(--benchmark-gray);">收益率</th>'
        + '</tr></thead><tbody>';
      rows.forEach(function(r) {
        var pc = r.pnl >= 0 ? '#0d9488' : '#dc2626';
        var tc = typeColors[r.type_label] || '#8A9199';
        tblHtml += '<tr style="border-bottom:1px solid rgba(138,145,153,0.08);">'
          + '<td class="py-1.5">'+r.date+'</td>'
          + '<td class="py-1.5 text-center"><span class="px-1.5 py-0.5 rounded text-xs" style="background:'+tc+'22;color:'+tc+';">'+r.type_label+'</span></td>'
          + '<td class="py-1.5 text-right">$'+r.buy_price.toFixed(2)+'</td>'
          + '<td class="py-1.5 text-right">$'+r.current_price.toFixed(2)+'</td>'
          + '<td class="py-1.5 text-right">'+(hide ? '***' : r.shares)+'</td>'
          + '<td class="py-1.5 text-right font-medium" style="color:'+pc+';">'+(hide ? '***' : (r.pnl>=0?'+$':'−$')+Math.abs(r.pnl).toFixed(2))+'</td>'
          + '<td class="py-1.5 text-right" style="color:'+pc+';">'+(r.return_pct>=0?'+':'')+r.return_pct+'%</td>'
          + '</tr>';
      });
      tblHtml += '</tbody></table></div>';
      tableEl.innerHTML = tblHtml;
    }

    async function loadAssetAnalysis(symbol) {
      var panel = document.getElementById('assetAnalysisPanel');
      if (!panel) return;

      // 再次点击同一标的 → 收起
      if (_analysisOpenSymbol === symbol && !panel.classList.contains('hidden')) {
        panel.classList.add('hidden');
        _analysisOpenSymbol = null;
        return;
      }

      var titleEl = document.getElementById('analysisTitle');
      var phEl = document.getElementById('chartAnalysisPlaceholder');
      var metricsEl = document.getElementById('analysisMetrics');
      if (titleEl) titleEl.textContent = symbol + ' 盈亏归因分析';
      if (phEl) { phEl.style.display = 'flex'; phEl.textContent = '加载中…'; }
      if (metricsEl) metricsEl.innerHTML = '';
      panel.classList.remove('hidden');
      _analysisOpenSymbol = symbol;
      panel.scrollIntoView({ behavior: 'smooth', block: 'start' });

      var data = await apiGet('/api/asset-analysis/' + encodeURIComponent(symbol));
      if (!data || data.error) {
        if (phEl) phEl.textContent = data ? data.error : '请求失败';
        return;
      }

      // --- 准备数据 ---
      var labels = data.price_series.map(function(p) { return p.date.slice(5); });
      var fullDates = data.price_series.map(function(p) { return p.date; });
      var priceData = data.price_series.map(function(p) { return p.close; });
      var costData = data.cost_series.map(function(c) { return c.vwac; });

      // 散点数据：用标签字符串作为 x，确保散点精确对齐日期轴
      var dateToLabel = {};
      data.price_series.forEach(function(p, i) { dateToLabel[p.date] = labels[i]; });

      // 在 price 数组中按日期插入散点值，其余位为 null（使散点精确落在对应日期上）
      var toundanLine = new Array(labels.length).fill(null);
      var dingtouLine = new Array(labels.length).fill(null);
      var toundanMeta = {};
      var dingtouMeta = {};
      (data.buy_points || []).forEach(function(bp) {
        var idx = fullDates.indexOf(bp.date);
        if (idx < 0) return;
        var meta = { date: bp.date, shares: bp.shares, label: bp.label, type: bp.type, price: bp.price };
        if (bp.type === '投弹') {
          toundanLine[idx] = bp.price;
          toundanMeta[idx] = meta;
        } else {
          dingtouLine[idx] = bp.price;
          dingtouMeta[idx] = meta;
        }
      });

      // --- Chart.js ---
      if (phEl) phEl.style.display = 'none';
      var ctx = document.getElementById('chartAssetAnalysis');
      if (!ctx) return;
      if (chartAssetAnalysis) chartAssetAnalysis.destroy();

      chartAssetAnalysis = new Chart(ctx, {
        type: 'line',
        data: {
          labels: labels,
          datasets: [
            {
              label: symbol + ' 价格',
              data: priceData,
              borderColor: '#4A3D7C',
              backgroundColor: 'rgba(74,61,124,0.04)',
              fill: { target: 1, above: 'rgba(13,148,136,0.12)', below: 'rgba(220,38,38,0.10)' },
              tension: 0.3, borderWidth: 2, pointRadius: 0, order: 2,
            },
            {
              label: '平均成本 (VWAC)',
              data: costData,
              borderColor: '#BFA960',
              borderDash: [6, 3],
              borderWidth: 1.5, pointRadius: 0, fill: false, order: 3,
              spanGaps: false,
            },
            {
              label: '投弹加仓',
              data: toundanLine,
              borderColor: 'transparent',
              backgroundColor: '#dc2626',
              pointStyle: 'triangle', pointRadius: 8, pointHoverRadius: 10,
              showLine: false, order: 1,
              _meta: toundanMeta,
            },
            {
              label: '定投加仓',
              data: dingtouLine,
              borderColor: 'transparent',
              backgroundColor: '#4A3D7C',
              pointStyle: 'circle', pointRadius: 5, pointHoverRadius: 7,
              showLine: false, order: 1,
              _meta: dingtouMeta,
            },
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: { intersect: false, mode: 'nearest' },
          plugins: {
            legend: { position: 'top', labels: { color: '#2d2a3e', usePointStyle: true, font: { size: 11 } } },
            tooltip: {
              filter: function(item) { return item.raw != null; },
              callbacks: {
                label: function(ctx) {
                  if (ctx.datasetIndex >= 2) {
                    var m = ctx.dataset._meta && ctx.dataset._meta[ctx.dataIndex];
                    if (m) return m.label + ': ' + _m(m.shares + '股 @ $' + m.price) + ' (' + m.date + ')';
                  }
                  return ctx.dataset.label + ': ' + (ctx.datasetIndex === 1 ? _m('$' + (ctx.parsed.y != null ? ctx.parsed.y.toFixed(2) : '--')) : '$' + (ctx.parsed.y != null ? ctx.parsed.y.toFixed(2) : '--'));
                }
              }
            }
          },
          scales: {
            x: { grid: { display: false }, ticks: { color: '#8A9199', maxTicksLimit: 12, font: { size: 10 } } },
            y: { grid: { color: 'rgba(138,145,153,0.15)' }, ticks: { color: '#8A9199' } }
          }
        }
      });

      // --- 性能指标卡片 ---
      if (metricsEl && data.metrics) {
        var m = data.metrics;
        var yocColor = m.yoc_pct >= 0 ? '#0d9488' : '#dc2626';
        var ddColor = m.max_drawdown_pct < 0 ? '#dc2626' : '#0d9488';
        var ddPeriod = m.max_drawdown_period ? m.max_drawdown_period.start + ' ~ ' + m.max_drawdown_period.end : '--';

        var alphaHtml = '';
        if (m.strategy_alpha) {
          var keys = Object.keys(m.strategy_alpha);
          alphaHtml = keys.map(function(k) {
            var v = m.strategy_alpha[k];
            var ac = v >= 0 ? '#0d9488' : '#dc2626';
            return '<div class="flex justify-between text-xs"><span>' + k + '</span><span style="color:'+ac+';font-weight:600;">' + (v>=0?'+':'') + v + '%</span></div>';
          }).join('');
        } else {
          alphaHtml = '<div class="text-xs" style="color:var(--benchmark-gray);">暂无数据</div>';
        }

        metricsEl.innerHTML =
          '<div class="rounded-xl p-4" style="background:var(--light-purple-bg);"><div class="text-xs" style="color:var(--benchmark-gray);">Yield on Cost</div><div class="text-2xl font-bold mt-1" style="color:'+yocColor+';">' + (m.yoc_pct>=0?'+':'') + m.yoc_pct + '%</div><div class="text-xs mt-1" style="color:var(--benchmark-gray);">均价 $'+Number(m.avg_cost).toFixed(2)+' → 现价 $'+m.current_price+'</div></div>'
          + '<div class="rounded-xl p-4" style="background:var(--light-purple-bg);"><div class="text-xs" style="color:var(--benchmark-gray);">策略贡献度 (Alpha)</div><div class="mt-2">' + alphaHtml + '</div><div class="text-xs mt-2" style="color:var(--benchmark-gray);">买入价 vs 后30日均价</div></div>'
          + '<div class="rounded-xl p-4" style="background:var(--light-purple-bg);"><div class="text-xs" style="color:var(--benchmark-gray);">最大持仓压力</div><div class="text-2xl font-bold mt-1" style="color:'+ddColor+';">' + m.max_drawdown_pct + '%</div><div class="text-xs mt-1" style="color:var(--benchmark-gray);">' + ddPeriod + '</div></div>';
      }

      // --- 交易归因明细表格 ---
      _analysisTradeData = data.trade_attribution || null;
      _renderAnalysisTradeTable(_analysisTradeData);
    }

    window.__loadAssetAnalysis = loadAssetAnalysis;

    // 收起按钮
    document.addEventListener('click', function(e) {
      if (e.target && e.target.id === 'closeAnalysis') {
        var panel = document.getElementById('assetAnalysisPanel');
        if (panel) panel.classList.add('hidden');
        _analysisOpenSymbol = null;
      }
    });
