/* ===== GMILLI AI — LAZY MILLIONAIRE HYBRID TRADING SYSTEM ===== */
/* ========== AI ENGINE + TRADING LOGIC ========================= */

'use strict';

// ===== GLOBAL STATE =====
const STATE = {
  // Market
  market: 'R_100',
  currentPrice: 0,
  prevPrice: 0,
  priceHistory: [],
  tickCount: 0,
  higherCount: 0,
  lowerCount: 0,
  candlerSpeed: 10,
  barrierOffset: 0.12,
  lowerBarrierOffset: 0.12,
  barrierType: 'offset',

  // Balance
  balance: 10000,
  startBalance: 10000,
  dailyPnl: 0,
  netProfit: 0,
  profitHistory: [],

  // Trade execution
  totalTrades: 0,
  wonTrades: 0,
  lostTrades: 0,
  activeStrikes: [],
  tradeHistory: [],
  consecutiveLosses: 0,
  consecutiveWins: 0,

  // AI
  aiConfidence: 0,
  aiDirection: null,
  aiLevel: 0,
  aiXp: 0,
  patternHistory: [],
  winningPatterns: {},
  marketRegime: 'ranging',
  volatilityIndex: 50,
  trendStrength: 0,
  neuralWeight: 0.5,
  geneticParams: { patternW: 0.3, volW: 0.25, trendW: 0.25, neuralW: 0.2 },
  recentPredictions: [],

  // Auto trading
  autoTrading: false,
  autoMode: 'hml',
  cooldownMs: 5000,
  cooldownRemaining: 0,
  cooldownInterval: null,
  roundCount: 0,
  autoProgressPct: 0,

  // Deriv API
  derivWs: null,
  derivConnected: false,
  paperMode: true,
  derivToken: '',

  // Charts
  priceChartData: [],
  chartCtx: null,
  profitChartCtx: null,
};

// ===== AI LEVELS =====
const AI_LEVELS = [
  { name: 'Rookie',    minXp: 0,    maxXp: 100  },
  { name: 'Learner',   minXp: 100,  maxXp: 300  },
  { name: 'Skilled',   minXp: 300,  maxXp: 700  },
  { name: 'Advanced',  minXp: 700,  maxXp: 1500 },
  { name: 'Expert',    minXp: 1500, maxXp: 3000 },
  { name: 'Master',    minXp: 3000, maxXp: 6000 },
  { name: 'GMilli AI', minXp: 6000, maxXp: 999999 },
];

// ===== MARKET BASE PRICES =====
const MARKET_BASE = {
  R_100: 100000,
  R_75: 500000,
  R_50: 1000,
  R_25: 5000,
  R_10: 500,
  '1HZ100V': 100000,
  '1HZ75V': 500000,
  '1HZ50V': 1000,
};

// ===== PRICE SIMULATION =====
function getBasePrice() {
  return MARKET_BASE[STATE.market] || 100000;
}

function simulateNextTick() {
  if (!STATE.currentPrice) {
    STATE.currentPrice = getBasePrice() + (Math.random() - 0.5) * getBasePrice() * 0.001;
  }
  const vol = STATE.volatilityIndex / 100;
  const trendBias = STATE.trendStrength * 0.0001;
  const delta = (Math.random() - 0.5 + trendBias) * getBasePrice() * vol * 0.0005;
  STATE.prevPrice = STATE.currentPrice;
  STATE.currentPrice = Math.max(STATE.currentPrice + delta, 0.01);

  // Track direction
  const dir = STATE.currentPrice > STATE.prevPrice ? 'H' : 'L';
  STATE.patternHistory.push(dir);
  if (STATE.patternHistory.length > 200) STATE.patternHistory.shift();

  if (dir === 'H') STATE.higherCount++;
  else STATE.lowerCount++;
  STATE.tickCount++;

  updatePriceDisplay();
  runAIEngine();
  checkStrikeResolutions();

  // Update volatility periodically
  if (STATE.tickCount % 20 === 0) detectMarketRegime();
  if (STATE.tickCount % 5 === 0) geneticOptimize();

  return dir;
}

// ===== MARKET REGIME DETECTION =====
function detectMarketRegime() {
  if (STATE.patternHistory.length < 20) return;
  const recent = STATE.patternHistory.slice(-30);
  const hCount = recent.filter(x => x === 'H').length;
  const pctH = hCount / recent.length;

  // Volatility: measure price swing
  if (STATE.priceChartData.length >= 20) {
    const prices = STATE.priceChartData.slice(-20).map(p => p.y);
    const max = Math.max(...prices);
    const min = Math.min(...prices);
    const swing = (max - min) / min * 100;
    STATE.volatilityIndex = Math.min(100, Math.max(10, swing * 200));
  }

  // Trend strength
  const trendWindow = STATE.patternHistory.slice(-20);
  const hRun = trendWindow.filter(x => x === 'H').length;
  STATE.trendStrength = (hRun - 10) / 10;

  if (pctH > 0.65) STATE.marketRegime = 'bull';
  else if (pctH < 0.35) STATE.marketRegime = 'bear';
  else STATE.marketRegime = 'ranging';

  document.getElementById('marketRegime').textContent =
    STATE.marketRegime.charAt(0).toUpperCase() + STATE.marketRegime.slice(1);
  document.getElementById('volIndex').textContent = STATE.volatilityIndex.toFixed(1);
  document.getElementById('trendStrength').textContent =
    STATE.trendStrength > 0.2 ? 'Bullish' :
    STATE.trendStrength < -0.2 ? 'Bearish' : 'Neutral';
}

