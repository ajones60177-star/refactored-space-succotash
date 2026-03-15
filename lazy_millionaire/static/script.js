/**
 * Lazy Millionaire Market Dominator – Tri-Mode Trading System
 * Frontend controller: mode switching, live analytics, auto-trading loop,
 * Deriv connection management, and real-time dashboard updates.
 */

'use strict';

// ── State ─────────────────────────────────────────────────────────────────
const state = {
    mode: 'balanced',
    isTrading: false,
    autoTradeHandle: null,
    recommendation: { mode: 'balanced', reason: '' },
    lastStatus: null,
};

// ── Interval configuration (ms) per mode ─────────────────────────────────
const TRADE_INTERVALS = {
    balanced:   8000,
    aggressive: 5000,
    maximum:    3000,
};

// ── API helpers ───────────────────────────────────────────────────────────
async function apiGet(path) {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

async function apiPost(path, body = {}) {
    const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

// ── Toast notifications ───────────────────────────────────────────────────
function showToast(message, type = 'info', duration = 3500) {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transition = 'opacity 0.4s';
        setTimeout(() => toast.remove(), 400);
    }, duration);
}

// ── Format helpers ─────────────────────────────────────────────────────────
function fmt$(v) {
    if (v === null || v === undefined) return '—';
    const n = parseFloat(v);
    if (isNaN(n)) return '—';
    return '$' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtPct(v) {
    if (v === null || v === undefined) return '—';
    return parseFloat(v).toFixed(1) + '%';
}

function fmtTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso + 'Z');
    return d.toLocaleTimeString();
}

function modeClass(m) {
    if (m === 'balanced')   return 'mode-b';
    if (m === 'aggressive') return 'mode-a';
    return 'mode-m';
}

// ── Mode switching ─────────────────────────────────────────────────────────
async function switchMode(mode) {
    try {
        const res = await apiPost('/api/mode', { mode });
        if (res.success) {
            state.mode = mode;
            updateModeUI(mode);
            showToast(`Switched to ${mode.toUpperCase()} mode`, 'info');
            // Restart auto-trade loop at new interval if running
            if (state.isTrading) {
                stopAutoTrade();
                startAutoTrade();
            }
        }
    } catch (e) {
        showToast(`Mode switch failed: ${e.message}`, 'error');
    }
}

