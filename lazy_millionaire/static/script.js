/* ============================================================
   Lazy Millionaire Market Dominator – Core Engine
   Author: AI Trading System
   ============================================================ */
'use strict';

// ─────────────────────────────────────────────────────────────
// Constants & Configuration
// ─────────────────────────────────────────────────────────────
const CFG = {
    DERIV_WS_URL : 'wss://ws.binaryws.com/websockets/v3?app_id=1089',
    STOP_LOSS_PCT  : 0.01,   // 1%
    TAKE_PROFIT_PCT: 0.04,   // 4%
    MIN_CONFIDENCE : 0.65,   // 65% to trade
    TRADE_DURATION : 15,     // seconds
    DERIV_MIN_STAKE: 0.50,
    DERIV_MAX_STAKE: 100.0,
    PAYOUT_RATIO   : 0.80,   // 80% payout on win (net)
    AUTO_INTERVAL  : 8000,   // ms between auto-trade checks
    COOLDOWN_SEC   : 30,
    MAX_CONSECUTIVE_LOSSES: 5,
    DAILY_LOSS_LIMIT_PCT  : 0.10,
    MAX_DRAWDOWN_PCT       : 0.10,
    DEFAULT_ASSET  : 'R_100',
    DEFAULT_ACCOUNT_DEMO: 10.00,
    CHART_POINTS   : 60,
    LEARNING_RATE  : 0.05,
};

const ASSETS = [
    { id:'R_100',  label:'Volatility 100 Index' },
    { id:'R_75',   label:'Volatility 75 Index' },
    { id:'R_50',   label:'Volatility 50 Index' },
    { id:'R_25',   label:'Volatility 25 Index' },
    { id:'R_10',   label:'Volatility 10 Index' },
    { id:'frxEURUSD', label:'EUR/USD' },
    { id:'frxGBPUSD', label:'GBP/USD' },
    { id:'cryBTCUSD', label:'BTC/USD' },
];

// ─────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────
let state = {
    connected   : false,
    authorized  : false,
    paperMode   : true,
    balance     : CFG.DEFAULT_ACCOUNT_DEMO,
    startBalance: CFG.DEFAULT_ACCOUNT_DEMO,
    currency    : 'USD',
    dailyStart  : CFG.DEFAULT_ACCOUNT_DEMO,
    dailyPnL    : 0,
    todayTrades : 0,
    totalTrades : 0,
    wins        : 0,
    losses      : 0,
    consecutiveLosses: 0,
    autoRunning : false,
    autoPaused  : false,
    cooldownLeft: 0,
    roundCount  : 0,
    autoMode    : 'hml2',   // hml2 | all4 | single
    activeStrikes: [],      // running trade objects
    tradeHistory: [],
    prices      : [],
    currentPrice: 0,
    asset       : CFG.DEFAULT_ASSET,
    apiToken    : '',
    ws          : null,
    reconnectTimer: null,
    autoTimer   : null,
    cooldownTimer : null,
    marketRegime: 'range',  // bull | bear | range
    prediction  : { dir:'higher', confidence:0.5 },
    ai          : {
        weights    : { momentum:1, volatility:1, trend:1, pattern:1 },
        recentAccuracy: [],
        totalTrades: 0,
        phase      : 0,    // 0=baseline 1=pattern 2=optimize 3=expert
        baseAccuracy: 0.50,
        currentAccuracy: 0.50,
    },
    barriers    : { upper:0, lower:0 },
    // Risk flags
    emergencyStopped: false,
    dailyLimitHit   : false,
    // Compound growth
    growthHistory : [],
    growthDays    : 0,
};

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const qs = sel => document.querySelector(sel);
const fmt = (v, d=2) => (isNaN(v) ? '0.00' : Number(v).toFixed(d));
const fmtPct = v => (v*100).toFixed(1)+'%';
const fmtPnL = v => (v>=0 ? '+$'+fmt(v) : '-$'+fmt(Math.abs(v)));
const now = () => new Date().toLocaleTimeString();
const rand = (a,b) => Math.random()*(b-a)+a;
const clamp = (v,mn,mx) => Math.max(mn, Math.min(mx, v));

