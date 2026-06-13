// js/main.js — ES module (split sources: js/common.js + js/tabs/*.js)

// --- tab: common ---
// ========== API 基地址 ==========
    const API_BASE = (window.location.protocol === 'file:' || window.location.port === '') ? 'http://localhost:1001' : '';
    function debugLog() {}  // 已移除 debug 面板，保留空函数避免报错

    // ========== 状态 ==========
    let currentPeriod = '1y';
    let chartCompareMode = 'bench';  // 'bench' | 'dca' | 'all'
    let chartReturns = null;
    let chartAllocation = null;
    let chartRiskAllocation = null;
    let chartStrategyDriver = null;
    var _get_settings_cache = null;
    let fundRecords = [];
    let trades = [];
    let fundEditIndex = null;  // 编辑时为存储索引，新增时为 null
    let tradeEditIndex = null;
    let returnsOverview = null; // { cards, chart }
    let allocationList = [];   // 资产配置列表，由 /api/allocation 拉取
    let allocationDataAsOf = '';  // 价格基准日
    let chartSignalHistory = null;

    function updateGlobalStatusBar(opts) {
      opts = opts || {};
      var timeEl = document.getElementById('globalStatusTime');
      var verEl = document.getElementById('globalStatusVersion');
      var modeEl = document.getElementById('globalStatusMode');
      if (timeEl) {
        var _fmtShFn = window.__formatAsShanghaiGMT8;
        var ts = opts.priceFetchedAt && typeof _fmtShFn === 'function' ? _fmtShFn(opts.priceFetchedAt)
          : (opts.dataAsOf ? opts.dataAsOf : '');
        timeEl.innerHTML = '<span class="global-status-dot" style="background:#7CFC9B;"></span>行情更新：' + (ts || '--');
      }
      if (verEl) {
        var ver = window.__cloudDataVersion || opts.version || '--';
        verEl.innerHTML = '<i class="fas fa-database" style="opacity:.85;margin-right:4px;"></i>数据版本：' + ver;
      }
      if (modeEl) {
        if (window.__isCloudMode) {
          modeEl.innerHTML = '<i class="fas fa-lock" style="opacity:.85;margin-right:4px;"></i>云端只读 · 金额脱敏';
        } else {
          modeEl.innerHTML = '<i class="fas fa-unlock" style="opacity:.85;margin-right:4px;"></i>本地全功能模式';
        }
      }
    }

    function _heatColor(v) {
      if (v === null || v === undefined) return '#fafafa';
      var max = 12, t = Math.max(-1, Math.min(1, v / max));
      function mix(a, b, f) {
        return 'rgb(' + a.map(function(x, i) { return Math.round(x + (b[i] - x) * f); }).join(',') + ')';
      }
      if (t >= 0) return mix([243, 243, 243], [45, 138, 94], t);
      return mix([243, 243, 243], [214, 69, 69], -t);
    }

    function renderMonthlyHeatmap(data) {
      var tbl = document.getElementById('monthlyHeatTable');
      if (!tbl) return;
      var rows = (data && data.rows) ? data.rows : [];
      if (!rows.length) {
        tbl.innerHTML = '<tbody><tr><td class="text-sm" style="color:var(--benchmark-gray);">暂无数据</td></tr></tbody>';
        return;
      }
      var months = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
      var head = '<thead><tr><th class="heat-year">年份</th>';
      months.forEach(function(m) { head += '<th>' + m + '</th>'; });
      head += '<th style="color:var(--deep-purple);">全年</th></tr></thead>';
      var body = '<tbody>';
      rows.forEach(function(row) {
        body += '<tr><td class="heat-year">' + row.year + '</td>';
        (row.months || []).forEach(function(v) {
          if (v === null || v === undefined) {
            body += '<td class="heat-cell" style="background:#fafafa;color:#ccc;">·</td>';
          } else {
            body += '<td class="heat-cell" style="background:' + _heatColor(v) + ';">' + (v > 0 ? '+' : '') + Number(v).toFixed(1) + '</td>';
          }
        });
        var ytd = row.ytd;
        if (ytd === null || ytd === undefined) {
          body += '<td class="heat-cell" style="background:#fafafa;color:#ccc;">·</td>';
        } else {
          body += '<td class="heat-cell" style="background:' + _heatColor(ytd / 2) + ';color:' + (ytd >= 0 ? '#1b5e3a' : '#8a1f1f') + ';">' + (ytd > 0 ? '+' : '') + Number(ytd).toFixed(1) + '</td>';
        }
        body += '</tr>';
      });
      body += '</tbody>';
      tbl.innerHTML = head + body;
    }

    async function loadMonthlyReturns() {
      var data = await apiGet('/api/monthly-returns');
      renderMonthlyHeatmap(data);
    }

    function renderTradeCalendar(tradesList) {
      var grid = document.getElementById('tradeCalendarGrid');
      var note = document.getElementById('tradeCalendarModeNote');
      if (!grid) return;
      var byDate = {};
      (tradesList || []).forEach(function(t) {
        var d = (t.date || '').slice(0, 10);
        if (!d) return;
        if (!byDate[d]) byDate[d] = { count: 0, amount: 0 };
        byDate[d].count += 1;
        if (t.price != null && t.shares != null) byDate[d].amount += Number(t.price) * Number(t.shares);
      });
      var useAmount = !window.__isCloudMode && !window.__sensitiveHidden;
      if (note) note.textContent = useAmount ? '色深 = 当日交易金额（本地）' : '色深 = 当日交易笔数（云端/脱敏）';
      var colors = ['#ebedf0', '#c9c0e3', '#9b8bc9', '#6b5ca5', '#4A3D7C'];
      var dates = Object.keys(byDate).sort();
      if (!dates.length) { grid.innerHTML = '<span class="text-xs" style="color:var(--benchmark-gray);">暂无交易</span>'; return; }
      var start = new Date(dates[0]);
      var end = new Date(dates[dates.length - 1]);
      // 防御：日期串畸形会得到 Invalid Date，后续 toISOString 抛 RangeError 且 while 可能死循环
      if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        grid.innerHTML = '<span class="text-xs" style="color:var(--benchmark-gray);">交易日期异常，无法渲染日历</span>';
        return;
      }
      start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
      var html = '';
      var cur = new Date(start);
      var maxVal = 0;
      dates.forEach(function(d) {
        var v = useAmount ? byDate[d].amount : byDate[d].count;
        if (v > maxVal) maxVal = v;
      });
      while (cur <= end || cur.getDay() !== 0) {
        var ds = cur.toISOString().slice(0, 10);
        var info = byDate[ds];
        var lvl = 0;
        if (info && maxVal > 0) {
          var v = useAmount ? info.amount : info.count;
          var ratio = v / maxVal;
          if (ratio > 0.75) lvl = 4;
          else if (ratio > 0.5) lvl = 3;
          else if (ratio > 0.25) lvl = 2;
          else if (ratio > 0) lvl = 1;
        }
        html += '<span class="cal-cell" style="background:' + colors[lvl] + ';" title="' + ds + (info ? (' · ' + info.count + '笔') : '') + '"></span>';
        cur.setDate(cur.getDate() + 1);
        if (cur > end && cur.getDay() === 0) break;
      }
      grid.innerHTML = html;
    }

    function _renderPctileBar(label, pct, reversed, tip) {
      if (pct == null || pct === undefined || isNaN(pct)) {
        return '<div class="pctile-row"><div class="text-sm">' + label + '</div><div class="text-xs" style="color:var(--benchmark-gray);">暂无数据</div><div></div></div>';
      }
      var p = Math.max(0, Math.min(1, Number(pct)));
      var disp = Math.round(p * 100);
      var color = reversed ? (p < 0.35 ? '#2d8a5e' : p > 0.65 ? '#D64545' : '#2d2a3e') : (p > 0.65 ? '#D64545' : p < 0.35 ? '#2d8a5e' : '#2d2a3e');
      var tipHtml = tip ? ' <span class="info-tip"><i class="fas fa-circle-question" style="font-size:11px;"></i><span class="info-tip-text">' + tip + '</span></span>' : '';
      return '<div class="pctile-row"><div class="text-sm">' + label + tipHtml + '</div>'
        + '<div><div class="pctile-track' + (reversed ? ' rev' : '') + '"><div class="pctile-marker" style="left:' + (p * 100) + '%;"></div></div>'
        + '<div class="pctile-scale"><span>0</span><span>50</span><span>100</span></div></div>'
        + '<div class="text-right font-bold" style="color:' + color + ';">' + disp + '</div></div>';
    }

    function renderQuantilePanel(qe) {
      var qpEl = document.getElementById('quantilePanel');
      if (!qpEl || !qe) return;
      qpEl.innerHTML = '<div class="rounded-xl p-4" style="background:#fff;box-shadow:0 2px 12px rgba(74,61,124,0.06);">'
        + _renderPctileBar('VIX 3年分位', qe.vix_3y_pctile, false, '当前 VIX 在近 3 年分布中的百分位')
        + _renderPctileBar('PE 10年分位', qe.pe_10y_pctile, true, '估值越高分位越高')
        + _renderPctileBar('PE 3年分位', qe.pe_3y_pctile, true, '')
        + _renderPctileBar('EMA200 偏离分位', qe.ema200_deviation_3y_pctile, true, '')
        + _renderPctileBar('EMA20 偏离分位', qe.ema20_deviation_3y_pctile, true, '')
        + _renderPctileBar('QQQM 跌幅分位', qe.qqqm_drop_3y_pctile, false, '相对 3 年高点的回撤深度')
        + '<div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3 pt-3" style="border-top:1px solid rgba(74,61,124,0.08);">'
        + '<div class="text-center"><div class="text-xs" style="color:var(--benchmark-gray);">QQQM</div><div class="font-bold">' + (qe.qqqm_price ? '$' + qe.qqqm_price : '--') + '</div></div>'
        + '<div class="text-center"><div class="text-xs" style="color:var(--benchmark-gray);">VIX</div><div class="font-bold">' + (qe.vix_price || '--') + '</div></div>'
        + '<div class="text-center"><div class="text-xs" style="color:var(--benchmark-gray);">10Y</div><div class="font-bold">' + (qe.tnx_yield ? qe.tnx_yield + '%' : '--') + '</div></div>'
        + '<div class="text-center"><div class="text-xs" style="color:var(--benchmark-gray);">IAU</div><div class="font-bold">' + (qe.iau_price ? '$' + qe.iau_price : '--') + '</div></div>'
        + '</div></div>';
    }

    function renderSignalHistory(entries) {
      var listEl = document.getElementById('signalTimelineList');
      var ph = document.getElementById('chartSignalHistoryPlaceholder');
      entries = entries || [];
      if (!entries.length) {
        if (listEl) listEl.innerHTML = '<p class="text-sm" style="color:var(--benchmark-gray);">暂无信号历史，将在每日访问/CI 预计算后逐步积累。</p>';
        if (ph) ph.style.display = 'flex';
        return;
      }
      function _money(n) { return n == null ? '' : '$' + Math.round(Number(n)).toLocaleString('en-US'); }
      function _amt(n) { return n != null ? ' (' + _money(n) + ')' : ''; }
      var events = [];
      entries.slice().reverse().forEach(function(e) {
        if (e.bomb_event) {
          events.push({
            date: e.date, type: 'trigger', level: e.bomb_level || '投弹',
            K: (e.bomb_signal_pct != null ? Number(e.bomb_signal_pct) / 100 : null),
            actualBombPct: e.actual_bomb_pct,
            sigAmt: e.bomb_signal_amount, actAmt: e.bomb_actual_amount
          });
        }
        if (e.monthly_event) {
          events.push({
            date: e.date, type: 'monthly', S: e.S, signalM: e.signal_M, actualM: e.actual_M,
            sigAmt: e.signal_amount, actAmt: e.actual_invest
          });
        }
      });
      if (listEl) {
        listEl.innerHTML = events.length ? events.slice(0, 24).map(function(ev) {
          if (ev.type === 'monthly') {
            var sig = (ev.signalM != null ? Number(ev.signalM).toFixed(2) + 'x' : (ev.S != null ? 'S=' + Number(ev.S).toFixed(2) : '—')) + _amt(ev.sigAmt);
            var exec;
            if (ev.actualM != null) {
              var a = Number(ev.actualM), col = 'var(--benchmark-gray)', tag = '持平';
              // 执行差距在 1%（相对倍率）内算持平
              if (ev.signalM != null) { var s = Number(ev.signalM); var tol = Math.abs(s) * 0.01; if (a > s + tol) { col = '#0d9488'; tag = '↑ 超投'; } else if (a < s - tol) { col = '#D64545'; tag = '↓ 欠投'; } }
              exec = '<span class="text-xs" style="color:' + col + ';white-space:nowrap;">实际 ' + a.toFixed(2) + 'x' + _amt(ev.actAmt) + ' · ' + tag + '</span>';
            } else {
              exec = '<span class="text-xs" style="color:var(--benchmark-gray);white-space:nowrap;">实际 —（' + (window.__isCloudMode ? '本地模式可见' : '本月暂无定投') + '）</span>';
            }
            return '<div class="signal-timeline-item"><div class="signal-tl-dot" style="background:#0d9488;"><i class="fas fa-calendar-check"></i></div>'
              + '<div style="flex:1;min-width:0;"><div class="flex justify-between gap-2 items-center">'
              + '<span class="font-medium text-sm" style="color:var(--deep-purple);white-space:nowrap;">月投 · 信号 ' + sig + '</span>'
              + '<span class="flex items-center gap-2" style="margin-left:auto;">' + exec + '<span class="text-xs" style="color:var(--benchmark-gray);">' + ev.date + '</span></span>'
              + '</div></div></div>';
          }
          var sigB = (ev.K != null ? '信号 ' + (Number(ev.K) * 100).toFixed(1) + '%' : '信号 —') + _amt(ev.sigAmt);
          var bombExec;
          if (ev.actualBombPct != null) {
            var ab = Number(ev.actualBombPct), bcol = 'var(--benchmark-gray)', btag = '持平';
            // 执行差距在 1 个百分点内算持平
            if (ev.K != null) { var sk = Number(ev.K) * 100; if (ab > sk + 1) { bcol = '#0d9488'; btag = '↑ 超投'; } else if (ab < sk - 1) { bcol = '#D64545'; btag = '↓ 欠投'; } }
            bombExec = '<span class="text-xs" style="color:' + bcol + ';white-space:nowrap;">实际 ' + ab.toFixed(1) + '%' + _amt(ev.actAmt) + ' · ' + btag + '</span>';
          } else if (ev.actAmt != null) {
            bombExec = '<span class="text-xs" style="color:var(--benchmark-gray);white-space:nowrap;">实际 ' + _money(ev.actAmt) + '（池未入金）</span>';
          } else {
            bombExec = '<span class="text-xs" style="color:var(--benchmark-gray);white-space:nowrap;">实际 —（' + (window.__isCloudMode ? '本地模式可见' : '近邻无执行') + '）</span>';
          }
          return '<div class="signal-timeline-item"><div class="signal-tl-dot" style="background:#D64545;"><i class="fas fa-crosshairs"></i></div>'
            + '<div style="flex:1;min-width:0;"><div class="flex justify-between gap-2 items-center">'
            + '<span class="font-medium text-sm" style="color:var(--deep-purple);white-space:nowrap;">' + (ev.level || '投弹') + ' 投弹 · ' + sigB + '</span>'
            + '<span class="flex items-center gap-2" style="margin-left:auto;">' + bombExec + '<span class="text-xs" style="color:var(--benchmark-gray);">' + ev.date + '</span></span>'
            + '</div></div></div>';
        }).join('') : '<p class="text-sm" style="color:var(--benchmark-gray);">暂无触发事件记录。</p>';
      }
      // 图表（按日期连续轴）：月投信号倍率 M（每月月末，左轴折线）+ 投弹信号 K%（当日，右轴散点）
      function _ts(d) { var p = (d || '').slice(0, 10).split('-'); return p.length === 3 ? Date.UTC(+p[0], +p[1] - 1, +p[2]) : null; }
      var mPts = entries.filter(function(e) { return e.monthly_event && e.signal_M != null && _ts(e.date) != null; })
        .map(function(e) { return { x: _ts(e.date), y: Number(e.signal_M) }; });
      var bPts = entries.filter(function(e) { return e.bomb_signal_pct != null && _ts(e.date) != null; })
        .map(function(e) { return { x: _ts(e.date), y: Number(e.bomb_signal_pct) }; });
      // 时间线 x 轴对齐「月投 M 折线」的首末点，使曲线从左坐标轴连续起始、右端贴边，无两侧空白
      // （月投 M 是主曲线；个别早于首个月末的投弹散点会被裁掉，仍保留在下方数据行）。
      var baseTs = (mPts.length ? mPts : bPts).map(function(p) { return p.x; });
      var xMin = baseTs.length ? Math.min.apply(null, baseTs) : undefined;
      var xMax = baseTs.length ? Math.max.apply(null, baseTs) : undefined;
      var ctx = document.getElementById('chartSignalHistory');
      if (!ctx) return;
      if (chartSignalHistory) chartSignalHistory.destroy();
      if (ph) ph.style.display = 'none';
      function _fmtMonth(ms) { var d = new Date(ms); return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2); }
      function _fmtDay(ms) { var d = new Date(ms); return _fmtMonth(ms) + '-' + ('0' + d.getUTCDate()).slice(-2); }
      chartSignalHistory = new Chart(ctx, {
        data: {
          datasets: [
            { type: 'line', label: '月投信号倍率 M', data: mPts, yAxisID: 'y', borderColor: '#4A3D7C', backgroundColor: 'rgba(74,61,124,0.08)', fill: true, tension: 0.3, pointRadius: 4, pointHoverRadius: 6 },
            { type: 'scatter', label: '投弹信号 K%', data: bPts, yAxisID: 'y1', borderColor: '#D64545', backgroundColor: '#D64545', pointStyle: 'crossRot', pointRadius: 6, pointHoverRadius: 8, borderWidth: 2 }
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: {
            legend: { labels: { font: { size: 11 }, color: '#8A9199', usePointStyle: true } },
            tooltip: { callbacks: {
              title: function() { return ''; },
              label: function(c) {
                return c.dataset.yAxisID === 'y1'
                  ? '投弹信号 K = ' + Number(c.parsed.y).toFixed(1) + '%（' + _fmtDay(c.parsed.x) + '）'
                  : '月投倍率 M = ' + Number(c.parsed.y).toFixed(2) + 'x（' + _fmtMonth(c.parsed.x) + '）';
              }
            } }
          },
          scales: {
            x: { type: 'linear', min: xMin, max: xMax, ticks: { color: '#8A9199', maxTicksLimit: 8, font: { size: 10 }, callback: function(v) { return _fmtMonth(v); } }, grid: { display: false } },
            y: { position: 'left', suggestedMin: 0.25, suggestedMax: 2.0, title: { display: true, text: '月投倍率 M', color: '#8A9199', font: { size: 10 } }, ticks: { color: '#8A9199', font: { size: 10 }, callback: function(v) { return Number(v).toFixed(2) + 'x'; } }, grid: { color: 'rgba(74,61,124,0.06)' } },
            y1: { position: 'right', beginAtZero: true, title: { display: true, text: '投弹信号 K%', color: '#D64545', font: { size: 10 } }, ticks: { color: '#D64545', font: { size: 10 }, callback: function(v) { return Number(v).toFixed(0) + '%'; } }, grid: { display: false } }
          }
        }
      });
    }

    async function loadSignalHistory() {
      var data = await apiGet('/api/signal-history');
      renderSignalHistory(data && data.entries ? data.entries : []);
    }

    if (typeof window.__sensitiveHidden === 'undefined') {
      window.__isCloudMode = window.location.hostname.indexOf('github.io') !== -1;
      window.__sensitiveHidden = window.__isCloudMode;
    }
    if (window.__isCloudMode) document.documentElement.classList.add('cloud-mode');

    // ========== 请求封装（带错误处理）==========
    function _mapApiToStatic(path) {
      var base = './data/computed/';
      var qIdx = path.indexOf('?');
      var route = qIdx >= 0 ? path.substring(0, qIdx) : path;
      var params = qIdx >= 0 ? path.substring(qIdx + 1) : '';
      var simple = {
        '/api/version': 'version.json',
        '/api/fund-records': 'fund-records.json',
        '/api/trades': 'trades.json',
        '/api/returns-overview': 'returns-overview.json',
        '/api/monthly-returns': 'monthly-returns.json',
        '/api/allocation': 'allocation.json',
        '/api/signals': 'signals.json',
        '/api/signal-history': 'signal-history.json',
        '/api/stress-test': 'stress-test.json',
      };
      if (simple[route]) return base + simple[route];
      if (route === '/api/trade-summary') {
        var p = (params.match(/period=([^&]+)/) || [])[1] || 'all';
        return base + 'trade-summary-' + p + '.json';
      }
      if (route === '/api/strategy-review') {
        var p = (params.match(/period=([^&]+)/) || [])[1] || 'all';
        return base + 'strategy-review-' + p + '.json';
      }
      if (route.indexOf('/api/asset-analysis/') === 0) {
        var sym = route.replace('/api/asset-analysis/', '');
        return base + 'asset-analysis-' + sym + '.json';
      }
      return null;
    }
    // 云端模式数据版本号：由 ensureCloudVersion() 从 version.json.updated_at 读出，
    // 作为所有 data/computed/*.json 的 ?v= 查询串，数据一旦更新 URL 即变化，
    // 手机浏览器/CDN 的旧缓存自然失效；未更新前仍可享受缓存。
    window.__cloudDataVersion = window.__cloudDataVersion || '';
    function _withVersion(url) {
      var v = window.__cloudDataVersion;
      if (!v) return url;
      return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'v=' + encodeURIComponent(v);
    }
    window.__cloudVersionPromise = window.__cloudVersionPromise || null;
    var _CC_VER_KEY = '__TF_cv';   // localStorage key: { v, t }
    var _CC_DAT_PFX = '__TF_cd:';  // localStorage key prefix for data: { v, d }
    var _CC_VER_TTL = 5 * 60 * 1000; // 5 分钟版本缓存有效期
    function _ccGetVer() {
      try { var o = JSON.parse(localStorage.getItem(_CC_VER_KEY) || 'null'); return (o && o.v && typeof o.t === 'number') ? o : null; } catch(e) { return null; }
    }
    function _ccSetVer(v) {
      try { localStorage.setItem(_CC_VER_KEY, JSON.stringify({ v: v, t: Date.now() })); } catch(e) {}
    }
    function _ccGetDat(url) {
      try { return JSON.parse(localStorage.getItem(_CC_DAT_PFX + url) || 'null'); } catch(e) { return null; }
    }
    function _ccSetDat(url, data) {
      if (!window.__cloudDataVersion) return;
      try { localStorage.setItem(_CC_DAT_PFX + url, JSON.stringify({ v: window.__cloudDataVersion, d: data })); } catch(e) {}
    }
    function ensureCloudVersion() {
      if (!window.__isCloudMode) return Promise.resolve();
      if (window.__cloudDataVersion) return Promise.resolve();
      if (window.__cloudVersionPromise) return window.__cloudVersionPromise;
      // 优先从 localStorage 读取 5 分钟内的缓存版本，避免每次访问都拉 version.json
      var cv = _ccGetVer();
      if (cv && (Date.now() - cv.t) < _CC_VER_TTL) {
        window.__cloudDataVersion = cv.v;
        updateGlobalStatusBar({});
        return Promise.resolve();
      }
      window.__cloudVersionPromise = (async function() {
        try {
          var u = './data/computed/version.json?t=' + Date.now();
          var res = await fetch(u, { cache: 'no-store' });
          if (res && res.ok) {
            var j = await res.json();
            if (j && j.updated_at) {
              window.__cloudDataVersion = String(j.updated_at);
              _ccSetVer(window.__cloudDataVersion);
              updateGlobalStatusBar({});
              return;
            }
          }
        } catch (e) { /* ignore */ }
        // 兜底：用本地时间戳，至少保证本次会话能破缓存
        window.__cloudDataVersion = String(Date.now());
      })();
      return window.__cloudVersionPromise;
    }
    async function apiGet(path) {
      if (window.__isCloudMode) {
        var staticUrl = _mapApiToStatic(path);
        if (!staticUrl) return null;
        if (!window.__cloudDataVersion) await ensureCloudVersion();
        // 版本命中缓存：直接返回，无需网络请求
        var cached = _ccGetDat(staticUrl);
        if (cached && cached.v === window.__cloudDataVersion && cached.d != null) {
          return cached.d;
        }
        const res = await fetch(_withVersion(staticUrl)).catch(function(err) { return null; });
        if (!res || !res.ok) return (cached && cached.d != null) ? cached.d : null;
        try {
          var data = await res.json();
          _ccSetDat(staticUrl, data);
          return data;
        } catch(e) { return null; }
      }
      const url = API_BASE + path;
      const res = await fetch(url).catch(function (err) {
        return null;
      });
      if (!res || !res.ok) return null;
      try {
        return await res.json();
      } catch (e) {
        return null;
      }
    }
    async function apiPost(path, body) {
      const url = API_BASE + path;
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined
        });
        var data = null;
        try {
          var ct = res.headers.get('content-type') || '';
          if (ct.indexOf('application/json') !== -1) data = await res.json();
        } catch (e1) {}
        return res.ok ? { ok: true, data: data } : { ok: false, status: res.status, data: data };
      } catch (e) { return { ok: false, status: 0 }; }
    }

    // ========== 工具：按日期降序 ==========
    function sortByDateDesc(arr, dateKey) {
      return [...arr].sort((a, b) => (b[dateKey] || '').localeCompare(a[dateKey] || ''));
    }

