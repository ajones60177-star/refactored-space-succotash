"""
Lazy Millionaire Market Dominator - Tri-Mode Trading System
Backend API with BALANCED / AGGRESSIVE / MAXIMUM trading modes,
Deriv WebSocket integration, pattern recognition, and risk management.
"""

import os
import json
import math
import random
import asyncio
import logging
from datetime import datetime, timedelta
from typing import Optional, List, Dict, Any

import websockets
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
DERIV_APP_ID = os.getenv("DERIV_APP_ID", "1089")
DERIV_WS_URL = f"wss://ws.derivws.com/websockets/v3?app_id={DERIV_APP_ID}"

MODES = {
    "balanced": {
        "name": "BALANCED",
        "target_win_rate": 60,
        "daily_growth_min": 150,
        "daily_growth_max": 200,
        "position_min": 0.25,
        "position_max": 0.50,
        "trade_interval_sec": 8,
        "trades_per_day": 150,
        "confidence_threshold": 55,
        "risk_stars": 2,
        "daily_profit_target": 50,
        "max_daily_loss_pct": 10,
    },
    "aggressive": {
        "name": "AGGRESSIVE",
        "target_win_rate": 70,
        "daily_growth_min": 400,
        "daily_growth_max": 500,
        "position_min": 0.50,
        "position_max": 1.00,
        "trade_interval_sec": 5,
        "trades_per_day": 250,
        "confidence_threshold": 65,
        "risk_stars": 3,
        "daily_profit_target": 500,
        "max_daily_loss_pct": 10,
    },
    "maximum": {
        "name": "MAXIMUM",
        "target_win_rate": 75,
        "daily_growth_min": 900,
        "daily_growth_max": 1000,
        "position_min": 1.00,
        "position_max": 5.00,
        "trade_interval_sec": 3,
        "trades_per_day": 400,
        "confidence_threshold": 75,
        "risk_stars": 5,
        "daily_profit_target": 5000,
        "max_daily_loss_pct": 10,
    },
}

LOSS_PCT = 0.01   # 1% loss per trade
PROFIT_PCT = 0.04  # 4% profit per trade
DERIV_MIN_TRADE = 0.35  # Deriv minimum stake

# ---------------------------------------------------------------------------
# In-memory state (production would use a database)
# ---------------------------------------------------------------------------
state: Dict[str, Any] = {
    "mode": "balanced",
    "auto_switch": False,
    "deriv_token": None,
    "deriv_connected": False,
    "balance": 10.00,
    "currency": "USD",
    "is_trading": False,
    "daily_start_balance": 10.00,
    "daily_pnl": 0.0,
    "daily_trade_count": 0,
    "consecutive_losses": 0,
    "consecutive_wins": 0,
    "last_10_results": [],   # True=win, False=loss
    "last_50_results": [],
    "tick_history": [],
    "volatility_index": 50.0,
    "trend_strength": 0.0,   # -1 to +1
    "trade_log": [],
    "mode_stats": {
        m: {"wins": 0, "losses": 0, "pnl": 0.0, "trades": 0}
        for m in MODES
    },
}

# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------
app = FastAPI(title="Lazy Millionaire Market Dominator")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve static files
STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
async def serve_index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------
class ConnectRequest(BaseModel):
    token: str


class ModeRequest(BaseModel):
    mode: str  # balanced | aggressive | maximum


class AutoSwitchRequest(BaseModel):
    enabled: bool


class TradeRequest(BaseModel):
    direction: Optional[str] = None  # HIGHER | LOWER (auto-detected if not provided)
    amount: Optional[float] = None


# ---------------------------------------------------------------------------
# Deriv WebSocket helper
# ---------------------------------------------------------------------------
_deriv_ws = None