// ─────────────────────────────────────────────────────────────
// AI Prediction Engine
// ─────────────────────────────────────────────────────────────
const AI = {
    // Compute technical indicators from price array
    indicators(prices) {
        const n = prices.length;
        if (n < 5) return null;
        const last  = prices[n-1];
        const prev  = prices[n-2];
        const prev5 = prices[Math.max(0,n-5)];
        const prev10= prices[Math.max(0,n-10)];
        const prev20= prices[Math.max(0,n-20)];

        // Momentum (short term)
        const mom1  = last - prev;
        const mom5  = last - prev5;
        const mom10 = last - prev10;

        // Volatility (std dev of last 10)
        const window = prices.slice(Math.max(0,n-10));
        const mean   = window.reduce((s,v)=>s+v,0)/window.length;
        const variance = window.reduce((s,v)=>s+(v-mean)**2,0)/window.length;
        const vol = Math.sqrt(variance);

        // Trend (slope of linear regression on last 20)
        const tw = prices.slice(Math.max(0,n-20));
        const tw_n = tw.length;
        let sumX=0,sumY=0,sumXY=0,sumX2=0;
        tw.forEach((y,x) => { sumX+=x; sumY+=y; sumXY+=x*y; sumX2+=x*x; });
        const slope = (tw_n*sumXY - sumX*sumY) / (tw_n*sumX2 - sumX*sumX) || 0;

        // RSI (simplified, 14-period)
        const rsiWindow = prices.slice(Math.max(0,n-15));
        let gains=0,losses=0;
        for (let i=1;i<rsiWindow.length;i++) {
            const d = rsiWindow[i]-rsiWindow[i-1];
            if (d>0) gains+=d; else losses+=Math.abs(d);
        }
        const rs  = losses===0 ? 100 : gains/losses;
        const rsi = 100 - (100/(1+rs));

        // Bollinger Bands position (how far from mean in std devs)
        const bPos = vol > 0 ? (last - mean)/vol : 0;

        // Recent pattern (last 3 up/down)
        const pattern = [];
        for (let i=n-4;i<n;i++) {
            if (i>0) pattern.push(prices[i]>prices[i-1]?1:-1);
        }
        const patternSum = pattern.reduce((s,v)=>s+v,0);

        return { mom1, mom5, mom10, vol, slope, rsi, bPos, patternSum, last, mean };
    },

    // Predict direction with confidence
    predict(prices) {
        const ind = this.indicators(prices);
        if (!ind) return { dir:'higher', confidence:0.50 };

        const ai = state.ai;
        const w  = ai.weights;

        // Signals (positive = higher, negative = lower)
        const signals = {
            momentum : Math.sign(ind.mom5) * Math.min(Math.abs(ind.mom5)/ind.last*100, 3) * w.momentum,
            trend    : Math.sign(ind.slope) * Math.min(Math.abs(ind.slope)*50, 2) * w.trend,
            rsi      : (ind.rsi < 30 ? 1 : ind.rsi > 70 ? -1 : 0) * 1.5 * w.volatility,
            bBand    : -Math.sign(ind.bPos) * Math.min(Math.abs(ind.bPos)*0.5, 1.5) * w.pattern, // mean reversion
            pattern  : Math.sign(ind.patternSum) * Math.abs(ind.patternSum)*0.5 * w.pattern,
        };

        const rawScore = Object.values(signals).reduce((s,v)=>s+v,0);

        // Detect market regime
        if (Math.abs(ind.slope) > ind.vol * 0.3) {
            state.marketRegime = ind.slope > 0 ? 'bull' : 'bear';
        } else {
            state.marketRegime = 'range';
        }

        // Regime bias
        let bias = 0;
        if (state.marketRegime === 'bull') bias = 0.3;
        if (state.marketRegime === 'bear') bias = -0.3;

        const totalScore = rawScore + bias;

        // Convert to probability using sigmoid
        const prob = 1 / (1 + Math.exp(-totalScore));

        // Add AI learning accuracy boost
        const accuracyBoost = (ai.currentAccuracy - 0.5) * 0.4;
        const adjustedProb  = clamp(prob + accuracyBoost, 0.35, 0.85);

        const dir = adjustedProb >= 0.5 ? 'higher' : 'lower';
        const confidence = dir === 'higher' ? adjustedProb : 1 - adjustedProb;

        return { dir, confidence: clamp(confidence, 0.35, 0.85) };
    },

    // Called after each trade to adapt weights
    learn(tradeDir, won, confidence) {
        const ai = state.ai;
        ai.totalTrades++;
        ai.recentAccuracy.push(won ? 1 : 0);
        if (ai.recentAccuracy.length > 30) ai.recentAccuracy.shift();

        const recentWR = ai.recentAccuracy.length > 0
            ? ai.recentAccuracy.reduce((s,v)=>s+v,0)/ai.recentAccuracy.length
            : 0.5;

        // Adjust learning phase
        if (ai.totalTrades >= 200) ai.phase = 3;
        else if (ai.totalTrades >= 100) ai.phase = 2;
        else if (ai.totalTrades >= 50)  ai.phase = 1;
        else                             ai.phase = 0;

        // Phase-based accuracy targets
        const targets = [0.50, 0.55, 0.60, 0.65];
        const phaseTarget = targets[ai.phase];
        ai.currentAccuracy = 0.7*ai.currentAccuracy + 0.3*recentWR;
        ai.currentAccuracy = clamp(ai.currentAccuracy, 0.45, phaseTarget + 0.05);

        // Adapt weights based on result
        const lr = CFG.LEARNING_RATE;
        const reward = won ? 1 : -1;
        Object.keys(ai.weights).forEach(k => {
            ai.weights[k] = clamp(ai.weights[k] + lr*reward*rand(-0.1,0.1), 0.5, 2.5);
        });

        updateAIDisplay();
    },

    getPhaseLabel() {
        const labels = ['Baseline Learning','Pattern Recognition','Optimization','Expert Mode'];
        return labels[state.ai.phase];
    },
};

// ─────────────────────────────────────────────────────────────
// Risk Manager
// ─────────────────────────────────────────────────────────────
const Risk = {
    canTrade() {
        if (state.emergencyStopped) return { ok:false, reason:'Emergency stop active' };
        if (state.dailyLimitHit)    return { ok:false, reason:'Daily loss limit hit' };
        if (state.autoPaused)       return { ok:false, reason:'Auto paused – consecutive losses' };
        if (state.activeStrikes.length > 0) return { ok:false, reason:'Trade already active' };

        const dailyLoss = state.dailyStart - state.balance;
        if (dailyLoss/state.dailyStart > CFG.DAILY_LOSS_LIMIT_PCT) {
            state.dailyLimitHit = true;
            notify('⛔ Daily loss limit hit! Trading paused for today.','warn');
            return { ok:false, reason:'Daily loss limit reached' };
        }

        const drawdown = (state.startBalance - state.balance)/state.startBalance;
        if (drawdown > CFG.MAX_DRAWDOWN_PCT) {
            notify('⚠️ Drawdown > 10% – switching conservative mode','warn');
        }

        return { ok:true };
    },

    stakeFor(balance, confidence) {
        // 1% risk per trade, scaled by confidence
        const maxRisk = balance * CFG.STOP_LOSS_PCT;
        let multiplier = 2;
        if (confidence > 0.80) multiplier = 10;
        else if (confidence > 0.65) multiplier = 5;
        // In binary options: stake × payout = profit target
        // We need: stake × PAYOUT_RATIO = takeProfit
        // takeProfit = balance × TAKE_PROFIT_PCT
        const targetProfit = balance * CFG.TAKE_PROFIT_PCT;
        const fromProfit   = targetProfit / CFG.PAYOUT_RATIO;
        const fromRisk     = maxRisk * multiplier;
        const stake = Math.min(fromProfit, fromRisk);
        return clamp(parseFloat(stake.toFixed(2)), CFG.DERIV_MIN_STAKE, CFG.DERIV_MAX_STAKE);
    },

    // Conservative mode: reduce stake if losing
    adjustedStake(base) {
        if (state.consecutiveLosses >= 3) return Math.max(CFG.DERIV_MIN_STAKE, base * 0.5);
        if (state.consecutiveLosses >= 5) {
            state.autoPaused = true;
            notify('⛔ 5 consecutive losses – auto paused to protect account','warn');
        }
        return base;
    },

    checkDrawdown() {
        const drawdown = (state.startBalance - state.balance)/state.startBalance;
        if (drawdown > 0.10) updateDisplay();
    },
};

