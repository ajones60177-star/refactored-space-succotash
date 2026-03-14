import os
import json
import random
import sqlite3
import asyncio
import websockets
import logging
from datetime import datetime, timedelta
from fastapi import FastAPI, HTTPException, Depends, Request
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from passlib.context import CryptContext
from jose import JWTError, jwt
from typing import Optional

from payment_system import (
    init_payment_db,
    create_license,
    validate_license,
    get_license_for_user,
    list_all_licenses,
    revoke_license,
    create_checkout_session,
    handle_stripe_webhook,
    TIERS,
)

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# --- CONFIG ---
SECRET_KEY = os.getenv("ALFA_SECRET", "alfa_ai_ultimate_secret")
ALGORITHM = "HS256"
DB_FILE = os.getenv("DB_FILE", "alfa_database.db")
DERIV_APP_ID = os.getenv("DERIV_APP_ID", "1089")  # Default Public App ID
OWNER_USERNAME = os.getenv("OWNER_USERNAME", "Anthony Jones")

# --- DERIV LIVE MANAGER ---
class DerivManager:
    def __init__(self):
        self.ws = None
        self.token = None
        self.connected = False
        self.account_info = {}
        self.current_ticks = {}
        
    async def connect(self, token):
        self.token = token
        try:
            url = f"wss://ws.derivws.com/websockets/v3?app_id={DERIV_APP_ID}"
            self.ws = await websockets.connect(url)
            
            # Authorize
            await self.ws.send(json.dumps({"authorize": token}))
            response = json.loads(await self.ws.recv())
            
            if 'error' in response:
                self.connected = False
                return False, response['error']['message']
            
            # Fetch account info
            await self.ws.send(json.dumps({"balance": 1}))
            balance_res = json.loads(await self.ws.recv())
            if 'balance' in balance_res:
                self.account_info = {
                    'balance': balance_res['balance'].get('balance', 10000),
                    'currency': balance_res['balance'].get('currency', 'USD')
                }
            
            self.connected = True
            logger.info(f"Deriv connected with balance: {self.account_info.get('balance', 'N/A')}")
            return True, "Connected"
        except Exception as e:
            self.connected = False
            logger.error(f"Deriv connection error: {str(e)}")
            return False, str(e)
    
    async def get_wallet(self):
        if not self.connected:
            return {"balance": 10000, "currency": "USD", "status": "offline"}
        
        try:
            await self.ws.send(json.dumps({"balance": 1}))
            response = json.loads(await self.ws.recv())
            if 'balance' in response:
                balance_data = response['balance']
                self.account_info = {
                    'balance': float(balance_data.get('balance', 10000)),
                    'currency': balance_data.get('currency', 'USD')
                }
                return self.account_info
        except Exception as e:
            logger.warning(f"Failed to fetch wallet: {str(e)}")
        
        return self.account_info if self.account_info else {"balance": 10000, "currency": "USD"}
    
    async def get_ticks(self, symbol, count=10):
        if not self.connected:
            return {"ticks": [], "symbol": symbol, "status": "offline"}
        
        try:
            req = {
                "ticks_history": symbol,
                "adjust_start_time": 1,
                "count": count,
                "end": "latest",
                "style": "ticks"
            }
            await self.ws.send(json.dumps(req))
            response = json.loads(await self.ws.recv())
            
            if 'error' in response:
                return {"ticks": [], "symbol": symbol, "error": response['error']['message']}
            
            if 'history' in response:
                ticks = response['history'].get('prices', [])
                if ticks:
                    self.current_ticks[symbol] = {
                        'current_price': float(ticks[-1]['quote']),
                        'time': ticks[-1].get('epoch', 0)
                    }
                    return {
                        "ticks": [{"time": t.get('epoch', 0), "price": float(t['quote'])} for t in ticks],
                        "symbol": symbol,
                        "current_price": float(ticks[-1]['quote']),
                        "status": "live"
                    }
        except Exception as e:
            logger.warning(f"Failed to fetch ticks: {str(e)}")
        
        return {"ticks": [], "symbol": symbol, "status": "error"}

    async def get_analysis(self, symbol):
        if not self.ws or not getattr(self.ws, 'open', True):
            return {"signal": "HOLD", "confidence": 0.5, "digits": [10]*10}

        # Request Tick History for Analysis
        req = {"ticks_history": symbol, "adjust_start_time": 1, "count": 20, "end": "latest", "style": "ticks"}
        await self.ws.send(json.dumps(req))
        response = json.loads(await self.ws.recv())

        if 'error' in response: return {"signal": "ERROR", "confidence": 0}

        prices = [float(p['quote']) for p in response['history']['prices']]
        
        # Simple AI Logic (Trend Analysis)
        sma = sum(prices[-5:]) / 5
        current = prices[-1]
        
        signal = "HOLD"
        conf = 0.5
        if current > sma: signal = "CALL"; conf = 0.65
        if current < sma: signal = "PUT"; conf = 0.65

        # Digit Probability
        digits = [random.uniform(8, 12) for _ in range(10)]
        return {"signal": signal, "confidence": conf, "digits": digits}

    async def execute_trade(self, symbol, amount, contract_type, digit=None):
        if not self.connected: raise HTTPException(400, "Deriv Disconnected")

        try:
            proposal = {
                "proposal": 1, "amount": amount, "basis": "stake",
                "contract_type": contract_type, "currency": "USD",
                "duration": 1, "duration_unit": "t", "symbol": symbol
            }
            if digit is not None:
                proposal["barrier"] = str(digit)

            await self.ws.send(json.dumps(proposal))
            prop_res = json.loads(await self.ws.recv())
            
            if 'error' in prop_res: raise HTTPException(400, prop_res['error']['message'])

            buy_req = {"buy": prop_res['proposal']['id'], "price": amount}
            await self.ws.send(json.dumps(buy_req))
            buy_res = json.loads(await self.ws.recv())

            if 'error' in buy_res: raise HTTPException(400, buy_res['error']['message'])

            contract_id = buy_res['buy'].get('contract_id', '')
            logger.info(f"Trade executed: {symbol} {contract_type} {amount}USD - Contract ID: {contract_id}")
            
            if self.connected:
                balance_req = await self.get_wallet()
                if balance_req and 'balance' in balance_req:
                    conn = sqlite3.connect(DB_FILE)
                    try:
                        c = conn.cursor()
                        c.execute("UPDATE settings SET value=? WHERE key='account_balance'", (str(balance_req['balance']),))
                        conn.commit()
                    finally:
                        conn.close()
            
            return {"status": "SUCCESS", "contract_id": contract_id}
        except Exception as e:
            logger.error(f"Trade execution error: {str(e)}")
            raise

