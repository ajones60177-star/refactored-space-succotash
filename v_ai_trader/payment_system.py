"""
ALFA AI Trader - Payment & License Management System
Handles license key generation, validation, and Stripe payment processing.
"""
import os
import uuid
import secrets
import sqlite3
import logging
from datetime import datetime, timedelta
from typing import Optional

logger = logging.getLogger(__name__)

DB_FILE = os.getenv("DB_FILE", "alfa_database.db")

# ---------------------------------------------------------------------------
# License tiers
# ---------------------------------------------------------------------------
TIERS = {
    "owner": {
        "label": "Owner",
        "max_trades_per_day": None,   # unlimited
        "features": ["all"],
        "price_usd": 0,
    },
    "premium": {
        "label": "Premium",
        "max_trades_per_day": None,
        "features": ["trading", "analytics", "advanced_reports", "api_access"],
        "price_usd": 99.00,
        "stripe_price_id": os.getenv("STRIPE_PREMIUM_PRICE_ID", ""),
    },
    "pro": {
        "label": "Pro",
        "max_trades_per_day": 500,
        "features": ["trading", "analytics", "basic_reports"],
        "price_usd": 49.00,
        "stripe_price_id": os.getenv("STRIPE_PRO_PRICE_ID", ""),
    },
    "basic": {
        "label": "Basic",
        "max_trades_per_day": 50,
        "features": ["trading"],
        "price_usd": 19.00,
        "stripe_price_id": os.getenv("STRIPE_BASIC_PRICE_ID", ""),
    },
    "trial": {
        "label": "Trial",
        "max_trades_per_day": 10,
        "features": ["trading"],
        "price_usd": 0,
    },
}


# ---------------------------------------------------------------------------
# Database helpers
# ---------------------------------------------------------------------------
def init_payment_db():
    """Create payment-related tables if they do not exist."""
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()

    c.execute("""
        CREATE TABLE IF NOT EXISTS licenses (
            license_key   TEXT PRIMARY KEY,
            username      TEXT,
            tier          TEXT NOT NULL DEFAULT 'trial',
            is_owner      BOOLEAN NOT NULL DEFAULT 0,
            issued_at     TEXT NOT NULL,
            expires_at    TEXT,
            is_active     BOOLEAN NOT NULL DEFAULT 1,
            notes         TEXT
        )
    """)

    c.execute("""
        CREATE TABLE IF NOT EXISTS payment_transactions (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            license_key         TEXT,
            stripe_session_id   TEXT UNIQUE,
            stripe_payment_id   TEXT,
            amount_usd          REAL,
            tier                TEXT,
            status              TEXT DEFAULT 'pending',
            created_at          TEXT NOT NULL,
            completed_at        TEXT,
            customer_email      TEXT
        )
    """)

    # Indexes for performance
    c.execute("CREATE INDEX IF NOT EXISTS idx_licenses_username ON licenses(username)")
    c.execute("CREATE INDEX IF NOT EXISTS idx_payment_session ON payment_transactions(stripe_session_id)")
    c.execute("CREATE INDEX IF NOT EXISTS idx_payment_license ON payment_transactions(license_key)")

    conn.commit()
    conn.close()


# ---------------------------------------------------------------------------
# License generation & lookup
# ---------------------------------------------------------------------------
def generate_license_key(prefix: str = "ALFA") -> str:
    """Return a unique uppercase license key like ALFA-XXXX-XXXX-XXXX."""
    parts = [secrets.token_hex(3).upper() for _ in range(3)]
    return f"{prefix}-{'-'.join(parts)}"


def _generate_unique_key(conn: sqlite3.Connection, prefix: str = "ALFA") -> str:
    """Generate a license key that is not already present in the database."""
    c = conn.cursor()
    for _ in range(10):
        key = generate_license_key(prefix)
        c.execute("SELECT 1 FROM licenses WHERE license_key = ?", (key,))
        if not c.fetchone():
            return key
    raise RuntimeError("Failed to generate a unique license key after 10 attempts")