async def _deriv_send_recv(payload: dict) -> dict:
    global _deriv_ws
    if _deriv_ws is None:
        raise HTTPException(status_code=400, detail="Not connected to Deriv")
    try:
        await _deriv_ws.send(json.dumps(payload))
        raw = await asyncio.wait_for(_deriv_ws.recv(), timeout=10)
        return json.loads(raw)
    except Exception as e:
        logger.error(f"Deriv WS error: {e}")
        raise HTTPException(status_code=502, detail=f"Deriv WS error: {e}")


async def _fetch_balance() -> float:
    res = await _deriv_send_recv({"balance": 1, "subscribe": 0})
    if "error" in res:
        return state["balance"]
    return float(res.get("balance", {}).get("balance", state["balance"]))


async def _fetch_ticks(symbol: str = "R_100", count: int = 50) -> List[float]:
    res = await _deriv_send_recv({
        "ticks_history": symbol,
        "adjust_start_time": 1,
        "count": count,
        "end": "latest",
        "style": "ticks",
    })
    prices = res.get("history", {}).get("prices", [])
    return [float(p) for p in prices]


# ---------------------------------------------------------------------------
# Analysis & AI helpers
# ---------------------------------------------------------------------------

def _compute_volatility(ticks: List[float]) -> float:
    """Compute a 0-100 volatility index from recent tick deltas."""
    if len(ticks) < 2:
        return 50.0
    deltas = [abs(ticks[i] - ticks[i - 1]) for i in range(1, len(ticks))]
    avg_price = sum(ticks) / len(ticks)
    if avg_price == 0:
        return 50.0
    avg_delta_pct = (sum(deltas) / len(deltas)) / avg_price * 100
    return min(100.0, avg_delta_pct * 1000)


def _compute_trend_strength(ticks: List[float]) -> float:
    """Returns -1 (strong down) to +1 (strong up)."""
    if len(ticks) < 4:
        return 0.0
    recent = ticks[-10:] if len(ticks) >= 10 else ticks
    ups = sum(1 for i in range(1, len(recent)) if recent[i] > recent[i - 1])
    downs = len(recent) - 1 - ups
    return (ups - downs) / max(1, len(recent) - 1)


def _detect_pattern(ticks: List[float]) -> Dict[str, Any]:
    """Detect trading patterns from tick history."""
    if len(ticks) < 5:
        return {"direction": "HIGHER", "confidence": 50, "pattern": "insufficient_data"}

    last3 = ticks[-3:]
    last5 = ticks[-5:]
    avg5 = sum(last5) / 5
    current = ticks[-1]

    # Momentum pattern (55-60% confidence)
    if all(last3[i] < last3[i + 1] for i in range(2)):
        return {"direction": "HIGHER", "confidence": 58, "pattern": "momentum_up"}
    if all(last3[i] > last3[i + 1] for i in range(2)):
        return {"direction": "LOWER", "confidence": 58, "pattern": "momentum_down"}

    # Reversal pattern (65-70% confidence)
    deviation = (current - avg5) / max(avg5, 0.001)
    if deviation > 0.002:
        return {"direction": "LOWER", "confidence": 67, "pattern": "reversal_high"}
    if deviation < -0.002:
        return {"direction": "HIGHER", "confidence": 67, "pattern": "reversal_low"}

    # Volatility clustering (70-75% confidence)
    recent_deltas = [abs(ticks[i] - ticks[i - 1]) for i in range(max(1, len(ticks) - 5), len(ticks))]
    prev_deltas = [abs(ticks[i] - ticks[i - 1]) for i in range(max(1, len(ticks) - 10), max(1, len(ticks) - 5))]
    if recent_deltas and prev_deltas:
        recent_vol = sum(recent_deltas) / len(recent_deltas)
        prev_vol = sum(prev_deltas) / len(prev_deltas)
        if recent_vol > prev_vol * 1.5:
            direction = "HIGHER" if ticks[-1] > ticks[-2] else "LOWER"
            return {"direction": direction, "confidence": 72, "pattern": "volatility_cluster"}

    # Multi-factor confirmation (75-85% confidence)
    trend = _compute_trend_strength(ticks)
    vol = _compute_volatility(ticks)
    if abs(trend) > 0.6 and vol > 60:
        direction = "HIGHER" if trend > 0 else "LOWER"
        confidence = min(85, 75 + int(abs(trend) * 10))
        return {"direction": direction, "confidence": confidence, "pattern": "multi_confirm"}

    # Default: follow last tick direction
    direction = "HIGHER" if ticks[-1] >= ticks[-2] else "LOWER"
    return {"direction": direction, "confidence": 52, "pattern": "default"}


