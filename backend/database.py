"""
Data layer for the Pump Readings app.

Three tables, each keyed by date (YYYY-MM-DD), mirroring the original
Claude-artifact version's document shapes almost exactly so the frontend
logic (meter-reset detection, cost categories, fuel-purchase auto-calc)
carries over unchanged:

  readings(date PK, pumps_json, totals_petrol, totals_diesel,
           entered_by, submitted_at, status)
  costs(date PK, items_json, entered_by, submitted_at)
  stock(date PK, petrol_json, diesel_json, cost, note,
        entered_by, submitted_at)
  settings(key PK, value_json)   -- 'rates' and 'targets' rows

Backend choice:
  - If the DATABASE_URL environment variable is set (a Postgres connection
    string, e.g. from Supabase), that Postgres database is used. This is
    what Render production uses, since Render's free web services have no
    persistent disk — Postgres lives independently and survives restarts
    and redeploys.
  - Otherwise, falls back to a local SQLite file (PUMP_DB_PATH, defaulting
    to pump_readings.db next to this file). This is what local development
    uses, so nothing changes for running the app on your own machine.

The SQL below is written to work unchanged on both backends (placeholder
style is the only thing that differs, handled by `q()` below).
"""
import json
import os
import datetime
from contextlib import contextmanager

DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()
IS_PG = bool(DATABASE_URL)

if IS_PG:
    import psycopg
    from psycopg.rows import dict_row
else:
    import sqlite3

DB_PATH = os.environ.get("PUMP_DB_PATH", os.path.join(os.path.dirname(__file__), "pump_readings.db"))

DEFAULT_RATES = {
    "petrol": 110.0,
    "diesel": 99.0,
    "marginPetrol": 2.75,
    "marginDiesel": 2.22,
    "petrolDepreciation": 0.24,
    "purchaseCostPetrol": 107.25,
    "purchaseCostDiesel": 96.78,
}
DEFAULT_TARGETS = {"petrol": 1150, "diesel": 1250}


def q(sql):
    """Translate '?' placeholders to '%s' for Postgres; pass through for SQLite."""
    return sql.replace("?", "%s") if IS_PG else sql


@contextmanager
def get_conn():
    if IS_PG:
        conn = psycopg.connect(DATABASE_URL, row_factory=dict_row)
    else:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    real_type = "DOUBLE PRECISION" if IS_PG else "REAL"
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute(f"""
            CREATE TABLE IF NOT EXISTS readings (
                date TEXT PRIMARY KEY,
                pumps_json TEXT NOT NULL,
                totals_petrol {real_type} NOT NULL DEFAULT 0,
                totals_diesel {real_type} NOT NULL DEFAULT 0,
                entered_by TEXT DEFAULT '',
                submitted_at TEXT,
                status TEXT DEFAULT 'ok'
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS costs (
                date TEXT PRIMARY KEY,
                items_json TEXT NOT NULL,
                entered_by TEXT DEFAULT '',
                submitted_at TEXT
            )
        """)
        cur.execute(f"""
            CREATE TABLE IF NOT EXISTS stock (
                date TEXT PRIMARY KEY,
                petrol_json TEXT NOT NULL,
                diesel_json TEXT NOT NULL,
                cost {real_type} NOT NULL DEFAULT 0,
                note TEXT DEFAULT '',
                entered_by TEXT DEFAULT '',
                submitted_at TEXT
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value_json TEXT NOT NULL
            )
        """)
        pk_type = "SERIAL PRIMARY KEY" if IS_PG else "INTEGER PRIMARY KEY AUTOINCREMENT"
        cur.execute(f"""
            CREATE TABLE IF NOT EXISTS backups (
                id {pk_type},
                created_at TEXT NOT NULL,
                kind TEXT NOT NULL,
                data_json TEXT NOT NULL
            )
        """)
        # Seed default rates/targets if not present yet.
        cur.execute(q("SELECT key FROM settings WHERE key = ?"), ("rates",))
        if cur.fetchone() is None:
            cur.execute(q("INSERT INTO settings (key, value_json) VALUES (?, ?)"),
                        ("rates", json.dumps(DEFAULT_RATES)))
        cur.execute(q("SELECT key FROM settings WHERE key = ?"), ("targets",))
        if cur.fetchone() is None:
            cur.execute(q("INSERT INTO settings (key, value_json) VALUES (?, ?)"),
                        ("targets", json.dumps(DEFAULT_TARGETS)))
        if IS_PG:
            conn.commit()


