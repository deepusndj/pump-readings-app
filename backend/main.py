"""
Pump Readings standalone backend.

A single FastAPI app that serves:
  - the JSON API under /api/*
  - the static frontend (everything in ../frontend) at /

Run locally:
    pip install -r requirements.txt
    uvicorn main:app --reload --port 8000

Deploy (Render, free tier): see ../README.md
"""
import os
import datetime
from typing import Optional, List

from fastapi import FastAPI, HTTPException, Header, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import database as db
import ai_assistant
import notify

OWNER_PASSWORD = os.environ.get("OWNER_PASSWORD", "changeme")

app = FastAPI(title="Pump Readings API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def _startup():
    db.init_db()


def now_iso():
    return datetime.datetime.utcnow().isoformat() + "Z"


def require_owner(x_owner_password: Optional[str] = Header(None)):
    if not x_owner_password or x_owner_password != OWNER_PASSWORD:
        raise HTTPException(status_code=401, detail="Invalid owner password")


# ---------------------------------------------------------------------------
# Readings
# ---------------------------------------------------------------------------

class PumpReading(BaseModel):
    initial: float
    final: float
    test: float = 0
    litres: float = 0
    confirmedReset: bool = False
    overridden: bool = False


class ReadingDoc(BaseModel):
    pumps: dict
    totals: dict
    enteredBy: str = ""
    status: str = "ok"


@app.get("/api/readings")
def list_readings(date_from: Optional[str] = Query(None, alias="from"),
                   date_to: Optional[str] = Query(None, alias="to"),
                   limit: int = 1000):
    return db.list_readings(date_from, date_to, limit)


@app.get("/api/readings/{date}")
def get_reading(date: str):
    doc = db.get_reading(date)
    if doc is None:
        raise HTTPException(status_code=404, detail="Not found")
    return doc


@app.put("/api/readings/{date}")
def put_reading(date: str, doc: ReadingDoc):
    was_new = db.get_reading(date) is None
    data = doc.dict()
    data["submittedAt"] = now_iso()
    db.upsert_reading(date, data)
    totals = data.get("totals") or {}
    who = data.get("enteredBy") or "someone"
    notify.push(
        "Reading submitted" if was_new else "Reading updated",
        f"{date} by {who} — petrol {round(totals.get('petrol', 0) or 0, 2)} L, diesel {round(totals.get('diesel', 0) or 0, 2)} L",
    )
    return db.get_reading(date)


@app.delete("/api/readings/{date}")
def delete_reading(date: str, x_owner_password: Optional[str] = Header(None)):
    require_owner(x_owner_password)
    db.delete_reading(date)
    notify.push("Reading deleted", f"{date} — deleted by owner", priority="high")
    return {"ok": True}


# ---------------------------------------------------------------------------
# Costs
# ---------------------------------------------------------------------------

class CostItem(BaseModel):
    category: str
    amount: float
    note: str = ""


class CostAppend(BaseModel):
    category: str
    amount: float
    note: str = ""
    enteredBy: str = ""


class CostReplace(BaseModel):
    items: List[CostItem]
    enteredBy: str = ""


class CostCategoryAmount(BaseModel):
    category: str
    amount: float
    enteredBy: str = ""


@app.get("/api/costs")
def list_costs(date_from: Optional[str] = Query(None, alias="from"),
               date_to: Optional[str] = Query(None, alias="to"),
               limit: int = 1000):
    return db.list_costs(date_from, date_to, limit)


@app.get("/api/costs/{date}")
def get_cost(date: str):
    doc = db.get_cost(date)
    if doc is None:
        return {"date": date, "items": [], "enteredBy": "", "submittedAt": None}
    return doc


@app.post("/api/costs/{date}/items")
def add_cost_item(date: str, item: CostAppend):
    """Employee's one-at-a-time expense entry: append a new item."""
    existing = db.get_cost(date)
    items = existing["items"] if existing else []
    items.append({"category": item.category, "amount": item.amount, "note": item.note})
    db.upsert_cost(date, items, item.enteredBy, now_iso())
    notify.push("Expense added", f"{date} by {item.enteredBy or 'someone'} — {item.category}: {item.amount}")
    return db.get_cost(date)


@app.put("/api/costs/{date}")
def replace_cost(date: str, body: CostReplace, x_owner_password: Optional[str] = Header(None)):
    """Owner's month-grid editor: replace the whole items list for a date."""
    require_owner(x_owner_password)
    db.upsert_cost(date, [i.dict() for i in body.items], body.enteredBy, now_iso())
    notify.push("Cost entry updated", f"{date} — edited by owner")
    return db.get_cost(date)


@app.put("/api/costs/{date}/category")
def set_cost_category(date: str, body: CostCategoryAmount, x_owner_password: Optional[str] = Header(None)):
    """Owner cost-table single-cell edit, and the stock tab's Fuel Purchase auto-calc."""
    require_owner(x_owner_password)
    db.upsert_cost_category_amount(date, body.category, body.amount, body.enteredBy)
    notify.push("Cost updated", f"{date} — {body.category}: {body.amount}")
    return db.get_cost(date)


@app.delete("/api/costs/{date}/category/{category}")
def delete_cost_category(date: str, category: str, x_owner_password: Optional[str] = Header(None)):
    require_owner(x_owner_password)
    db.delete_cost_category(date, category)
    notify.push("Cost category removed", f"{date} — {category} deleted by owner", priority="high")
    return {"ok": True}


@app.delete("/api/costs/{date}")
def delete_cost(date: str, x_owner_password: Optional[str] = Header(None)):
    require_owner(x_owner_password)
    db.delete_cost(date)
    notify.push("Cost entry deleted", f"{date} — deleted by owner", priority="high")
    return {"ok": True}


# ---------------------------------------------------------------------------
# Stock
# ---------------------------------------------------------------------------

class TankEntry(BaseModel):
    dip: float = 0
    received: float = 0
    note: str = ""


class StockDoc(BaseModel):
    petrol: TankEntry
    diesel: TankEntry
    cost: float = 0
    note: str = ""
    enteredBy: str = ""


FUEL_PURCHASE_CATEGORY = "Fuel Purchase"


@app.get("/api/stock")
def list_stock(date_from: Optional[str] = Query(None, alias="from"),
               date_to: Optional[str] = Query(None, alias="to"),
               limit: int = 1000):
    return db.list_stock(date_from, date_to, limit)


@app.get("/api/stock/{date}")
def get_stock(date: str):
    doc = db.get_stock(date)
    if doc is None:
        raise HTTPException(status_code=404, detail="Not found")
    return doc


@app.put("/api/stock/{date}")
def put_stock(date: str, doc: StockDoc):
    """Employee stock entry. Mirrors the original app: whenever stock cost
    changes, the Fuel Purchase cost-category line for the same date is
    recalculated to match (so the cost tab stays in sync automatically)."""
    db.upsert_stock(
        date,
        doc.petrol.dict(),
        doc.diesel.dict(),
        doc.cost,
        doc.note,
        doc.enteredBy,
        now_iso(),
    )
    if doc.cost and doc.cost > 0:
        db.upsert_cost_category_amount(date, FUEL_PURCHASE_CATEGORY, doc.cost, doc.enteredBy)
    notify.push("Stock entry saved", f"{date} by {doc.enteredBy or 'someone'}")
    return db.get_stock(date)


@app.delete("/api/stock/{date}")
def delete_stock(date: str, x_owner_password: Optional[str] = Header(None)):
    require_owner(x_owner_password)
    db.delete_stock(date)
    db.delete_cost_category(date, FUEL_PURCHASE_CATEGORY)
    notify.push("Stock entry deleted", f"{date} — deleted by owner", priority="high")
    return {"ok": True}


# ---------------------------------------------------------------------------
# Settings (rates / targets)
# ---------------------------------------------------------------------------

@app.get("/api/settings/rates")
def get_rates():
    return db.get_setting("rates", db.DEFAULT_RATES)


@app.put("/api/settings/rates")
def put_rates(body: dict, x_owner_password: Optional[str] = Header(None)):
    require_owner(x_owner_password)
    current = db.get_setting("rates", db.DEFAULT_RATES)
    current.update(body)
    db.set_setting("rates", current)
    notify.push("Rates updated", "Fuel rates changed by owner")
    return current


@app.get("/api/settings/targets")
def get_targets():
    return db.get_setting("targets", db.DEFAULT_TARGETS)


@app.put("/api/settings/targets")
def put_targets(body: dict, x_owner_password: Optional[str] = Header(None)):
    require_owner(x_owner_password)
    current = db.get_setting("targets", db.DEFAULT_TARGETS)
    current.update(body)
    db.set_setting("targets", current)
    notify.push("Targets updated", "Monthly targets changed by owner")
    return current


# ---------------------------------------------------------------------------
# AI Assistant (owner-only) — ported from the original artifact's AI tab,
# backed by Google Gemini's free API tier instead of window.claude.complete.
# ---------------------------------------------------------------------------

class AiSendBody(BaseModel):
    history: list = []
    message: str


class AiResolveBody(BaseModel):
    history: list = []
    decisions: List[bool] = []


class AiBriefingBody(BaseModel):
    force: bool = False


def _ai_result(result: dict) -> dict:
    # `history` here is what the frontend should store and resend next time
    # (Gemini's own "contents" array) — renamed so it doesn't read as a
    # browser history object.
    out = {"status": result["status"], "history": result["contents"]}
    if result["status"] == "done":
        out["text"] = result["text"]
    else:
        out["pending"] = result["pending"]
    return out


@app.get("/api/ai/status")
def ai_status():
    return {"configured": bool(ai_assistant.GEMINI_API_KEY), "suggestions": ai_assistant.AI_SUGGESTIONS}


@app.post("/api/ai/briefing")
async def ai_briefing(body: AiBriefingBody, x_owner_password: Optional[str] = Header(None)):
    """Gemini's free tier has a small daily request quota, and the Summary
    tab's briefing used to regenerate on every page load — which burns
    through that quota fast with normal use. It's genuinely a *daily*
    briefing, so cache it per calendar day and only call Gemini again when
    the day has changed or the owner explicitly hits Refresh (force=True)."""
    require_owner(x_owner_password)
    if not ai_assistant.GEMINI_API_KEY:
        raise HTTPException(status_code=503, detail="AI Assistant isn't set up yet (no GEMINI_API_KEY on the server).")

    today = datetime.date.today().isoformat()
    cached = db.get_setting("dailyBriefing", {})
    if not body.force and cached.get("dateKey") == today and cached.get("text"):
        return {"text": cached["text"], "generatedAt": cached["generatedAt"], "cached": True}

    try:
        text = await ai_assistant.generate_briefing()
    except ai_assistant.AiNotConfigured as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"AI Assistant error: {e}")

    generated_at = now_iso()
    db.set_setting("dailyBriefing", {"text": text, "generatedAt": generated_at, "dateKey": today})
    return {"text": text, "generatedAt": generated_at, "cached": False}