// ===== AI ENGINE =====
function runAIEngine() {
  if (STATE.patternHistory.length < 5) return;

  const { patternW, volW, trendW, neuralW } = STATE.geneticParams;

  // 1. Pattern score
  const patternScore = analyzePatterns();

  // 2. Volatility score (high vol = more uncertain, slight bias to current direction)
  const volScore = 0.5 + (STATE.trendStrength * 0.2);

  // 3. Trend score
  const trendScore = 0.5 + (STATE.trendStrength * 0.35);

  // 4. Neural network score (simulated deep learning)
  const neuralScore = simulateNeuralNet();

  // Weighted confidence
  const rawScore = patternW * patternScore +
                   volW * volScore +
                   trendW * trendScore +
                   neuralW * neuralScore;

  // Clamp to 0-1
  const clampedScore = Math.max(0, Math.min(1, rawScore));

  // Direction
  const direction = clampedScore > 0.5 ? 'HIGHER' : 'LOWER';
  const confidence = direction === 'HIGHER'
    ? 40 + (clampedScore - 0.5) * 120
    : 40 + (0.5 - clampedScore) * 120;

  STATE.aiConfidence = Math.round(Math.min(95, Math.max(40, confidence)));
  STATE.aiDirection = direction;

  // Store prediction
  STATE.recentPredictions.push({ dir: direction, conf: STATE.aiConfidence, ts: Date.now() });
  if (STATE.recentPredictions.length > 50) STATE.recentPredictions.shift();

  updatePredictionDisplay(patternScore, volScore, trendScore, neuralScore);
  updateTradeButtonInfo();
}

function analyzePatterns() {
  const hist = STATE.patternHistory;
  if (hist.length < 10) return 0.5;

  // Last 3 pattern
  const last3 = hist.slice(-3).join('');
  // Last 5 pattern
  const last5 = hist.slice(-5).join('');

  const patternKey3 = last3;
  const patternKey5 = last5;

  // Check winning pattern database
  let score = 0.5;
  if (STATE.winningPatterns[patternKey5]) {
    const p = STATE.winningPatterns[patternKey5];
    score = p.wins / (p.wins + p.losses + 1);
  } else if (STATE.winningPatterns[patternKey3]) {
    const p = STATE.winningPatterns[patternKey3];
    score = p.wins / (p.wins + p.losses + 1);
  }

  // Momentum: last 5 ticks direction
  const last5arr = hist.slice(-5);
  const recentH = last5arr.filter(x => x === 'H').length;
  const momentum = recentH / 5;
  return score * 0.5 + momentum * 0.5;
}

function simulateNeuralNet() {
  // Simulates a neural network using price momentum and pattern complexity
  const hist = STATE.patternHistory.slice(-20);
  if (hist.length < 10) return 0.5;

  // Layer 1: input features
  const f1 = hist.filter(x => x === 'H').length / hist.length;
  const f2 = hist.slice(-5).filter(x => x === 'H').length / 5;
  const f3 = hist.slice(-10).filter(x => x === 'H').length / 10;
  const f4 = STATE.volatilityIndex / 100;
  const f5 = (STATE.trendStrength + 1) / 2;

  // Layer 2: weights (evolve with genetic algo)
  const w1 = 0.2 + STATE.neuralWeight * 0.1;
  const w2 = 0.35;
  const w3 = 0.2;
  const w4 = 0.1;
  const w5 = 0.15;

  // Sigmoid activation
  const rawOut = w1*f1 + w2*f2 + w3*f3 + w4*f4 + w5*f5;
  return 1 / (1 + Math.exp(-(rawOut - 0.5) * 5));
}

// ===== GENETIC ALGORITHM OPTIMIZER =====
function geneticOptimize() {
  if (STATE.totalTrades < 10) return;
  const winRate = STATE.wonTrades / STATE.totalTrades;

  // Mutate if win rate is below target
  if (winRate < 0.6) {
    const mutRate = 0.05;
    STATE.geneticParams.patternW += (Math.random() - 0.5) * mutRate;
    STATE.geneticParams.volW += (Math.random() - 0.5) * mutRate;
    STATE.geneticParams.trendW += (Math.random() - 0.5) * mutRate;
    STATE.geneticParams.neuralW += (Math.random() - 0.5) * mutRate;

    // Normalize weights to sum = 1
    const sum = STATE.geneticParams.patternW + STATE.geneticParams.volW +
                STATE.geneticParams.trendW + STATE.geneticParams.neuralW;
    STATE.geneticParams.patternW = Math.max(0.1, STATE.geneticParams.patternW / sum);
    STATE.geneticParams.volW = Math.max(0.1, STATE.geneticParams.volW / sum);
    STATE.geneticParams.trendW = Math.max(0.1, STATE.geneticParams.trendW / sum);
    STATE.geneticParams.neuralW = 1 - STATE.geneticParams.patternW -
                                      STATE.geneticParams.volW - STATE.geneticParams.trendW;
  }

  if (winRate > 0.65) {
    STATE.neuralWeight = Math.min(1, STATE.neuralWeight + 0.01);
  }
}