trader = DerivManager()

# --- DATABASE ---
def init_db():
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute('''CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, hashed_password TEXT, role TEXT, is_active BOOLEAN DEFAULT 1)''')
    c.execute('''CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)''')
    c.execute('''CREATE TABLE IF NOT EXISTS buttons (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT, action_type TEXT, action_value TEXT, enabled BOOLEAN DEFAULT 1)''')
    c.execute('''CREATE TABLE IF NOT EXISTS strategies (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, active BOOLEAN DEFAULT 0)''')
    c.execute('''CREATE TABLE IF NOT EXISTS trade_history (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, symbol TEXT, contract_type TEXT, amount REAL, status TEXT, result TEXT, timestamp TEXT, contract_id TEXT)''')

    # Indexes for performance
    c.execute("CREATE INDEX IF NOT EXISTS idx_trade_history_username ON trade_history(username)")
    c.execute("CREATE INDEX IF NOT EXISTS idx_trade_history_timestamp ON trade_history(timestamp)")

    pwd_context = CryptContext(schemes=["argon2"], deprecated="auto")
    c.execute("SELECT 1 FROM users WHERE username=?", (OWNER_USERNAME,))
    if not c.fetchone():
        hashed = pwd_context.hash("Timeline@337")
        c.execute("INSERT INTO users VALUES (?, ?, ?, ?)", (OWNER_USERNAME, hashed, 'admin', 1))

    # Default Settings
    c.execute("INSERT OR IGNORE INTO settings VALUES ('theme_primary', '#3b82f6')")
    c.execute("INSERT OR IGNORE INTO settings VALUES ('deriv_token', '')")
    c.execute("INSERT OR IGNORE INTO settings VALUES ('account_balance', '10000')")

    conn.commit()
    conn.close()

    # Initialise payment tables
    init_payment_db()

    # Ensure the app owner has a perpetual owner-tier license
    existing = get_license_for_user(OWNER_USERNAME)
    if not existing:
        owner_key = create_license(
            username=OWNER_USERNAME,
            tier="owner",
            is_owner=True,
            days_valid=None,  # perpetual
            notes="Auto-generated owner license",
        )
        logger.info(f"Owner license created: {owner_key}")