@app.post("/api/ai/send")
async def ai_send(body: AiSendBody, x_owner_password: Optional[str] = Header(None)):
    require_owner(x_owner_password)
    if not ai_assistant.GEMINI_API_KEY:
        raise HTTPException(status_code=503, detail="AI Assistant isn't set up yet (no GEMINI_API_KEY on the server).")
    try:
        result = await ai_assistant.send_message(body.history, body.message)
    except ai_assistant.AiNotConfigured as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"AI Assistant error: {e}")
    return _ai_result(result)


@app.post("/api/ai/resolve")
async def ai_resolve(body: AiResolveBody, x_owner_password: Optional[str] = Header(None)):
    require_owner(x_owner_password)
    try:
        result = await ai_assistant.resolve_turn(body.history, body.decisions)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"AI Assistant error: {e}")
    return _ai_result(result)


# ---------------------------------------------------------------------------
# Backups (owner-only) — manual "Backup now" button plus a lazy monthly
# auto-backup that fires the next time the owner opens the app after 30+
# days, since Render's free tier can't be trusted to run a background timer
# while asleep. Backups are stored as rows in Postgres itself, so they
# survive restarts/redeploys with no extra infrastructure.
# ---------------------------------------------------------------------------

@app.get("/api/backups")
def backups_list(x_owner_password: Optional[str] = Header(None)):
    require_owner(x_owner_password)
    return {"backups": db.list_backups(), "lastBackupAt": db.last_backup_at()}