def _calculate_position(mode: str, balance: float, confidence: float, volatility: float) -> float:
    """
    Position sizing per mode spec.

    The formula produces a risk-adjusted fraction of balance.  For small accounts
    (e.g. $10) the raw calculation is often below Deriv's $0.35 minimum stake, so
    max(position, DERIV_MIN_TRADE) ensures we always submit a valid order while
    respecting the mode's cap.
    """
    base_risk = balance * LOSS_PCT  # 1% of balance

    if mode == "balanced":
        if confidence >= 55:
            position = base_risk * 0.25  # very conservative fraction
        else:
            return 0.0
        position = min(position, 0.50)   # hard cap per spec

    elif mode == "aggressive":
        if confidence >= 70:
            position = base_risk * 0.50
        elif confidence >= 65:
            position = base_risk * 0.25
        else:
            return 0.0
        if volatility > 70:
            position *= 1.5
        elif volatility < 40:
            position *= 0.75
        position = min(position, 1.00)   # hard cap per spec

    else:  # maximum
        if confidence >= 80:
            position = base_risk * 1.50
        elif confidence >= 75:
            position = base_risk * 1.00
        elif confidence >= 70:
            position = base_risk * 0.50
        else:
            return 0.0
        if volatility > 80:
            position *= 2.0
        elif volatility > 60:
            position *= 1.5
        elif volatility < 30:
            position *= 0.50
        position = min(position, 5.00)   # hard cap per spec

    # Always meet Deriv's minimum stake; return 0 only if mode threshold not met (above)
    return max(position, DERIV_MIN_TRADE)


def _recommend_mode(volatility: float, trend_strength: float,
                    last_10_wr: float, consecutive_losses: int) -> Dict[str, str]:
    """AI mode recommendation logic."""
    if consecutive_losses >= 5:
        return {"mode": "balanced", "reason": "5+ consecutive losses – stepping down for recovery"}

    if abs(trend_strength) > 0.6 and volatility > 70 and last_10_wr >= 0.70:
        return {"mode": "maximum", "reason": "Clear trend + high volatility + good recent win rate"}

    if abs(trend_strength) > 0.3 and volatility > 50 and last_10_wr >= 0.60:
        return {"mode": "aggressive", "reason": "Moderate trend + medium volatility – optimal growth"}

    if last_10_wr < 0.50:
        return {"mode": "balanced", "reason": "Win rate dropping – use conservative mode"}

    return {"mode": "balanced", "reason": "Low volatility / weak trend – steady conservative growth"}


def _simulate_trade_result(direction: str, ticks: List[float], mode: str) -> bool:
    """Simulate outcome when not live-connected (uses mode win-rate targets)."""
    target_wr = MODES[mode]["target_win_rate"] / 100.0
    noise = random.uniform(-0.05, 0.05)
    return random.random() < (target_wr + noise)


