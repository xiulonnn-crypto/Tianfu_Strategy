// ========== 天府 v1.0 决策中心渲染 ==========
    function _$(id) { return document.getElementById(id); }
    function _usd(v) { if (window.__sensitiveHidden) return '***'; return v != null ? '$' + Number(v).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2}) : '--'; }
    function _m(v) { return window.__sensitiveHidden ? '***' : v; }
    function _pct(v) { return v != null ? (v >= 0 ? '+' : '') + Number(v).toFixed(2) + '%' : '--'; }
    function _pctColor(v) { return v != null && v < 0 ? 'color:#dc2626;' : v != null && v > 0 ? 'color:#0d9488;' : ''; }

    // B: SVG sparkline 辅助函数
    function _sparkSvg(entries, w, h) {
      if (!entries || entries.length < 2) return '';
      var vals = entries.map(function(e) { return e.value != null ? e.value : 0; });
      var mn = Math.min.apply(null, vals), mx = Math.max.apply(null, vals);
      var range = mx - mn || 1;
      var pts = vals.map(function(v, i) {
        return Math.round(i / (vals.length - 1) * w) + ',' + Math.round((1 - (v - mn) / range) * (h - 4) + 2);
      }).join(' ');
      var lastX = w, lastY = Math.round((1 - (vals[vals.length-1] - mn) / range) * (h - 4) + 2);
      return '<svg width="'+w+'" height="'+h+'" style="display:inline-block;vertical-align:middle;margin-left:6px;">'
        + '<polyline points="'+pts+'" fill="none" stroke="#8A9199" stroke-width="1.5" stroke-linejoin="round"/>'
        + '<circle cx="'+lastX+'" cy="'+lastY+'" r="2.5" fill="var(--deep-purple)"/>'
        + '</svg>';
    }

    // A: 数据新鲜度倒计时
    var _signalsTimer = null;
    var _signalsComputedAt = null;
    function _startFreshnessTimer() {
      if (_signalsTimer) clearInterval(_signalsTimer);
      var els = document.querySelectorAll('.freshness-timer');
      _signalsTimer = setInterval(function() {
        if (!_signalsComputedAt) return;
        var sec = Math.round((Date.now() - new Date(_signalsComputedAt).getTime()) / 1000);
        var txt = sec < 60 ? sec + '秒前' : Math.round(sec/60) + '分钟前';
        els.forEach(function(el) { el.textContent = txt; });
      }, 1000);
    }

    async function loadSignals() {
      var data = await apiGet('/api/signals');
      if (!data) return;

      // --- 模型信息 + 新鲜度计时器 ---
      var ve = _$('sigVersion'); if (ve) ve.textContent = data.version || '-';
      var ue = _$('sigUpdated'); if (ue) ue.textContent = data.updated_at || '-';
      _signalsComputedAt = data.computed_at;
      _startFreshnessTimer();

      // --- 顶部预警 banner（3.2 下行强补）---
      var banner = _$('alertBanner');
      if (banner) {
        var alerts = [];
        var pa = data.position_alerts || {};
        if (pa.rebalance_alert) alerts.push(pa.rebalance_alert.message);
        if (alerts.length) { banner.innerHTML = alerts.join('<br>'); banner.classList.remove('hidden'); }
        else { banner.classList.add('hidden'); }
      }

      // --- 大盘现状 ---
      var mkEl = _$('marketOverviewList');
      if (mkEl) {
        var mo = data.market_overview || [];
        if (!mo.length) { mkEl.innerHTML = '<p class="text-sm col-span-full" style="color:var(--benchmark-gray);">暂无行情数据</p>'; }
        else {
          mkEl.innerHTML = mo.map(function(q) {
            var cc = _pctColor(q.change_pct);
            var cs = q.change_pct != null ? (q.change_pct >= 0 ? '+' : '') + q.change_pct + '%' : '--';
            return '<div class="rounded-xl shadow-sm p-4" style="background:#fff;box-shadow:0 2px 16px rgba(74,61,124,0.06);"><div class="font-medium text-sm" style="color:var(--deep-purple);">' + (q.name||q.symbol) + '</div><div class="flex items-baseline gap-2 mt-1"><span class="text-lg font-semibold" style="color:#2d2a3e;">' + (q.price!=null?Number(q.price).toLocaleString(undefined,{minimumFractionDigits:2}):'--') + '</span><span class="text-xs" style="'+cc+'">' + cs + '</span></div></div>';
          }).join('');
        }
      }

      // --- 2.1 触发预警动态卡片（含临界状态 + 倒计时）---
      var tcEl = _$('triggerCards');
      if (tcEl && data.triggers) {
        var tr = data.triggers;
        var levels = ['M1','M2','M3','IAU'];
        tcEl.innerHTML = levels.map(function(lv) {
          var t = tr[lv]; if (!t) return '';
          var st = t.status || 'idle';
          if (t.near_critical && st === 'idle') st = 'near_critical';
          var statusMap = {
            'can_fire':        {text:'可执行',           color:'#dc2626', bold:true,  border:'#dc2626', bg:'#fef2f2'},
            'near_critical':   {text:'临界警戒',         color:'#a16207', bold:true,  border:'#FACC15', bg:'rgba(250,204,21,0.1)'},
            'month_exhausted': {text:'本月次数已满',      color:'#f59e0b', bold:false, border:'#f59e0b', bg:'#fffbeb'},
            'day_exhausted':   {text:'今日次数已满',      color:'#f59e0b', bold:false, border:'#f59e0b', bg:'#fffbeb'},
            'year_exhausted':  {text:'本年次数已满',      color:'#f59e0b', bold:false, border:'#f59e0b', bg:'#fffbeb'},
            'idle':            {text:'未触发',           color:'var(--benchmark-gray)', bold:false, border:'rgba(74,61,124,0.12)', bg:'#fff'},
          };
          var si = statusMap[st] || statusMap['idle'];
          var distStr = t.distance_pct != null ? '距触发 ' + (t.distance_pct > 0 ? '+' : '') + t.distance_pct + '%' : '';
          var threshStr = t.threshold_price ? '临界价 $' + t.threshold_price : '';
          var liveTag = ' <span style="color:#0d9488;font-size:10px;font-weight:600;">(Live)</span>';
          var ktStr = (lv === 'M3' && t.yearly_used !== undefined) ? 'K=' + t.K + '，额度 ' + _usd(t.T) + (t.yearly_used ? ' (本年已用)' : '') + liveTag : 'K=' + t.K + '，额度 ' + _usd(t.T) + liveTag;
          var extra = '';
          if (st === 'can_fire') extra = '<div class="text-xs mt-2 font-bold" style="color:#dc2626;">请立即执行交易</div>';
          return '<div class="rounded-xl shadow-sm p-4 relative" style="background:'+si.bg+';border:2px solid '+si.border+';box-shadow:0 2px 16px rgba(74,61,124,0.06);">'
            + '<div class="absolute top-2 right-3 freshness-timer text-xs" style="color:var(--benchmark-gray);"></div>'
            + '<div class="flex justify-between items-center pr-16"><span class="font-bold" style="color:var(--deep-purple);">' + lv + '</span><span style="color:'+si.color+';'+(si.bold?'font-weight:700;':'')+'">' + si.text + '</span></div>'
            + '<div class="text-xs mt-2" style="color:#2d2a3e;">' + (t.condition||'') + '</div>'
            + ((threshStr || distStr) ? '<div class="text-xs mt-1" style="color:var(--benchmark-gray);">' + [threshStr, distStr].filter(Boolean).join(' · ') + '</div>' : '')
            + '<div class="text-xs mt-1 font-medium" style="color:var(--deep-purple);">' + ktStr + '</div>'
            + extra + '</div>';
        }).join('');
        var con = tr._constraints || {};
        tcEl.innerHTML += '<div class="rounded-xl shadow-sm p-4 col-span-full" style="background:#fff;box-shadow:0 2px 16px rgba(74,61,124,0.06);">'
          + '<div class="text-xs" style="color:var(--benchmark-gray);">QQQM 本月 ' + (con.qqqm_monthly_count||0) + '/' + (con.qqqm_monthly_limit||2) + ' 次　|　IAU 本月 ' + (con.iau_monthly_count||0) + '/' + (con.iau_monthly_limit||1) + ' 次</div></div>';
      }

      // --- 分位数引擎面板（百分位横条）---
      // 独立 try/catch：分位数/信号历史渲染若异常，不得中断下方风险预算、月投仪表盘等核心渲染
      try { if (data.quantile_engine) renderQuantilePanel(data.quantile_engine); }
      catch (e) { console.error('renderQuantilePanel 失败（已隔离）:', e); }

      try { await loadSignalHistory(); }
      catch (e) { console.error('loadSignalHistory 失败（已隔离）:', e); }

      // --- 风险预算 R→RR→K→T（含 RR sparkline）---
      var rbEl = _$('riskBudgetBlock');
      if (rbEl && data.risk_budget) {
        var rb = data.risk_budget;
        var rrSpark = _sparkSvg(data.history_7d && data.history_7d.RR, 80, 30);
        rbEl.innerHTML = '<div class="flex flex-wrap items-center justify-center gap-4 text-sm">'
          + '<div class="text-center px-3"><div class="text-xs" style="color:var(--benchmark-gray);">R</div><div class="text-xl font-bold" style="color:var(--deep-purple);">' + rb.R + '</div></div>'
          + '<div style="color:var(--benchmark-gray);">×</div>'
          + '<div class="text-center px-3"><div class="text-xs" style="color:var(--benchmark-gray);">S(EMA)</div><div class="text-xl font-bold" style="color:var(--deep-purple);">' + rb.S_ema + '</div></div>'
          + '<div style="color:var(--benchmark-gray);">→</div>'
          + '<div class="text-center px-3"><div class="text-xs" style="color:var(--benchmark-gray);">RR</div><div class="text-xl font-bold" style="color:var(--champagne-gold);">' + rb.RR + rrSpark + '</div></div>'
          + '<div style="color:var(--benchmark-gray);">→</div>'
          + '<div class="text-center px-3"><div class="text-xs" style="color:var(--benchmark-gray);">K</div><div class="text-xl font-bold" style="color:var(--deep-purple);">' + rb.K + '</div></div>'
          + '<div style="color:var(--benchmark-gray);">→</div>'
          + '<div class="text-center px-3"><div class="text-xs" style="color:var(--benchmark-gray);">T(额度)</div><div class="text-xl font-bold" style="color:#0d9488;">' + _usd(rb.T) + '</div></div>'
          + '</div>';
      }

      // --- 2.2 月投信号仪表盘（v1.3.1: 去掉 RRF，显示 S_median）---
      var mdEl = _$('monthlyDashboard');
      if (mdEl && data.monthly_signal) {
        var ms = data.monthly_signal;
        var sVal = ms.S || 0;
        var gaugeAngle = Math.max(0, Math.min(180, sVal * 180));
        var sentiment = sVal > 0.6 ? '偏恐惧（利于加仓）' : sVal < 0.4 ? '偏贪婪（谨慎加仓）' : '中性';
        var sentColor = sVal > 0.6 ? '#0d9488' : sVal < 0.4 ? '#dc2626' : 'var(--benchmark-gray)';
        var doubleNote = ms.double_up_from_reserve ? '当月无投弹，备弹池倍投 +' + _usd(ms.double_up_amount) + '（上限2000）' : '当月有投弹，不翻倍';
        mdEl.innerHTML = '<div class="grid grid-cols-1 sm:grid-cols-3 gap-6 items-center">'
          + '<div class="flex flex-col items-center">'
          + '<div style="width:140px;height:70px;position:relative;overflow:hidden;">'
          + '<div style="width:140px;height:140px;border-radius:50%;border:12px solid rgba(74,61,124,0.1);border-top-color:var(--deep-purple);border-right-color:var(--champagne-gold);position:absolute;top:0;transform:rotate('+(-90+gaugeAngle)+'deg);transition:transform 0.8s;"></div>'
          + '</div>'
          + '<div class="text-2xl font-bold mt-1" style="color:var(--deep-purple);">' + sVal.toFixed(3) + '</div>'
          + '<div class="text-xs" style="color:'+sentColor+';">' + sentiment + '</div>'
          + '<div class="text-xs mt-1" style="color:var(--benchmark-gray);">S=' + ms.S + _sparkSvg(data.history_7d && data.history_7d.S, 60, 24) + '　S_median=' + (ms.S_median || '-') + '</div>'
          + '</div>'
          + '<div class="text-center">'
          + '<div class="text-xs" style="color:var(--benchmark-gray);">月投倍率 M（范围 0.25~2.0）</div>'
          + '<div class="text-4xl font-bold" style="color:var(--deep-purple);">' + Number(ms.M).toFixed(2) + '×</div>'
          + '<div class="text-sm mt-1" style="color:#2d2a3e;">月投金额 ' + _usd(ms.monthly_amount) + '</div>'
          + '</div>'
          + '<div class="text-center">'
          + '<div class="text-xs" style="color:var(--benchmark-gray);">备弹池倍投</div>'
          + '<div class="text-lg font-bold mt-1" style="color:' + (ms.double_up_from_reserve ? '#0d9488' : 'var(--benchmark-gray)') + ';">' + (ms.double_up_from_reserve ? '+' + _usd(ms.double_up_amount) : '不翻倍') + '</div>'
          + '<div class="text-xs mt-1" style="color:var(--benchmark-gray);">' + doubleNote + '</div>'
          + '<div class="text-sm font-bold mt-2" style="color:var(--deep-purple);">合计 ' + _usd(ms.total_invest) + '</div>'
          + '</div></div>';
      }

      // --- 下次定投（渐进熔断 v1.3.1）---
      var dingBlock = _$('nextDingtouBlock');
      if (dingBlock && data.next_dingtou) {
        var d = data.next_dingtou;
        var allocLines = (d.allocation || []).map(function (a) {
          var sharesStr = a.shares != null ? ' ' + _m(a.shares.toFixed(1) + '股') : '';
          return '<span style="display:inline-block;min-width:3.5em;font-weight:500;color:#2d2a3e;">' + a.symbol + '</span>'
            + '<span style="display:inline-block;min-width:3.5em;text-align:right;">' + a.pct + '%</span>'
            + '<span style="display:inline-block;min-width:5.5em;text-align:right;">' + _usd(a.amount) + '</span>'
            + (sharesStr ? '<span style="display:inline-block;min-width:4.5em;text-align:right;">' + sharesStr + '</span>' : '');
        }).join('<br>');
        var fadePct = d.fade ? (d.fade * 100).toFixed(0) : 0;
        var fuseTag = d.fuse_active ? ' <span class="text-xs px-2 py-0.5 rounded" style="background:#fef2f2;color:#dc2626;">渐进缩减 ' + fadePct + '%</span>' : '';
        dingBlock.innerHTML = '<p class="text-sm" style="color:#2d2a3e;"><span class="font-medium">' + (d.date||'') + '</span> ' + (d.description||'') + ' 合计 ' + _usd(d.total_usd) + fuseTag + '</p>'
          + '<div class="text-sm mt-2 font-mono" style="color:var(--benchmark-gray);line-height:1.8;">' + allocLines + '</div>';
      }

      // --- 2.3 备弹池健康度（年度注入模型）---
      var rpEl = _$('reservePoolValue');
      var tuEl = _$('totalToundanUsed');
      var tiEl = _$('totalInjected');
      var mtEl = _$('maxToundanTimes');
      if (rpEl) rpEl.textContent = _usd(data.reserve_pool);
      if (tuEl) tuEl.textContent = _usd(data.total_toundan_used);
      if (tiEl) tiEl.textContent = data.total_injected ? _usd(data.total_injected) : '--';
      if (mtEl) mtEl.textContent = data.max_toundan_times != null ? data.max_toundan_times + ' 次' : '--';
      var rhEl = _$('reserveHealthPct');
      var pa = data.position_alerts || {};
      if (rhEl) {
        var hp = pa.reserve_health_pct || 0;
        rhEl.textContent = hp + '%';
        rhEl.style.color = hp < 10 ? '#dc2626' : hp < 20 ? '#f59e0b' : 'var(--deep-purple)';
      }
      var bar = _$('reserveBar');
      if (bar) { bar.style.width = Math.min(100, pa.reserve_health_pct || 0) + '%'; bar.style.background = (pa.reserve_health_pct || 0) < 10 ? '#dc2626' : 'var(--deep-purple)'; }
      var warnEl = _$('reserveWarning');
      if (warnEl) {
        var warnParts = [];
        if (pa.reserve_warning) warnParts.push('备弹池不足以支付下次投弹或月投翻倍');
        var fc = pa.reserve_forecast;
        if (fc) {
          if (fc.forecast_date) {
            var fcColor = fc.days_remaining != null && fc.days_remaining < 30 ? 'color:#dc2626;' : 'color:var(--benchmark-gray);';
            warnParts.push('<span style="'+fcColor+'">按近 90 天投弹频率，备弹池预计可支撑至 ' + fc.forecast_date + '</span>');
          } else {
            warnParts.push('<span style="color:var(--benchmark-gray);">暂无足够历史投弹数据预测消耗速率</span>');
          }
        }
        if (warnParts.length) { warnEl.innerHTML = warnParts.join('<br>'); warnEl.classList.remove('hidden'); }
        else { warnEl.classList.add('hidden'); }
      }

      // --- 投弹预估（含股数 + 复制指令 + 临界状态）---
      var toundanEl = _$('toundanList');
      if (toundanEl && data.toundan_estimate) {
        var _sm = {
          'can_fire':{t:'可执行',c:'#dc2626',bg:'#fef2f2',bl:'#dc2626'},
          'near_critical':{t:'临界警戒',c:'#a16207',bg:'rgba(250,204,21,0.1)',bl:'#FACC15'},
          'month_exhausted':{t:'本月次数已满',c:'#f59e0b',bg:'#fffbeb',bl:'#f59e0b'},
          'day_exhausted':{t:'今日次数已满',c:'#f59e0b',bg:'#fffbeb',bl:'#f59e0b'},
          'idle':{t:'',c:'',bg:'',bl:'var(--champagne-gold)'}
        };
        toundanEl.innerHTML = data.toundan_estimate.map(function (t, idx) {
          var st = t.status || 'idle';
          if (t.near_critical && st === 'idle') st = 'near_critical';
          var s = _sm[st] || _sm['idle'];
          var bc = 'border-left:4px solid '+s.bl+';';
          var badge = s.t ? '<span class="text-xs px-2 py-0.5 rounded" style="background:'+s.bg+';color:'+s.c+';">'+s.t+'</span>' : '';
          var sharesLine = t.shares_to_buy ? '<div class="text-xs mt-1" style="color:#2d2a3e;">应买入 <b>' + _m(t.shares_to_buy + '股') + '</b> @ $' + t.latest_price + '</div>' : '';
          var copyBtn = t.order_text ? '<button type="button" class="btn-copy-order mt-2 px-3 py-1 rounded text-xs transition" style="border:1px solid var(--deep-purple);color:var(--deep-purple);background:transparent;" data-order="'+t.order_text.replace(/"/g,'&quot;')+'"><i class="fas fa-copy mr-1"></i>复制交易指令</button>' : '';
          var actionLine = st === 'can_fire' ? '<div class="text-xs mt-1 font-bold" style="color:#dc2626;">请立即执行交易</div>' : '';
          return '<div class="rounded-xl shadow-sm p-4" style="background:#fff;box-shadow:0 2px 16px rgba(74,61,124,0.06);'+bc+'">'
            + '<div class="flex justify-between"><span class="font-medium" style="color:var(--deep-purple);">' + (t.symbol||'') + ' ' + (t.level||'') + '</span>' + badge + '</div>'
            + '<div class="text-xs mt-1" style="color:#2d2a3e;">' + (t.condition||'') + '</div>'
            + '<div class="text-xs mt-1" style="color:var(--benchmark-gray);">K=' + t.k + '，额度 ' + _usd(t.max_usd) + ' <span style="color:#0d9488;font-size:10px;font-weight:600;">(Live)</span></div>'
            + sharesLine + actionLine + copyBtn + '</div>';
        }).join('');
      }

      // --- 仓位风控（v1.3.1 渐进熔断可视化）---
      var pcEl = _$('positionControlBlock');
      if (pcEl && pa) {
        var qr = pa.qqqm_ratio || 0;
        var fadePct = pa.fade ? (pa.fade * 100).toFixed(0) : 0;
        var softPct = pa.soft_pct || 70;
        var hardPct = pa.hard_pct || 85;
        var fuseStr;
        if (!pa.fuse_active) {
          fuseStr = '<span style="color:#0d9488;">正常（≤' + softPct + '%）：定投按 60/25/15 分配</span>';
        } else if (pa.fade >= 1) {
          fuseStr = '<span style="color:#dc2626;">硬停（≥' + hardPct + '%）：QQQM 暂停，BRK-B + IAU 按 2.5:1.5</span>';
        } else {
          fuseStr = '<span style="color:#f59e0b;">渐进缩减 ' + fadePct + '%：QQQM 占比逐步降低</span>';
        }
        // 渐进熔断进度条
        var barPct = Math.min(100, Math.max(0, (qr - softPct) / (hardPct - softPct) * 100));
        var barColor = barPct > 80 ? '#dc2626' : barPct > 0 ? '#f59e0b' : '#0d9488';
        var progressBar = '<div class="mt-2" style="background:rgba(74,61,124,0.08);border-radius:4px;height:8px;position:relative;">'
          + '<div style="width:' + barPct + '%;background:' + barColor + ';border-radius:4px;height:100%;transition:width 0.5s;"></div>'
          + '</div>'
          + '<div class="flex justify-between text-xs mt-1" style="color:var(--benchmark-gray);"><span>' + softPct + '%</span><span>' + hardPct + '%</span></div>';
        var rbAlert = pa.rebalance_alert;
        var rbStr = rbAlert ? '<div class="mt-2 p-2 rounded text-xs" style="background:#fef2f2;color:#dc2626;">' + rbAlert.message + '（已连续 ' + rbAlert.days_below + ' 天）</div>' : '';
        pcEl.innerHTML = '<div class="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">'
          + '<div><span style="color:var(--benchmark-gray);">QQQM 占比</span><div class="text-2xl font-bold mt-1" style="color:' + (qr>=hardPct?'#dc2626':qr>softPct?'#f59e0b':qr<35?'#f59e0b':'var(--deep-purple)') + ';">' + qr + '%</div></div>'
          + '<div><span style="color:var(--benchmark-gray);">渐进熔断状态</span><div class="text-sm font-medium mt-1">' + fuseStr + '</div>' + progressBar + '</div>'
          + '</div>' + rbStr;
      }

      // --- Put 保险状态卡片 ---
      var insEl = _$('insuranceBlock');
      if (insEl && data.insurance) {
        var ins = data.insurance;
        var posInfo = ins.has_position ? '<span style="color:#0d9488;">持仓中</span>' : '<span style="color:var(--benchmark-gray);">无持仓</span>';
        var budgetBar = '<div style="background:rgba(74,61,124,0.08);border-radius:4px;height:6px;margin-top:4px;"><div style="width:' + Math.min(100,ins.budget_utilization) + '%;background:' + (ins.budget_utilization>80?'#dc2626':'var(--deep-purple)') + ';border-radius:4px;height:100%;"></div></div>';
        var actionStr = '';
        if (ins.action === 'open') actionStr = '<div class="mt-2 p-2 rounded text-xs" style="background:#ecfdf5;color:#0d9488;">' + ins.action_detail.reason + '</div>';
        else if (ins.action === 'roll') actionStr = '<div class="mt-2 p-2 rounded text-xs" style="background:#fffbeb;color:#a16207;">' + ins.action_detail.reason + '</div>';
        else if (ins.action && ins.action.startsWith('close')) actionStr = '<div class="mt-2 p-2 rounded text-xs" style="background:#fef2f2;color:#dc2626;">' + ins.action_detail.reason + '</div>';
        var openVix = ins.open_vix != null ? ins.open_vix : 12;
        var curVix = ins.current_vix != null ? ins.current_vix : null;
        var vixBelowTarget = curVix != null && curVix < openVix;
        var vixColor = curVix == null ? 'var(--benchmark-gray)' : (vixBelowTarget ? '#0d9488' : '#dc2626');
        var vixDisplay = curVix != null
          ? '<span style="color:' + vixColor + ';font-weight:600;">' + curVix + '</span><span style="color:var(--benchmark-gray);font-size:11px;"> / 触发线 ' + openVix + '</span>'
          : '<span style="color:var(--benchmark-gray);">--</span>';
        insEl.innerHTML = '<div class="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">'
          + '<div><span style="color:var(--benchmark-gray);">Put 保险</span><div class="font-medium mt-1">' + posInfo + '</div></div>'
          + '<div><span style="color:var(--benchmark-gray);">目标触发 VIX<span class="info-tip review-card-tip" style="margin-left:3px;"><i class="fas fa-circle-question" style="font-size:11px;"></i><span class="info-tip-text">开仓触发条件：当前 VIX 低于此阈值且年度预算未超支时，模型建议买入 Put 保护。默认 12，可在「参数调整建议」中修改（范围 8~20）。绿色表示当前 VIX 已达触发条件。</span></span></span><div class="font-medium mt-1">' + vixDisplay + '</div></div>'
          + '<div><span style="color:var(--benchmark-gray);">年度预算</span><div class="font-medium mt-1">' + _usd(ins.annual_budget) + '</div>' + budgetBar + '<div class="text-xs" style="color:var(--benchmark-gray);">已用 ' + ins.budget_utilization + '%</div></div>'
          + '<div><span style="color:var(--benchmark-gray);">已支出</span><div class="font-medium mt-1">' + _usd(ins.annual_spent) + '</div></div>'
          + '</div>' + actionStr;
      }

      // --- 一句话决策合成 ---
      var dsEl = _$('decisionSummary');
      if (dsEl) {
        var parts = [];
        var ms = data.monthly_signal || {};
        var sVal = ms.S;
        if (sVal != null) {
          var mood = sVal > 0.6 ? '偏恐惧' : sVal < 0.4 ? '偏贪婪' : '中性';
          var moodColor = sVal > 0.6 ? '#5eead4' : sVal < 0.4 ? '#fca5a5' : 'rgba(255,255,255,0.7)';
          parts.push('<span style="color:'+moodColor+';">市场'+mood+'(S='+Number(sVal).toFixed(2)+')</span>');
        }
        var fires = (data.toundan_estimate || []).filter(function(t){ return t.status === 'can_fire'; });
        var nears = (data.toundan_estimate || []).filter(function(t){ return t.near_critical || t.status === 'near_critical'; });
        if (fires.length) parts.push('<span style="color:#fca5a5;font-weight:700;">'+fires.length+'个投弹可执行</span>');
        else if (nears.length) parts.push('<span style="color:#fbbf24;">'+nears.length+'个投弹临界</span>');
        else parts.push('无投弹触发');
        if (ms.M != null) parts.push('月投 '+Number(ms.M).toFixed(1)+'x '+_usd(ms.monthly_amount));
        var pa2 = data.position_alerts || {};
        if (pa2.fuse_active) {
          var fp = pa2.fade ? (pa2.fade*100).toFixed(0) : 0;
          parts.push('<span style="color:#fbbf24;">渐进熔断 '+fp+'%</span>');
        } else {
          parts.push('<span style="color:#5eead4;">仓位正常</span>');
        }
        dsEl.innerHTML = '<span class="ds-label">综合研判</span>' + parts.join('<span class="ds-sep">·</span>');
      }
    }
