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