// --- tab: returns ---
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

// --- tab: allocation ---
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

// --- tab: history ---
// ========== 交易历史：出入金与交易（数据由 loadFundRecords / loadTrades 拉取）==========
    function renderFundTable() {
      const tbody = document.getElementById('fundTableBody');
      if (!tbody) return;
      const withIndex = fundRecords.map(function (r, i) { return Object.assign({}, r, { _i: i }); });
      const sorted = sortByDateDesc(withIndex, 'date');
      if (!sorted.length) {
        tbody.innerHTML = '<tr><td colspan="4" class="p-3 text-center text-slate-500">暂无出入金记录</td></tr>';
        return;
      }
      var hide = window.__sensitiveHidden;
      var cloud = window.__isCloudMode;
      tbody.innerHTML = sorted.map(function (r) {
        const amt = Number(r.amount);
        var amtStr = hide ? '***' : ((amt >= 0 ? '+' : '') + '$' + amt.toLocaleString());
        var ops = cloud ? '' : '<td class="p-3"><div class="flex justify-between items-center gap-2 whitespace-nowrap"><button type="button" class="btn-fund-edit px-2 py-1 rounded bg-slate-200 hover:bg-slate-300 text-sm whitespace-nowrap" data-index="' + r._i + '">编辑</button><button type="button" class="btn-fund-delete px-2 py-1 rounded bg-red-100 hover:bg-red-200 text-red-700 text-sm whitespace-nowrap" data-index="' + r._i + '">删除</button></div></td>';
        return '<tr data-index="' + r._i + '"><td class="p-3">' + r.date + '</td><td class="p-3 text-right">' + amtStr + '</td><td class="p-3">' + (r.note || '-') + '</td>' + ops + '</tr>';
      }).join('');
    }

    var _typeTagStyle = {
      '定投': 'background:#4A3D7C;color:#fff;', '投弹': 'background:#BFA960;color:#2d2a3e;',
      '投机': 'background:#e2e8f0;color:#475569;', '现金管理': 'background:#94a3b8;color:#fff;',
      '分红': 'background:#0d9488;color:#fff;',
      '合股拆股': 'background:#c2410c;color:#fff;',
    };
    function _typeTag(t) {
      var s = _typeTagStyle[t] || 'background:#e2e8f0;color:#475569;';
      return '<span class="px-2 py-0.5 rounded text-xs" style="'+s+'">' + (t||'--') + '</span>';
    }
    var TRADE_TYPE_FILTER_OPTIONS = ['定投', '投弹', '投机', '现金管理', '分红', '合股拆股'];
    var TRADE_TYPE_FILTER_DEFAULT = ['定投', '投弹', '投机'];
    function _setTradeTypeFilterBtnStyle(btn, active) {
      if (!btn) return;
      if (active) {
        btn.style.background = 'var(--deep-purple)';
        btn.style.color = '#fff';
        btn.style.border = '1px solid var(--deep-purple)';
      } else {
        btn.style.background = '#fff';
        btn.style.color = 'var(--deep-purple)';
        btn.style.border = '1px solid var(--deep-purple)';
      }
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    function syncTradeTypeAllBtn() {
      var allBtn = document.querySelector('.trade-type-filter-btn[data-type="__all__"]');
      var typeBtns = document.querySelectorAll('.trade-type-filter-btn[data-type]:not([data-type="__all__"])');
      var allActive = typeBtns.length > 0;
      typeBtns.forEach(function (b) {
        if (b.getAttribute('aria-pressed') !== 'true') allActive = false;
      });
      _setTradeTypeFilterBtnStyle(allBtn, allActive);
    }
    function setTradeTypeFilters(types) {
      var set = {};
      (types || []).forEach(function (t) { set[t] = true; });
      document.querySelectorAll('.trade-type-filter-btn[data-type]:not([data-type="__all__"])').forEach(function (b) {
        _setTradeTypeFilterBtnStyle(b, !!set[b.dataset.type]);
      });
      syncTradeTypeAllBtn();
    }
    function getSelectedTradeTypes() {
      var selected = [];
      document.querySelectorAll('.trade-type-filter-btn[data-type]:not([data-type="__all__"])').forEach(function (b) {
        if (b.getAttribute('aria-pressed') === 'true') selected.push(b.dataset.type);
      });
      return selected;
    }
    function initTradeTypeFilters() {
      setTradeTypeFilters(TRADE_TYPE_FILTER_DEFAULT);
    }
    function refreshTradeSymbolOptions() {
      var sel = document.getElementById('tradeFilterSymbol');
      if (!sel) return;
      var prev = sel.value || '__all__';
      var set = {};
      (trades || []).forEach(function (r) { if (r && r.symbol) set[r.symbol] = true; });
      var symbols = Object.keys(set).sort();
      var html = '<option value="__all__">全部</option>';
      symbols.forEach(function (s) {
        html += '<option value="' + s + '">' + s + '</option>';
      });
      sel.innerHTML = html;
      sel.value = (prev === '__all__' || symbols.indexOf(prev) >= 0) ? prev : '__all__';
    }
    function renderTradesTable() {
      const tbody = document.getElementById('tradesTableBody');
      if (!tbody) return;
      const withIndex = trades.map(function (r, i) { return Object.assign({}, r, { _i: i }); });
      var symSel = document.getElementById('tradeFilterSymbol');
      var symFilter = symSel ? symSel.value : '__all__';
      var typeFilters = getSelectedTradeTypes();
      var filtered = withIndex.filter(function (r) {
        if (symFilter !== '__all__' && r.symbol !== symFilter) return false;
        if (!typeFilters.length) return false;
        if (typeFilters.indexOf(r.type || '') < 0) return false;
        return true;
      });
      const sorted = sortByDateDesc(filtered, 'date');
      var hide = window.__sensitiveHidden;
      var cloud = window.__isCloudMode;
      if (!sorted.length) {
        var emptyText = trades.length === 0 ? '暂无交易明细' : '当前筛选下无交易明细';
        var colSpan = cloud ? 5 : 9;
        tbody.innerHTML = '<tr><td colspan="' + colSpan + '" class="p-3 text-center text-slate-500">' + emptyText + '</td></tr>';
        return;
      }
      tbody.innerHTML = sorted.map(function (r) {
        var autoBadge = r.auto ? ' <span class="text-xs px-1.5 py-0.5 rounded" style="background:#e0e7ff;color:#3730a3;">自动</span>' : '';
        var editBtn = (cloud || r.auto) ? '' : '<button type="button" class="btn-trade-edit px-2 py-1 rounded bg-slate-200 hover:bg-slate-300 text-sm whitespace-nowrap" data-index="' + r._i + '">编辑</button>';
        var delBtn = cloud ? '' : '<button type="button" class="btn-trade-delete px-2 py-1 rounded bg-red-100 hover:bg-red-200 text-red-700 text-sm whitespace-nowrap" data-index="' + r._i + '">删除</button>';
        var ops = cloud ? '' : '<td class="p-3"><div class="flex justify-between items-center gap-2 whitespace-nowrap">' + editBtn + delBtn + '</div></td>';
        var priceStr = r.price != null ? '$' + Number(r.price).toFixed(2) : '--';
        var sharesStr = hide ? '***' : (r.shares != null ? r.shares : '--');
        var commStr = hide ? '***' : ('$' + Number(r.commission || 0).toFixed(2));
        var totalAmt = (r.price != null && r.shares != null) ? r.price * r.shares : null;
        var totalStr = hide ? '***' : (totalAmt != null ? '$' + totalAmt.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2}) : '--');
        return '<tr data-index="' + r._i + '"><td class="p-3">' + r.date + '</td><td class="p-3">' + r.symbol + '</td><td class="p-3">' + r.action + '</td><td class="p-3 text-right">' + priceStr + '</td><td class="p-3 text-right cloud-hide-col">' + sharesStr + '</td><td class="p-3 text-right col-commission cloud-hide-col">' + commStr + '</td><td class="p-3 text-right cloud-hide-col">' + totalStr + '</td><td class="p-3 col-type">' + _typeTag(r.type) + autoBadge + '</td>' + ops + '</tr>';
      }).join('');
    }
    async function loadTradeSummary(period) {
      var data = await apiGet('/api/trade-summary?period=' + (period || 'all'));
      if (!data) return;
      var ie = document.getElementById('sumInflow');
      var oe = document.getElementById('sumOutflow');
      var ce = document.getElementById('sumCommission');
      var ue = document.getElementById('sumCashUtil');
      if (ie) ie.textContent = _usd(data.total_inflow);
      if (oe) oe.textContent = _usd(data.total_outflow);
      if (ce) ce.textContent = _usd(data.total_commission);
      if (ue) ue.textContent = data.cash_utilization_pct + '%';
    }
    async function loadFundRecords() {
      const data = await apiGet('/api/fund-records');
      fundRecords = Array.isArray(data) ? data : [];
      renderFundTable();
    }
    async function loadTrades() {
      const data = await apiGet('/api/trades');
      trades = Array.isArray(data) ? data : [];
      refreshTradeSymbolOptions();
      renderTradesTable();
      try { renderTradeCalendar(trades); }
      catch (e) { console.error('renderTradeCalendar 失败（已隔离）:', e); }
    }

    // ========== 主导航切换（支持 hash 路由同步；_skipHash=true 用于 __applyRoute 内部调用）==========
    function showSection(sectionId, _skipHash) {
      document.querySelectorAll('.section-content').forEach(el => el.classList.add('hidden'));
      document.querySelectorAll('.nav-btn').forEach(el => { el.classList.remove('bg-white/20'); el.style.background = ''; });
      const section = document.getElementById('section-' + sectionId);
      const btn = document.querySelector('.nav-btn[data-section="' + sectionId + '"]');
      if (section) section.classList.remove('hidden');
      if (btn) { btn.classList.add('bg-white/20'); btn.style.background = 'rgba(255,255,255,0.2)'; }
      document.querySelectorAll('.mob-tab').forEach(el => el.classList.remove('mob-active'));
      const mobBtn = document.querySelector('.mob-tab[data-section="' + sectionId + '"]');
      if (mobBtn) mobBtn.classList.add('mob-active');
      window.scrollTo(0, 0);
      if (!_skipHash && window.__updateRouteHash) {
        if (sectionId === 'history' && window.__isCloudMode) window.__updateRouteHash(sectionId, 'trades');
        else window.__updateRouteHash(sectionId);
      }
      if (sectionId === 'history') {
        var hr = window.__parseHash ? window.__parseHash(window.location.hash) : null;
        var hsub = (hr && hr.sub) || (window.__isCloudMode ? 'trades' : 'fund');
        if (window.__isCloudMode && hsub === 'fund') hsub = 'trades';
        showHistoryTab(hsub, true);
      }
      // 懒加载：首次切换到信号/复盘时才触发耗时 API
      if (sectionId === 'signals' && !__lazyLoaded.signals) {
        __lazyLoaded.signals = true;
        loadSignals();
      }
      if (sectionId === 'review' && !__lazyLoaded.review) {
        __lazyLoaded.review = true;
        var activeRevBtn = document.querySelector('.review-period-btn.review-period-active');
        loadStrategyReview(activeRevBtn ? activeRevBtn.dataset.rp : 'all');
      }
    }

    // ========== 交易历史子标签（支持 hash 路由同步；_skipHash=true 用于 __applyRoute 内部调用）==========
    function showHistoryTab(tab, _skipHash) {
      if (window.__isCloudMode && tab === 'fund') tab = 'trades';
      document.querySelectorAll('.history-tab').forEach(el => {
        el.classList.remove('tab-active');
        el.style.color = 'var(--benchmark-gray)';
      });
      const active = document.querySelector('.history-tab[data-tab="' + tab + '"]');
      if (active) { active.classList.add('tab-active'); active.style.color = 'var(--deep-purple)'; }
      document.getElementById('panel-fund').classList.toggle('hidden', tab !== 'fund');
      document.getElementById('panel-trades').classList.toggle('hidden', tab !== 'trades');
      if (!_skipHash && window.__updateRouteHash) window.__updateRouteHash('history', tab);
    }

    // ========== 弹窗显示/隐藏 ==========
    function openModal(id) {
      const modal = document.getElementById(id);
      if (modal) { modal.classList.remove('hidden'); modal.classList.add('flex'); }
    }
    function closeModal(id) {
      const modal = document.getElementById(id);
      if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); }
    }

