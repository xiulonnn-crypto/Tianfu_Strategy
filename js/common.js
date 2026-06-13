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
      var events = [];
      entries.slice().reverse().forEach(function(e) {
        var tr = e.triggers || {};
        ['M1', 'M2', 'M3'].forEach(function(lv) {
          var t = tr[lv];
          if (t && (t.triggered || t.can_fire)) {
            events.push({ date: e.date, type: 'trigger', level: lv, backfilled: e.backfilled });
          }
        });
        if (e.S != null && !e.backfilled) events.push({ date: e.date, type: 'monthly', S: e.S });
        else if (e.backfilled && e.vix_3y_pctile != null) events.push({ date: e.date, type: 'backfill' });
      });
      if (listEl) {
        listEl.innerHTML = events.length ? events.slice(0, 12).map(function(ev) {
          var color = ev.type === 'trigger' ? '#D64545' : (ev.type === 'monthly' ? '#0d9488' : 'var(--benchmark-gray)');
          var icon = ev.type === 'trigger' ? 'crosshairs' : (ev.type === 'monthly' ? 'calendar-check' : 'clock-rotate-left');
          var title = ev.type === 'trigger' ? (ev.level + ' 投弹') : (ev.type === 'monthly' ? ('月投 S=' + Number(ev.S).toFixed(2)) : '分位数回填');
          return '<div class="signal-timeline-item"><div class="signal-tl-dot" style="background:' + color + ';"><i class="fas fa-' + icon + '"></i></div>'
            + '<div style="flex:1;"><div class="flex justify-between gap-2"><span class="font-medium text-sm" style="color:var(--deep-purple);">' + title + '</span><span class="text-xs" style="color:var(--benchmark-gray);">' + ev.date + '</span></div></div></div>';
        }).join('') : '<p class="text-sm" style="color:var(--benchmark-gray);">暂无触发事件记录。</p>';
      }
      var labels = entries.map(function(e) { return (e.date || '').slice(5); });
      var sData = entries.map(function(e) { return e.S != null ? Number(e.S) * 100 : null; });
      var ctx = document.getElementById('chartSignalHistory');
      if (!ctx) return;
      if (chartSignalHistory) chartSignalHistory.destroy();
      if (ph) ph.style.display = 'none';
      chartSignalHistory = new Chart(ctx, {
        type: 'line',
        data: { labels: labels, datasets: [{ label: 'S × 100', data: sData, borderColor: '#4A3D7C', backgroundColor: 'rgba(74,61,124,0.08)', fill: true, tension: 0.3, pointRadius: 2, spanGaps: true }] },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { labels: { font: { size: 11 }, color: '#8A9199' } } },
          scales: {
            x: { ticks: { color: '#8A9199', maxTicksLimit: 8, font: { size: 10 } }, grid: { display: false } },
            y: { ticks: { color: '#8A9199', font: { size: 10 } }, grid: { color: 'rgba(74,61,124,0.06)' } }
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