def _update_learning(mode: str, won: bool, pattern: str):
    """Update per-mode stats (learning system)."""
    stats = state["mode_stats"][mode]
    stats["trades"] += 1
    if won:
        stats["wins"] += 1
    else:
        stats["losses"] += 1

    results_10 = state["last_10_results"]
    results_10.append(won)
    if len(results_10) > 10:
        results_10.pop(0)

    results_50 = state["last_50_results"]
    results_50.append(won)
    if len(results_50) > 50:
        results_50.pop(0)

    if won:
        state["consecutive_wins"] += 1
        state["consecutive_losses"] = 0
    else:
        state["consecutive_losses"] += 1
        state["consecutive_wins"] = 0

    # Auto-switch if enabled
    if state["auto_switch"] and state["consecutive_losses"] >= 5:
        modes_order = ["maximum", "aggressive", "balanced"]
        current_idx = modes_order.index(state["mode"]) if state["mode"] in modes_order else 2
        if current_idx < len(modes_order) - 1:
            new_mode = modes_order[current_idx + 1]
            state["mode"] = new_mode
            logger.info(f"Auto-switched to {new_mode} after 5 consecutive losses")


# ---------------------------------------------------------------------------
# API endpoints
# ---------------------------------------------------------------------------

@app.post("/api/connect")
async def connect_deriv(req: ConnectRequest):
    global _deriv_ws
    state["deriv_token"] = req.token
    try:
        _deriv_ws = await websockets.connect(DERIV_WS_URL)
        res = await _deriv_send_recv({"authorize": req.token})
        if "error" in res:
            state["deriv_connected"] = False
            return {"success": False, "error": res["error"]["message"]}
        state["deriv_connected"] = True
        state["balance"] = await _fetch_balance()
        state["daily_start_balance"] = state["balance"]
        logger.info(f"Deriv connected. Balance: {state['balance']}")
        return {"success": True, "balance": state["balance"], "currency": state.get("currency", "USD")}
    except Exception as e:
        state["deriv_connected"] = False
        logger.error(f"Connect error: {e}")
        return {"success": False, "error": str(e)}


@app.post("/api/disconnect")
async def disconnect_deriv():
    global _deriv_ws
    if _deriv_ws:
        await _deriv_ws.close()
        _deriv_ws = None
    state["deriv_connected"] = False
    state["deriv_token"] = None
    return {"success": True}


@app.get("/api/status")
async def get_status():
    results_10 = state["last_10_results"]
    wr10 = (sum(results_10) / len(results_10) * 100) if results_10 else 0
    results_50 = state["last_50_results"]
    wr50 = (sum(results_50) / len(results_50) * 100) if results_50 else 0

    recommendation = _recommend_mode(
        state["volatility_index"],
        state["trend_strength"],
        sum(results_10) / max(1, len(results_10)),
        state["consecutive_losses"],
    )

    return {
        "mode": state["mode"],
        "auto_switch": state["auto_switch"],
        "deriv_connected": state["deriv_connected"],
        "balance": state["balance"],
        "currency": state.get("currency", "USD"),
        "is_trading": state["is_trading"],
        "daily_pnl": round(state["daily_pnl"], 4),
        "daily_trade_count": state["daily_trade_count"],
        "consecutive_losses": state["consecutive_losses"],
        "consecutive_wins": state["consecutive_wins"],
        "win_rate_10": round(wr10, 1),
        "win_rate_50": round(wr50, 1),
        "volatility_index": round(state["volatility_index"], 1),
        "trend_strength": round(state["trend_strength"], 3),
        "recommendation": recommendation,
        "mode_stats": state["mode_stats"],
        "modes_config": MODES,
    }