def _execute(conn, sql, params=()):
    """Run a query and return something with .fetchone()/.fetchall(), on
    either backend."""
    if IS_PG:
        cur = conn.cursor()
        cur.execute(q(sql), params)
        return cur
    return conn.execute(sql, params)


# ---------- readings ----------

def reading_row_to_doc(row):
    return {
        "date": row["date"],
        "pumps": json.loads(row["pumps_json"]),
        "totals": {"petrol": row["totals_petrol"], "diesel": row["totals_diesel"]},
        "enteredBy": row["entered_by"] or "",
        "submittedAt": row["submitted_at"],
        "status": row["status"] or "ok",
    }


def get_reading(date):
    with get_conn() as conn:
        row = _execute(conn, "SELECT * FROM readings WHERE date = ?", (date,)).fetchone()
        return reading_row_to_doc(row) if row else None


def list_readings(date_from=None, date_to=None, limit=1000):
    sql = "SELECT * FROM readings WHERE 1=1"
    params = []
    if date_from:
        sql += " AND date >= ?"
        params.append(date_from)
    if date_to:
        sql += " AND date <= ?"
        params.append(date_to)
    sql += " ORDER BY date DESC LIMIT ?"
    params.append(limit)
    with get_conn() as conn:
        rows = _execute(conn, sql, params).fetchall()
        return [reading_row_to_doc(r) for r in rows]


def upsert_reading(date, doc):
    with get_conn() as conn:
        _execute(conn, """
            INSERT INTO readings (date, pumps_json, totals_petrol, totals_diesel, entered_by, submitted_at, status)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(date) DO UPDATE SET
                pumps_json=excluded.pumps_json,
                totals_petrol=excluded.totals_petrol,
                totals_diesel=excluded.totals_diesel,
                entered_by=excluded.entered_by,
                submitted_at=excluded.submitted_at,
                status=excluded.status
        """, (
            date, json.dumps(doc["pumps"]), doc["totals"]["petrol"], doc["totals"]["diesel"],
            doc.get("enteredBy", ""), doc.get("submittedAt"), doc.get("status", "ok"),
        ))


def delete_reading(date):
    with get_conn() as conn:
        _execute(conn, "DELETE FROM readings WHERE date = ?", (date,))


# ---------- costs ----------

def cost_row_to_doc(row):
    return {
        "date": row["date"],
        "items": json.loads(row["items_json"]),
        "enteredBy": row["entered_by"] or "",
        "submittedAt": row["submitted_at"],
    }


def get_cost(date):
    with get_conn() as conn:
        row = _execute(conn, "SELECT * FROM costs WHERE date = ?", (date,)).fetchone()
        return cost_row_to_doc(row) if row else None


def list_costs(date_from=None, date_to=None, limit=1000):
    sql = "SELECT * FROM costs WHERE 1=1"
    params = []
    if date_from:
        sql += " AND date >= ?"
        params.append(date_from)
    if date_to:
        sql += " AND date <= ?"
        params.append(date_to)
    sql += " ORDER BY date DESC LIMIT ?"
    params.append(limit)
    with get_conn() as conn:
        rows = _execute(conn, sql, params).fetchall()
        return [cost_row_to_doc(r) for r in rows]


def upsert_cost(date, items, entered_by, submitted_at):
    with get_conn() as conn:
        _execute(conn, """
            INSERT INTO costs (date, items_json, entered_by, submitted_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(date) DO UPDATE SET
                items_json=excluded.items_json,
                entered_by=excluded.entered_by,
                submitted_at=excluded.submitted_at
        """, (date, json.dumps(items), entered_by or "", submitted_at))