// --- tab: signals ---
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

// --- tab: review ---
// ========== 压力测试 & 蒙特卡洛 ==========
    var chartMonteCarlo = null;

    // 懒加载状态：首次进入该标签才触发对应的耗时 API，避免每次页面加载都触发冷启动
    var __lazyLoaded = { signals: false, review: false };
    async function loadStressTest() {
      var loadEl = document.getElementById('stressLoading');
      var resultEl = document.getElementById('stressResultBlock');
      var btnEl = document.getElementById('btnRunStress');
      var isRefresh = resultEl && !resultEl.classList.contains('hidden');
      if (!isRefresh) {
        if (loadEl) loadEl.textContent = '正在运行压力测试，请稍候…';
        if (btnEl) btnEl.disabled = true;
      }
      var data = await apiGet('/api/stress-test');
      if (btnEl) btnEl.disabled = false;
      if (!data) { if (loadEl) loadEl.textContent = '请求失败，请检查后端。'; return; }
      if (loadEl) loadEl.textContent = '';
      if (resultEl) resultEl.classList.remove('hidden');

      var s = data.stress;
      if (s) {
        var scEl = document.getElementById('stressScenario');
        if (scEl) scEl.textContent = s.scenario || '';
        var sbEl = document.getElementById('stressBefore');
        if (sbEl) sbEl.textContent = _usd(s.portfolio_value_before);
        var saEl = document.getElementById('stressAfter');
        if (saEl) saEl.textContent = _usd(s.portfolio_value_after);
        var sdEl = document.getElementById('stressDrawdown');
        if (sdEl) sdEl.textContent = '−' + (s.portfolio_drawdown_pct || 0) + '%';
        var cdEl = document.getElementById('stressCashDeploy');
        if (cdEl) cdEl.textContent = _usd(s.total_cash_deployed);

        var dtBody = document.getElementById('stressDetailBody');
        if (dtBody && s.detail) {
          dtBody.innerHTML = s.detail.map(function(d) {
            var shockColor = d.shock_pct < 0 ? 'color:var(--down-red);' : d.shock_pct > 0 ? 'color:#0d9488;' : '';
            return '<tr><td class="p-2">' + d.symbol + '</td><td class="p-2 text-right" style="' + shockColor + '">' + (d.shock_pct >= 0 ? '+' : '') + d.shock_pct + '%</td><td class="p-2 text-right">' + _usd(d.value_before) + '</td><td class="p-2 text-right">' + _usd(d.value_after) + '</td></tr>';
          }).join('');
        }

        var tsEl = document.getElementById('stressToundanSim');
        if (tsEl && s.toundan_simulation) {
          tsEl.innerHTML = s.toundan_simulation.map(function(t) {
            return '<div class="rounded-xl p-3 text-sm" style="background:var(--light-purple-bg);"><span class="font-medium" style="color:var(--deep-purple);">' + t.level + '</span> K=' + t.k + '<div class="font-bold mt-1">' + _usd(t.deployed_usd) + '</div></div>';
          }).join('');
        }

        var survEl = document.getElementById('stressSurvival');
        if (survEl && s.remaining_reserve != null) {
          var rem = s.remaining_reserve;
          if (rem > 0) {
            survEl.style.background = 'rgba(13,148,136,0.08)';
            survEl.style.color = '#0d9488';
            survEl.innerHTML = '资金链安全：压力后备弹池仍余 ' + _usd(rem) + '（现金占用 ' + _usd(s.total_cash_deployed) + '）';
        } else {
            survEl.style.background = 'rgba(220,38,38,0.08)';
            survEl.style.color = '#dc2626';
            survEl.innerHTML = '风险：资金链断裂，备弹池缺口 ' + _usd(Math.abs(rem)) + '。需调低 K 值或增加备弹池额度。';
          }
        }
      }

      // 蒙特卡洛
      var mc = data.monte_carlo;
      if (mc) {
        var nsEl = document.getElementById('mcNSims'); if (nsEl) nsEl.textContent = mc.n_simulations;
        var nhEl = document.getElementById('mcNHistory'); if (nhEl) nhEl.textContent = mc.n_history_days + '天';
        var clEl = document.getElementById('mcCILow'); if (clEl) clEl.textContent = mc.ci_95_low + '%';
        var chEl = document.getElementById('mcCIHigh'); if (chEl) chEl.textContent = mc.ci_95_high + '%';

        // 分位数
        var pcEl = document.getElementById('mcPercentiles');
        if (pcEl && mc.percentiles) {
          pcEl.innerHTML = Object.keys(mc.percentiles).map(function(k) {
            var v = mc.percentiles[k];
            var col = v < 0 ? 'color:var(--down-red);' : 'color:#0d9488;';
            return '<div class="rounded-lg p-2" style="background:var(--light-purple-bg);"><span class="text-xs" style="color:var(--benchmark-gray);">P' + k + '</span><div class="font-bold" style="' + col + '">' + v + '%</div></div>';
          }).join('');
        }

        // 直方图
        var mcPh = document.getElementById('chartMonteCarloPlaceholder');
        if (mcPh) mcPh.style.display = 'none';
        var mcCtx = document.getElementById('chartMonteCarlo');
        if (mcCtx && mc.histogram && typeof Chart !== 'undefined') {
          if (chartMonteCarlo) chartMonteCarlo.destroy();
          var bgColors = mc.histogram.labels.map(function(v) { return v < 0 ? 'rgba(214,69,69,0.5)' : 'rgba(13,148,136,0.5)'; });
          chartMonteCarlo = new Chart(mcCtx, {
            type: 'bar',
            data: { labels: mc.histogram.labels.map(function(v){return v+'%';}), datasets: [{ label: '频次', data: mc.histogram.counts, backgroundColor: bgColors, borderWidth: 0 }] },
            options: {
              responsive: true, maintainAspectRatio: false,
              plugins: { legend: { display: false }, tooltip: { callbacks: { title: function(items) { return '收益: ' + items[0].label; }, label: function(c) { return c.parsed.y + ' 次'; } } } },
              scales: { x: { grid: { display: false }, ticks: { color: '#8A9199', maxTicksLimit: 10, font: { size: 10 } } }, y: { grid: { color: 'rgba(138,145,153,0.15)' }, ticks: { color: '#8A9199' } } }
            }
          });
        }
      }
    }
    window.__loadStressTest = loadStressTest;

    // ========== 策略复盘 ==========
    async function loadStrategyReview(period) {
      var data = await apiGet('/api/strategy-review?period=' + (period || 'all'));
      if (!data) return;
      // 指标卡片（含合规分 + 小字定义）
      var cards = document.getElementById('reviewCards');
      if (cards) {
        var ds = data.discipline_score, cs = data.compliance_score, er = data.excess_return;
        var be = data.bomb_efficiency, sr = data.safety_ratio;
        var items = [
          {label:'纪律分', val: ds + '%', color: ds >= 90 ? '#0d9488' : '#f59e0b',
           sub: ds >= 90 ? '执行优秀' : ds >= 70 ? '执行良好' : '执行偏低',
           eval: '信号触发后实际执行次数与应执行次数之比，反映策略执行完整度。' + (ds >= 90 ? '当前 ' + ds + '%，执行纪律优秀，信号落地完整' : ds >= 70 ? '当前 ' + ds + '%，执行纪律良好，偶有漏单' : '当前 ' + ds + '%，执行纪律偏低，漏单较多')},
          {label:'合规分', val: cs + '%', color: cs >= 80 ? '#0d9488' : '#f59e0b',
           sub: cs >= 80 ? '配置受控' : cs >= 60 ? '偏离偏大' : '配置超标',
           eval: '各资产实际仓位偏离目标配置比例的综合评分，反映配置纪律。' + (cs >= 80 ? '当前 ' + cs + '%，仓位偏离受控，配置在目标轨道内' : cs >= 60 ? '当前 ' + cs + '%，仓位偏离偏大，建议关注再平衡' : '当前 ' + cs + '%，配置偏离超标，需优先纠偏')},
          {label:'超额收益', val: (er >= 0 ? '+' : '') + er + '%', color: er >= 0 ? '#0d9488' : '#dc2626',
           sub: er > 2 ? '显著跑赢基准' : er > 0 ? '小幅跑赢基准' : er === 0 ? '与基准持平' : '跑输基准',
           eval: '实际收益率（MWRR）减去同期 DCA 定投基准的差值，衡量主动操作带来的额外收益。' + (er > 2 ? '超额 +' + er + '%，策略显著跑赢定投基准' : er > 0 ? '超额 +' + er + '%，策略小幅跑赢定投基准' : er === 0 ? '与定投基准持平，策略效果中性' : '落后 ' + Math.abs(er) + '%，策略跑输定投基准')},
          {label:'投弹效率', val: be != null ? be + '%' : '--', color: be != null && be < 5 ? '#0d9488' : '#f59e0b',
           sub: be == null ? '暂无数据' : be < 3 ? '买点精准' : be < 5 ? '买点良好' : be < 10 ? '买点一般' : '买点偏高',
           eval: '实际买入价偏离同期区间最低价的百分比，越低代表买点越精准。' + (be == null ? '暂无数据' : be < 3 ? '偏离 ' + be + '%，买点精准，接近区间最低价' : be < 5 ? '偏离 ' + be + '%，买点良好，效率较高' : be < 10 ? '偏离 ' + be + '%，买点一般，在合理区间内' : '偏离 ' + be + '%，买点偏高，注意控制入场时机')},
          {label:'安全系数', val: sr != null ? sr + '×' : '--', color: sr != null && sr > 2 ? '#0d9488' : '#dc2626',
           sub: sr == null ? '暂无数据' : sr > 3 ? '备弹非常充裕' : sr > 2 ? '安全边际良好' : sr > 1 ? '备弹有限' : '备弹严重不足',
           eval: '当前备弹池余额除以极端下行压力回撤所需资金之比，反映应对市场极端行情的储备能力。' + (sr == null ? '暂无数据' : sr > 3 ? '当前 ' + sr + '×，备弹非常充裕，应对极端行情有余' : sr > 2 ? '当前 ' + sr + '×，备弹充足，安全边际良好' : sr > 1 ? '当前 ' + sr + '×，备弹有限，需关注补充节奏' : '当前 ' + sr + '×，备弹严重不足，建议尽快补充')},
        ];
        cards.innerHTML = items.map(function(it) {
          return '<div class="rounded-xl p-4" style="background:#fff;box-shadow:0 2px 12px rgba(74,61,124,0.06);position:relative;">'
            + '<span class="info-tip review-card-tip" style="position:absolute;top:10px;right:10px;margin-left:0;">'
            + '<i class="fas fa-circle-info" style="font-size:13px;color:rgba(138,145,153,0.5);"></i>'
            + '<span class="info-tip-text">' + it.eval + '</span>'
            + '</span>'
            + '<div class="text-xs font-medium" style="color:var(--benchmark-gray);padding-right:18px;">' + it.label + '</div>'
            + '<div class="text-2xl font-bold mt-1" style="color:' + it.color + ';">' + it.val + '</div>'
            + '<div class="text-xs mt-1" style="color:var(--benchmark-gray);">' + it.sub + '</div>'
            + '</div>';
        }).join('');
      }
      // AI 结论
      var ce = document.getElementById('reviewConclusion');
      if (ce) ce.textContent = data.conclusion || '暂无数据';
      // 参数建议（根据后端 suggestions 动态生成）
      var sd = document.getElementById('settingsDisplay');
      var sw = document.getElementById('settingsWarning');
      var sa = document.getElementById('settingsActions');
      var st = data.settings || {};
      _get_settings_cache = st;
      if (sd) {
        var whPct = ((st.dividend_withholding_rate != null ? st.dividend_withholding_rate : 0.30) * 100).toFixed(1);
        var offBD = (st.dividend_reinvest_offset_bd != null ? st.dividend_reinvest_offset_bd : 5);
        sd.innerHTML = '<div class="rounded-lg p-3" style="background:var(--light-purple-bg);"><div class="text-xs" style="color:var(--benchmark-gray);">K 封顶值</div><div class="text-lg font-bold mt-1" style="color:var(--deep-purple);">' + st.K_MAX_CAP + '</div><div class="text-xs" style="color:rgba(138,145,153,0.7);font-style:italic;">投弹比例 K 的最大值（v1.3.1 默认 0.12）</div></div>'
          + '<div class="rounded-lg p-3" style="background:var(--light-purple-bg);"><div class="text-xs" style="color:var(--benchmark-gray);">月投基数</div><div class="text-lg font-bold mt-1" style="color:var(--deep-purple);">' + _usd(st.MONTHLY_BASE_OVERRIDE) + '</div><div class="text-xs" style="color:rgba(138,145,153,0.7);font-style:italic;">每月定投基础金额，乘以倍率 M 后为实际月投</div></div>'
          + '<div class="rounded-lg p-3" style="background:var(--light-purple-bg);"><div class="text-xs" style="color:var(--benchmark-gray);">备弹池消耗率</div><div class="text-lg font-bold mt-1" style="color:' + (data.burn_rate > 70 ? '#dc2626' : data.burn_rate > 50 ? '#f59e0b' : 'var(--deep-purple)') + ';">' + data.burn_rate + '%</div><div class="text-xs" style="color:rgba(138,145,153,0.7);font-style:italic;">期间投弹总额 / 累计注入额，>70% 为过快</div></div>'
          + '<div class="rounded-lg p-3" style="background:var(--light-purple-bg);"><div class="text-xs" style="color:var(--benchmark-gray);">渐进熔断</div><div class="text-sm font-bold mt-1" style="color:var(--deep-purple);">' + (st.qqqm_soft_pct||70) + '% ~ ' + (st.qqqm_hard_pct||85) + '%</div><div class="text-xs" style="color:rgba(138,145,153,0.7);font-style:italic;">QQQM 占比超 soft 线后渐进缩减，hard 线完全停投</div></div>'
          + '<div class="rounded-lg p-3" style="background:var(--light-purple-bg);"><div class="text-xs" style="color:var(--benchmark-gray);">分红再投资口径</div><div class="text-sm font-bold mt-1" style="color:var(--deep-purple);">预扣税 ' + whPct + '% · 付息偏移 +' + offBD + ' 工作日</div><div class="text-xs" style="color:rgba(138,145,153,0.7);font-style:italic;">同步分红时：股数 = (每股分红 × 持仓 × (1-税率)) / 付息日开盘价</div></div>';
      }
      // 动态建议
      var sugs = data.suggestions || [];
      if (sw) {
        if (sugs.length > 0) {
          sw.innerHTML = sugs.map(function(s) {
            var icon = s.priority === 'high' ? '<i class="fas fa-exclamation-triangle mr-1"></i>' : '<i class="fas fa-info-circle mr-1"></i>';
            return '<div class="mb-1">' + icon + s.text + '</div>';
          }).join('');
          sw.classList.remove('hidden');
        } else { sw.classList.add('hidden'); }
      }
      if (sa) {
        if (window.__isCloudMode) { sa.innerHTML = ''; }
        else {
          sa.innerHTML = '<button type="button" class="btn-adjust-k px-4 py-2 rounded text-sm transition" style="background:var(--champagne-gold);color:#2d2a3e;">下调 K 封顶（' + st.K_MAX_CAP + ' → ' + (st.K_MAX_CAP / 2).toFixed(2) + '）</button>'
            + '<button type="button" class="btn-adjust-m px-4 py-2 rounded text-sm transition" style="background:var(--deep-purple);color:#fff;">提高月投 20%（' + _m('$' + st.MONTHLY_BASE_OVERRIDE + ' → $' + Math.round(st.MONTHLY_BASE_OVERRIDE * 1.2)) + '）</button>'
            + '<button type="button" class="btn-adjust-div px-4 py-2 rounded text-sm transition" style="background:#0d9488;color:#fff;" title="修改分红同步用的预扣税率与付息日偏移">编辑分红再投资口径</button>';
        }
      }
    }

    // ========== 历史回测（静态 JSON：data/backtest/v1.3.1-*.json）==========
    var __backtestState = {
      period: '10y',
      cache: {},
      navRange: 'all',
      navScale: 'linear',
      navView: 'nav',
      page: 1,
      pageSize: 50,
      lastTrades: null,
      lastSummary: null,
      lastNav: null
    };
    var chartBacktestNav = null;
    var chartBacktestDrawdown = null;

    function _backtestUsd(v) {
      if (v == null || isNaN(v)) return '—';
      var abs = Math.abs(Number(v));
      return (Number(v) >= 0 ? '+$' : '-$') + abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    function _btMoneyAlways(v) {
      if (v == null || isNaN(v)) return '—';
      return '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    function _backtestDailyReturns(navRows) {
      if (!navRows || navRows.length < 2) return [];
      var rets = [];
      for (var i = 1; i < navRows.length; i++) {
        var a = navRows[i - 1].nav, b = navRows[i].nav;
        if (a == null || b == null || !(a > 0)) continue;
        rets.push(b / a - 1.0);
      }
      return rets;
    }
    function _backtestSortinoFromNav(navRows) {
      var rets = _backtestDailyReturns(navRows);
      if (!rets.length) return null;
      var mar = 0.0;
      var dn = 0.0;
      var nObs = rets.length;
      for (var i = 0; i < rets.length; i++) {
        var dd = Math.min(0.0, rets[i] - mar);
        dn += dd * dd;
      }
      var ddev = Math.sqrt(dn / nObs) * Math.sqrt(252);
      if (!ddev || ddev <= 1e-12 || !isFinite(ddev)) return null;
      var prod = 1.0;
      for (var j = 0; j < rets.length; j++) prod *= (1.0 + rets[j]);
      var years = Math.max(rets.length / 252.0, 1e-6);
      var annRet = Math.pow(Math.max(prod, 1e-18), 1.0 / years) - 1.0;
      return annRet / ddev;
    }
    function _backtestCalmarFromSummary(m) {
      if (!m || m.cagr_pct == null || m.max_drawdown_pct == null) return null;
      var dd = Number(m.max_drawdown_pct);
      if (!(dd > 1e-6)) return null;
      return Number(m.cagr_pct) / dd;
    }
    function backtestBasePath() {
      /* 使用 origin + 当前文档目录，避免 #hash 或 /index.html 等形态下 ./data 解析到错误路径 */
      try {
        var origin = window.location.origin;
        var path = window.location.pathname || '/';
        if (!origin || origin === 'null') return './data/backtest/v1.3.1-';
        var seg = (path.split('/').pop() || '');
        if (/\.[^./]+$/.test(seg)) path = path.replace(/\/[^/]+$/, '/');
        else if (!path.endsWith('/')) path += '/';
        if (!path.startsWith('/')) path = '/' + path;
        return origin + path + 'data/backtest/v1.3.1-';
      } catch (e) {
        return './data/backtest/v1.3.1-';
      }
    }
    function downsampleBacktestSeries(labels, data, maxPts) {
      if (!labels || labels.length <= maxPts) return { labels: labels, data: data };
      var step = Math.ceil(labels.length / maxPts);
      var nl = [];
      var nd = [];
      for (var i = 0; i < labels.length; i += step) {
        nl.push(labels[i]);
        nd.push(data[i]);
      }
      if (nl[nl.length - 1] !== labels[labels.length - 1]) {
        nl.push(labels[labels.length - 1]);
        nd.push(data[data.length - 1]);
      }
      return { labels: nl, data: nd };
    }
    function downsampleBacktestMulti(labels, seriesArrays, maxPts) {
      if (!labels || !seriesArrays || !seriesArrays.length) return { labels: labels || [], series: seriesArrays || [] };
      if (labels.length <= maxPts) {
        return { labels: labels, series: seriesArrays.map(function (a) { return a.slice(); }) };
      }
      var step = Math.ceil(labels.length / maxPts);
      var nl = [];
      var ns = seriesArrays.map(function () { return []; });
      for (var i = 0; i < labels.length; i += step) {
        nl.push(labels[i]);
        for (var j = 0; j < seriesArrays.length; j++) {
          ns[j].push(seriesArrays[j][i]);
        }
      }
      if (nl[nl.length - 1] !== labels[labels.length - 1]) {
        nl.push(labels[labels.length - 1]);
        for (var j = 0; j < seriesArrays.length; j++) {
          ns[j].push(seriesArrays[j][seriesArrays[j].length - 1]);
        }
      }
      return { labels: nl, series: ns };
    }
    function filterBacktestNavByRange(navRows, rangeKey) {
      if (!navRows || !navRows.length || rangeKey === 'all') return navRows;
      var last = navRows[navRows.length - 1].date;
      var end = new Date(last + 'T12:00:00');
      var years = rangeKey === '5y' ? 5 : 1;
      var start = new Date(end);
      start.setFullYear(start.getFullYear() - years);
      var startStr = start.toISOString().slice(0, 10);
      return navRows.filter(function (r) { return r.date >= startStr; });
    }
    async function loadBacktestBundle(period) {
      if (__backtestState.cache[period]) return __backtestState.cache[period];
      var base = backtestBasePath() + period;
      var fetchOpts = { cache: 'no-store' };
      var res = await Promise.all([
        fetch(base + '-summary.json', fetchOpts).then(function (r) {
          if (!r.ok) throw new Error('summary HTTP ' + r.status);
          return r.json();
        }),
        fetch(base + '-nav.json', fetchOpts).then(function (r) {
          if (!r.ok) throw new Error('nav HTTP ' + r.status);
          return r.json();
        }),
        fetch(base + '-trades.json', fetchOpts).then(function (r) {
          if (!r.ok) throw new Error('trades HTTP ' + r.status);
          return r.json();
        })
      ]);
      if (!Array.isArray(res[1])) throw new Error('nav 非数组');
      if (!Array.isArray(res[2])) throw new Error('trades 非数组');
      __backtestState.cache[period] = { summary: res[0], nav: res[1], trades: res[2] };
      return __backtestState.cache[period];
    }
    function applyBacktestQueryParam() {
      try {
        var q = new URLSearchParams(window.location.search).get('bt');
        if (q === '10y' || q === '20y' || q === '30y') {
          __backtestState.period = q;
          document.querySelectorAll('.backtest-period-btn').forEach(function (b) {
            var on = b.getAttribute('data-bt-period') === q;
            b.style.background = on ? 'var(--deep-purple)' : '#fff';
            b.style.color = on ? '#fff' : 'var(--deep-purple)';
          });
        }
      } catch (e) {}
    }
    window.__reviewSubTab = function (mode, skipHash) {
      var live = document.getElementById('reviewLivePanel');
      var bt = document.getElementById('reviewBacktestPanel');
      var stress = document.getElementById('reviewStressPanel');
      document.querySelectorAll('.review-main-tab').forEach(function (t) {
        var m = t.getAttribute('data-review-main');
        var on = m === mode;
        t.classList.toggle('tab-active', on);
        t.classList.toggle('text-slate-600', !on);
        t.style.color = on ? 'var(--deep-purple)' : '';
      });
      if (live) live.classList.toggle('hidden', mode !== 'live');
      if (bt) bt.classList.toggle('hidden', mode !== 'backtest');
      if (stress) stress.classList.toggle('hidden', mode !== 'stress');
      if (mode === 'backtest') {
        applyBacktestQueryParam();
        window.__renderBacktestPanel();
      }
      if (!skipHash && window.__updateRouteHash) {
        window.__updateRouteHash('review', mode);
      }
    };
    window.__renderBacktestPanel = async function () {
      var period = __backtestState.period;
      var ph = document.getElementById('chartBacktestNavPlaceholder');
      var phd = document.getElementById('chartBacktestDrawdownPlaceholder');
      if (ph) { ph.style.display = 'flex'; ph.textContent = '加载中…'; }
      if (phd) { phd.style.display = 'flex'; phd.textContent = '加载中…'; }
      try {
        var bundle = await loadBacktestBundle(period);
        __backtestState.lastTrades = bundle.trades;
        __backtestState.lastSummary = bundle.summary;
        __backtestState.lastNav = bundle.nav;
        renderBacktestMeta(bundle.summary);
        renderBacktestCoreCards(bundle.summary);
        renderBacktestSubCards(bundle.summary);
        renderBacktestTop3Block(bundle.summary.top_drawdowns);
        __backtestState.page = 1;
        renderBacktestTradesPage();
        buildBacktestCharts(bundle.nav, bundle.summary);
        if (ph) ph.style.display = 'none';
        if (phd) phd.style.display = 'none';
      } catch (err) {
        var hint = '加载失败：请确认 data/backtest 下存在 v1.3.1-*-{summary,nav,trades}.json；'
          + '本地请使用本仓库内 python3 server.py（含 /data/backtest/ 路由）并 Ctrl+C 后重启。';
        var detail = (err && err.message) ? (' (' + String(err.message) + ')') : '';
        if (ph) {
          ph.textContent = hint + detail;
          ph.style.display = 'flex';
        }
        if (phd) phd.style.display = 'flex';
      }
    };
    function renderBacktestMeta(summary) {
      var syms = (summary.symbols || []).join(' · ');
      var metaSub = document.getElementById('backtestMetaSub');
      var rows = summary.nav_rows != null ? summary.nav_rows : '—';
      if (metaSub) {
        metaSub.innerHTML = '标的：' + syms + '<br/>'
          + '区间：' + (summary.start_date || '') + ' → ' + (summary.end_date || '') + '（' + rows + ' 个交易日）<br/>'
          + '初始 ' + _btMoneyAlways(summary.initial_capital)
          + ' · 最终 ' + _btMoneyAlways((summary.metrics || {}).final_capital)
          + ' · 手续费 '
          + (summary.commission_rate != null ? (summary.commission_rate * 100).toFixed(2) + '%' : '—')
          + ' · 滑点 ' + (summary.slippage_bps != null ? summary.slippage_bps + ' bps' : '—');
      }
    }
    function renderBacktestCoreCards(summary) {
      var m = summary.metrics || {};
      var el = document.getElementById('backtestCoreCards');
      if (!el) return;
      var cards = [
        { label: '累积收益', val: formatPct(m.cumulative_return_pct), color: (m.cumulative_return_pct >= 0) ? '#2d8a5e' : '#D64545' },
        { label: '年化收益', val: formatPct(m.cagr_pct), color: (m.cagr_pct >= 0) ? '#2d8a5e' : '#D64545' },
        { label: '最大回撤', val: m.max_drawdown_pct != null ? ('−' + m.max_drawdown_pct + '%') : '--', color: '#D64545' },
        { label: '夏普比率', val: m.sharpe != null ? String(m.sharpe) : '--', color: 'var(--deep-purple)' }
      ];
      el.innerHTML = cards.map(function (c) {
        return '<div class="returns-card rounded-xl p-4" style="background:#fff;box-shadow:0 2px 12px rgba(74,61,124,0.06);">'
          + '<div class="text-xs" style="color:var(--benchmark-gray);">' + c.label + '</div>'
          + '<div class="text-xl font-bold mt-1" style="color:' + c.color + ';">' + c.val + '</div></div>';
      }).join('');
    }
    function renderBacktestSubCards(summary) {
      var m = summary.metrics || {};
      var el = document.getElementById('backtestSubCards');
      if (!el) return;
      var ab = (m.alpha_pct != null ? m.alpha_pct : '—') + ' / ' + (m.beta != null ? m.beta : '—');
      var sortino = _backtestSortinoFromNav(__backtestState.lastNav);
      var calmar = _backtestCalmarFromSummary(m);
      var items = [
        { label: '胜率', val: m.win_rate_pct != null ? (Number(m.win_rate_pct).toFixed(2) + '%') : '--' },
        { label: '盈亏比', val: m.profit_loss_ratio != null ? String(m.profit_loss_ratio) : '--' },
        { label: '交易次数', val: m.trade_count != null ? String(m.trade_count) : '--' },
        { label: 'Alpha / Beta', val: ab },
        { label: 'Sortino', val: sortino != null && isFinite(sortino) ? sortino.toFixed(3) : '--' },
        { label: 'Calmar', val: calmar != null && isFinite(calmar) ? calmar.toFixed(3) : '--' }
      ];
      el.innerHTML = items.map(function (c) {
        return '<div class="rounded-xl p-3" style="background:var(--light-purple-bg);">'
          + '<div class="text-xs" style="color:var(--benchmark-gray);">' + c.label + '</div>'
          + '<div class="text-lg font-semibold mt-1" style="color:#2d2a3e;">' + c.val + '</div></div>';
      }).join('');
    }
    function renderBacktestTop3Block(top3) {
      var el = document.getElementById('backtestTop3DrawdownList');
      if (!el) return;
      if (!top3 || !top3.length) {
        el.innerHTML = '<p class="text-sm col-span-full" style="color:var(--benchmark-gray);">无明显回撤段</p>';
        return;
      }
      el.innerHTML = top3.map(function (d, i) {
        var recStr = d.recovery_date ? d.recovery_date : '<span style="color:var(--down-red);">未恢复</span>';
        var recDays = d.recovery_days != null ? d.recovery_days + '天' : '—';
        return '<div class="rounded-xl p-4 priority-high" style="background:#fff;box-shadow:0 2px 12px rgba(214,69,69,0.08);">'
          + '<div class="text-sm font-medium" style="color:var(--down-red);">#' + (i + 1) + '  −' + d.drawdown_pct + '%</div>'
          + '<div class="text-xs mt-1" style="color:var(--benchmark-gray);">峰值 → 谷底：' + (d.peak_date || '') + ' → ' + (d.trough_date || '') + '</div>'
          + '<div class="text-xs" style="color:var(--benchmark-gray);">Duration：' + (d.duration_days != null ? d.duration_days + '天' : '—') + '</div>'
          + '<div class="text-xs" style="color:var(--benchmark-gray);">Recovery：' + recDays + '（' + recStr + '）</div>'
          + '</div>';
      }).join('');
    }
    function renderBacktestTradesPage() {
      var trades = __backtestState.lastTrades || [];
      var page = __backtestState.page;
      var size = __backtestState.pageSize;
      var total = trades.length;
      var start = (page - 1) * size;
      var slice = trades.slice(start, start + size);
      var tb = document.getElementById('backtestTradesBody');
      var info = document.getElementById('backtestTradesPageInfo');
      if (info) {
        info.textContent = total ? ('第 ' + page + ' / ' + Math.ceil(total / size) + ' 页 · 共 ' + total + ' 条') : '无数据';
      }
      var prev = document.getElementById('backtestTradesPrev');
      var next = document.getElementById('backtestTradesNext');
      if (prev) prev.disabled = page <= 1;
      if (next) next.disabled = start + size >= total;
      if (!tb) return;
      tb.innerHTML = slice.map(function (t) {
        var sideZh = t.side === 'SELL' ? '卖出' : (t.side === 'BUY' ? '买入' : t.side);
        var pnl = t.pnl == null ? '—' : _backtestUsd(t.pnl);
        return '<tr style="border-bottom:1px solid rgba(138,145,153,0.15);">'
          + '<td class="p-2">' + t.seq + '</td>'
          + '<td class="p-2">' + t.date + '</td>'
          + '<td class="p-2">' + sideZh + '</td>'
          + '<td class="p-2">' + (t.symbol || '') + '</td>'
          + '<td class="p-2 text-right">' + (t.price != null ? Number(t.price).toFixed(4) : '—') + '</td>'
          + '<td class="p-2 text-right">' + (t.qty != null ? Number(t.qty).toFixed(4) : '—') + '</td>'
          + '<td class="p-2 text-right hidden sm:table-cell">' + (t.commission != null ? Number(t.commission).toFixed(4) : '—') + '</td>'
          + '<td class="p-2 text-right hidden sm:table-cell">' + (t.slippage != null ? Number(t.slippage).toFixed(4) : '—') + '</td>'
          + '<td class="p-2 text-right">' + pnl + '</td></tr>';
      }).join('');
    }
    function updateBacktestNavToolbar() {
      var v = __backtestState.navView || 'nav';
      var titleEl = document.getElementById('backtestNavChartTitle');
      if (titleEl) titleEl.textContent = v === 'return' ? '累计收益率（%）' : '净值曲线';
      document.querySelectorAll('.backtest-nav-view-btn').forEach(function (b) {
        var on = b.getAttribute('data-bt-view') === v;
        b.style.background = on ? 'var(--deep-purple)' : '#fff';
        b.style.color = on ? '#fff' : 'var(--deep-purple)';
      });
      var showScale = v === 'nav';
      var sep = document.getElementById('backtestNavScaleSep');
      var wrap = document.getElementById('backtestNavScaleWrap');
      if (sep) sep.classList.toggle('hidden', !showScale);
      if (wrap) wrap.classList.toggle('hidden', !showScale);
      var note = document.getElementById('backtestBenchmarkProxyNote');
      var sum = __backtestState.lastSummary;
      if (note) {
        var bm = sum && sum.benchmark;
        if (v === 'return' && bm && bm.proxy_days > 0) {
          note.textContent = bm.proxy_days + ' 个交易日早于 QQQ 上市（' + (bm.qqq_ipo_date || '1999-03-10') + '），用 ' + (bm.proxy_before || '^IXIC') + ' 按比例缩放拟合';
          note.classList.remove('hidden');
        } else {
          note.textContent = '';
          note.classList.add('hidden');
        }
      }
    }
    function buildBacktestCharts(navRowsFull, summary) {
      if (typeof Chart === 'undefined') return;
      if (summary) __backtestState.lastSummary = summary;
      updateBacktestNavToolbar();
      var rangeKey = __backtestState.navRange || 'all';
      var navRows = filterBacktestNavByRange(navRowsFull, rangeKey);
      var labels = navRows.map(function (r) { return r.date; });
      var dds = navRows.map(function (r) {
        return r.drawdown_pct != null ? -Math.abs(r.drawdown_pct) : 0;
      });
      var maxPts = 2000;
      var dsDd = downsampleBacktestSeries(labels, dds, maxPts);
      var ctx = document.getElementById('chartBacktestNav');
      var ph = document.getElementById('chartBacktestNavPlaceholder');
      if (chartBacktestNav) chartBacktestNav.destroy();
      if (!ctx) return;

      var view = __backtestState.navView || 'nav';
      if (view === 'return') {
        var row0 = navRows[0] || {};
        if (!('port_ret_pct' in row0)) {
          if (ph) {
            ph.style.display = 'flex';
            ph.textContent = '暂无收益率序列：请运行 python3 scripts/import_backtest.py --enrich-benchmark 并提交 data/backtest/*.json';
          }
          chartBacktestNav = new Chart(ctx, { type: 'line', data: { labels: [], datasets: [] }, options: { responsive: true, maintainAspectRatio: false } });
        } else {
        if (ph) ph.style.display = 'none';
        var portArr = navRows.map(function (r) { return r.port_ret_pct; });
        var bhArr = navRows.map(function (r) { return r.qqq_bh_pct; });
        var dcaArr = navRows.map(function (r) { return r.qqq_dca_pct; });
        var mds = downsampleBacktestMulti(labels, [portArr, bhArr, dcaArr], maxPts);
        chartBacktestNav = new Chart(ctx, {
          type: 'line',
          data: {
            labels: mds.labels,
            datasets: [
              { label: '组合 (回测)', data: mds.series[0], borderColor: '#4A3D7C', backgroundColor: 'rgba(74,61,124,0.06)', fill: true, tension: 0.3, borderWidth: 2, pointRadius: 0 },
              { label: 'QQQ 买入持有', data: mds.series[1], borderColor: '#8A9199', backgroundColor: 'rgba(138,145,153,0.04)', fill: true, tension: 0.3, borderWidth: 1.5, pointRadius: 0 },
              { label: 'QQQ 月定投', data: mds.series[2], borderColor: '#BFA960', backgroundColor: 'rgba(191,169,96,0.04)', fill: false, tension: 0.3, borderWidth: 1.5, borderDash: [6, 3], pointRadius: 0 }
            ]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { intersect: false, mode: 'index' },
            plugins: {
              legend: { position: 'top', labels: { color: '#2d2a3e', usePointStyle: true } },
              tooltip: {
                mode: 'index',
                intersect: false,
                filter: function (item) { return item.raw != null && !isNaN(item.raw); },
                callbacks: {
                  label: function (c) {
                    var y = c.parsed.y;
                    return c.dataset.label + ': ' + (y != null ? Number(y).toFixed(2) : '—') + '%';
                  }
                }
              }
            },
            scales: {
              x: { grid: { display: false }, ticks: { color: '#8A9199', maxTicksLimit: 10 } },
              y: {
                grid: { color: 'rgba(138,145,153,0.15)' },
                ticks: { color: '#8A9199' },
                beginAtZero: false
              }
            }
          }
        });
        }
      } else {
        if (ph) ph.style.display = 'none';
        var navs = navRows.map(function (r) { return r.nav; });
        var dsNav = downsampleBacktestSeries(labels, navs, maxPts);
        var scale = __backtestState.navScale || 'linear';
        var navData = dsNav.data;
        if (scale === 'log') {
          navData = dsNav.data.map(function (v) { return v > 0 ? v : null; });
        }
        var yType = scale === 'log' ? 'logarithmic' : 'linear';
        chartBacktestNav = new Chart(ctx, {
          type: 'line',
          data: {
            labels: dsNav.labels,
            datasets: [{
              label: '净值',
              data: navData,
              borderColor: '#4A3D7C',
              backgroundColor: 'rgba(74,61,124,0.08)',
              fill: true,
              tension: 0.1,
              pointRadius: 0,
              spanGaps: scale === 'log'
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { intersect: false, mode: 'index' },
            plugins: { legend: { display: false } },
            scales: {
              x: { grid: { display: false }, ticks: { color: '#8A9199', maxTicksLimit: 10 } },
              y: {
                type: yType,
                grid: { color: 'rgba(138,145,153,0.15)' },
                ticks: { color: '#8A9199' },
                beginAtZero: scale !== 'log'
              }
            }
          }
        });
      }
      var ctx2 = document.getElementById('chartBacktestDrawdown');
      if (chartBacktestDrawdown) chartBacktestDrawdown.destroy();
      if (!ctx2) return;
      chartBacktestDrawdown = new Chart(ctx2, {
        type: 'line',
        data: {
          labels: dsDd.labels,
          datasets: [{
            label: 'Drawdown %',
            data: dsDd.data,
            borderColor: '#D64545',
            backgroundColor: 'rgba(214,69,69,0.12)',
            fill: true,
            tension: 0.2,
            borderWidth: 1.5,
            pointRadius: 0
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { intersect: false, mode: 'index' },
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: function (c) {
                  var y = c.parsed.y;
                  return '回撤 ' + (y != null ? (-y).toFixed(2) : '') + '%';
                }
              }
            }
          },
          scales: {
            x: { grid: { display: false }, ticks: { color: '#8A9199', maxTicksLimit: 8 } },
            y: { grid: { color: 'rgba(214,69,69,0.1)' }, ticks: { color: '#8A9199' }, max: 0 }
          }
        }
      });
    }
    function downloadBacktestCsv() {
      var trades = __backtestState.lastTrades;
      if (!trades || !trades.length) return;
      function esc(v) {
        if (v == null) return '';
        var s = String(v);
        if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
        return s;
      }
      var headers = ['seq', 'date', 'side', 'symbol', 'price', 'qty', 'commission', 'slippage', 'pnl'];
      var lines = [headers.join(',')];
      trades.forEach(function (t) {
        lines.push([t.seq, t.date, t.side, t.symbol, t.price, t.qty, t.commission, t.slippage, t.pnl].map(esc).join(','));
      });
      var blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'backtest-' + __backtestState.period + '-trades.csv';
      a.click();
      URL.revokeObjectURL(a.href);
    }

    // ========== 智能粘贴解析 ==========
    var _parsedSmartTrades = [];
    function parseSmartPaste() {
      var text = (document.getElementById('smartPasteText') || {}).value || '';
      var resultEl = document.getElementById('smartPasteResult');
      var submitBtn = document.getElementById('btnSubmitSmartPaste');
      var warnEl = document.getElementById('smartPasteCashWarn');
      if (warnEl) warnEl.classList.add('hidden');
      _parsedSmartTrades = [];
      // 多种模式匹配
      var patterns = [
        /(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})\s+(?:买入|卖出|Buy|Sell)\s+(\S+)\s+\$?([\d.]+)\s+([\d.]+)\s*(?:股|shares)?/gi,
        /(\d{4}[-\/]\d{1,2}[-\/]\d{1,2}).*?(QQQM|BRK\.?B|IAU|BOXX|IVV|VIG|QLD|SPY)\s+.*?(买入|卖出|Buy|Sell).*?\$?([\d.]+).*?([\d.]+)\s*(?:股|shares)/gi,
      ];
      var lines = text.split('\n');
      lines.forEach(function(line) {
        line = line.trim();
        if (!line) return;
        for (var pi = 0; pi < patterns.length; pi++) {
          patterns[pi].lastIndex = 0;
          var m = patterns[pi].exec(line);
          if (m) {
            var date = m[1].replace(/\//g, '-');
            var sym, action, price, shares;
            if (pi === 0) { action = /卖出|sell/i.test(line) ? '卖出' : '买入'; sym = m[2].toUpperCase(); price = parseFloat(m[3]); shares = parseFloat(m[4]); }
            else { sym = m[2].toUpperCase().replace('BRKB','BRK.B'); action = /卖出|sell/i.test(m[3]) ? '卖出' : '买入'; price = parseFloat(m[4]); shares = parseFloat(m[5]); }
            if (sym && price > 0 && shares > 0) {
              _parsedSmartTrades.push({ date: date, symbol: sym, action: action, price: price, shares: shares, commission: 0, type: sym === 'BOXX' ? '现金管理' : '定投' });
            }
            return;
          }
        }
      });
      if (!_parsedSmartTrades.length) {
        if (resultEl) resultEl.innerHTML = '<span style="color:#dc2626;">无法识别交易信息，请检查格式</span>';
        if (submitBtn) submitBtn.classList.add('hidden');
        return;
      }
      if (resultEl) {
        resultEl.innerHTML = '<div class="text-xs mb-1" style="color:var(--benchmark-gray);">识别到 ' + _parsedSmartTrades.length + ' 条交易：</div>'
          + _parsedSmartTrades.map(function(t) { return '<div class="text-xs">' + t.date + ' ' + t.action + ' ' + t.symbol + ' $' + t.price + ' × ' + t.shares + '股 ' + _typeTag(t.type) + '</div>'; }).join('');
      }
      if (submitBtn) submitBtn.classList.remove('hidden');
      // 现金余额校验
      var totalBuy = _parsedSmartTrades.reduce(function(s, t) { return t.action === '买入' ? s + t.price * t.shares : s; }, 0);
      if (totalBuy > 0 && allocationList) {
        var boxxRow = allocationList.find(function(r) { return r.symbol === 'BOXX'; });
        var boxxVal = boxxRow ? boxxRow.amount : 0;
        if (totalBuy > boxxVal && warnEl) {
          warnEl.textContent = '注意：买入总额 $' + totalBuy.toFixed(2) + ' 超过当前现金余额（BOXX $' + boxxVal.toFixed(2) + '），可能导致负现金';
          warnEl.classList.remove('hidden');
        }
      }
    }
    async function submitSmartPaste() {
      if (!_parsedSmartTrades.length) return;
      for (var i = 0; i < _parsedSmartTrades.length; i++) {
        await apiPost('/api/trades', _parsedSmartTrades[i]);
      }
      _parsedSmartTrades = [];
      window.__closeModal('modalSmartPaste');
      var ta = document.getElementById('smartPasteText'); if (ta) ta.value = '';
      var re = document.getElementById('smartPasteResult'); if (re) re.innerHTML = '';
      var sb = document.getElementById('btnSubmitSmartPaste'); if (sb) sb.classList.add('hidden');
      await loadTrades(); await loadReturnsOverview(); await loadAllocation(); await loadSignals(); loadTradeSummary('all');
    }

    // ========== 事件绑定（DOMContentLoaded 后绑定，委托到 document 捕获阶段）==========
    function bindEvents() {
      var root = document.documentElement || document.body;
      if (!root) {
        debugLog('documentElement 不可用，50ms 后重试', true);
        setTimeout(bindEvents, 50);
        return;
      }
      document.addEventListener('click', function (e) {
        try {
          var btn = e.target.closest && e.target.closest('.nav-btn[data-section]');
          if (btn) { e.preventDefault(); e.stopPropagation(); showSection(btn.dataset.section); return; }
          var tdToggle = e.target.closest && e.target.closest('#toundanEstimateToggle');
          if (tdToggle) {
            e.preventDefault(); e.stopPropagation();
            var tdList = document.getElementById('toundanList');
            var tdChev = document.getElementById('toundanEstimateChevron');
            if (tdList) {
              var open = tdList.style.display === 'none';
              tdList.style.display = open ? '' : 'none';
              if (tdChev) tdChev.style.transform = open ? 'rotate(90deg)' : '';
            }
            return;
          }
          if (e.target.id === 'btnParseSmartPaste') { e.preventDefault(); e.stopPropagation(); parseSmartPaste(); return; }
          var reviewMain = e.target.closest && e.target.closest('.review-main-tab[data-review-main]');
          if (reviewMain) {
            e.preventDefault(); e.stopPropagation();
            window.__reviewSubTab(reviewMain.getAttribute('data-review-main'), false);
            return;
          }
          var rpBtn = e.target.closest && e.target.closest('.review-period-btn[data-rp]');
          if (rpBtn) {
            e.preventDefault(); e.stopPropagation();
            var rp = rpBtn.dataset.rp;
            document.querySelectorAll('.review-period-btn').forEach(function(b) {
              if (b.dataset.rp === rp) {
                b.style.background = 'var(--deep-purple)'; b.style.color = '#fff';
                b.classList.add('review-period-active');
              } else {
                b.style.background = '#fff'; b.style.color = 'var(--deep-purple)';
                b.classList.remove('review-period-active');
              }
            });
            loadStrategyReview(rp);
            return;
          }
          var btp = e.target.closest && e.target.closest('.backtest-period-btn[data-bt-period]');
          if (btp) {
            e.preventDefault(); e.stopPropagation();
            __backtestState.period = btp.getAttribute('data-bt-period');
            __backtestState.navRange = 'all';
            __backtestState.navScale = 'linear';
            document.querySelectorAll('.backtest-period-btn').forEach(function(b) {
              var on = b.getAttribute('data-bt-period') === __backtestState.period;
              b.style.background = on ? 'var(--deep-purple)' : '#fff';
              b.style.color = on ? '#fff' : 'var(--deep-purple)';
            });
            document.querySelectorAll('.backtest-nav-range-btn').forEach(function(b) {
              var on = b.getAttribute('data-bt-range') === 'all';
              b.style.background = on ? 'var(--deep-purple)' : '#fff';
              b.style.color = on ? '#fff' : 'var(--deep-purple)';
            });
            document.querySelectorAll('.backtest-nav-scale-btn').forEach(function(b) {
              var on = b.getAttribute('data-bt-scale') === 'linear';
              b.style.background = on ? 'var(--deep-purple)' : '#fff';
              b.style.color = on ? '#fff' : 'var(--deep-purple)';
            });
            if (window.__renderBacktestPanel) window.__renderBacktestPanel();
            return;
          }
          var btr = e.target.closest && e.target.closest('.backtest-nav-range-btn[data-bt-range]');
          if (btr) {
            e.preventDefault(); e.stopPropagation();
            __backtestState.navRange = btr.getAttribute('data-bt-range');
            document.querySelectorAll('.backtest-nav-range-btn').forEach(function(b) {
              var on = b.getAttribute('data-bt-range') === __backtestState.navRange;
              b.style.background = on ? 'var(--deep-purple)' : '#fff';
              b.style.color = on ? '#fff' : 'var(--deep-purple)';
            });
            var bundle = __backtestState.cache[__backtestState.period];
            if (bundle && bundle.nav) buildBacktestCharts(bundle.nav, bundle.summary);
            return;
          }
          var btv = e.target.closest && e.target.closest('.backtest-nav-view-btn[data-bt-view]');
          if (btv) {
            e.preventDefault(); e.stopPropagation();
            __backtestState.navView = btv.getAttribute('data-bt-view') || 'nav';
            if (__backtestState.navView === 'return') __backtestState.navScale = 'linear';
            document.querySelectorAll('.backtest-nav-scale-btn').forEach(function(b) {
              var on = b.getAttribute('data-bt-scale') === __backtestState.navScale;
              b.style.background = on ? 'var(--deep-purple)' : '#fff';
              b.style.color = on ? '#fff' : 'var(--deep-purple)';
            });
            var bundleV = __backtestState.cache[__backtestState.period];
            if (bundleV && bundleV.nav) buildBacktestCharts(bundleV.nav, bundleV.summary);
            return;
          }
          var bts = e.target.closest && e.target.closest('.backtest-nav-scale-btn[data-bt-scale]');
          if (bts) {
            e.preventDefault(); e.stopPropagation();
            if ((__backtestState.navView || 'nav') === 'return') return;
            __backtestState.navScale = bts.getAttribute('data-bt-scale');
            document.querySelectorAll('.backtest-nav-scale-btn').forEach(function(b) {
              var on = b.getAttribute('data-bt-scale') === __backtestState.navScale;
              b.style.background = on ? 'var(--deep-purple)' : '#fff';
              b.style.color = on ? '#fff' : 'var(--deep-purple)';
            });
            var bundle2 = __backtestState.cache[__backtestState.period];
            if (bundle2 && bundle2.nav) buildBacktestCharts(bundle2.nav, bundle2.summary);
            return;
          }
          if (e.target.id === 'btnBacktestCsv') {
            e.preventDefault(); e.stopPropagation();
            downloadBacktestCsv();
            return;
          }
          if (e.target.id === 'backtestTradesPrev') {
            e.preventDefault(); e.stopPropagation();
            if (__backtestState.page > 1) { __backtestState.page--; renderBacktestTradesPage(); }
            return;
          }
          if (e.target.id === 'backtestTradesNext') {
            e.preventDefault(); e.stopPropagation();
            var tr = __backtestState.lastTrades || [];
            if (__backtestState.page * __backtestState.pageSize < tr.length) {
              __backtestState.page++;
              renderBacktestTradesPage();
            }
            return;
          }
          var adjK = e.target.closest && e.target.closest('.btn-adjust-k');
          if (adjK) {
            e.preventDefault(); e.stopPropagation();
            var curK = _get_settings_cache ? _get_settings_cache.K_MAX_CAP : 0.2;
            apiPost('/api/update-settings', {K_MAX_CAP: curK / 2}).then(function() { loadStrategyReview('all'); loadSignals(); });
            return;
          }
          var adjM = e.target.closest && e.target.closest('.btn-adjust-m');
          if (adjM) {
            e.preventDefault(); e.stopPropagation();
            var curM = _get_settings_cache ? _get_settings_cache.MONTHLY_BASE_OVERRIDE : 2000;
            apiPost('/api/update-settings', {MONTHLY_BASE_OVERRIDE: Math.round(curM * 1.2)}).then(function() { loadStrategyReview('all'); loadSignals(); });
            return;
          }
          var adjDiv = e.target.closest && e.target.closest('.btn-adjust-div');
          if (adjDiv) {
            e.preventDefault(); e.stopPropagation();
            var cs = _get_settings_cache || {};
            var curRate = cs.dividend_withholding_rate != null ? cs.dividend_withholding_rate : 0.30;
            var curOff = cs.dividend_reinvest_offset_bd != null ? cs.dividend_reinvest_offset_bd : 5;
            var rStr = prompt('预扣税率（0~0.5）：\n  0.30 = 非居民默认\n  0.10 = 中美税收协定（需 W-8BEN）\n  0    = 美国税务居民', String(curRate));
            if (rStr === null) return;
            var rNum = Number(rStr);
            if (isNaN(rNum)) { alert('税率需为数字'); return; }
            var oStr = prompt('付息日偏移（0~10，工作日）：\n  5 = Invesco / SPDR 等常见 ETF\n  0 = 用除息日收盘价（旧口径近似）', String(curOff));
            if (oStr === null) return;
            var oNum = Number(oStr);
            if (isNaN(oNum)) { alert('偏移需为数字'); return; }
            apiPost('/api/update-settings', {
              dividend_withholding_rate: rNum,
              dividend_reinvest_offset_bd: oNum,
            }).then(function() { loadStrategyReview('all'); loadSignals(); });
            return;
          }
          if (e.target.id === 'btnSubmitSmartPaste') { e.preventDefault(); e.stopPropagation(); submitSmartPaste(); return; }
          if (e.target.id === 'btnSaveGhPat') {
            e.preventDefault(); e.stopPropagation();
            var _inp = document.getElementById('inputGhPat');
            var _pat = (_inp && _inp.value.trim()) || '';
            var _errEl = document.getElementById('ghPatError');
            if (!_pat) {
              if (_errEl) { _errEl.textContent = '请先粘贴 Token。'; _errEl.classList.remove('hidden'); }
              return;
            }
            localStorage.setItem('__ghPatTianfu', _pat);
            if (window.__closeModal) window.__closeModal('modalGhPat');
            if (window.__doTriggerWorkflow) window.__doTriggerWorkflow(_pat);
            return;
          }
          if (e.target.id === 'chkShowPat') {
            var _patInp = document.getElementById('inputGhPat');
            if (_patInp) _patInp.type = e.target.checked ? 'text' : 'password';
            return;
          }
          var sumPBtn = e.target.closest && e.target.closest('.sum-period-btn[data-period]');
          if (sumPBtn) {
            e.preventDefault(); e.stopPropagation();
            var sp = sumPBtn.dataset.period;
            document.querySelectorAll('.sum-period-btn').forEach(function(b) {
              if (b.dataset.period === sp) { b.style.background = 'var(--deep-purple)'; b.style.color = '#fff'; }
              else { b.style.background = '#fff'; b.style.color = 'var(--deep-purple)'; }
            });
            loadTradeSummary(sp);
            return;
          }
          var cmpBtn = e.target.closest && e.target.closest('.chart-cmp-btn[data-mode]');
          if (cmpBtn) {
            e.preventDefault(); e.stopPropagation();
            chartCompareMode = cmpBtn.dataset.mode;
            document.querySelectorAll('.chart-cmp-btn').forEach(function(b) {
              if (b.dataset.mode === chartCompareMode) { b.style.background = 'var(--deep-purple)'; b.style.color = '#fff'; }
              else { b.style.background = '#fff'; b.style.color = 'var(--deep-purple)'; }
            });
            buildReturnsChart(currentPeriod);
            return;
          }
          var card = e.target.closest && e.target.closest('.returns-card[data-period]');
          if (card) { e.preventDefault(); e.stopPropagation(); setPeriod(card.dataset.period); return; }
          var periodBtn = e.target.closest && e.target.closest('.period-btn[data-period]');
          if (periodBtn) { e.preventDefault(); e.stopPropagation(); setPeriod(periodBtn.dataset.period); return; }
          var toggleBtn = e.target.closest && e.target.closest('.btn-toggle-sensitive');
          if (toggleBtn) { e.preventDefault(); e.stopPropagation(); toggleSensitive(); return; }
          var historyTab = e.target.closest && e.target.closest('.history-tab[data-tab]');
          if (historyTab) { e.preventDefault(); e.stopPropagation(); showHistoryTab(historyTab.dataset.tab); return; }
          var typeFilterBtn = e.target.closest && e.target.closest('.trade-type-filter-btn[data-type]');
          if (typeFilterBtn) {
            e.preventDefault(); e.stopPropagation();
            if (typeFilterBtn.dataset.type === '__all__') {
              var allActive = typeFilterBtn.getAttribute('aria-pressed') === 'true';
              document.querySelectorAll('.trade-type-filter-btn[data-type]:not([data-type="__all__"])').forEach(function (b) {
                _setTradeTypeFilterBtnStyle(b, !allActive);
              });
              _setTradeTypeFilterBtnStyle(typeFilterBtn, !allActive);
            } else {
              var active = typeFilterBtn.getAttribute('aria-pressed') === 'true';
              _setTradeTypeFilterBtnStyle(typeFilterBtn, !active);
              syncTradeTypeAllBtn();
            }
            renderTradesTable();
            return;
          }
          if (e.target.id === 'btnAddFund') {
            e.preventDefault(); e.stopPropagation();
            fundEditIndex = null;
            var tit = document.getElementById('modalFundTitle'); if (tit) tit.textContent = '批量添加入出金';
            var form = document.getElementById('formFund'); if (form) form.reset();
            openModal('modalFund'); return;
          }
          if (e.target.id === 'cancelFund') { e.preventDefault(); e.stopPropagation(); closeModal('modalFund'); return; }
          if (e.target.id === 'btnAddTrade') {
            e.preventDefault(); e.stopPropagation();
            tradeEditIndex = null;
            var tit = document.getElementById('modalTradeTitle'); if (tit) tit.textContent = '添加交易';
            var form = document.getElementById('formTrade'); if (form) form.reset();
            openModal('modalTrade'); return;
          }
          var btnSyncCorp = e.target.closest && e.target.closest('#btnSyncCorpActions');
          if (btnSyncCorp) {
            e.preventDefault(); e.stopPropagation();
            if (window.__isCloudMode) return;
            (async function() {
              var btn = document.getElementById('btnSyncCorpActions');
              var originalHTML = btn ? btn.innerHTML : '';
              if (btn) {
                btn.disabled = true;
                btn.innerHTML = '<i class="fas fa-rotate fa-spin mr-1"></i>同步中...';
              }
              try {
                var result = await apiPost('/api/corp-actions/sync', {});
                var toast = document.getElementById('toastCorpSync');
                if (result.ok && result.data) {
                  var n = (result.data.inserted && result.data.inserted.length) || 0;
                  if (toast) {
                    toast.textContent = '同步完成：新增 ' + n + ' 条记录（分红/合股拆股）。';
                    toast.classList.remove('hidden');
                    setTimeout(function() { if (toast) toast.classList.add('hidden'); }, 6000);
                  }
                  await loadTrades();
                  await loadReturnsOverview();
                  await loadAllocation();
                  await loadSignals();
                  loadTradeSummary('all');
                } else {
                  alert('同步失败，请检查后端是否运行');
                }
              } catch (err1) {
                alert('同步失败');
              }
              if (btn) {
                btn.disabled = false;
                btn.innerHTML = originalHTML;
              }
            })();
            return;
          }
          if (e.target.id === 'cancelTrade') { e.preventDefault(); e.stopPropagation(); closeModal('modalTrade'); return; }
          var btnFundEdit = e.target.closest && e.target.closest('.btn-fund-edit');
          if (btnFundEdit) {
            e.preventDefault(); e.stopPropagation();
            debugLog('点击：编辑出入金');
            var idx = parseInt(btnFundEdit.getAttribute('data-index'), 10);
            if (isNaN(idx) || idx < 0 || idx >= fundRecords.length) { debugLog('编辑出入金：索引无效 idx=' + idx, true); return; }
            var r = fundRecords[idx];
            var form = document.getElementById('formFund');
            if (form) {
              var dateEl = form.elements && form.elements['date'];
              var amountEl = form.elements && form.elements['amount'];
              var noteEl = form.elements && form.elements['note'];
              if (dateEl) dateEl.value = r.date || '';
              if (amountEl) amountEl.value = r.amount != null ? r.amount : '';
              if (noteEl) noteEl.value = r.note || '';
            }
            fundEditIndex = idx;
            var tit = document.getElementById('modalFundTitle'); if (tit) tit.textContent = '编辑出入金';
            openModal('modalFund'); return;
          }
          var btnFundDelete = e.target.closest && e.target.closest('.btn-fund-delete');
          if (btnFundDelete) {
            e.preventDefault(); e.stopPropagation();
            debugLog('点击：删除出入金');
            var idx = parseInt(btnFundDelete.getAttribute('data-index'), 10);
            if (isNaN(idx) || idx < 0 || idx >= fundRecords.length) { debugLog('删除出入金：索引无效', true); return; }
            if (!confirm('确定删除这条出入金记录？')) return;
            apiPost('/api/fund-records/delete', { index: idx }).then(function(result) {
              if (result.ok) { debugLog('删除出入金成功'); loadFundRecords(); loadReturnsOverview(); loadAllocation(); loadSignals(); }
              else { debugLog('删除出入金失败 status=' + result.status, true); alert(result.status === 404 ? '删除失败（索引无效或请刷新后重试）' : '删除失败'); }
            }).catch(function(err) { debugLog('删除出入金异常: ' + (err && err.message), true); alert('删除失败'); });
            return;
          }
          var btnTradeEdit = e.target.closest && e.target.closest('.btn-trade-edit');
          if (btnTradeEdit) {
            e.preventDefault(); e.stopPropagation();
            debugLog('点击：编辑交易');
            var idx = parseInt(btnTradeEdit.getAttribute('data-index'), 10);
            if (isNaN(idx) || idx < 0 || idx >= trades.length) { debugLog('编辑交易：索引无效', true); return; }
            var r = trades[idx];
            var form = document.getElementById('formTrade');
            if (form) {
              var dateEl = form.elements && form.elements['date'];
              if (dateEl) dateEl.value = r.date || '';
              form.symbol.value = r.symbol || '';
              var actionEl = form.elements && form.elements['tradeAction'];
              if (actionEl) actionEl.value = r.action || '买入';
              form.price.value = r.price != null ? r.price : '';
              form.shares.value = r.shares != null ? r.shares : '';
              form.commission.value = r.commission != null ? r.commission : 0;
              form.type.value = r.type || '定投';
            }
            tradeEditIndex = idx;
            var tit = document.getElementById('modalTradeTitle'); if (tit) tit.textContent = '编辑交易';
            openModal('modalTrade'); return;
          }
          var btnCopyOrder = e.target.closest && e.target.closest('.btn-copy-order');
          if (btnCopyOrder) {
            e.preventDefault(); e.stopPropagation();
            var orderText = btnCopyOrder.getAttribute('data-order');
            if (orderText && navigator.clipboard) {
              navigator.clipboard.writeText(orderText).then(function() {
                var orig = btnCopyOrder.innerHTML;
                btnCopyOrder.innerHTML = '<i class="fas fa-check mr-1"></i>已复制';
                btnCopyOrder.style.color = '#0d9488';
                btnCopyOrder.style.borderColor = '#0d9488';
                setTimeout(function() { btnCopyOrder.innerHTML = orig; btnCopyOrder.style.color = ''; btnCopyOrder.style.borderColor = ''; }, 1500);
              });
            }
            return;
          }
          var btnTradeDelete = e.target.closest && e.target.closest('.btn-trade-delete');
          if (btnTradeDelete) {
            e.preventDefault(); e.stopPropagation();
            debugLog('点击：删除交易');
            var idx = parseInt(btnTradeDelete.getAttribute('data-index'), 10);
            if (isNaN(idx) || idx < 0 || idx >= trades.length) { debugLog('删除交易：索引无效', true); return; }
            if (!confirm('确定删除这条交易记录？')) return;
            apiPost('/api/trades/delete', { index: idx }).then(function(result) {
              if (result.ok) { debugLog('删除交易成功'); loadTrades(); loadReturnsOverview(); loadAllocation(); loadSignals(); }
              else { debugLog('删除交易失败 status=' + result.status, true); alert(result.status === 404 ? '删除失败（索引无效或请刷新后重试）' : '删除失败'); }
            }).catch(function(err) { debugLog('删除交易异常: ' + (err && err.message), true); alert('删除失败'); });
            return;
          }
          if (e.target.id === 'modalFund') { e.preventDefault(); closeModal('modalFund'); return; }
          if (e.target.id === 'modalTrade') { e.preventDefault(); closeModal('modalTrade'); return; }
        } catch (err) {}
      }, true);

      document.addEventListener('change', function (e) {
        try {
          if (e.target && e.target.id === 'tradeFilterSymbol') {
            renderTradesTable();
          }
        } catch (err) {}
      }, true);

      document.addEventListener('submit', async function (e) {
        if (e.target.id === 'formFund') {
          e.preventDefault();
          try {
            var form = e.target;
            var fd = new FormData(form);
            var body = { date: fd.get('date'), amount: Number(fd.get('amount')), note: fd.get('note') || '' };
            var result = fundEditIndex !== null
              ? await apiPost('/api/fund-records/update', Object.assign({ index: fundEditIndex }, body))
              : await apiPost('/api/fund-records', body);
            if (result.ok) {
              closeModal('modalFund');
              form.reset();
              fundEditIndex = null;
              var tit = document.getElementById('modalFundTitle'); if (tit) tit.textContent = '批量添加入出金';
              await loadFundRecords();
              await loadReturnsOverview();
              await loadAllocation();
              await loadSignals();
            } else { alert(result.status === 404 ? '提交失败（索引无效或请刷新后重试）' : '提交失败，请检查后端是否运行'); }
          } catch (err) { debugLog('formFund: ' + (err && err.message), true); alert('提交失败'); }
          return;
        }
        if (e.target.id === 'formTrade') {
          e.preventDefault();
          try {
            var form = e.target;
            var fd = new FormData(form);
            var sym = fd.get('symbol').trim().toUpperCase();
            var tradeType = fd.get('type') || '定投';
            if ((tradeType === '分红' || tradeType === '合股拆股') && tradeEditIndex === null) {
              alert('分红与合股拆股只能由「同步分红/拆股」自动生成；要对账请编辑已有的记录。');
              return;
            }
            if (sym === 'BOXX') tradeType = '现金管理';
            var body = { date: fd.get('date'), symbol: sym, action: fd.get('tradeAction') || '买入', price: Number(fd.get('price')), shares: Number(fd.get('shares')), commission: Number(fd.get('commission')) || 0, type: tradeType };
            var result = tradeEditIndex !== null
              ? await apiPost('/api/trades/update', Object.assign({ index: tradeEditIndex }, body))
              : await apiPost('/api/trades', body);
            if (result.ok) {
              closeModal('modalTrade');
              form.reset();
              tradeEditIndex = null;
              var tit = document.getElementById('modalTradeTitle'); if (tit) tit.textContent = '添加交易';
              await loadTrades();
              await loadReturnsOverview();
              await loadAllocation();
              await loadSignals();
            } else { alert(result.status === 404 ? '提交失败（索引无效或请刷新后重试）' : '提交失败，请检查后端是否运行'); }
          } catch (err) { debugLog('formTrade: ' + (err && err.message), true); alert('提交失败'); }
        }
      }, true);
    }

    async function checkBackendVersion() {
      if (window.__isCloudMode) return;
      var banner = document.getElementById('bannerRestartBackend');
      if (!banner) return;
      var data = await apiGet('/api/version');
      if (!data || !data.edit_delete) {
        banner.classList.remove('hidden');
        banner.classList.add('block');
      } else {
        banner.classList.add('hidden');
        banner.classList.remove('block');
      }
    }
    async function doInit() {
      window.__navClick = showSection;
      window.__setPeriod = setPeriod;
      window.__toggleSensitive = toggleSensitive;
      window.__refreshAllViews = refreshAllViews;
      window.__historyTab = showHistoryTab;
      window.__openModal = openModal;
      window.__closeModal = closeModal;
      if (window.__isCloudMode) {
        window.__sensitiveHidden = true;
        document.querySelectorAll('.btn-toggle-sensitive').forEach(function(b) { b.style.display = 'none'; });
        ['btnAddFund','btnAddTrade','btnSmartPaste','btnSyncCorpActions'].forEach(function(id) {
          var el = document.getElementById(id); if (el) el.style.display = 'none';
        });
        document.querySelectorAll('.cloud-hide-col').forEach(function(el) { el.style.display = 'none'; });
        var fundTabBtn = document.querySelector('.history-tab[data-tab="fund"]');
        if (fundTabBtn) fundTabBtn.style.display = 'none';
        var route = window.__parseHash ? window.__parseHash(window.location.hash) : null;
        if (!route || route.section === 'history') {
          var histTab = (route && route.sub === 'fund') ? 'trades' : ((route && route.sub) || 'trades');
          showHistoryTab(histTab, true);
        }
        var bannerEl = document.getElementById('bannerRestartBackend');
        if (bannerEl) bannerEl.style.display = 'none';
      }
      if (window.__applyRoute) window.__applyRoute();
      if (window.__isCloudMode) await ensureCloudVersion();
      updateGlobalStatusBar({});
      checkBackendVersion();
      loadReturnsOverview();
      loadAllocation();
      loadFundRecords();
      initTradeTypeFilters();
      loadTrades();
      loadTradeSummary('all');
      // 懒加载：仅在直接进入对应标签时才触发，否则推迟到用户首次切换时
      var secSignals = document.getElementById('section-signals');
      var secReview = document.getElementById('section-review');
      if (secSignals && !secSignals.classList.contains('hidden')) {
        __lazyLoaded.signals = true;
        loadSignals();
      }
      if (secReview && !secReview.classList.contains('hidden')) {
        __lazyLoaded.review = true;
        var activeRevBtn = document.querySelector('.review-period-btn.review-period-active');
        loadStrategyReview(activeRevBtn ? activeRevBtn.dataset.rp : 'all');
      }
    }

    bindEvents();
    doInit();

    // ========== URL 参数自动录入交易 ==========
    (async function autoTradeFromURL() {
      if (window.__isCloudMode) return;
      var params = new URLSearchParams(window.location.search);
      var date = params.get('date'), symbol = params.get('symbol'),
          price = params.get('price'), shares = params.get('shares');
      if (!date || !symbol || !price || !shares) return;
      symbol = symbol.trim().toUpperCase();
      var action = params.get('tradeAction') || '买入';
      var commission = Number(params.get('commission')) || 0;
      var type = params.get('type') || '定投';
      if (symbol === 'BOXX') type = '现金管理';
      var body = {
        date: date.trim(), symbol: symbol, action: action,
        price: Number(price), shares: Number(shares),
        commission: commission, type: type
      };
      history.replaceState(null, '', window.location.pathname);
      var result = await apiPost('/api/trades', body);
      if (result.ok) {
        showSection('history');
        showHistoryTab('trades');
        await loadTrades();
        await loadReturnsOverview();
        await loadAllocation();
        await loadSignals();
        loadTradeSummary('all');
      } else {
        alert('URL 自动录入失败，请检查后端是否运行');
      }
    })();