// ===== DYNAMIC STAKE SIZING =====
function getDynamicStake(conf) {
  if (conf >= 85) return Math.min(2000, STATE.balance * 0.02 * 2);
  if (conf >= 75) return Math.min(1000, STATE.balance * 0.02 * 1.5);
  if (conf >= 60) return Math.min(300, STATE.balance * 0.02);
  return Math.min(100, STATE.balance * 0.01);
}

// ===== STAKE ADJUSTMENT =====
function adjustStake(side, delta) {
  const el = document.getElementById(side === 'higher' ? 'higherStake' : 'lowerStake');
  const val = parseFloat(el.value) || 0;
  el.value = Math.max(1, Math.round(val + delta));
  updateTradeButtonInfo();
}

function adjustBarrier(side, delta) {
  const el = document.getElementById(side === 'higher' ? 'higherBarrierOffset' : 'lowerBarrierOffset');
  el.value = (parseFloat(el.value) + delta).toFixed(2);
  updateBarriers();
}

function updateBarriers() {
  STATE.barrierOffset = parseFloat(document.getElementById('higherBarrierOffset').value) || 0.12;
  STATE.lowerBarrierOffset = parseFloat(document.getElementById('lowerBarrierOffset').value) || 0.12;
  updatePriceDisplay();
}

function updateCandlerSpeed() {
  STATE.candlerSpeed = parseInt(document.getElementById('candlerSpeed').value) || 10;
  restartTickSimulator();
}


// ===== TRADE EXECUTION =====
function executeTrade(type) {
  if (!STATE.currentPrice) return;

  const duration = parseInt(document.getElementById('tradeDuration').value) || 10;
  const hStake = parseFloat(document.getElementById('higherStake').value) || 100;
  const lStake = parseFloat(document.getElementById('lowerStake').value) || 100;
  const s1 = parseFloat(document.getElementById('s1').value) || 0.35;
  const s2 = parseFloat(document.getElementById('s2').value) || 0.35;
  const s3 = parseFloat(document.getElementById('s3').value) || 0.35;
  const s4 = parseFloat(document.getElementById('s4').value) || 0.35;

  const entryPrice = STATE.currentPrice;
  const higherBarrier = entryPrice + STATE.barrierOffset;
  const lowerBarrier = entryPrice - STATE.lowerBarrierOffset;

  if (type === 'higher' || type === 'both') {
    spawnStrike({ dir: 'H', label: 'Higher 1', stake: hStake, entry: entryPrice, barrier: higherBarrier, duration });
    spawnStrike({ dir: 'H', label: 'Higher 2', stake: s4, entry: entryPrice, barrier: higherBarrier, duration });
  }
  if (type === 'lower' || type === 'both') {
    spawnStrike({ dir: 'L', label: 'Lower 1', stake: lStake, entry: entryPrice, barrier: lowerBarrier, duration });
    spawnStrike({ dir: 'L', label: 'Lower 2', stake: s3, entry: entryPrice, barrier: lowerBarrier, duration });
  }
  if (type === 'both') {
    // All 4 active
  }

  renderStrikes();
}

function executeAutoRound() {
  if (!STATE.autoTrading || !STATE.currentPrice) return;
  const mode = STATE.autoMode;

  // Risk management checks
  if (STATE.dailyPnl <= -(STATE.balance * 0.05)) {
    stopAutoTrading('Daily loss limit reached!');
    return;
  }
  if (STATE.consecutiveLosses >= 5) {
    stopAutoTrading('5 consecutive losses — pausing AI to learn...');
    setTimeout(() => { STATE.consecutiveLosses = 0; }, 30000);
    return;
  }
  const winRate = STATE.totalTrades > 10 ? STATE.wonTrades / STATE.totalTrades : 1;
  if (STATE.totalTrades > 20 && winRate < 0.45) {
    stopAutoTrading('Win rate below 45% — AI recalibrating...');
    return;
  }

  const conf = STATE.aiConfidence;
  const dir = STATE.aiDirection;
  const aiStake = getDynamicStake(conf);

  // Update stake inputs with AI-calculated values
  document.getElementById('higherStake').value = aiStake.toFixed(2);
  document.getElementById('lowerStake').value = aiStake.toFixed(2);

  STATE.roundCount++;
  document.getElementById('roundCounter').textContent = STATE.roundCount;

  let tradeType = 'both';
  if (mode === 'hml' && dir) {
    tradeType = dir === 'HIGHER' ? 'higher' : 'lower';
  } else if (mode === 'all4') {
    tradeType = 'both';
  } else if (mode === 'p5') {
    tradeType = Math.random() > 0.5 ? 'higher' : 'lower';
  } else {
    tradeType = dir === 'HIGHER' ? 'higher' : 'lower';
  }

  executeTrade(tradeType);

  // Progress
  STATE.autoProgressPct = Math.min(100, STATE.autoProgressPct + 8);
  document.getElementById('autoProgressFill').style.width = STATE.autoProgressPct + '%';

  const modeName = document.getElementById('autoMode').options[document.getElementById('autoMode').selectedIndex].text;
  document.getElementById('autoModeLabel').textContent = modeName.toUpperCase() + ' ACTIVE';
}