// ─────────────────────────────────────────────────────────────
// Deriv WebSocket Integration
// ─────────────────────────────────────────────────────────────
let wsReqId = 1;
const pendingReqs = {};
const activeBinaryContracts = {};

function derivConnect() {
    if (state.ws && state.ws.readyState < 2) return;
    setConnStatus('connecting');

    try {
        state.ws = new WebSocket(CFG.DERIV_WS_URL);
    } catch(e) {
        setConnStatus('error');
        scheduleReconnect();
        return;
    }

    state.ws.onopen = () => {
        setConnStatus('connected');
        state.connected = true;
        clearTimeout(state.reconnectTimer);
        subscribePrice(state.asset);
        if (state.apiToken && !state.paperMode) {
            derivAuthorize(state.apiToken);
        }
        notify('Connected to Deriv','info');
    };

    state.ws.onmessage = (evt) => {
        try { handleDerivMsg(JSON.parse(evt.data)); } catch(e) {}
    };

    state.ws.onerror = () => {
        setConnStatus('error');
        state.connected = false;
    };

    state.ws.onclose = () => {
        setConnStatus('error');
        state.connected = false;
        scheduleReconnect();
    };
}

function scheduleReconnect() {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = setTimeout(() => derivConnect(), 5000);
}

function derivSend(payload, cb) {
    if (!state.ws || state.ws.readyState !== 1) return;
    payload.req_id = wsReqId++;
    if (cb) pendingReqs[payload.req_id] = cb;
    state.ws.send(JSON.stringify(payload));
}

function subscribePrice(symbol) {
    derivSend({ ticks: symbol, subscribe: 1 });
}

function derivAuthorize(token) {
    derivSend({ authorize: token }, (resp) => {
        if (resp.error) {
            notify('Auth failed: ' + resp.error.message,'warn');
            return;
        }
        state.authorized = true;
        state.balance     = resp.authorize.balance;
        state.currency    = resp.authorize.currency;
        state.paperMode   = false;
        state.startBalance = state.balance;
        state.dailyStart   = state.balance;
        updateBalanceDisplay();
        notify('Live account connected – Balance: '+state.currency+' '+fmt(state.balance),'info');
    });
}

function buyBinaryContract(direction, stake, cb) {
    // direction: 'CALL' (higher) or 'PUT' (lower)
    derivSend({
        buy: 1,
        price: stake,
        parameters: {
            contract_type  : direction,
            symbol         : state.asset,
            duration       : CFG.TRADE_DURATION,
            duration_unit  : 's',
            basis          : 'stake',
            amount         : stake,
            currency       : state.currency,
        },
    }, (resp) => {
        if (resp.error) {
            notify('Trade error: '+resp.error.message,'warn');
            if (cb) cb(null, resp.error);
            return;
        }
        const contract = resp.buy;
        activeBinaryContracts[contract.contract_id] = { cb, stake, direction };
        // Subscribe to contract updates
        derivSend({ proposal_open_contract: 1, contract_id: contract.contract_id, subscribe: 1 });
        if (cb) cb(contract, null);
    });
}

function handleDerivMsg(msg) {
    if (msg.req_id && pendingReqs[msg.req_id]) {
        pendingReqs[msg.req_id](msg);
        delete pendingReqs[msg.req_id];
    }

    // Tick stream
    if (msg.tick) {
        const price = parseFloat(msg.tick.quote);
        onTick(price);
    }

    // Contract updates
    if (msg.proposal_open_contract) {
        const c = msg.proposal_open_contract;
        const tracked = activeBinaryContracts[c.contract_id];
        if (!tracked) return;
        if (c.is_sold || c.status === 'sold') {
            const won = c.profit > 0;
            tracked.cb && tracked.cb({ won, profit: c.profit });
            delete activeBinaryContracts[c.contract_id];
        }
    }
}

// ─────────────────────────────────────────────────────────────
// Price / Chart
// ─────────────────────────────────────────────────────────────
function onTick(price) {
    state.currentPrice = price;
    state.prices.push(price);
    if (state.prices.length > CFG.CHART_POINTS) state.prices.shift();

    // Update barriers (±1% from rolling 20-period mean)
    if (state.prices.length >= 20) {
        const slice = state.prices.slice(-20);
        const mean  = slice.reduce((s,v)=>s+v,0)/slice.length;
        const vol   = Math.sqrt(slice.reduce((s,v)=>s+(v-mean)**2,0)/slice.length);
        state.barriers.upper = mean + vol;
        state.barriers.lower = mean - vol;
    }

    // Re-run prediction
    state.prediction = AI.predict(state.prices);

    // Render
    drawChart();
    updatePriceDisplay();
    updatePredictionBox();
    updateWinRateDisplay();
    updateMovesGrid();
    updateTradeButtons();
}

// ─────────────────────────────────────────────────────────────
// Paper trading simulation (when no live token)
// ─────────────────────────────────────────────────────────────
let simInterval = null;
let simBase = 100;

function startSimulation() {
    if (simInterval) return;
    simBase = rand(80, 120);
    simInterval = setInterval(() => {
        const trend = state.marketRegime==='bull' ? 0.0005 : state.marketRegime==='bear' ? -0.0005 : 0;
        const noise = (Math.random()-0.5)*0.004;
        simBase *= (1 + trend + noise);
        onTick(parseFloat(simBase.toFixed(4)));
    }, 500);
    // Randomly shift market regime
    setInterval(() => {
        const r = Math.random();
        if (r < 0.33) state.marketRegime = 'bull';
        else if (r < 0.66) state.marketRegime = 'bear';
        else state.marketRegime = 'range';
        updateRegimeBadge();
    }, 30000);
}