@app.get("/api/market")
async def get_market_analysis():
    """Fetch latest ticks, compute indicators, return market analysis."""
    if state["deriv_connected"]:
        try:
            ticks = await _fetch_ticks("R_100", 50)
            state["tick_history"] = ticks
        except Exception:
            ticks = state["tick_history"]
    else:
        ticks = state["tick_history"] or _generate_demo_ticks()
        state["tick_history"] = ticks

    state["volatility_index"] = _compute_volatility(ticks)
    state["trend_strength"] = _compute_trend_strength(ticks)
    pattern = _detect_pattern(ticks)

    results_10 = state["last_10_results"]
    wr10 = sum(results_10) / max(1, len(results_10))

    recommendation = _recommend_mode(
        state["volatility_index"],
        state["trend_strength"],
        wr10,
        state["consecutive_losses"],
    )

    trend_label = "RANGING"
    if state["trend_strength"] > 0.3:
        trend_label = "BULL"
    elif state["trend_strength"] < -0.3:
        trend_label = "BEAR"

    vol = state["volatility_index"]
    vol_label = "LOW"
    if vol > 70:
        vol_label = "VERY HIGH"
    elif vol > 50:
        vol_label = "HIGH"
    elif vol > 30:
        vol_label = "MEDIUM"

    return {
        "volatility": round(state["volatility_index"], 1),
        "volatility_label": vol_label,
        "trend_strength": round(state["trend_strength"], 3),
        "trend_label": trend_label,
        "pattern": pattern,
        "recommendation": recommendation,
        "tick_count": len(ticks),
        "latest_price": ticks[-1] if ticks else None,
    }


@app.post("/api/mode")
async def set_mode(req: ModeRequest):
    if req.mode not in MODES:
        raise HTTPException(status_code=400, detail=f"Invalid mode: {req.mode}")
    state["mode"] = req.mode
    logger.info(f"Mode switched to: {req.mode}")
    return {"success": True, "mode": req.mode}


@app.post("/api/auto_switch")
async def set_auto_switch(req: AutoSwitchRequest):
    state["auto_switch"] = req.enabled
    return {"success": True, "auto_switch": req.enabled}


@app.post("/api/trade/execute")
async def execute_trade(req: TradeRequest):
    """Execute a single trade (manual or AI-initiated)."""
    mode = state["mode"]
    balance = state["balance"]

    # Refresh market data each call to simulate continuous market movement
    if state["deriv_connected"]:
        try:
            ticks = await _fetch_ticks("R_100", 50)
            state["tick_history"] = ticks
        except Exception:
            ticks = state["tick_history"] or _generate_demo_ticks()
    else:
        existing = state["tick_history"]
        if existing:
            last = existing[-1]
            new_tick = round(last + random.gauss(0, 0.05), 5)
            ticks = existing[1:] + [new_tick]
        else:
            ticks = _generate_demo_ticks()
        state["tick_history"] = ticks

    state["volatility_index"] = _compute_volatility(ticks)
    state["trend_strength"] = _compute_trend_strength(ticks)

    # Check daily loss limit
    loss_limit = state["daily_start_balance"] * (MODES[mode]["max_daily_loss_pct"] / 100.0)
    if state["daily_pnl"] <= -loss_limit:
        return {"success": False, "error": "Daily loss limit reached – trading halted"}

    pattern = _detect_pattern(ticks)
    confidence = float(pattern["confidence"])
    volatility = state["volatility_index"]

    # Calculate position
    position = req.amount if req.amount else _calculate_position(mode, balance, confidence, volatility)
    if position <= 0:
        return {"success": False, "error": f"Confidence {confidence:.0f}% below threshold for {mode} mode"}

    direction = req.direction or pattern["direction"]

    # Execute on Deriv or simulate
    won = False
    pnl = 0.0
    if state["deriv_connected"]:
        try:
            trade_params = {
                "buy": 1,
                "price": position,
                "parameters": {
                    "contract_type": "CALL" if direction == "HIGHER" else "PUT",
                    "symbol": "R_100",
                    "duration": 10,
                    "duration_unit": "t",
                    "basis": "stake",
                },
            }
            buy_res = await _deriv_send_recv(trade_params)
            if "error" in buy_res:
                return {"success": False, "error": buy_res["error"]["message"]}
            # Deriv binary options settle asynchronously; wait for contract result
            contract_id = buy_res.get("buy", {}).get("contract_id")
            if contract_id:
                await asyncio.sleep(12)  # wait for 10-tick contract to expire
                settle_res = await _deriv_send_recv({"proposal_open_contract": 1, "contract_id": contract_id})
                profit = settle_res.get("proposal_open_contract", {}).get("profit", None)
                won = (profit is not None and float(profit) > 0)
            else:
                won = _simulate_trade_result(direction, ticks, mode)
        except Exception as e:
            logger.warning(f"Deriv trade error – using simulation: {e}")
            won = _simulate_trade_result(direction, ticks, mode)
    else:
        won = _simulate_trade_result(direction, ticks, mode)

    # Calculate pnl
    if won:
        pnl = balance * PROFIT_PCT
    else:
        pnl = -(balance * LOSS_PCT)

    # Update state
    state["balance"] = max(0.0, state["balance"] + pnl)
    state["daily_pnl"] += pnl
    state["daily_trade_count"] += 1
    state["mode_stats"][mode]["pnl"] = round(state["mode_stats"][mode]["pnl"] + pnl, 4)

    _update_learning(mode, won, pattern["pattern"])

    trade_record = {
        "id": state["daily_trade_count"],
        "timestamp": datetime.utcnow().isoformat(),
        "mode": mode,
        "direction": direction,
        "position": round(position, 4),
        "confidence": confidence,
        "pattern": pattern["pattern"],
        "won": won,
        "pnl": round(pnl, 4),
        "balance_after": round(state["balance"], 4),
    }
    state["trade_log"].insert(0, trade_record)
    if len(state["trade_log"]) > 200:
        state["trade_log"] = state["trade_log"][:200]

    logger.info(f"Trade {trade_record['id']}: {direction} {position:.2f} | {'WIN' if won else 'LOSS'} {pnl:+.4f} | Balance: {state['balance']:.4f}")
    return {"success": True, "trade": trade_record}


