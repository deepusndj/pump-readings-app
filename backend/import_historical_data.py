"""
One-time import of the historical spreadsheet data (originally embedded in
the Claude-artifact version of this app) into the standalone SQLite database.

Run from the backend/ folder, with the venv's Python, after init_db has run
at least once (starting the server once is enough):

    .\\venv\\Scripts\\python.exe import_historical_data.py

Safe to re-run: any date that already has REAL (non-imported) data in it is
left untouched — only missing dates, or dates that were themselves filled in
by a previous import, get written.
"""
import json
import os

import database as db

SEED_DIR = os.path.join(os.path.dirname(__file__), "seed_data")
IMPORTED_LABEL = "Imported from spreadsheet"

PUMP_FUEL = {
    "petrolA1": "petrol", "petrolA2": "petrol", "petrolB1": "petrol", "petrolB2": "petrol",
    "dieselA1": "diesel", "dieselA2": "diesel", "dieselB1": "diesel", "dieselB2": "diesel",
}


def build_reading_doc(rec):
    pumps_out = {}
    petrol_total = 0.0
    diesel_total = 0.0
    for pid, v in (rec.get("p") or {}).items():
        if not v:
            continue
        litres = v.get("l") or 0
        pumps_out[pid] = {
            "initial": v.get("i"),
            "final": v.get("f"),
            "test": v.get("t") or 0,
            "litres": litres,
            "confirmedReset": bool(v.get("r")),
            "overridden": False,
        }
        fuel = PUMP_FUEL.get(pid)
        if fuel == "petrol":
            petrol_total += litres
        elif fuel == "diesel":
            diesel_total += litres
    return {
        "pumps": pumps_out,
        "totals": {"petrol": round(petrol_total, 2), "diesel": round(diesel_total, 2)},
        "enteredBy": IMPORTED_LABEL,
        "submittedAt": rec["d"] + "T00:00:00.000Z",
        "status": "ok",
    }


def build_cost_items(rec):
    return [{"category": it["c"], "amount": it["a"], "note": ""} for it in rec.get("items", [])]


def build_stock_doc(rec):
    return {
        "petrol": {"dip": None, "received": rec.get("p"), "note": ""},
        "diesel": {"dip": None, "received": rec.get("ds"), "note": ""},
        "cost": rec.get("cost") or 0,
        "note": "",
        "enteredBy": IMPORTED_LABEL,
    }


def is_protected(existing):
    """A date is protected (left alone) if it already has data that a real
    person entered, i.e. anything whose enteredBy isn't our import label."""
    return existing is not None and existing.get("enteredBy") != IMPORTED_LABEL


def load(name):
    with open(os.path.join(SEED_DIR, name), encoding="utf-8") as f:
        return json.load(f)


def main():
    db.init_db()
    counts = {"readings": 0, "costs": 0, "stock": 0, "skipped": 0}

    for rec in load("historical_readings.json"):
        existing = db.get_reading(rec["d"])
        if is_protected(existing):
            counts["skipped"] += 1
            continue
        doc = build_reading_doc(rec)
        db.upsert_reading(rec["d"], doc)
        counts["readings"] += 1

    for rec in load("historical_costs.json"):
        existing = db.get_cost(rec["d"])
        if is_protected(existing):
            counts["skipped"] += 1
            continue
        items = build_cost_items(rec)
        db.upsert_cost(rec["d"], items, IMPORTED_LABEL, rec["d"] + "T00:00:00.000Z")
        counts["costs"] += 1

    for rec in load("historical_stock.json"):
        existing = db.get_stock(rec["d"])
        if is_protected(existing):
            counts["skipped"] += 1
            continue
        doc = build_stock_doc(rec)
        db.upsert_stock(
            rec["d"], doc["petrol"], doc["diesel"], doc["cost"], doc["note"],
            doc["enteredBy"], rec["d"] + "T00:00:00.000Z",
        )
        counts["stock"] += 1

    print("Import complete:")
    print(f"  readings imported: {counts['readings']}")
    print(f"  costs imported:    {counts['costs']}")
    print(f"  stock imported:    {counts['stock']}")
    print(f"  dates skipped (already had real data): {counts['skipped']}")


if __name__ == "__main__":
    main()