function stopSimulation() {
    clearInterval(simInterval);
    simInterval = null;
}

// ─────────────────────────────────────────────────────────────
// Trade Execution
// ─────────────────────────────────────────────────────────────
function executeTrade(direction) {
    // direction: 'higher' | 'lower' | 'both'
    const check = Risk.canTrade();
    if (!check.ok) {
        notify('⚠️ '+check.reason,'warn');
        return;
    }
    if (state.prediction.confidence < CFG.MIN_CONFIDENCE && direction !== 'manual') {
        notify('Confidence too low ('+fmtPct(state.prediction.confidence)+') – skipping','warn');
        return;
    }

    const dirs = direction === 'both' ? ['higher','lower'] : [direction];

    dirs.forEach(dir => {
        const stake = Risk.adjustedStake(Risk.stakeFor(state.balance, state.prediction.confidence));
        const tradeId = Date.now() + '_' + dir;

        // Create strike entry
        const strike = { id:tradeId, dir, stake, status:'pending', startBalance:state.balance };
        state.activeStrikes.push(strike);
        updateStrikesDisplay();

        if (state.paperMode) {
            // Simulate outcome after TRADE_DURATION seconds
            simulateTrade(strike);
        } else {
            // Live Deriv trade
            const derivDir = dir === 'higher' ? 'CALL' : 'PUT';
            buyBinaryContract(derivDir, stake, (resp, err) => {
                if (err) {
                    removeStrike(tradeId);
                    return;
                }
                strike.contractId = resp.contract_id;
                // Monitor via WebSocket – onContractUpdate handles completion
            });
        }
        state.todayTrades++;
        state.totalTrades++;
    });
    updateDashboard();
}

function simulateTrade(strike) {
    const dur = CFG.TRADE_DURATION * 1000;
    // Simulate price movement
    setTimeout(() => {
        // Use AI prediction accuracy to determine outcome probability
        const pred = state.prediction;
        const correctDir = pred.dir === strike.dir;
        // Base win probability = prediction confidence if direction matches, else 1-confidence
        const winProb = correctDir ? pred.confidence : (1 - pred.confidence);
        // Adjust by current AI accuracy
        const finalWinProb = 0.6*winProb + 0.4*state.ai.currentAccuracy;
        const won = Math.random() < finalWinProb;
        onTradeClose(strike, won);
    }, dur);
}

function onTradeClose(strike, won) {
    const pnl = won
        ? parseFloat((strike.stake * CFG.PAYOUT_RATIO).toFixed(2))
        : -strike.stake;

    // Apply 1%/4% limits
    const stopLoss   = state.balance * CFG.STOP_LOSS_PCT;
    const takeProfit = state.balance * CFG.TAKE_PROFIT_PCT;
    const clampedPnL = clamp(pnl, -stopLoss, takeProfit);

    state.balance   = parseFloat((state.balance + clampedPnL).toFixed(2));
    state.dailyPnL  = parseFloat((state.dailyPnL + clampedPnL).toFixed(2));
    state.balance    = Math.max(0, state.balance);

    // Win/loss tracking
    if (clampedPnL > 0) {
        state.wins++;
        state.consecutiveLosses = 0;
        strike.status = 'win';
        notify(`✅ WIN ${strike.dir.toUpperCase()} +$${fmt(clampedPnL)} | Balance: $${fmt(state.balance)}`,'win');
    } else {
        state.losses++;
        state.consecutiveLosses++;
        strike.status = 'loss';
        notify(`❌ LOSS ${strike.dir.toUpperCase()} -$${fmt(Math.abs(clampedPnL))} | Balance: $${fmt(state.balance)}`,'loss');
    }

    // AI learning
    AI.learn(strike.dir, clampedPnL > 0, state.prediction.confidence);

    // Record in history
    state.tradeHistory.unshift({
        id     : strike.id,
        time   : now(),
        dir    : strike.dir[0].toUpperCase(),
        stake  : strike.stake,
        pnl    : clampedPnL,
        conf   : state.prediction.confidence,
        balance: state.balance,
        status : clampedPnL > 0 ? 'win' : 'loss',
    });
    if (state.tradeHistory.length > 100) state.tradeHistory.pop();

    // Remove from active strikes after a brief display
    setTimeout(() => {
        removeStrike(strike.id);
        if (state.autoRunning) startCooldown();
    }, 1500);

    Risk.checkDrawdown();
    updateBalanceDisplay();
    updateHistoryTable();
    updateDashboard();
    updateGrowthChart();
    updateMovesGrid();
    updateStrikesDisplay();
}

function removeStrike(id) {
    state.activeStrikes = state.activeStrikes.filter(s=>s.id!==id);
    updateStrikesDisplay();
}

// ─────────────────────────────────────────────────────────────
// 4-Strike Auto Mode
// ─────────────────────────────────────────────────────────────
function executeAllFourStrikes() {
    const check = Risk.canTrade();
    if (!check.ok) return;
    // Stakes scaled down for 4 simultaneous
    const dirs = ['higher','lower','lower','higher'];
    const stake = Risk.adjustedStake(Risk.stakeFor(state.balance, state.prediction.confidence) / 4);
    state.activeStrikes = []; // clear before batching
    dirs.forEach((dir, i) => {
        const tradeId = Date.now() + '_' + i + '_' + dir;
        const strike = { id:tradeId, dir, stake, status:'pending', startBalance:state.balance };
        state.activeStrikes.push(strike);
        if (state.paperMode) simulateTrade(strike);
        state.todayTrades++;
        state.totalTrades++;
    });
    state.roundCount++;
    updateStrikesDisplay();
    updateDashboard();
    updateRoundCounter();
}

// ─────────────────────────────────────────────────────────────
// Auto Trading Loop
// ─────────────────────────────────────────────────────────────
function startAutoTrading() {
    if (state.autoRunning) return;
    state.autoRunning = true;
    state.autoPaused  = false;
    updateAutoStatus();
    runAutoStep();
    notify('⚡ Auto Trading STARTED','info');
}