def upsert_cost_category_amount(date, category, amount, entered_by):
    """Replace every item of `category` on `date` with a single new item of
    `amount` (or remove the category entirely if amount <= 0). Mirrors the
    original app's upsertCostCategoryAmount helper, used both for manual
    cost-table edits and the stock tab's auto-calculated Fuel Purchase line.
    """
    existing = get_cost(date)
    items = existing["items"] if existing else []
    items = [it for it in items if it["category"] != category]
    if amount and amount > 0:
        items.append({"category": category, "amount": round(amount, 2), "note": ""})
    upsert_cost(date, items, entered_by, datetime.datetime.utcnow().isoformat() + "Z")


def delete_cost_category(date, category):
    existing = get_cost(date)
    if not existing:
        return
    items = [it for it in existing["items"] if it["category"] != category]
    if items:
        upsert_cost(date, items, existing["enteredBy"], existing["submittedAt"])
    else:
        with get_conn() as conn:
            _execute(conn, "DELETE FROM costs WHERE date = ?", (date,))


def delete_cost(date):
    with get_conn() as conn:
        _execute(conn, "DELETE FROM costs WHERE date = ?", (date,))


# ---------- stock ----------

def stock_row_to_doc(row):
    return {
        "date": row["date"],
        "petrol": json.loads(row["petrol_json"]),
        "diesel": json.loads(row["diesel_json"]),
        "cost": row["cost"],
        "note": row["note"] or "",
        "enteredBy": row["entered_by"] or "",
        "submittedAt": row["submitted_at"],
    }


def get_stock(date):
    with get_conn() as conn:
        row = _execute(conn, "SELECT * FROM stock WHERE date = ?", (date,)).fetchone()
        return stock_row_to_doc(row) if row else None


def list_stock(date_from=None, date_to=None, limit=1000):
    sql = "SELECT * FROM stock WHERE 1=1"
    params = []
    if date_from:
        sql += " AND date >= ?"
        params.append(date_from)
    if date_to:
        sql += " AND date <= ?"
        params.append(date_to)
    sql += " ORDER BY date DESC LIMIT ?"
    params.append(limit)
    with get_conn() as conn:
        rows = _execute(conn, sql, params).fetchall()
        return [stock_row_to_doc(r) for r in rows]


def upsert_stock(date, petrol, diesel, cost, note, entered_by, submitted_at):
    with get_conn() as conn:
        _execute(conn, """
            INSERT INTO stock (date, petrol_json, diesel_json, cost, note, entered_by, submitted_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(date) DO UPDATE SET
                petrol_json=excluded.petrol_json,
                diesel_json=excluded.diesel_json,
                cost=excluded.cost,
                note=excluded.note,
                entered_by=excluded.entered_by,
                submitted_at=excluded.submitted_at
        """, (date, json.dumps(petrol), json.dumps(diesel), cost, note or "", entered_by or "", submitted_at))


def delete_stock(date):
    with get_conn() as conn:
        _execute(conn, "DELETE FROM stock WHERE date = ?", (date,))


# ---------- settings ----------

def get_setting(key, default):
    with get_conn() as conn:
        row = _execute(conn, "SELECT value_json FROM settings WHERE key = ?", (key,)).fetchone()
        if row is None:
            return dict(default)
        return json.loads(row["value_json"])


def set_setting(key, value):
    with get_conn() as conn:
        _execute(conn, """
            INSERT INTO settings (key, value_json) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json
        """, (key, json.dumps(value)))


# ---------- backups ----------

def build_full_snapshot():
    """Gather every table into one plain-dict snapshot, used for both
    manual and automatic backups."""
    return {
        "exportedAt": datetime.datetime.utcnow().isoformat() + "Z",
        "readings": list_readings(limit=1000000),
        "costs": list_costs(limit=1000000),
        "stock": list_stock(limit=1000000),
        "settings": {
            "rates": get_setting("rates", DEFAULT_RATES),
            "targets": get_setting("targets", DEFAULT_TARGETS),
        },
    }