function updateModeUI(mode) {
    ['balanced', 'aggressive', 'maximum'].forEach(m => {
        const btn  = document.getElementById(`btn${cap(m)}`);
        const card = document.getElementById(`card${cap(m)}`);
        const badge= document.getElementById(`badge${cap(m)}`);
        if (btn)  btn.classList.toggle('active', m === mode);
        if (card) card.style.opacity = m === mode ? '1' : '0.65';
        if (badge) badge.classList.toggle('hidden', m !== mode);
    });
    const label = document.getElementById('activeModeLabel');
    if (label) label.textContent = mode.toUpperCase();

    const stratMap = {
        balanced:   'Momentum detection – trade direction of momentum',
        aggressive: 'Trend + Reversal combo – high confidence signals',
        maximum:    'Multi-factor confirmation – trend × momentum × volatility',
    };
    const sd = document.getElementById('stratDesc');
    if (sd) sd.textContent = stratMap[mode] || '';
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// ── Apply AI recommendation ────────────────────────────────────────────────
function applyRecommendation() {
    if (state.recommendation && state.recommendation.mode) {
        switchMode(state.recommendation.mode);
    }
}

// ── Auto-switch toggle ─────────────────────────────────────────────────────
async function toggleAutoSwitch() {
    const enabled = document.getElementById('autoSwitchToggle').checked;
    try {
        await apiPost('/api/auto_switch', { enabled });
        showToast(`Auto-switch ${enabled ? 'enabled' : 'disabled'}`, 'info');
    } catch (e) {
        showToast(`Auto-switch error: ${e.message}`, 'error');
    }
}

// ── Deriv connection ──────────────────────────────────────────────────────
async function connectDeriv() {
    const token = document.getElementById('derivToken').value.trim();
    if (!token) { showToast('Please enter your Deriv API token', 'warning'); return; }
    showToast('Connecting to Deriv…', 'info');
    try {
        const res = await apiPost('/api/connect', { token });
        if (res.success) {
            showToast(`Connected! Balance: ${fmt$(res.balance)} ${res.currency || ''}`, 'success');
            document.getElementById('btnConnect').classList.add('hidden');
            document.getElementById('btnDisconnect').classList.remove('hidden');
            setOnline(true);
        } else {
            showToast(`Connection failed: ${res.error}`, 'error');
        }
    } catch (e) {
        showToast(`Connection error: ${e.message}`, 'error');
    }
}

async function disconnectDeriv() {
    try {
        await apiPost('/api/disconnect');
        document.getElementById('btnConnect').classList.remove('hidden');
        document.getElementById('btnDisconnect').classList.add('hidden');
        setOnline(false);
        showToast('Disconnected from Deriv', 'info');
    } catch (e) {
        showToast(`Disconnect error: ${e.message}`, 'error');
    }
}

function setOnline(online) {
    const dot  = document.querySelector('.dot');
    const text = document.getElementById('statusText');
    if (dot)  { dot.classList.toggle('online', online); dot.classList.toggle('offline', !online); }
    if (text) text.textContent = online ? 'LIVE' : 'DEMO';
}

// ── Execute a single trade ────────────────────────────────────────────────
async function executeTrade(direction = null) {
    try {
        const body = direction ? { direction } : {};
        const res = await apiPost('/api/trade/execute', body);
        if (res.success) {
            const t = res.trade;
            const sign = t.won ? '✅ WIN' : '❌ LOSS';
            showToast(`${sign} ${t.direction} | P&L: ${fmt$(t.pnl)} | Balance: ${fmt$(t.balance_after)}`,
                t.won ? 'success' : 'error', 4000);
            prependTradeRow(t);
            // Update balance
            document.getElementById('balanceDisplay').textContent = fmt$(t.balance_after);
        } else {
            showToast(`Trade skipped: ${res.error}`, 'warning');
        }
    } catch (e) {
        showToast(`Trade error: ${e.message}`, 'error');
    }
}

// ── Auto-trading loop ─────────────────────────────────────────────────────
function startAutoTrade() {
    state.isTrading = true;
    const interval = TRADE_INTERVALS[state.mode] || 5000;
    state.autoTradeHandle = setInterval(() => {
        if (state.isTrading) executeTrade();
    }, interval);
    const btn = document.getElementById('btnAutoTrade');
    if (btn) { btn.textContent = '⏸ STOP AUTO'; btn.classList.add('running'); }
    showToast(`Auto-trading started – ${state.mode.toUpperCase()} mode (every ${interval / 1000}s)`, 'success');
}

function stopAutoTrade() {
    state.isTrading = false;
    if (state.autoTradeHandle) {
        clearInterval(state.autoTradeHandle);
        state.autoTradeHandle = null;
    }
    const btn = document.getElementById('btnAutoTrade');
    if (btn) { btn.textContent = '▶ AUTO TRADE'; btn.classList.remove('running'); }
}

function toggleAutoTrade() {
    if (state.isTrading) {
        stopAutoTrade();
        showToast('Auto-trading stopped', 'warning');
    } else {
        startAutoTrade();
    }
}

// ── Refresh trade log ─────────────────────────────────────────────────────
async function refreshTrades() {
    try {
        const res = await apiGet('/api/trades?limit=50');
        const tbody = document.getElementById('tradeLogBody');
        if (!res.trades || res.trades.length === 0) {
            tbody.innerHTML = '<tr><td colspan="10" class="empty-row">No trades yet.</td></tr>';
            return;
        }
        tbody.innerHTML = res.trades.map(t => tradeRowHTML(t)).join('');
    } catch (e) {
        showToast(`Trade log error: ${e.message}`, 'error');
    }
}

function prependTradeRow(t) {
    const tbody = document.getElementById('tradeLogBody');
    const emptyRow = tbody.querySelector('.empty-row');
    if (emptyRow) emptyRow.parentElement.remove();
    tbody.insertAdjacentHTML('afterbegin', tradeRowHTML(t));
    // Keep max 100 rows
    while (tbody.children.length > 100) tbody.removeChild(tbody.lastChild);
}

function tradeRowHTML(t) {
    const resultClass = t.won ? 'result-win' : 'result-loss';
    const pnlClass    = t.pnl >= 0 ? 'pnl-pos' : 'pnl-neg';
    const mc = modeClass(t.mode);
    return `<tr>
        <td>${t.id}</td>
        <td>${fmtTime(t.timestamp)}</td>
        <td class="${mc}">${(t.mode || '').toUpperCase().slice(0,3)}</td>
        <td>${t.direction}</td>
        <td>${fmt$(t.position)}</td>
        <td>${t.confidence ? t.confidence.toFixed(0) + '%' : '—'}</td>
        <td>${(t.pattern || '').replace(/_/g, ' ')}</td>
        <td class="${resultClass}">${t.won ? 'WIN' : 'LOSS'}</td>
        <td class="${pnlClass}">${fmt$(t.pnl)}</td>
        <td>${fmt$(t.balance_after)}</td>
    </tr>`;
}

// ── Status polling ────────────────────────────────────────────────────────
async function pollStatus() {
    try {
        const [status, market, projections] = await Promise.all([
            apiGet('/api/status'),
            apiGet('/api/market'),
            apiGet('/api/projections'),
        ]);

        // Balance
        document.getElementById('balanceDisplay').textContent = fmt$(status.balance);

        // Daily stats
        const pnl = status.daily_pnl || 0;
        const pnlEl = document.getElementById('dailyPnl');
        pnlEl.textContent = (pnl >= 0 ? '+' : '') + fmt$(pnl);
        pnlEl.className = 'stat-val pnl-val ' + (pnl >= 0 ? 'positive' : 'negative');
        document.getElementById('tradesToday').textContent = status.daily_trade_count || 0;
        document.getElementById('wr10').textContent = status.win_rate_10 != null ? fmtPct(status.win_rate_10) : '—';
        document.getElementById('wr50').textContent = status.win_rate_50 != null ? fmtPct(status.win_rate_50) : '—';

        const streak = status.consecutive_wins > 0
            ? `🔥 ${status.consecutive_wins}W`
            : status.consecutive_losses > 0
                ? `💔 ${status.consecutive_losses}L`
                : '—';
        document.getElementById('streak').textContent = streak;

        // Deriv status
        setOnline(status.deriv_connected);
        if (status.deriv_connected) {
            document.getElementById('btnConnect').classList.add('hidden');
            document.getElementById('btnDisconnect').classList.remove('hidden');
        }

        // Sync mode if auto-switched
        if (status.mode && status.mode !== state.mode) {
            state.mode = status.mode;
            updateModeUI(status.mode);
        }

        // Market bar
        document.getElementById('trendLabel').textContent = market.trend_label || '—';
        const vol = parseFloat(market.volatility || 50);
        document.getElementById('volBar').style.width = vol + '%';
        document.getElementById('volLabel').textContent = `${vol.toFixed(0)} ${market.volatility_label || ''}`;
        document.getElementById('patternLabel').textContent = (market.pattern?.pattern || '—').replace(/_/g, ' ');
        document.getElementById('confidenceLabel').textContent = market.pattern?.confidence ? fmtPct(market.pattern.confidence) : '—';

        // Recommendation
        const rec = market.recommendation || status.recommendation;
        if (rec) {
            state.recommendation = rec;
            document.getElementById('recMode').textContent = (rec.mode || '').toUpperCase();
            document.getElementById('recReason').textContent = rec.reason || '';
        }

        // Mode stats cards
        const modeStats = status.mode_stats || {};
        ['balanced', 'aggressive', 'maximum'].forEach(m => {
            const ms = modeStats[m] || {};
            const wins   = ms.wins   || 0;
            const losses = ms.losses || 0;
            const trades = ms.trades || 0;
            const wr     = trades > 0 ? ((wins / trades) * 100).toFixed(1) + '%' : '—';
            const pnlV   = ms.pnl || 0;

            const key = cap(m);
            setText(`stat${key}WR`,     wr);
            setText(`stat${key}Trades`, trades);
            setText(`stat${key}WL`,     `${wins} / ${losses}`);
            const pnlEl2 = document.getElementById(`stat${key}Pnl`);
            if (pnlEl2) {
                pnlEl2.textContent = (pnlV >= 0 ? '+' : '') + fmt$(pnlV);
                pnlEl2.style.color = pnlV >= 0 ? 'var(--win-green)' : 'var(--loss-red)';
            }
        });

        // Projections
        if (projections && projections.projections) {
            const p = projections.projections;
            updateProj('Bal',  p.balanced);
            updateProj('Agg',  p.aggressive);
            updateProj('Max',  p.maximum);
        }

        state.lastStatus = status;
    } catch (e) {
        // Silently ignore polling errors
    }
}

function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
}

function updateProj(key, proj) {
    if (!proj) return;
    setText(`proj${key}_day`,   fmt$(proj.daily_end));
    setText(`proj${key}_pct`,   proj.daily_growth_pct != null ? '+' + proj.daily_growth_pct.toFixed(0) + '%' : '—');
    setText(`proj${key}_week`,  fmt$(proj.weekly_end));
    setText(`proj${key}_month`, fmt$(proj.monthly_end));
}

// ── Init ──────────────────────────────────────────────────────────────────
function init() {
    updateModeUI('balanced');
    pollStatus();
    // Poll every 5 seconds for live updates
    setInterval(pollStatus, 5000);
    // Initial trade log load
    refreshTrades();
}

document.addEventListener('DOMContentLoaded', init);