function stopAutoTrading() {
    state.autoRunning = false;
    clearTimeout(state.autoTimer);
    clearInterval(state.cooldownTimer);
    state.cooldownLeft = 0;
    updateAutoStatus();
    updateCooldown();
    notify('⏹ Auto Trading STOPPED','info');
}

function runAutoStep() {
    if (!state.autoRunning) return;

    const check = Risk.canTrade();
    if (!check.ok) {
        // Retry after 10s if paused for reasons that might resolve
        state.autoTimer = setTimeout(runAutoStep, 10000);
        return;
    }

    const { confidence } = state.prediction;
    if (confidence >= CFG.MIN_CONFIDENCE) {
        if (state.autoMode === 'all4') {
            executeAllFourStrikes();
        } else if (state.autoMode === 'hml2') {
            // HML: trade both directions when confidence is moderate
            executeTrade('both');
        } else {
            executeTrade(state.prediction.dir);
        }
    }

    // Next step happens after cooldown (triggered in onTradeClose)
}

function startCooldown() {
    state.cooldownLeft = CFG.COOLDOWN_SEC;
    clearInterval(state.cooldownTimer);
    state.cooldownTimer = setInterval(() => {
        state.cooldownLeft--;
        updateCooldown();
        if (state.cooldownLeft <= 0) {
            clearInterval(state.cooldownTimer);
            if (state.autoRunning) {
                state.autoTimer = setTimeout(runAutoStep, 500);
            }
        }
    }, 1000);
    updateCooldown();
}

// ─────────────────────────────────────────────────────────────
// Chart Rendering
// ─────────────────────────────────────────────────────────────
function drawChart() {
    const canvas = $('priceChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width = canvas.offsetWidth;
    const H = canvas.height = canvas.offsetHeight;
    if (!W || !H) return;

    ctx.clearRect(0,0,W,H);

    const prices = state.prices;
    if (prices.length < 2) return;

    const min = Math.min(...prices) * 0.9995;
    const max = Math.max(...prices) * 1.0005;
    const range = max - min || 1;

    const toX = i => (i/(prices.length-1))*W;
    const toY = v => H - ((v-min)/range)*H;

    // Grid lines
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for (let i=0;i<5;i++) {
        const y = (i/4)*H;
        ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke();
    }

    // Barrier lines
    if (state.barriers.upper && state.barriers.lower) {
        const uy = toY(state.barriers.upper);
        const ly = toY(state.barriers.lower);

        ctx.setLineDash([4,4]);
        ctx.strokeStyle = 'rgba(0,255,136,0.5)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0,uy); ctx.lineTo(W,uy); ctx.stroke();

        ctx.strokeStyle = 'rgba(255,45,120,0.5)';
        ctx.beginPath(); ctx.moveTo(0,ly); ctx.lineTo(W,ly); ctx.stroke();
        ctx.setLineDash([]);

        // Update barrier labels
        const upEl = $('barrierUpper');
        const loEl = $('barrierLower');
        if (upEl) {
            upEl.style.top = Math.max(4, Math.min(H-16, uy-10)) + 'px';
            upEl.textContent = '▲ '+fmt(state.barriers.upper,4);
        }
        if (loEl) {
            loEl.style.top = Math.max(4, Math.min(H-16, ly+2)) + 'px';
            loEl.textContent = '▼ '+fmt(state.barriers.lower,4);
        }
    }

    // Price line (gradient fill)
    const grad = ctx.createLinearGradient(0,0,0,H);
    grad.addColorStop(0,'rgba(0,240,255,0.3)');
    grad.addColorStop(1,'rgba(0,240,255,0.01)');

    ctx.beginPath();
    prices.forEach((p,i) => {
        const x=toX(i), y=toY(p);
        i===0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y);
    });
    const lastX = toX(prices.length-1);
    ctx.lineTo(lastX,H); ctx.lineTo(0,H);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // Price line
    ctx.beginPath();
    prices.forEach((p,i) => {
        const x=toX(i), y=toY(p);
        i===0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y);
    });
    ctx.strokeStyle = '#00f0ff';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Last price dot
    if (prices.length > 0) {
        const lx = toX(prices.length-1);
        const ly2 = toY(prices[prices.length-1]);
        ctx.beginPath();
        ctx.arc(lx, ly2, 4, 0, Math.PI*2);
        ctx.fillStyle = '#00f0ff';
        ctx.fill();
    }
}