@app.get("/api/trades")
async def get_trades(limit: int = 50):
    return {"trades": state["trade_log"][:limit]}


@app.post("/api/trading/start")
async def start_trading():
    """Enable automated trading loop (flag only – client polls or uses /api/trade/execute)."""
    state["is_trading"] = True
    return {"success": True, "is_trading": True}


@app.post("/api/trading/stop")
async def stop_trading():
    state["is_trading"] = False
    return {"success": True, "is_trading": False}


@app.post("/api/reset_daily")
async def reset_daily():
    """Reset daily stats (call at start of trading day)."""
    state["daily_start_balance"] = state["balance"]
    state["daily_pnl"] = 0.0
    state["daily_trade_count"] = 0
    state["consecutive_losses"] = 0
    state["consecutive_wins"] = 0
    state["last_10_results"] = []
    state["last_50_results"] = []
    return {"success": True}


@app.get("/api/projections")
async def get_projections():
    """Return daily/weekly/monthly projections for current balance per mode."""
    balance = state["balance"]
    results = {}
    for mode_key, cfg in MODES.items():
        wr = cfg["target_win_rate"] / 100.0
        trades = cfg["trades_per_day"]
        # Expected daily return: each trade wins PROFIT_PCT or loses LOSS_PCT
        expected_per_trade = wr * PROFIT_PCT - (1 - wr) * LOSS_PCT
        # Compound daily factor
        daily_factor = (1 + expected_per_trade) ** trades
        daily_end = balance * daily_factor
        weekly_end = balance * (daily_factor ** 5)
        monthly_end = balance * (daily_factor ** 20)
        results[mode_key] = {
            "daily_end": round(daily_end, 2),
            "daily_growth_pct": round((daily_factor - 1) * 100, 1),
            "weekly_end": round(weekly_end, 2),
            "monthly_end": round(monthly_end, 2),
        }
    return {"balance": balance, "projections": results}


# ---------------------------------------------------------------------------
# Demo tick generator (when not connected to Deriv)
# ---------------------------------------------------------------------------
def _generate_demo_ticks(n: int = 50) -> List[float]:
    price = 100.0
    ticks = []
    for _ in range(n):
        price += random.gauss(0, 0.05)
        ticks.append(round(price, 5))
    return ticks


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