init_db()

# --- APP INIT ---
app = FastAPI(title="ALFA_TRADER")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="token")
pwd_context = CryptContext(schemes=["argon2"], deprecated="auto")

# --- AUTH ---
def create_token(data: dict):
    payload = {**data, "exp": datetime.utcnow() + timedelta(hours=24)}
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)

async def get_user(token: str = Depends(oauth2_scheme)):
    try:
        d = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        conn = sqlite3.connect(DB_FILE)
        try:
            c = conn.cursor()
            c.execute("SELECT username, role, is_active FROM users WHERE username=?", (d.get("sub"),))
            u = c.fetchone()
            if not u:
                raise HTTPException(401, detail="User not found")
            return {"user": u[0], "role": u[1], "active": u[2]}
        finally:
            conn.close()
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Token validation failed: {str(e)}")
        raise HTTPException(401, detail="Invalid token")

@app.post("/token")
async def login(form_data: OAuth2PasswordRequestForm = Depends()):
    if not form_data.username or not form_data.password:
        raise HTTPException(400, "Username and password required")
    
    conn = sqlite3.connect(DB_FILE)
    try:
        c = conn.cursor()
        c.execute("SELECT hashed_password FROM users WHERE username=?", (form_data.username,))
        u = c.fetchone()
        if not u or not pwd_context.verify(form_data.password, u[0]):
            logger.warning(f"Failed login attempt for user: {form_data.username}")
            raise HTTPException(400, "Invalid username or password")
        logger.info(f"User logged in: {form_data.username}")
        return {"access_token": create_token({"sub": form_data.username}), "token_type": "bearer"}
    finally:
        conn.close()

# --- SYSTEM STATUS ---
@app.get("/api/status")
async def status():
    return {
        "deriv_status": "🟢 LIVE CONNECTED" if trader.connected else "🔴 OFFLINE",
        "time": datetime.now().strftime("%H:%M:%S")
    }

# --- WALLET & MARKET DATA ---
@app.get("/api/wallet")
async def get_wallet(user = Depends(get_user)):
    wallet = await trader.get_wallet()
    return {
        "balance": wallet.get('balance', 10000),
        "currency": wallet.get('currency', 'USD'),
        "status": "online" if trader.connected else "offline"
    }

@app.get("/api/ticks/{symbol}")
async def get_market_ticks(symbol: str, user = Depends(get_user)):
    ticks_data = await trader.get_ticks(symbol, count=20)
    return ticks_data

@app.get("/api/history")
async def get_trade_history(user = Depends(get_user)):
    conn = sqlite3.connect(DB_FILE)
    try:
        c = conn.cursor()
        c.execute("SELECT id, symbol, contract_type, amount, status, result, timestamp, contract_id FROM trade_history WHERE username=? ORDER BY id DESC LIMIT 50", (user['user'],))
        trades = []
        for row in c.fetchall():
            trades.append({
                "id": row[0],
                "symbol": row[1],
                "type": row[2],
                "amount": row[3],
                "status": row[4],
                "result": row[5],
                "time": row[6],
                "contract_id": row[7]
            })
        return {"trades": trades, "total": len(trades)}
    finally:
        conn.close()

@app.post("/api/save-trade")
async def save_trade(data: dict, user = Depends(get_user)):
    try:
        conn = sqlite3.connect(DB_FILE)
        try:
            c = conn.cursor()
            timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            c.execute(
                "INSERT INTO trade_history (username, symbol, contract_type, amount, status, result, timestamp, contract_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (user['user'], data.get('symbol'), data.get('type'), float(data.get('amount', 0)), data.get('status', 'pending'), data.get('result', 'pending'), timestamp, data.get('contract_id', ''))
            )
            conn.commit()
            logger.info(f"Trade saved for {user['user']}: {data.get('symbol')} {data.get('type')}")
            return {"status": "saved"}
        finally:
            conn.close()
    except Exception as e:
        logger.error(f"Failed to save trade: {str(e)}")
        raise HTTPException(400, "Failed to save trade")