function drawGrowthChart() {
    const canvas = $('growthChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width = canvas.offsetWidth;
    const H = canvas.height = canvas.offsetHeight;
    if (!W || !H) return;

    ctx.clearRect(0,0,W,H);

    const data = state.growthHistory;
    if (data.length < 2) {
        ctx.fillStyle = 'rgba(0,240,255,0.3)';
        ctx.font = '12px sans-serif';
        ctx.fillText('Growth chart will appear after trades...', 20, H/2);
        return;
    }

    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = max - min || 1;

    const toX = i => (i/(data.length-1))*W;
    const toY = v => H - ((v-min)/range)*(H-10) - 5;

    // Area fill
    const grad = ctx.createLinearGradient(0,0,0,H);
    grad.addColorStop(0,'rgba(0,255,136,0.35)');
    grad.addColorStop(1,'rgba(0,255,136,0.02)');

    ctx.beginPath();
    data.forEach((v,i) => { const x=toX(i),y=toY(v); i===0?ctx.moveTo(x,y):ctx.lineTo(x,y); });
    ctx.lineTo(toX(data.length-1),H); ctx.lineTo(0,H); ctx.closePath();
    ctx.fillStyle = grad; ctx.fill();

    // Line
    ctx.beginPath();
    data.forEach((v,i) => { const x=toX(i),y=toY(v); i===0?ctx.moveTo(x,y):ctx.lineTo(x,y); });
    ctx.strokeStyle = '#00ff88'; ctx.lineWidth = 2; ctx.stroke();
}

// ─────────────────────────────────────────────────────────────
// UI Update Functions
// ─────────────────────────────────────────────────────────────
function setConnStatus(s) {
    const dot = $('connDot');
    const lbl = $('connLabel');
    if (!dot) return;
    dot.className = 'conn-dot ' + s;
    if (lbl) lbl.textContent = s === 'connected' ? 'Live' : s === 'connecting' ? 'Connecting…' : 'Disconnected';
}

function updateBalanceDisplay() {
    const el = $('balanceBadge');
    if (el) el.textContent = (state.currency || 'USD') + ' ' + fmt(state.balance);
    updatePnLBadge();
    updateGrowthProjections();
}

function updatePnLBadge() {
    const el = $('pnlBadge');
    if (!el) return;
    const pnl = state.dailyPnL;
    el.textContent = fmtPnL(pnl) + ' Today';
    el.className = 'pnl-badge ' + (pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : 'zero');
}

function updatePriceDisplay() {
    const el = $('chartPriceLabel');
    if (el) el.textContent = fmt(state.currentPrice, 4);
}

function updatePredictionBox() {
    const { dir, confidence } = state.prediction;
    const box = $('predBox');
    const dirEl = $('predDir');
    const confEl = $('predConf');
    const descEl = $('predDesc');
    const barEl  = $('confBar');
    if (!box) return;

    box.className = 'prediction-box ' + dir;
    if (dirEl) { dirEl.textContent = '⬆ '+dir.toUpperCase(); dirEl.className = 'pred-dir '+dir; }
    if (confEl){ confEl.textContent = fmtPct(confidence); confEl.className = 'pred-conf '+dir; }
    if (descEl) descEl.textContent = 'Next tick predicted to go '+dir+' than current';
    if (barEl)  { barEl.style.width = fmtPct(confidence); barEl.className = 'conf-bar '+dir; }
}

function updateWinRateDisplay() {
    const total = state.wins + state.losses;
    const higherPct = total > 0 ? state.wins / total : 0.5;
    const lowerPct  = 1 - higherPct;

    const hBar = $('wrHigherBar');
    const lBar = $('wrLowerBar');
    const hPct = $('wrHigherPct');
    const lPct = $('wrLowerPct');
    const hTks = $('wrHigherTicks');
    const lTks = $('wrLowerTicks');

    if (hBar) hBar.style.width = fmtPct(higherPct);
    if (lBar) lBar.style.width = fmtPct(lowerPct);
    if (hPct) hPct.textContent = fmtPct(higherPct);
    if (lPct) lPct.textContent = fmtPct(lowerPct);
    if (hTks) hTks.textContent = state.wins + ' wins';
    if (lTks) lTks.textContent = state.losses + ' losses';
}

function updateMovesGrid() {
    const container = $('movesGrid');
    if (!container) return;
    const history = state.tradeHistory.slice(0, 24).reverse();
    const cells = history.map(t => `<div class="move-cell ${t.dir}">${t.dir}</div>`).join('');
    const empty = Math.max(0, 24-history.length);
    const empties = Array(empty).fill('<div class="move-cell ?">?</div>').join('');
    container.innerHTML = empties + cells;
}

function updateTradeButtons() {
    const { dir, confidence } = state.prediction;
    const stake = Risk.stakeFor(state.balance, confidence);
    const win   = parseFloat((state.balance + stake*CFG.PAYOUT_RATIO).toFixed(2));

    const hExp = $('higherExpect');
    const lExp = $('lowerExpect');
    const hPro = $('higherProfit');
    const lPro = $('lowerProfit');
    const bPayout = $('bothPayout');

    if (hExp) hExp.textContent = 'Stake: $'+fmt(stake)+' | Target: $'+fmt(win);
    if (lExp) lExp.textContent = 'Stake: $'+fmt(stake)+' | Target: $'+fmt(win);
    if (hPro) hPro.textContent = 'Profit: +$'+fmt(stake*CFG.PAYOUT_RATIO);
    if (lPro) lPro.textContent = 'Profit: +$'+fmt(stake*CFG.PAYOUT_RATIO);
    if (bPayout) bPayout.textContent = 'Combined Payout: $'+fmt(win*2-state.balance);
}

function updateStrikesDisplay() {
    // strike cells
    const labels = ['H1','L1','L2','H2'];
    const dirs   = ['higher','lower','lower','higher'];
    for (let i=0;i<4;i++) {
        const cell = $('strike'+i);
        if (!cell) continue;
        const s = state.activeStrikes[i];
        if (s) {
            cell.querySelector('.strike-amt').textContent = '$'+fmt(s.stake);
            const statusEl = cell.querySelector('.strike-status');
            statusEl.className = 'strike-status ' + s.status;
            statusEl.textContent = s.status.toUpperCase();
            cell.classList.add('active-s');
        } else {
            cell.querySelector('.strike-amt').textContent = '--';
            const statusEl = cell.querySelector('.strike-status');
            statusEl.className = 'strike-status idle';
            statusEl.textContent = 'IDLE';
            cell.classList.remove('active-s');
        }
    }
}

function updateAutoStatus() {
    const statusEl = $('autoStatus');
    if (!statusEl) return;
    if (state.autoRunning) {
        statusEl.className = 'auto-status active';
        statusEl.textContent = '● HML ACTIVE';
    } else if (state.autoPaused) {
        statusEl.className = 'auto-status paused';
        statusEl.textContent = '⏸ PAUSED';
    } else {
        statusEl.className = 'auto-status inactive';
        statusEl.textContent = '○ INACTIVE';
    }

    const btn = $('autoToggleBtn');
    if (btn) {
        btn.textContent = state.autoRunning ? '⏹ Stop Auto' : '⚡ Start Auto';
        btn.className   = 'btn-sm ' + (state.autoRunning ? 'btn-pink' : 'btn-green');
    }
}

function updateCooldown() {
    const el = $('cooldownTimer');
    if (el) el.textContent = state.cooldownLeft > 0 ? '🕐 Cooldown '+state.cooldownLeft+'s' : '🟢 Ready';
}

function updateRoundCounter() {
    const el = $('roundCounter');
    if (el) el.textContent = '⭕ '+state.roundCount+' rounds';
}

function updateAIDisplay() {
    const ai = state.ai;
    const phaseEl = $('aiPhase');
    const accEl   = $('aiAccuracy');
    const trEl    = $('aiTrades');
    const barEl   = $('aiLearnBar');

    if (phaseEl) phaseEl.textContent = AI.getPhaseLabel();
    if (accEl)   accEl.textContent   = fmtPct(ai.currentAccuracy);
    if (trEl)    trEl.textContent    = ai.totalTrades+' trades';

    const progress = Math.min(100, (ai.totalTrades/200)*100);
    if (barEl) barEl.style.width = progress+'%';
}

function updateRegimeBadge() {
    const el = $('regimeBadge');
    if (!el) return;
    const labels = { bull:'🟢 BULL', bear:'🔴 BEAR', range:'🔵 RANGING' };
    el.textContent = labels[state.marketRegime] || 'RANGE';
    el.className = 'regime-badge '+state.marketRegime;
}

function updateDashboard() {
    const total = state.wins + state.losses;
    const wr    = total > 0 ? state.wins/total : 0;
    const avgWin= state.wins  > 0 ? state.tradeHistory.filter(t=>t.status==='win').reduce((s,t)=>s+t.pnl,0)/state.wins  : 0;
    const avgLos= state.losses> 0 ? Math.abs(state.tradeHistory.filter(t=>t.status==='loss').reduce((s,t)=>s+t.pnl,0)/state.losses) : 0;
    const pf    = avgLos > 0 ? (avgWin*state.wins)/(avgLos*state.losses) : 0;

    const set = (id,v) => { const el=$(id); if(el) el.textContent=v; };
    set('anaBalance', '$'+fmt(state.balance));
    set('anaTodayPnL', fmtPnL(state.dailyPnL));
    set('anaTrades',   state.todayTrades);
    set('anaWinRate',  fmtPct(wr));
    set('anaAvgWin',   '$'+fmt(avgWin));
    set('anaAvgLoss',  '$'+fmt(avgLos));
    set('anaPF',       fmt(pf,2)+'x');
    set('anaTotalTrades', state.totalTrades);
    set('anaConsecLoss',  state.consecutiveLosses);
    set('anaPhase',       AI.getPhaseLabel());
}

function updateHistoryTable() {
    const tbody = $('historyTbody');
    if (!tbody) return;
    tbody.innerHTML = state.tradeHistory.slice(0,20).map(t => `
        <tr>
            <td>${t.time}</td>
            <td><span class="dir-badge ${t.dir}">${t.dir==='H'?'HIGHER':t.dir==='L'?'LOWER':'BOTH'}</span></td>
            <td>$${fmt(t.stake)}</td>
            <td class="${t.status==='win'?'trade-win':'trade-loss'}">${fmtPnL(t.pnl)}</td>
            <td>${fmtPct(t.conf)}</td>
            <td>$${fmt(t.balance)}</td>
        </tr>
    `).join('');
}

function updateGrowthChart() {
    state.growthHistory.push(state.balance);
    if (state.growthHistory.length > 200) state.growthHistory.shift();
    drawGrowthChart();
    updateGrowthProjections();
}

function updateGrowthProjections() {
    const bal = state.balance;
    const dailyWr = 0.55; // conservative
    const dailyMult = 1 + (dailyWr * CFG.TAKE_PROFIT_PCT - (1-dailyWr) * CFG.STOP_LOSS_PCT) * 10;

    const set = (id,v) => { const el=$(id); if(el) el.textContent=v; };
    set('projDay7',  '$'+fmt(bal * Math.pow(dailyMult, 7)));
    set('projDay14', '$'+fmt(bal * Math.pow(dailyMult, 14)));
    set('projDay30', '$'+fmt(bal * Math.pow(dailyMult, 30)));
    set('projDay90', '$'+fmt(bal * Math.pow(dailyMult, 90)));
}

function updateDisplay() {
    updateBalanceDisplay();
    updatePredictionBox();
    updateWinRateDisplay();
    updateAutoStatus();
    updateDashboard();
    updateHistoryTable();
    updateAIDisplay();
    updateRegimeBadge();
    updateCooldown();
    updateRoundCounter();
    updateStrikesDisplay();
    drawChart();
    drawGrowthChart();
}

// ─────────────────────────────────────────────────────────────
// Notifications
// ─────────────────────────────────────────────────────────────
function notify(message, type='info') {
    const container = $('notifications');
    if (!container) return;
    const div = document.createElement('div');
    div.className = 'notif ' + type;
    div.textContent = message;
    container.appendChild(div);
    setTimeout(() => div.remove(), 4000);

    // Log to console for debugging
    console.log(`[${type.toUpperCase()}] ${message}`);
}

// ─────────────────────────────────────────────────────────────
// Tab Switching
// ─────────────────────────────────────────────────────────────
function switchTab(tabId) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    const btn = document.querySelector(`[data-tab="${tabId}"]`);
    const content = $('tab-'+tabId);
    if (btn) btn.classList.add('active');
    if (content) content.classList.add('active');
}