def create_license(
    username: str,
    tier: str = "trial",
    is_owner: bool = False,
    days_valid: Optional[int] = 30,
    notes: str = "",
) -> str:
    """
    Insert a new license into the database and return the generated key.
    Pass days_valid=None for a perpetual license.
    """
    if tier not in TIERS:
        raise ValueError(f"Unknown tier '{tier}'. Valid tiers: {list(TIERS)}")

    now = datetime.utcnow().isoformat()
    expires = None
    if days_valid is not None:
        expires = (datetime.utcnow() + timedelta(days=days_valid)).isoformat()

    conn = sqlite3.connect(DB_FILE)
    try:
        c = conn.cursor()
        key = _generate_unique_key(conn)
        c.execute(
            """
            INSERT INTO licenses
                (license_key, username, tier, is_owner, issued_at, expires_at, is_active, notes)
            VALUES (?, ?, ?, ?, ?, ?, 1, ?)
            """,
            (key, username, tier, int(is_owner), now, expires, notes),
        )
        conn.commit()
        logger.info(f"License created: {key} for user '{username}' (tier={tier})")
    finally:
        conn.close()

    return key


def validate_license(license_key: str) -> dict:
    """
    Return a dict describing validity:
      {"valid": bool, "tier": str, "is_owner": bool, "username": str, "error": str|None}
    """
    if not license_key:
        return {"valid": False, "error": "No license key provided"}

    conn = sqlite3.connect(DB_FILE)
    try:
        c = conn.cursor()
        c.execute(
            """
            SELECT username, tier, is_owner, expires_at, is_active
            FROM licenses WHERE license_key = ?
            """,
            (license_key,),
        )
        row = c.fetchone()
    finally:
        conn.close()

    if not row:
        return {"valid": False, "error": "Invalid license key"}

    username, tier, is_owner, expires_at, is_active = row

    if not is_active:
        return {"valid": False, "error": "License has been revoked"}

    if expires_at:
        expiry_dt = datetime.fromisoformat(expires_at)
        if expiry_dt < datetime.utcnow():
            return {"valid": False, "error": f"License expired on {expiry_dt.date()}"}

    return {
        "valid": True,
        "license_key": license_key,
        "username": username,
        "tier": tier,
        "is_owner": bool(is_owner),
        "features": TIERS.get(tier, {}).get("features", []),
        "max_trades_per_day": TIERS.get(tier, {}).get("max_trades_per_day"),
        "expires_at": expires_at,
        "error": None,
    }


def get_license_for_user(username: str) -> Optional[dict]:
    """Return the most recently issued active license for a given username."""
    conn = sqlite3.connect(DB_FILE)
    try:
        c = conn.cursor()
        c.execute(
            """
            SELECT license_key, tier, is_owner, expires_at, is_active
            FROM licenses
            WHERE username = ? AND is_active = 1
            ORDER BY issued_at DESC
            LIMIT 1
            """,
            (username,),
        )
        row = c.fetchone()
    finally:
        conn.close()

    if not row:
        return None

    key, tier, is_owner, expires_at, is_active = row
    return {
        "license_key": key,
        "tier": tier,
        "is_owner": bool(is_owner),
        "expires_at": expires_at,
        "features": TIERS.get(tier, {}).get("features", []),
    }


def list_all_licenses() -> list:
    """Return all licenses (for admin view)."""
    conn = sqlite3.connect(DB_FILE)
    try:
        c = conn.cursor()
        c.execute(
            """
            SELECT license_key, username, tier, is_owner, issued_at, expires_at, is_active, notes
            FROM licenses ORDER BY issued_at DESC
            """
        )
        rows = c.fetchall()
    finally:
        conn.close()

    return [
        {
            "license_key": r[0],
            "username": r[1],
            "tier": r[2],
            "is_owner": bool(r[3]),
            "issued_at": r[4],
            "expires_at": r[5],
            "is_active": bool(r[6]),
            "notes": r[7],
        }
        for r in rows
    ]


def revoke_license(license_key: str) -> bool:
    """Deactivate a license. Returns True if a row was updated."""
    conn = sqlite3.connect(DB_FILE)
    try:
        c = conn.cursor()
        c.execute("UPDATE licenses SET is_active = 0 WHERE license_key = ?", (license_key,))
        conn.commit()
        updated = c.rowcount > 0
    finally:
        conn.close()

    if updated:
        logger.info(f"License revoked: {license_key}")
    return updated