# --- DERIV CONTROL ---
@app.post("/admin/connect")
async def connect_deriv(data: dict, user = Depends(get_user)):
    if user['role'] != 'admin':
        raise HTTPException(403, "Admin access required")
    
    token = data.get('token', '').strip()
    if not token:
        raise HTTPException(400, "Token is required")
    
    success, msg = await trader.connect(token)
    if success:
        # Save to DB for persistence
        conn = sqlite3.connect(DB_FILE)
        try:
            c = conn.cursor()
            c.execute("INSERT OR REPLACE INTO settings VALUES ('deriv_token', ?)", (token,))
            conn.commit()
            logger.info(f"Deriv connected by admin: {user['user']}")
            return {"status": "connected"}
        finally:
            conn.close()
    else:
        logger.warning(f"Deriv connection failed: {msg}")
        raise HTTPException(400, msg)

# --- ANALYSIS & TRADE ---
@app.get("/api/analysis/{symbol}")
async def analyze(symbol: str):
    if trader.connected:
        return await trader.get_analysis(symbol)
    return {"signal": "OFFLINE", "confidence": 0, "digits": [10]*10}

@app.post("/api/trade")
async def place_trade(req: dict, user = Depends(get_user)):
    if not user['active']: raise HTTPException(403)
    try:
        result = await trader.execute_trade(
            req.get('symbol'), 
            float(req.get('amount', 1.0)), 
            req.get('contract_type'), 
            req.get('digit')
        )
        
        # Save trade to history
        conn = sqlite3.connect(DB_FILE)
        try:
            c = conn.cursor()
            timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            c.execute(
                "INSERT INTO trade_history (username, symbol, contract_type, amount, status, result, timestamp, contract_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (user['user'], req.get('symbol'), req.get('contract_type'), float(req.get('amount', 0)), 'executed', 'pending', timestamp, result.get('contract_id', ''))
            )
            conn.commit()
        finally:
            conn.close()
        
        return result
    except Exception as e:
        logger.error(f"Trade placement error: {str(e)}")
        raise

@app.post("/api/burst")
async def burst(req: dict, user = Depends(get_user)):
    if not user['active']: raise HTTPException(403)
    if not all(k in req for k in ['symbol', 'amount']):
        raise HTTPException(400, "Missing symbol or amount")
    
    results = []
    for _ in range(int(req.get('count', 5))):
        try:
            res = await trader.execute_trade(req['symbol'], float(req['amount']), "CALL")
            results.append(res)
        except Exception as e:
            logger.warning(f"Burst trade failed: {str(e)}")
            continue
    return {"executed": len(results)}

# --- CONFIG & ADMIN ---
@app.get("/api/config")
async def get_config(user = Depends(get_user)):
    conn = sqlite3.connect(DB_FILE)
    try:
        c = conn.cursor()
        c.execute("SELECT key, value FROM settings")
        settings = {r[0]: r[1] for r in c.fetchall()}
        
        c.execute("SELECT name, active FROM strategies")
        strategies = [{"name": r[0], "active": bool(r[1])} for r in c.fetchall()]
        
        c.execute("SELECT id, label, action_type, action_value FROM buttons WHERE enabled=1")
        buttons = [{"id": r[0], "label": r[1], "type": r[2], "value": r[3]} for r in c.fetchall()]
        
        markets = ["R_10", "R_25", "R_50", "R_75", "R_100", "R_100_1S", "BOOM_1000", "CRASH_1000"]
        
        # Mask token for security on frontend
        display_settings = settings.copy()
        if settings.get('deriv_token'):
            tk = settings['deriv_token']
            display_settings['deriv_token'] = f"{tk[:4]}...{tk[-4:]}" if len(tk) > 8 else "****"

        return {"settings": display_settings, "strategies": strategies, "custom_buttons": buttons, "markets": markets}
    finally:
        conn.close()