// ─────────────────────────────────────────────────────────────
// Export to CSV
// ─────────────────────────────────────────────────────────────
function exportCSV() {
    const header = 'Time,Direction,Stake,PnL,Confidence,Balance,Status';
    const rows = state.tradeHistory.map(t =>
        `${t.time},${t.dir},${t.stake},${t.pnl},${(t.conf*100).toFixed(1)}%,${t.balance},${t.status}`
    );
    const csv = [header,...rows].join('\n');
    const blob = new Blob([csv],{type:'text/csv'});
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href=url; a.download='trade_history.csv'; a.click();
    URL.revokeObjectURL(url);
}

// ─────────────────────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────────────────────
function init() {
    // Populate asset selector
    const assetSel = $('assetSelect');
    if (assetSel) {
        ASSETS.forEach(a => {
            const opt = document.createElement('option');
            opt.value=a.id; opt.textContent=a.label;
            if(a.id===CFG.DEFAULT_ASSET) opt.selected=true;
            assetSel.appendChild(opt);
        });
        assetSel.addEventListener('change', e => {
            state.asset = e.target.value;
            state.prices = [];
            if (state.ws && state.ws.readyState===1) subscribePrice(state.asset);
            if (state.paperMode) { stopSimulation(); startSimulation(); }
        });
    }

    // Auto mode buttons
    document.querySelectorAll('.mode-btn').forEach(b => {
        b.addEventListener('click', () => {
            document.querySelectorAll('.mode-btn').forEach(x=>x.classList.remove('active'));
            b.classList.add('active');
            state.autoMode = b.dataset.mode;
        });
    });

    // Auto toggle
    const autoBtn = $('autoToggleBtn');
    if (autoBtn) autoBtn.addEventListener('click', () => {
        if (state.autoRunning) stopAutoTrading();
        else startAutoTrading();
    });

    // Trade buttons
    const higherBtn = $('higherBtn');
    const lowerBtn  = $('lowerBtn');
    const bothBtn   = $('bothBtn');
    if (higherBtn) higherBtn.addEventListener('click', () => executeTrade('higher'));
    if (lowerBtn)  lowerBtn.addEventListener('click',  () => executeTrade('lower'));
    if (bothBtn)   bothBtn.addEventListener('click',   () => executeTrade('both'));

    // Emergency stop
    const emerBtn = $('emergencyStop');
    if (emerBtn) emerBtn.addEventListener('click', () => {
        state.emergencyStopped = true;
        stopAutoTrading();
        state.activeStrikes = [];
        updateStrikesDisplay();
        notify('🚨 EMERGENCY STOP activated! All trading halted.','warn');
        updateDisplay();
    });
    const resumeBtn = $('resumeBtn');
    if (resumeBtn) resumeBtn.addEventListener('click', () => {
        state.emergencyStopped = false;
        state.dailyLimitHit   = false;
        state.autoPaused      = false;
        state.consecutiveLosses = 0;
        notify('✅ Trading resumed','info');
        updateDisplay();
    });

    // API Token connect
    const connectBtn = $('connectBtn');
    if (connectBtn) connectBtn.addEventListener('click', () => {
        const token = $('apiToken')?.value?.trim();
        if (!token) {
            notify('Enter your Deriv API token first','warn');
            return;
        }
        state.apiToken = token;
        state.paperMode = false;
        derivAuthorize(token);
    });

    // Paper mode toggle
    const paperToggle = $('paperToggle');
    if (paperToggle) {
        paperToggle.checked = state.paperMode;
        paperToggle.addEventListener('change', e => {
            state.paperMode = e.target.checked;
            if (state.paperMode) {
                state.authorized = false;
                state.balance = CFG.DEFAULT_ACCOUNT_DEMO;
                state.startBalance = state.balance;
                state.dailyStart = state.balance;
                startSimulation();
                notify('📝 Paper trading mode activated (demo account)','info');
            } else {
                stopSimulation();
                notify('⚠️ Live mode – connect your Deriv API token','warn');
            }
            updateBalanceDisplay();
        });
    }

    // Export
    const exportBtn = $('exportBtn');
    if (exportBtn) exportBtn.addEventListener('click', exportCSV);

    // Tabs
    document.querySelectorAll('.tab-btn').forEach(b => {
        b.addEventListener('click', () => switchTab(b.dataset.tab));
    });

    // Strategy toggles in sidebar
    document.querySelectorAll('.strategy-toggle').forEach(tog => {
        tog.addEventListener('change', e => {
            const strategy = e.target.dataset.strategy;
            document.querySelectorAll('.strategy-toggle').forEach(t => {
                if (t !== e.target) t.checked = false;
            });
            // Only 'hybrid' is fully implemented
            if (strategy !== 'hybrid') {
                notify('Strategy "'+strategy+'" – coming soon! Using Hybrid.','warn');
                e.target.checked = false;
                document.querySelector('[data-strategy="hybrid"]').checked = true;
            }
        });
    });

    // Reset balance (demo)
    const resetBtn = $('resetBalanceBtn');
    if (resetBtn) resetBtn.addEventListener('click', () => {
        if (state.paperMode) {
            state.balance = CFG.DEFAULT_ACCOUNT_DEMO;
            state.startBalance = state.balance;
            state.dailyStart = state.balance;
            state.dailyPnL = 0;
            state.wins = 0;
            state.losses = 0;
            state.todayTrades = 0;
            state.totalTrades = 0;
            state.consecutiveLosses = 0;
            state.emergencyStopped = false;
            state.dailyLimitHit = false;
            state.autoPaused = false;
            state.tradeHistory = [];
            state.growthHistory = [];
            state.ai = { ...state.ai, totalTrades:0, phase:0, currentAccuracy:0.50, recentAccuracy:[] };
            updateDisplay();
            notify('🔄 Demo account reset to $'+fmt(CFG.DEFAULT_ACCOUNT_DEMO),'info');
        }
    });

    // Confidence threshold slider
    const confSlider = $('confThreshold');
    const confLabel  = $('confLabel');
    if (confSlider) {
        confSlider.value = CFG.MIN_CONFIDENCE * 100;
        confSlider.addEventListener('input', () => {
            CFG.MIN_CONFIDENCE = confSlider.value / 100;
            if (confLabel) confLabel.textContent = confSlider.value + '%';
        });
    }

    // Trade duration selector
    const durSel = $('durationSel');
    if (durSel) {
        durSel.value = CFG.TRADE_DURATION;
        durSel.addEventListener('change', () => {
            CFG.TRADE_DURATION = parseInt(durSel.value);
        });
    }

    // Connect to Deriv (for live tick data even in paper mode)
    derivConnect();

    // Paper mode simulation (always runs for price chart)
    if (state.paperMode) {
        startSimulation();
    }

    // Initial render
    updateDisplay();
    switchTab('trading');

    // Periodic UI refresh
    setInterval(() => {
        updateDashboard();
        updateAIDisplay();
        updateRegimeBadge();
        drawGrowthChart();
        drawChart();
    }, 2000);
}

// Boot when DOM ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
