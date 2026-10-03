"""
Faster one-time import for a FRESH/EMPTY database — skips the per-record
GET existence/protection check (there's nothing to protect yet) and sends
requests concurrently instead of one at a time.

Usage (from the backend/ folder, with your venv active):

    .\\venv\\Scripts\\python.exe import_via_api_fast.py https://pump-readings.onrender.com YOUR_OWNER_PASSWORD

WARNING: unlike import_via_api.py, this OVERWRITES any existing data for a
date without checking first. Only use this against a database you know is
empty (or where you're fine overwriting everything).
"""
import json
import os
import sys
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed

SEED_DIR = os.path.join(os.path.dirname(__file__), "seed_data")
IMPORTED_LABEL = "Imported from spreadsheet"
WORKERS = 16

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
            "initial": v.get("i"), "final": v.get("f"), "test": v.get("t") or 0,
            "litres": litres, "confirmedReset": bool(v.get("r")), "overridden": False,
        }
        fuel = PUMP_FUEL.get(pid)
        if fuel == "petrol":
            petrol_total += litres
        elif fuel == "diesel":
            diesel_total += litres
    return {
        "pumps": pumps_out,
        "totals": {"petrol": round(petrol_total, 2), "diesel": round(diesel_total, 2)},
        "enteredBy": IMPORTED_LABEL, "status": "ok",
    }


def build_cost_items(rec):
    return [{"category": it["c"], "amount": it["a"], "note": ""} for it in rec.get("items", [])]


def build_stock_doc(rec):
    return {
        "petrol": {"dip": 0, "received": rec.get("p") or 0, "note": ""},
        "diesel": {"dip": 0, "received": rec.get("ds") or 0, "note": ""},
        "cost": rec.get("cost") or 0, "note": "", "enteredBy": IMPORTED_LABEL,
    }


def load(name):
    with open(os.path.join(SEED_DIR, name), encoding="utf-8") as f:
        return json.load(f)


def request(method, url, body=None, owner_password=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if owner_password:
        req.add_header("X-Owner-Password", owner_password)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, None
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8")
    except Exception as e:
        return 0, str(e)


def run_batch(label, records, build_fn, url_fn, owner_password=None):
    print(f"Importing {len(records)} {label}...")
    ok, err = 0, 0
    done = 0
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futures = {}
        for rec in records:
            date = rec["d"]
            doc = build_fn(rec)
            fut = ex.submit(request, "PUT", url_fn(date), doc, owner_password)
            futures[fut] = date
        for fut in as_completed(futures):
            status, detail = fut.result()
            done += 1
            if status == 200:
                ok += 1
            else:
                err += 1
                print(f"  ERROR {futures[fut]}: {status} {detail}")
            if done % 100 == 0:
                print(f"  ...{done}/{len(records)}")
    return ok, err


def main():
    if len(sys.argv) < 3:
        print("Usage: python import_via_api_fast.py <base_url> <owner_password>")
        sys.exit(1)
    base = sys.argv[1].rstrip("/")
    owner_password = sys.argv[2]

    readings = load("historical_readings.json")
    costs = load("historical_costs.json")
    stock = load("historical_stock.json")

    r_ok, r_err = run_batch("readings", readings, build_reading_doc, lambda d: f"{base}/api/readings/{d}")
    c_ok, c_err = run_batch("cost records", costs,
                             lambda rec: {"items": build_cost_items(rec), "enteredBy": IMPORTED_LABEL},
                             lambda d: f"{base}/api/costs/{d}", owner_password)
    s_ok, s_err = run_batch("stock records", stock, build_stock_doc, lambda d: f"{base}/api/stock/{d}")

    print("\nImport complete:")
    print(f"  readings imported: {r_ok}  (errors: {r_err})")
    print(f"  costs imported:    {c_ok}  (errors: {c_err})")
    print(f"  stock imported:    {s_ok}  (errors: {s_err})")


if __name__ == "__main__":
    main()