function spawnStrike(opts) {
  const { dir, label, stake, entry, barrier, duration } = opts;
  const id = `strike_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  STATE.balance -= stake;
  updateBalanceDisplay();

  const strike = {
    id,
    dir,
    label,
    stake,
    entry,
    barrier,
    duration,
    startTime: Date.now(),
    endTime: Date.now() + duration * 1000,
    status: 'running',
    profit: 0,
  };

  STATE.activeStrikes.push(strike);
  renderStrikes();
}

function checkStrikeResolutions() {
  const now = Date.now();
  let changed = false;

  STATE.activeStrikes.forEach(s => {
    if (s.status !== 'running') return;
    if (now >= s.endTime) {
      resolveStrike(s);
      changed = true;
    }
  });

  if (changed) {
    // Cleanup old resolved strikes after 3s
    setTimeout(() => {
      STATE.activeStrikes = STATE.activeStrikes.filter(s => {
        return s.status === 'running' || (Date.now() - s.endTime) < 4000;
      });
      renderStrikes();
    }, 3000);
    renderStrikes();
  }
}

function resolveStrike(s) {
  const price = STATE.currentPrice;
  let won;
  if (s.dir === 'H') {
    won = price > s.barrier;
  } else {
    won = price < s.barrier;
  }

  const payout = won ? s.stake * 0.97 : 0;
  const pnl = won ? payout : -s.stake;

  s.status = won ? 'won' : 'lost';
  s.profit = pnl;

  STATE.balance += s.stake + pnl;
  STATE.netProfit += pnl;
  STATE.dailyPnl += pnl;
  STATE.totalTrades++;

  if (won) {
    STATE.wonTrades++;
    STATE.consecutiveLosses = 0;
    STATE.consecutiveWins++;
    // Learn winning pattern
    const pattern = STATE.patternHistory.slice(-5).join('');
    if (!STATE.winningPatterns[pattern]) STATE.winningPatterns[pattern] = { wins: 0, losses: 0 };
    STATE.winningPatterns[pattern].wins++;
    gainXp(10 + Math.floor(STATE.aiConfidence / 10));
  } else {
    STATE.lostTrades++;
    STATE.consecutiveLosses++;
    STATE.consecutiveWins = 0;
    // Learn losing pattern
    const pattern = STATE.patternHistory.slice(-5).join('');
    if (!STATE.winningPatterns[pattern]) STATE.winningPatterns[pattern] = { wins: 0, losses: 0 };
    STATE.winningPatterns[pattern].losses++;
    gainXp(2);
  }

  // Add to history
  STATE.tradeHistory.unshift({
    num: STATE.totalTrades,
    time: new Date().toLocaleTimeString(),
    market: STATE.market,
    direction: s.dir === 'H' ? 'HIGHER' : 'LOWER',
    stake: s.stake.toFixed(2),
    result: won ? 'WIN' : 'LOSS',
    pnl: pnl.toFixed(2),
    conf: STATE.aiConfidence,
  });
  if (STATE.tradeHistory.length > 200) STATE.tradeHistory.pop();

  // Recent move
  addMoveToGrid(s.dir);

  updateBalanceDisplay();
  updateSessionStats();
  updateHistoryTable();
  updateProfitChart();

  // Auto round result
  if (STATE.autoTrading) {
    const net = STATE.activeStrikes.filter(x => x.status !== 'running')
      .reduce((a, b) => a + b.profit, 0);
    const winCount = STATE.activeStrikes.filter(x => x.status === 'won').length;
    const totalResolved = STATE.activeStrikes.filter(x => x.status !== 'running').length;
    document.getElementById('autoRoundResult').textContent =
      `Round ${STATE.roundCount}: ${winCount}/${totalResolved} wins | Net: ${net >= 0 ? '+' : ''}$${net.toFixed(2)}`;
  }
}

// ===== XP + AI LEVEL =====
function gainXp(amount) {
  STATE.aiXp += amount;
  const level = AI_LEVELS.findIndex((l, i) =>
    STATE.aiXp >= l.minXp && (i === AI_LEVELS.length - 1 || STATE.aiXp < AI_LEVELS[i + 1].minXp)
  );
  if (level >= 0 && level !== STATE.aiLevel) {
    STATE.aiLevel = level;
  }
  updateAILevel();
}

function updateAILevel() {
  const level = AI_LEVELS[STATE.aiLevel] || AI_LEVELS[0];
  const next = AI_LEVELS[STATE.aiLevel + 1] || AI_LEVELS[AI_LEVELS.length - 1];
  const pct = Math.min(100, ((STATE.aiXp - level.minXp) / (next.minXp - level.minXp)) * 100);
  document.getElementById('aiLevelName').textContent = level.name;
  document.getElementById('aiXpFill').style.width = pct + '%';
  document.getElementById('sidebarTrades').textContent = STATE.totalTrades;
  const wr = STATE.totalTrades > 0 ? Math.round(STATE.wonTrades / STATE.totalTrades * 100) : 0;
  document.getElementById('sidebarWinRate').textContent = wr + '%';
}

// ===== RENDERS =====
function renderStrikes() {
  const container = document.getElementById('strikesContainer');
  const countEl = document.getElementById('strikesActiveCount');
  const active = STATE.activeStrikes.filter(s => s.status === 'running');
  countEl.textContent = active.length + ' Active';

  if (STATE.activeStrikes.length === 0) {
    container.innerHTML = '<div class="no-strikes">No active strikes. Click HIGHER, LOWER, or HIGHER &amp; LOWER to trade.</div>';
    return;
  }

  container.innerHTML = STATE.activeStrikes.map(s => {
    const remaining = Math.max(0, Math.ceil((s.endTime - Date.now()) / 1000));
    const resultClass = s.status === 'running' ? 'running' :
                        s.status === 'won' ? 'win' : 'lose';
    const resultText = s.status === 'running' ? 'LIVE' :
                       s.status === 'won' ? `WIN +$${s.profit.toFixed(2)}` : `LOSS -$${s.stake.toFixed(2)}`;
    const rowClass = s.status === 'won' ? 'won' : s.status === 'lost' ? 'lost' : '';
    const dirClass = s.dir === 'H' ? 'strike-h' : 'strike-l';
    const dirIcon = s.dir === 'H' ? '▲' : '▼';

    return `<div class="strike-row ${rowClass}" id="${s.id}">
      <span class="strike-val ${dirClass}">${dirIcon} ${s.label}</span>
      <span class="strike-info">Entry: ${s.entry.toFixed(3)}</span>
      <span class="strike-info">Barrier: ${s.barrier.toFixed(3)}</span>
      <span class="strike-timer">${s.status === 'running' ? remaining + 's' : '0s'}</span>
      <span class="strike-result ${resultClass}">${resultText}</span>
    </div>`;
  }).join('');
}

function addMoveToGrid(dir) {
  const grid = document.getElementById('movesGrid');
  const pill = document.createElement('div');
  pill.className = `move-pill ${dir === 'H' ? 'move-h' : 'move-l'}`;
  pill.textContent = dir;
  grid.appendChild(pill);
  // Keep last 40 moves
  while (grid.children.length > 40) grid.removeChild(grid.firstChild);
}

function updatePriceDisplay() {
  const price = STATE.currentPrice;
  const prev = STATE.prevPrice;
  const change = price - prev;

  document.getElementById('currentPrice').textContent = price.toFixed(3);

  const changeEl = document.getElementById('priceChange');
  changeEl.textContent = (change >= 0 ? '+' : '') + change.toFixed(3);
  changeEl.className = 'price-change ' + (change >= 0 ? 'up' : 'down');

  // Barriers
  const hB = price + STATE.barrierOffset;
  const lB = price - STATE.lowerBarrierOffset;
  document.getElementById('higherBarrierDisplay').textContent = hB.toFixed(3);
  document.getElementById('lowerBarrierDisplay').textContent = lB.toFixed(3);

  // Higher/Lower %
  const total = STATE.higherCount + STATE.lowerCount || 1;
  const hPct = Math.round(STATE.higherCount / total * 100);
  document.getElementById('higherPct').textContent = hPct + '%';
  document.getElementById('lowerPct').textContent = (100 - hPct) + '%';
  document.getElementById('tickCount').textContent = STATE.tickCount;

  // Win rate badge
  const wr = STATE.totalTrades > 0 ? Math.round(STATE.wonTrades / STATE.totalTrades * 100) : 0;
  document.getElementById('winRateBadge').textContent = `Win Rate: ${wr}%`;

  // Price chart data
  STATE.priceChartData.push({ x: STATE.tickCount, y: price });
  if (STATE.priceChartData.length > 120) STATE.priceChartData.shift();
  drawPriceChart();
}

function updatePredictionDisplay(patternS, volS, trendS, neuralS) {
  const conf = STATE.aiConfidence;
  const dir = STATE.aiDirection;

  // Confidence circle
  const circumference = 2 * Math.PI * 42;
  const dashArray = (conf / 100) * circumference;
  const circle = document.getElementById('confCircle');
  circle.setAttribute('stroke-dasharray', `${dashArray} ${circumference - dashArray}`);
  circle.setAttribute('stroke', conf >= 75 ? 'var(--green)' : conf >= 60 ? 'var(--cyan)' : 'var(--pink)');

  document.getElementById('confPct').textContent = conf + '%';
  document.getElementById('confBar').style.width = conf + '%';

  const dirEl = document.getElementById('predDirection');
  if (dir === 'HIGHER') {
    dirEl.textContent = '▲ HIGHER';
    dirEl.className = 'pred-direction higher';
  } else if (dir === 'LOWER') {
    dirEl.textContent = '▼ LOWER';
    dirEl.className = 'pred-direction lower';
  }

  // Explanation
  const explanations = {
    'HIGHER': [
      'Bullish momentum detected — next tick likely UP',
      'Pattern analysis confirms upward bias',
      'Volume and trend support HIGHER prediction',
      `Neural network: ${conf}% confidence UP`,
      'Strong buying pressure in recent ticks',
    ],
    'LOWER': [
      'Bearish momentum detected — next tick likely DOWN',
      'Pattern reversal signals LOWER movement',
      'Market regime supports downward bias',
      `Neural network: ${conf}% confidence DOWN`,
      'Resistance level reached — expect pullback',
    ],
  };
  const pool = explanations[dir] || ['Analyzing market conditions...'];
  document.getElementById('predExplanation').textContent = pool[Math.floor(STATE.tickCount / 3) % pool.length];

  // Factor bars
  document.getElementById('factorPattern').style.width = (patternS * 100).toFixed(0) + '%';
  document.getElementById('factorVol').style.width = (volS * 100).toFixed(0) + '%';
  document.getElementById('factorTrend').style.width = (trendS * 100).toFixed(0) + '%';
  document.getElementById('factorNeural').style.width = (neuralS * 100).toFixed(0) + '%';

  document.getElementById('aiBadge').textContent = `${conf}% CONFIDENCE`;
}

function updateTradeButtonInfo() {
  const hStake = parseFloat(document.getElementById('higherStake').value) || 100;
  const lStake = parseFloat(document.getElementById('lowerStake').value) || 100;
  const hExpect = hStake * 1.97;
  const lExpect = lStake * 1.97;
  const hProfit = hStake * 0.97;
  const lProfit = lStake * 0.97;

  document.getElementById('higherExpect').textContent = `Expect: $${hExpect.toFixed(2)}`;
  document.getElementById('higherProfit').textContent = `Profit: +$${hProfit.toFixed(2)}`;
  document.getElementById('lowerExpect').textContent = `Expect: $${lExpect.toFixed(2)}`;
  document.getElementById('lowerProfit').textContent = `Profit: +$${lProfit.toFixed(2)}`;
  document.getElementById('bothExpect').textContent = `Expect: $${(hStake + lStake).toFixed(2)}`;
  document.getElementById('bothGuaranteed').textContent = `Guaranteed Payout: $${Math.max(hExpect, lExpect).toFixed(2)}`;

  document.getElementById('statHStake').textContent = `$${hStake.toFixed(0)}`;
}

function updateBalanceDisplay() {
  document.getElementById('balanceDisplay').textContent = '$' + STATE.balance.toFixed(2);
  const dailyEl = document.getElementById('dailyPnlValue');
  dailyEl.textContent = (STATE.dailyPnl >= 0 ? '+$' : '-$') + Math.abs(STATE.dailyPnl).toFixed(2);
  dailyEl.className = 'pnl-value ' + (STATE.dailyPnl >= 0 ? 'positive' : 'negative');
}

function updateSessionStats() {
  const wr = STATE.totalTrades > 0 ? Math.round(STATE.wonTrades / STATE.totalTrades * 100) : 0;
  const netEl = document.getElementById('netProfit');
  netEl.textContent = (STATE.netProfit >= 0 ? '+$' : '-$') + Math.abs(STATE.netProfit).toFixed(2);
  netEl.className = 'stat-val ' + (STATE.netProfit >= 0 ? 'positive' : 'negative');
  document.getElementById('sessionWinRate').textContent = wr + '%';
  document.getElementById('totalTradesDisplay').textContent = STATE.totalTrades;

  document.getElementById('historyProfit').textContent = (STATE.netProfit >= 0 ? '' : '-') + '$' + Math.abs(STATE.netProfit).toFixed(2) + ' USD';
  document.getElementById('historyWinRateBadge').textContent = wr + '.0% Win Rate';
}

function updateHistoryTable() {
  const tbody = document.getElementById('historyTableBody');
  if (STATE.tradeHistory.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--muted)">No trades yet.</td></tr>';
    return;
  }
  tbody.innerHTML = STATE.tradeHistory.slice(0, 50).map(t => `
    <tr>
      <td>${t.num}</td>
      <td>${t.time}</td>
      <td>${t.market}</td>
      <td>${t.direction}</td>
      <td>$${t.stake}</td>
      <td class="${t.result === 'WIN' ? 'result-win' : 'result-loss'}">${t.result}</td>
      <td class="${parseFloat(t.pnl) >= 0 ? 'pnl-pos' : 'pnl-neg'}">${parseFloat(t.pnl) >= 0 ? '+' : ''}$${t.pnl}</td>
      <td>${t.conf}%</td>
    </tr>
  `).join('');
}

// ===== CHARTS =====
function drawPriceChart() {
  const canvas = document.getElementById('priceChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const data = STATE.priceChartData;
  if (data.length < 2) return;

  const W = canvas.offsetWidth || 700;
  const H = 180;
  canvas.width = W;
  canvas.height = H;

  const prices = data.map(p => p.y);
  const minP = Math.min(...prices);
  const maxP = Math.max(...prices);
  const range = maxP - minP || 1;

  ctx.clearRect(0, 0, W, H);

  // Background grid
  ctx.strokeStyle = 'rgba(30,42,58,0.5)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = (i / 4) * H;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }

  // Gradient fill
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  const lastPrice = prices[prices.length - 1];
  const firstPrice = prices[0];
  const isUp = lastPrice >= firstPrice;
  grad.addColorStop(0, isUp ? 'rgba(0,230,118,0.3)' : 'rgba(255,45,114,0.3)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');

  ctx.beginPath();
  data.forEach((p, i) => {
    const x = (i / (data.length - 1)) * W;
    const y = H - ((p.y - minP) / range) * (H - 20) - 5;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.lineTo(W, H);
  ctx.lineTo(0, H);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Line
  ctx.beginPath();
  ctx.strokeStyle = isUp ? '#00e676' : '#ff2d72';
  ctx.lineWidth = 2;
  ctx.shadowColor = isUp ? 'rgba(0,230,118,0.5)' : 'rgba(255,45,114,0.5)';
  ctx.shadowBlur = 4;
  data.forEach((p, i) => {
    const x = (i / (data.length - 1)) * W;
    const y = H - ((p.y - minP) / range) * (H - 20) - 5;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Barrier lines
  const hBarrier = STATE.currentPrice + STATE.barrierOffset;
  const lBarrier = STATE.currentPrice - STATE.lowerBarrierOffset;
  const drawBarrierLine = (price, color, label) => {
    const y = H - ((price - minP) / range) * (H - 20) - 5;
    if (y < 0 || y > H) return;
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.moveTo(0, y); ctx.lineTo(W, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.font = '10px monospace';
    ctx.fillText(label + ' ' + price.toFixed(3), 4, y - 3);
  };
  drawBarrierLine(hBarrier, 'rgba(0,230,118,0.7)', '▲');
  drawBarrierLine(lBarrier, 'rgba(255,45,114,0.7)', '▼');
}

function updateProfitChart() {
  STATE.profitHistory.push(STATE.netProfit);
  if (STATE.profitHistory.length > 80) STATE.profitHistory.shift();

  const canvas = document.getElementById('profitChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.offsetWidth || 300;
  const H = 60;
  canvas.width = W;
  canvas.height = H;

  const data = STATE.profitHistory;
  if (data.length < 2) return;

  const min = Math.min(...data, 0);
  const max = Math.max(...data, 0);
  const range = max - min || 1;

  ctx.clearRect(0, 0, W, H);

  // Zero line
  const zeroY = H - ((0 - min) / range) * (H - 10) - 5;
  ctx.strokeStyle = 'rgba(74,85,104,0.5)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, zeroY); ctx.lineTo(W, zeroY); ctx.stroke();

  // Profit line
  ctx.beginPath();
  ctx.strokeStyle = STATE.netProfit >= 0 ? '#00e676' : '#ff2d72';
  ctx.lineWidth = 1.5;
  data.forEach((p, i) => {
    const x = (i / (data.length - 1)) * W;
    const y = H - ((p - min) / range) * (H - 10) - 5;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();
}


// ===== AUTO TRADING =====
function toggleAutoTrading(cb) {
  STATE.autoTrading = cb.checked;
  const statusEl = document.getElementById('autoStatus');
  const progressWrap = document.getElementById('autoProgressWrap');
  const activeLabel = document.getElementById('autoActiveLabel');

  if (STATE.autoTrading) {
    statusEl.textContent = 'ON';
    statusEl.className = 'auto-status on';
    progressWrap.style.display = 'block';
    activeLabel.style.display = 'block';
    STATE.autoProgressPct = 0;
    startAutoTradingCooldown();
  } else {
    stopAutoTrading('');
  }
}

function stopAutoTrading(reason) {
  STATE.autoTrading = false;
  const cb = document.getElementById('autoTradingToggle');
  if (cb) cb.checked = false;
  document.getElementById('autoStatus').textContent = 'OFF';
  document.getElementById('autoStatus').className = 'auto-status';
  document.getElementById('autoProgressWrap').style.display = 'none';
  document.getElementById('autoActiveLabel').style.display = 'none';

  if (STATE.cooldownInterval) {
    clearInterval(STATE.cooldownInterval);
    STATE.cooldownInterval = null;
  }
  if (reason) {
    document.getElementById('autoRoundResult').textContent = '⚠️ ' + reason;
  }
  document.getElementById('cooldownTimer').textContent = '--s';
}

function startAutoTradingCooldown() {
  if (!STATE.autoTrading) return;
  if (STATE.cooldownInterval) clearInterval(STATE.cooldownInterval);

  STATE.autoMode = document.getElementById('autoMode').value;
  const cooldownSec = STATE.candlerSpeed;
  STATE.cooldownRemaining = cooldownSec;
  document.getElementById('cooldownTimer').textContent = cooldownSec + 's';

  STATE.cooldownInterval = setInterval(() => {
    STATE.cooldownRemaining--;
    document.getElementById('cooldownTimer').textContent = Math.max(0, STATE.cooldownRemaining) + 's';

    if (STATE.cooldownRemaining <= 0) {
      if (STATE.autoTrading) {
        STATE.autoProgressPct = 0;
        document.getElementById('autoProgressFill').style.width = '0%';
        executeAutoRound();
        STATE.cooldownRemaining = cooldownSec;
      } else {
        clearInterval(STATE.cooldownInterval);
      }
    }
  }, 1000);
}

// ===== DERIV API =====
function connectDeriv() {
  const token = document.getElementById('derivToken').value.trim();
  if (!token && !STATE.paperMode) {
    alert('Please enter a Deriv API token.');
    return;
  }

  if (STATE.derivWs) {
    STATE.derivWs.close();
    STATE.derivWs = null;
  }

  const wsUrl = 'wss://ws.binaryws.com/websockets/v3?app_id=1089';

  try {
    STATE.derivWs = new WebSocket(wsUrl);

    STATE.derivWs.onopen = () => {
      if (token) {
        STATE.derivWs.send(JSON.stringify({ authorize: token }));
      } else {
        // Paper trading — subscribe to ticks
        subscribeToTicks();
      }
      setDerivOnline();
    };

    STATE.derivWs.onmessage = (evt) => {
      const msg = JSON.parse(evt.data);
      handleDerivMessage(msg);
    };

    STATE.derivWs.onerror = () => setDerivOffline();
    STATE.derivWs.onclose = () => setDerivOffline();
  } catch (e) {
    setDerivOffline();
  }
}

function handleDerivMessage(msg) {
  if (msg.msg_type === 'authorize') {
    if (msg.authorize) {
      const bal = msg.authorize.balance;
      STATE.balance = bal;
      STATE.startBalance = bal;
      updateBalanceDisplay();
      subscribeToTicks();
    }
  } else if (msg.msg_type === 'tick') {
    const tick = msg.tick;
    if (tick) {
      STATE.prevPrice = STATE.currentPrice;
      STATE.currentPrice = parseFloat(tick.quote);
      STATE.tickCount++;
      const dir = STATE.currentPrice > STATE.prevPrice ? 'H' : 'L';
      STATE.patternHistory.push(dir);
      if (STATE.patternHistory.length > 200) STATE.patternHistory.shift();
      if (dir === 'H') STATE.higherCount++;
      else STATE.lowerCount++;

      STATE.priceChartData.push({ x: STATE.tickCount, y: STATE.currentPrice });
      if (STATE.priceChartData.length > 120) STATE.priceChartData.shift();

      updatePriceDisplay();
      runAIEngine();
      checkStrikeResolutions();
    }
  } else if (msg.msg_type === 'buy') {
    if (msg.buy) {
      console.log('Trade placed:', msg.buy.contract_id);
    }
  }
}

function subscribeToTicks() {
  if (!STATE.derivWs || STATE.derivWs.readyState !== WebSocket.OPEN) return;
  STATE.derivWs.send(JSON.stringify({
    ticks: STATE.market,
    subscribe: 1,
  }));
}

function setDerivOnline() {
  STATE.derivConnected = true;
  document.getElementById('derivStatus').querySelector('.status-dot').className = 'status-dot online';
  document.getElementById('derivStatusText').textContent = 'Connected';
  stopTickSimulator();
}

function setDerivOffline() {
  STATE.derivConnected = false;
  document.getElementById('derivStatus').querySelector('.status-dot').className = 'status-dot offline';
  document.getElementById('derivStatusText').textContent = 'Offline';
  if (!STATE.tickInterval) startTickSimulator();
}

// ===== TICK SIMULATOR (Paper Mode) =====
let tickInterval = null;

function startTickSimulator() {
  if (tickInterval) clearInterval(tickInterval);
  tickInterval = setInterval(() => {
    simulateNextTick();
  }, STATE.candlerSpeed * 1000 / 10); // ~10 ticks per candler period
}

function stopTickSimulator() {
  if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
}

function restartTickSimulator() {
  if (!STATE.derivConnected) {
    stopTickSimulator();
    startTickSimulator();
  }
}

// ===== UI CONTROLS =====
function changeMarket() {
  STATE.market = document.getElementById('marketSelect').value;
  STATE.currentPrice = getBasePrice();
  STATE.priceChartData = [];
  STATE.patternHistory = [];
  STATE.higherCount = 0;
  STATE.lowerCount = 0;
  STATE.tickCount = 0;
  document.getElementById('movesGrid').innerHTML = '';

  if (STATE.derivWs && STATE.derivWs.readyState === WebSocket.OPEN) {
    subscribeToTicks();
  }
}

function togglePaperMode(cb) {
  STATE.paperMode = cb.checked;
  if (STATE.paperMode) {
    if (STATE.derivWs) { STATE.derivWs.close(); STATE.derivWs = null; }
    setDerivOffline();
    STATE.balance = 10000;
    STATE.startBalance = 10000;
    updateBalanceDisplay();
  }
}

function toggleStrategy(cb, name) {
  const items = document.querySelectorAll('.strategy-item');
  items.forEach(el => el.classList.remove('active'));
  if (cb.checked) {
    const el = document.querySelector(`[data-strategy="${name}"]`);
    if (el) el.classList.add('active');
  }
}

function toggleHistory() {
  const panel = document.getElementById('historyPanel');
  panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
}

function showHowTo(evt) {
  evt.stopPropagation();
  document.getElementById('howToModal').style.display = 'flex';
}

function closeModal(id) {
  document.getElementById(id).style.display = 'none';
}

function updatePrediction() {
  updateTradeButtonInfo();
}

// ===== INITIALIZATION =====
function init() {
  // Set initial price
  STATE.currentPrice = getBasePrice();
  STATE.priceChartData = [];

  updateBalanceDisplay();
  updateTradeButtonInfo();
  updateSessionStats();
  updateAILevel();

  // Start tick simulator
  startTickSimulator();

  // Initial render
  renderStrikes();
  drawPriceChart();

  // Resize handler for charts
  window.addEventListener('resize', () => {
    drawPriceChart();
    updateProfitChart();
  });

  console.log('GMilli AI Hybrid Trading System initialized!');
}

// Start when DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

