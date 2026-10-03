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
from pydantic import BaseModel

import database as db

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
    data = doc.dict()
    data["submittedAt"] = now_iso()
    db.upsert_reading(date, data)
    return db.get_reading(date)


@app.delete("/api/readings/{date}")
def delete_reading(date: str, x_owner_password: Optional[str] = Header(None)):
    require_owner(x_owner_password)
    db.delete_reading(date)
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
    return db.get_cost(date)


@app.put("/api/costs/{date}")
def replace_cost(date: str, body: CostReplace, x_owner_password: Optional[str] = Header(None)):
    """Owner's month-grid editor: replace the whole items list for a date."""
    require_owner(x_owner_password)
    db.upsert_cost(date, [i.dict() for i in body.items], body.enteredBy, now_iso())
    return db.get_cost(date)


@app.put("/api/costs/{date}/category")
def set_cost_category(date: str, body: CostCategoryAmount, x_owner_password: Optional[str] = Header(None)):
    """Owner cost-table single-cell edit, and the stock tab's Fuel Purchase auto-calc."""
    require_owner(x_owner_password)
    db.upsert_cost_category_amount(date, body.category, body.amount, body.enteredBy)
    return db.get_cost(date)


@app.delete("/api/costs/{date}/category/{category}")
def delete_cost_category(date: str, category: str, x_owner_password: Optional[str] = Header(None)):
    require_owner(x_owner_password)
    db.delete_cost_category(date, category)
    return {"ok": True}


@app.delete("/api/costs/{date}")
def delete_cost(date: str, x_owner_password: Optional[str] = Header(None)):
    require_owner(x_owner_password)
    db.delete_cost(date)
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
    return db.get_stock(date)


@app.delete("/api/stock/{date}")
def delete_stock(date: str, x_owner_password: Optional[str] = Header(None)):
    require_owner(x_owner_password)
    db.delete_stock(date)
    db.delete_cost_category(date, FUEL_PURCHASE_CATEGORY)
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
    return current


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