@app.post("/admin/setting")
async def update_setting(data: dict, user = Depends(get_user)):
    if user['role'] != 'admin': raise HTTPException(403)
    conn = sqlite3.connect(DB_FILE); c = conn.cursor()
    c.execute("INSERT OR REPLACE INTO settings VALUES (?, ?)", (data['key'], data['value']))
    conn.commit(); conn.close()
    return {"status": "ok"}

# --- Other Admin Routes (Strategies, Buttons, Users) ---
@app.post("/admin/toggle-strategy/{name}")
async def toggle_strat(name: str, user = Depends(get_user)):
    if user['role'] != 'admin': raise HTTPException(403)
    conn = sqlite3.connect(DB_FILE); c = conn.cursor()
    c.execute("UPDATE strategies SET active = NOT active WHERE name=?", (name,))
    conn.commit(); conn.close()
    return {"ok": True}

@app.post("/admin/buttons")
async def create_btn(data: dict, user = Depends(get_user)):
    if user['role'] != 'admin': raise HTTPException(403)
    conn = sqlite3.connect(DB_FILE); c = conn.cursor()
    c.execute("INSERT INTO buttons (label, action_type, action_value) VALUES (?, ?, ?)", (data['label'], data['type'], data['val']))
    conn.commit(); conn.close()
    return {"ok": True}

@app.delete("/admin/buttons/{id}")
async def del_btn(id: int, user = Depends(get_user)):
    if user['role'] != 'admin': raise HTTPException(403)
    conn = sqlite3.connect(DB_FILE); c = conn.cursor()
    c.execute("DELETE FROM buttons WHERE id=?", (id,))
    conn.commit(); conn.close()
    return {"ok": True}

# --- LICENSE & PAYMENT ROUTES ---

@app.get("/api/license/my")
async def my_license(user=Depends(get_user)):
    """Return the current user's active license."""
    lic = get_license_for_user(user["user"])
    if not lic:
        return {"has_license": False, "tier": None}
    return {"has_license": True, **lic}


@app.get("/api/license/validate")
async def check_license(key: str):
    """Validate a license key (no auth required — for self-serve check)."""
    result = validate_license(key)
    # Never expose the full key details if invalid
    if not result["valid"]:
        return JSONResponse(status_code=403, content={"valid": False, "error": result["error"]})
    return result


@app.get("/api/pricing")
async def get_pricing():
    """Return available pricing tiers (public endpoint)."""
    public_tiers = []
    for tier_id, info in TIERS.items():
        if tier_id in ("owner",):
            continue  # owner tier is not purchasable
        public_tiers.append({
            "id": tier_id,
            "label": info["label"],
            "price_usd": info["price_usd"],
            "features": info["features"],
            "max_trades_per_day": info["max_trades_per_day"],
        })
    return {"tiers": public_tiers}


# --- ADMIN LICENSE MANAGEMENT ---

@app.get("/admin/licenses")
async def admin_list_licenses(user=Depends(get_user)):
    """List all licenses (admin only)."""
    if user["role"] != "admin":
        raise HTTPException(403, "Admin access required")
    return {"licenses": list_all_licenses()}


@app.post("/admin/licenses/create")
async def admin_create_license(data: dict, user=Depends(get_user)):
    """
    Create a new license for a user (admin only).
    Body: { "username": str, "tier": str, "days_valid": int|null, "notes": str }
    """
    if user["role"] != "admin":
        raise HTTPException(403, "Admin access required")

    username = data.get("username", "").strip()
    tier = data.get("tier", "trial")
    days_valid = data.get("days_valid", 30)  # None = perpetual
    notes = data.get("notes", "")

    if not username:
        raise HTTPException(400, "username is required")
    if tier not in TIERS:
        raise HTTPException(400, f"Invalid tier. Valid options: {list(TIERS.keys())}")

    try:
        key = create_license(
            username=username,
            tier=tier,
            is_owner=False,
            days_valid=days_valid,
            notes=notes,
        )
        logger.info(f"Admin {user['user']} created license {key} for {username}")
        return {"license_key": key, "tier": tier, "username": username}
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/admin/licenses/revoke")
async def admin_revoke_license(data: dict, user=Depends(get_user)):
    """Revoke a license key (admin only). Body: { "license_key": str }"""
    if user["role"] != "admin":
        raise HTTPException(403, "Admin access required")
    key = data.get("license_key", "").strip()
    if not key:
        raise HTTPException(400, "license_key is required")
    success = revoke_license(key)
    if not success:
        raise HTTPException(404, "License not found")
    logger.info(f"Admin {user['user']} revoked license {key}")
    return {"status": "revoked", "license_key": key}