def create_backup(kind="manual"):
    """Snapshot all data and store it as a new backup row. `kind` is
    'manual' or 'auto'. Returns the backup's summary row."""
    snapshot = build_full_snapshot()
    created_at = datetime.datetime.utcnow().isoformat() + "Z"
    data_json = json.dumps(snapshot)
    with get_conn() as conn:
        if IS_PG:
            cur = conn.cursor()
            cur.execute(q("INSERT INTO backups (created_at, kind, data_json) VALUES (?, ?, ?) RETURNING id"),
                        (created_at, kind, data_json))
            new_id = cur.fetchone()["id"]
        else:
            cur = conn.execute("INSERT INTO backups (created_at, kind, data_json) VALUES (?, ?, ?)",
                                (created_at, kind, data_json))
            new_id = cur.lastrowid
    return {"id": new_id, "createdAt": created_at, "kind": kind, "sizeBytes": len(data_json)}


def list_backups(limit=50):
    with get_conn() as conn:
        rows = _execute(conn, """
            SELECT id, created_at, kind, LENGTH(data_json) AS size_bytes
            FROM backups ORDER BY created_at DESC LIMIT ?
        """, (limit,)).fetchall()
        return [{"id": r["id"], "createdAt": r["created_at"], "kind": r["kind"], "sizeBytes": r["size_bytes"]}
                for r in rows]


def get_backup(backup_id):
    with get_conn() as conn:
        row = _execute(conn, "SELECT * FROM backups WHERE id = ?", (backup_id,)).fetchone()
        if row is None:
            return None
        return {"id": row["id"], "createdAt": row["created_at"], "kind": row["kind"],
                "data": json.loads(row["data_json"])}


def delete_backup(backup_id):
    with get_conn() as conn:
        _execute(conn, "DELETE FROM backups WHERE id = ?", (backup_id,))


def last_backup_at():
    with get_conn() as conn:
        row = _execute(conn, "SELECT created_at FROM backups ORDER BY created_at DESC LIMIT 1").fetchone()
        return row["created_at"] if row else None


def health_summary(missing_lookback_days=14):
    """Non-sensitive status snapshot for monitoring (no financial figures),
    safe to expose without owner auth. Used by the scheduled 'Friday'
    watchdog task."""
    today = datetime.date.today()
    rows = list_readings(limit=1)
    last_reading_date = rows[0]["date"] if rows else None
    days_since_last_reading = None
    if last_reading_date:
        y, m, d = (int(x) for x in last_reading_date.split("-"))
        days_since_last_reading = (today - datetime.date(y, m, d)).days

    range_to = today - datetime.timedelta(days=1)  # yesterday — today isn't due yet
    range_from = today - datetime.timedelta(days=missing_lookback_days)
    window_rows = list_readings(date_from=range_from.isoformat(), date_to=range_to.isoformat(), limit=1000000)
    present = {r["date"] for r in window_rows}
    missing_days = []
    cur = range_from
    while cur <= range_to:
        ds = cur.isoformat()
        if ds not in present:
            missing_days.append(ds)
        cur += datetime.timedelta(days=1)

    last_backup = last_backup_at()
    backup_age_days = None
    if last_backup:
        last_dt = datetime.datetime.fromisoformat(last_backup.replace("Z", "+00:00"))
        backup_age_days = (datetime.datetime.now(datetime.timezone.utc) - last_dt).days

    return {
        "today": today.isoformat(),
        "lastReadingDate": last_reading_date,
        "daysSinceLastReading": days_since_last_reading,
        "missingDaysLast14": missing_days,
        "lastBackupAt": last_backup,
        "backupAgeDays": backup_age_days,
    }


def maybe_auto_backup(min_days=30):
    """Create an 'auto' backup if the last backup (of any kind) is older
    than `min_days`, or none exists yet. Cheap to call on every owner page
    load — one SELECT when nothing is due. Returns the new backup summary
    if one was created, else None."""
    last = last_backup_at()
    if last:
        last_dt = datetime.datetime.fromisoformat(last.replace("Z", "+00:00"))
        age_days = (datetime.datetime.now(datetime.timezone.utc) - last_dt).days
        if age_days < min_days:
            return None
    return create_backup(kind="auto")