# ---------------------------------------------------------------------------
# Stripe helpers (optional — only active when STRIPE_SECRET_KEY is set)
# ---------------------------------------------------------------------------
def _get_stripe():
    """Return the stripe module configured with the secret key, or None."""
    stripe_key = os.getenv("STRIPE_SECRET_KEY", "")
    if not stripe_key:
        return None
    try:
        import stripe  # type: ignore
        stripe.api_key = stripe_key
        return stripe
    except ImportError:
        logger.warning("stripe package not installed; payment features disabled")
        return None


def create_checkout_session(
    tier: str,
    customer_email: str,
    success_url: str,
    cancel_url: str,
    username: str = "",
) -> Optional[str]:
    """
    Create a Stripe Checkout session and return the session URL.
    Returns None if Stripe is not configured.
    """
    stripe = _get_stripe()
    if not stripe:
        return None

    tier_info = TIERS.get(tier)
    if not tier_info:
        raise ValueError(f"Unknown tier: {tier}")

    price_id = tier_info.get("stripe_price_id", "")
    if not price_id:
        raise ValueError(f"No Stripe price ID configured for tier '{tier}'")

    session = stripe.checkout.Session.create(
        payment_method_types=["card"],
        line_items=[{"price": price_id, "quantity": 1}],
        mode="payment",
        customer_email=customer_email or None,
        success_url=success_url,
        cancel_url=cancel_url,
        metadata={"tier": tier, "username": username},
    )

    # Record pending transaction
    conn = sqlite3.connect(DB_FILE)
    try:
        c = conn.cursor()
        c.execute(
            """
            INSERT INTO payment_transactions
                (stripe_session_id, amount_usd, tier, status, created_at, customer_email)
            VALUES (?, ?, ?, 'pending', ?, ?)
            """,
            (
                session.id,
                tier_info["price_usd"],
                tier,
                datetime.utcnow().isoformat(),
                customer_email,
            ),
        )
        conn.commit()
    finally:
        conn.close()

    return session.url


def handle_stripe_webhook(payload: bytes, sig_header: str) -> dict:
    """
    Verify and process an incoming Stripe webhook.
    Returns {"status": "ok"} or raises an exception.
    """
    stripe = _get_stripe()
    if not stripe:
        raise RuntimeError("Stripe not configured")

    webhook_secret = os.getenv("STRIPE_WEBHOOK_SECRET", "")
    if not webhook_secret:
        raise RuntimeError("STRIPE_WEBHOOK_SECRET not set")

    event = None
    try:
        event = stripe.Webhook.construct_event(payload, sig_header, webhook_secret)
    except stripe.error.SignatureVerificationError as e:
        raise RuntimeError(f"Webhook signature verification failed: {e}") from e
    except Exception as e:
        raise RuntimeError(f"Webhook payload construction failed: {e}") from e

    if event["type"] == "checkout.session.completed":
        session = event["data"]["object"]
        session_id = session["id"]
        tier = session.get("metadata", {}).get("tier", "basic")
        username = session.get("metadata", {}).get("username", "")
        customer_email = session.get("customer_email", "")

        # Generate license
        license_key = create_license(
            username=username or customer_email,
            tier=tier,
            is_owner=False,
            days_valid=365,
            notes=f"Stripe session {session_id}",
        )

        # Update transaction record
        conn = sqlite3.connect(DB_FILE)
        try:
            c = conn.cursor()
            c.execute(
                """
                UPDATE payment_transactions
                SET status = 'completed', completed_at = ?, license_key = ?,
                    stripe_payment_id = ?, customer_email = ?
                WHERE stripe_session_id = ?
                """,
                (
                    datetime.utcnow().isoformat(),
                    license_key,
                    session.get("payment_intent", ""),
                    customer_email,
                    session_id,
                ),
            )
            conn.commit()
        finally:
            conn.close()

        logger.info(f"Payment completed: tier={tier}, license={license_key}")

    return {"status": "ok"}
