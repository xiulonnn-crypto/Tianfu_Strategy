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