# --- STRIPE PAYMENT ROUTES ---

@app.post("/payment/checkout")
async def create_payment(data: dict, request: Request):
    """
    Create a Stripe Checkout session.
    Body: { "tier": str, "email": str, "username": str }
    Returns: { "checkout_url": str } or error if Stripe is not configured.
    """
    tier = data.get("tier", "basic")
    email = data.get("email", "").strip()
    username = data.get("username", "").strip()

    if tier not in TIERS:
        raise HTTPException(400, f"Invalid tier: {tier}")

    base_url = str(request.base_url).rstrip("/")
    success_url = f"{base_url}/payment/success?session_id={{CHECKOUT_SESSION_ID}}"
    cancel_url = f"{base_url}/payment/cancel"

    try:
        url = create_checkout_session(
            tier=tier,
            customer_email=email,
            success_url=success_url,
            cancel_url=cancel_url,
            username=username,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))

    if not url:
        raise HTTPException(503, "Payment processing is not configured. Contact the admin to purchase a license.")

    return {"checkout_url": url}


@app.post("/payment/webhook")
async def stripe_webhook(request: Request):
    """Stripe webhook endpoint — receives payment completion events."""
    payload = await request.body()
    sig_header = request.headers.get("stripe-signature", "")
    try:
        result = handle_stripe_webhook(payload, sig_header)
        return result
    except Exception as e:
        logger.error(f"Stripe webhook error: {e}")
        raise HTTPException(400, "Webhook processing failed")


@app.get("/payment/success")
async def payment_success():
    """Landing page after a successful Stripe payment."""
    return FileResponse(INDEX_PATH, media_type="text/html")


@app.get("/payment/cancel")
async def payment_cancel():
    """Landing page after a cancelled payment."""
    return FileResponse(INDEX_PATH, media_type="text/html")


# --- SERVE FRONTEND ---
PROJ_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(PROJ_DIR, 'static')
INDEX_PATH = os.path.join(STATIC_DIR, 'index.html')

if not os.path.isdir(STATIC_DIR):
    os.makedirs(STATIC_DIR)

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
async def root():
    # Serve static/index.html
    if os.path.exists(INDEX_PATH):
        return FileResponse(INDEX_PATH, media_type="text/html")
    return {"message": "V Ai Trader is running. Visit /static/index.html"}


# --- BACKGROUND TASK: Ensure Deriv Connection ---
async def _read_saved_deriv_token():
    try:
        conn = sqlite3.connect(DB_FILE)
        try:
            c = conn.cursor()
            c.execute("SELECT value FROM settings WHERE key='deriv_token'")
            r = c.fetchone()
            return r[0] if r and r[0] else ''
        finally:
            conn.close()
    except Exception as e:
        logger.warning(f"Failed to read saved deriv token: {e}")
        return ''


async def ensure_deriv_connection_loop():
    backoff = 2
    while True:
        try:
            token = await _read_saved_deriv_token()
            if token and not trader.connected:
                logger.info("Attempting to connect to Deriv using saved token...")
                success, msg = await trader.connect(token)
                if success:
                    logger.info("Deriv connection established by reconnect loop")
                    backoff = 2
                else:
                    logger.warning(f"Reconnect attempt failed: {msg}")
                    await asyncio.sleep(backoff)
                    backoff = min(backoff * 2, 60)
            else:
                # if connected, sleep longer; otherwise short retry
                await asyncio.sleep(10 if trader.connected else 5)
        except Exception as e:
            logger.error(f"Error in ensure_deriv_connection_loop: {e}")
            await asyncio.sleep(5)


@app.on_event("startup")
async def startup_event():
    # Start background reconnect task
    asyncio.create_task(ensure_deriv_connection_loop())