@app.post("/api/backups")
def backups_create(x_owner_password: Optional[str] = Header(None)):
    """Manual 'Backup now' button."""
    require_owner(x_owner_password)
    return db.create_backup(kind="manual")


@app.post("/api/backups/check")
def backups_check(x_owner_password: Optional[str] = Header(None)):
    """Called once when the owner opens the app. Silently creates an 'auto'
    backup if the last one is 30+ days old (or none exists yet)."""
    require_owner(x_owner_password)
    created = db.maybe_auto_backup(min_days=30)
    return {"created": created, "lastBackupAt": db.last_backup_at()}


@app.get("/api/backups/{backup_id}/download")
def backups_download(backup_id: int, x_owner_password: Optional[str] = Header(None)):
    require_owner(x_owner_password)
    backup = db.get_backup(backup_id)
    if backup is None:
        raise HTTPException(status_code=404, detail="Backup not found")
    filename = f"pump-readings-backup-{backup['createdAt'][:10]}.json"
    return JSONResponse(
        content=backup["data"],
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.delete("/api/backups/{backup_id}")
def backups_delete(backup_id: int, x_owner_password: Optional[str] = Header(None)):
    require_owner(x_owner_password)
    db.delete_backup(backup_id)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Health (public, no financial data) — used by the scheduled "Friday"
# watchdog/digest tasks, which can only reach this via a plain GET.
# ---------------------------------------------------------------------------

@app.get("/api/health")
def health():
    return db.health_summary()


@app.get("/api/notify/test")
def notify_test():
    """Fires one real test push and reports exactly what happened —
    open this URL in a browser to troubleshoot why notifications aren't
    arriving, instead of guessing."""
    return notify.test()


@app.get("/api/digest")
def digest(date: Optional[str] = Query(None)):
    """Factual, server-computed figures for a single day (default:
    yesterday). Public and read-only, like the other GET endpoints — used
    by the scheduled 'Friday' digest task so it reports real numbers
    rather than an AI guess at arithmetic from raw JSON."""
    target = date or (datetime.date.today() - datetime.timedelta(days=1)).isoformat()
    reading = db.get_reading(target)
    cost = db.get_cost(target)
    rates = ai_assistant.get_rates()
    rate = ai_assistant.rate_for_date(target, rates)

    if not reading:
        return {"date": target, "entered": False}

    totals = reading.get("totals") or {}
    petrol_l = totals.get("petrol") or 0
    diesel_l = totals.get("diesel") or 0
    revenue = petrol_l * rate["petrol"] + diesel_l * rate["diesel"]
    operating_cost = 0.0
    for it in ((cost or {}).get("items") or []):
        if it.get("category") != "Fuel Purchase":
            operating_cost += it.get("amount") or 0

    return {
        "date": target,
        "entered": True,
        "petrolL": round(petrol_l, 2),
        "dieselL": round(diesel_l, 2),
        "revenue": round(revenue, 2),
        "operatingCost": round(operating_cost, 2),
        "netProfit": round(revenue - operating_cost, 2),
        "status": reading.get("status", "ok"),
    }


# ---------------------------------------------------------------------------
# Owner login check
# ---------------------------------------------------------------------------

@app.post("/api/owner/login")
def owner_login(x_owner_password: Optional[str] = Header(None)):
    if not x_owner_password or x_owner_password != OWNER_PASSWORD:
        raise HTTPException(status_code=401, detail="Invalid password")
    return {"ok": True}


# ---------------------------------------------------------------------------
# Static frontend
# ---------------------------------------------------------------------------

FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend")
if os.path.isdir(FRONTEND_DIR):
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
