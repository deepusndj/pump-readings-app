"""
AI Assistant — ported from the original Claude-Artifact version's "AI
Assistant" tab, but running against a real model API instead of the
in-artifact window.claude.complete(). Uses Google Gemini's free API tier
(function calling / tool use), since that's what the owner has access to
without a paid API key.

Design, mirroring the artifact as closely as a stateless HTTP backend
allows:
  - A snapshot of the last 90 days of readings/costs (plus summary totals)
    is given to the model up front, same as the artifact's buildAiSnapshot().
  - READ tools (get_readings_range, get_cost_detail, ...) are executed
    immediately and fed straight back to the model — no confirmation needed,
    they can't change anything.
  - WRITE tools (update_reading_pump, add_cost, ...) are NEVER executed by
    this module directly when the model calls them. Instead the call is
    paused and handed back to the frontend as a "pending confirmation" —
    exactly like the artifact's requestOwnerConfirmation() Promise. Only
    POST /api/ai/resolve (after the owner clicks Confirm) actually performs
    the database write.
  - The whole Gemini conversation ("contents") is stateless on the server:
    the frontend holds it and resends it every call, the same way the rest
    of this app has no server-side session state.
"""
import datetime
import json
import os

import httpx

import database as db

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.8-flash")
GEMINI_URL = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"

PUMPS = [
    {"id": "petrolA1", "label": "Petrol A1", "fuel": "petrol"},
    {"id": "petrolA2", "label": "Petrol A2", "fuel": "petrol"},
    {"id": "petrolB1", "label": "Petrol B1", "fuel": "petrol"},
    {"id": "petrolB2", "label": "Petrol B2", "fuel": "petrol"},
    {"id": "dieselA1", "label": "Diesel A1", "fuel": "diesel"},
    {"id": "dieselA2", "label": "Diesel A2", "fuel": "diesel"},
    {"id": "dieselB1", "label": "Diesel B1", "fuel": "diesel"},
    {"id": "dieselB2", "label": "Diesel B2", "fuel": "diesel"},
]
PUMP_IDS = [p["id"] for p in PUMPS]
PUMP_LABEL = {p["id"]: p["label"] for p in PUMPS}
PUMP_FUEL = {p["id"]: p["fuel"] for p in PUMPS}

COST_CATEGORIES = ["Fuel Purchase", "Salary", "Electricity", "Minor Tools",
                    "Rent for Swiping Machines", "Tea", "Watercan", "Cleaning",
                    "Miscellaneous", "Other"]

# Same historical selling-rate change points embedded in frontend/app.js —
# kept in sync manually since there's no shared module between the two yet.
RATE_CHANGES = [
    {"d": "2024-08-18", "p": 105.65, "ds": 94.63},
    {"d": "2024-11-10", "p": 105.7, "ds": 94.68},
    {"d": "2025-01-01", "p": 105.71, "ds": 94.69},
    {"d": "2026-05-15", "p": 108.98, "ds": 97.85},
    {"d": "2026-05-19", "p": 109.93, "ds": 98.81},
    {"d": "2026-05-23", "p": 110.87, "ds": 99.78},
]

AI_SUGGESTIONS = [
    "How did we do this month?",
    "Forecast diesel sales for next month",
    "Any anomalies in the last 30 days?",
    "Where can we cut costs?",
]

WRITE_TOOL_NAMES = {
    "update_reading_pump", "delete_reading", "add_cost", "delete_cost_item",
    "update_stock", "delete_stock_entry", "update_targets", "update_rates",
}


# ---------------------------------------------------------------------------
# date / rate helpers
# ---------------------------------------------------------------------------

def today_str():
    return datetime.date.today().isoformat()


def days_ago(n):
    return (datetime.date.today() - datetime.timedelta(days=n)).isoformat()


def rate_for_date(date_str, fallback):
    match = None
    for c in RATE_CHANGES:
        if c["d"] <= date_str:
            match = c
        else:
            break
    if not match:
        match = RATE_CHANGES[0] if RATE_CHANGES else None
    if not match:
        return {"petrol": fallback["petrol"], "diesel": fallback["diesel"]}
    return {"petrol": match["p"], "diesel": match["ds"]}


def get_rates():
    return db.get_setting("rates", db.DEFAULT_RATES)


def get_targets():
    return db.get_setting("targets", db.DEFAULT_TARGETS)


# ---------------------------------------------------------------------------
# snapshot (fed to the model as its opening context, like aiLeadingTurn())
# ---------------------------------------------------------------------------

def month_range(month_key):
    y, m = (int(x) for x in month_key.split("-"))
    from_d = f"{month_key}-01"
    last_day = (datetime.date(y + (m == 12), (m % 12) + 1, 1) - datetime.timedelta(days=1)).day
    to_d = f"{month_key}-{last_day:02d}"
    return from_d, to_d


def monthly_figures(month_key, rates, targets):
    from_d, to_d = month_range(month_key)
    readings = db.list_readings(from_d, to_d, 100)
    costs = db.list_costs(from_d, to_d, 100)
    petrol_l = sum((r.get("totals") or {}).get("petrol") or 0 for r in readings)
    diesel_l = sum((r.get("totals") or {}).get("diesel") or 0 for r in readings)
    revenue = 0.0
    for r in readings:
        rate = rate_for_date(r["date"], rates)
        totals = r.get("totals") or {}
        revenue += (totals.get("petrol") or 0) * rate["petrol"] + (totals.get("diesel") or 0) * rate["diesel"]
    operating_cost = 0.0
    for c in costs:
        for it in (c.get("items") or []):
            if it.get("category") != "Fuel Purchase":
                operating_cost += it.get("amount") or 0
    margin_p = rates.get("marginPetrol", 2.75)
    margin_d = rates.get("marginDiesel", 2.22)
    fuel_profit = petrol_l * margin_p + diesel_l * margin_d
    return {
        "petrolL": petrol_l, "dieselL": diesel_l, "revenue": revenue,
        "operatingCost": operating_cost, "netProfit": fuel_profit - operating_cost,
    }


def build_ai_snapshot():
    rates = get_rates()
    targets = get_targets()
    margin_p = rates.get("marginPetrol", 2.75)
    margin_d = rates.get("marginDiesel", 2.22)

    cutoff = days_ago(90)
    readings = [r for r in db.list_readings(None, None, 1000) if r["date"] >= cutoff]
    readings.sort(key=lambda r: r["date"])
    all_readings = db.list_readings(None, None, 1000)
    all_costs = db.list_costs(None, None, 1000)

    costs_by_date = {}
    for c in all_costs:
        total = sum((it.get("amount") or 0) for it in (c.get("items") or []))
        costs_by_date[c["date"]] = costs_by_date.get(c["date"], 0) + total

    daily = []
    for r in readings:
        totals = r.get("totals") or {}
        petrol, diesel = totals.get("petrol") or 0, totals.get("diesel") or 0
        rate = rate_for_date(r["date"], rates)
        revenue = petrol * rate["petrol"] + diesel * rate["diesel"]
        cost = costs_by_date.get(r["date"], 0)
        fuel_profit = petrol * margin_p + diesel * margin_d
        daily.append({
            "date": r["date"], "petrolL": round(petrol), "dieselL": round(diesel),
            "revenue": round(revenue), "operatingCost": round(cost),
            "fuelProfit": round(fuel_profit), "netProfit": round(fuel_profit - cost),
            "petrolTargetMet": petrol >= targets.get("petrol", 0),
            "dieselTargetMet": diesel >= targets.get("diesel", 0),
            "status": r.get("status", "ok"),
        })

    all_petrol_l = sum((r.get("totals") or {}).get("petrol") or 0 for r in all_readings)
    all_diesel_l = sum((r.get("totals") or {}).get("diesel") or 0 for r in all_readings)
    all_operating_cost = 0.0
    all_fuel_purchase = 0.0
    for c in all_costs:
        for it in (c.get("items") or []):
            if it.get("category") == "Fuel Purchase":
                all_fuel_purchase += it.get("amount") or 0
            else:
                all_operating_cost += it.get("amount") or 0
    all_time_fuel_profit = all_petrol_l * margin_p + all_diesel_l * margin_d
    all_time_net_profit = all_time_fuel_profit - all_operating_cost

    def avg(arr, key):
        return round(sum(d[key] for d in arr) / len(arr)) if arr else 0

    last7, last30 = daily[-7:], daily[-30:]
    this_month = monthly_figures(today_str()[:7], rates, targets)

    return {
        "today": today_str(),
        "currentRates": {
            "petrol": rates.get("petrol"), "diesel": rates.get("diesel"),
            "marginPetrolPerL": margin_p, "marginDieselPerL": margin_d,
            "petrolEvaporationPct": round(rates.get("petrolDepreciation", 0.24) * 100),
        },
        "dailyTargetsL": {"petrol": targets.get("petrol"), "diesel": targets.get("diesel")},
        "recordedDaysInCache": len(all_readings),
        "allTimeTotals": {
            "petrolL": round(all_petrol_l), "dieselL": round(all_diesel_l),
            "operatingCost": round(all_operating_cost), "fuelPurchaseCostRef": round(all_fuel_purchase),
            "fuelGrossProfit": round(all_time_fuel_profit), "netProfit": round(all_time_net_profit),
            "note": "Totals over every day currently stored (up to 1000 most recent).",
        },
        "currentMonth": {
            "month": today_str()[:7], "petrolL": round(this_month["petrolL"]), "dieselL": round(this_month["dieselL"]),
            "revenue": round(this_month["revenue"]), "operatingCost": round(this_month["operatingCost"]),
            "netProfit": round(this_month["netProfit"]),
        },
        "last7DayAvg": {"petrolL": avg(last7, "petrolL"), "dieselL": avg(last7, "dieselL"), "netProfit": avg(last7, "netProfit")},
        "last30DayAvg": {"petrolL": avg(last30, "petrolL"), "dieselL": avg(last30, "dieselL"), "netProfit": avg(last30, "netProfit")},
        "dailyLast90Days": daily,
    }


# ---------------------------------------------------------------------------
# Owner summary / daily briefing — a single plain-text Gemini call (no
# tools, no conversation history), generated automatically whenever the
# owner opens the Summary tab. Mirrors the artifact's buildBriefingContext /
# briefingPrompt / generateBriefing.
# ---------------------------------------------------------------------------

def sum_range(start, end):
    """Inclusive day offsets from today, e.g. (0,6) = last 7 days, oldest first."""
    return [days_ago(i) for i in range(end, start - 1, -1)]


def summarize_date_window(dates, readings_by_date, cost_by_date, rates):
    margin_p = rates.get("marginPetrol", 2.75)
    margin_d = rates.get("marginDiesel", 2.22)
    petrol_l = diesel_l = revenue = cost = 0.0
    days_with_entry = 0
    missing_dates = []
    review_flagged_dates = []
    for d in dates:
        r = readings_by_date.get(d)
        if not r:
            missing_dates.append(d)
            continue
        days_with_entry += 1
        totals = r.get("totals") or {}
        p, ds = totals.get("petrol") or 0, totals.get("diesel") or 0
        petrol_l += p
        diesel_l += ds
        rate = rate_for_date(d, rates)
        revenue += p * rate["petrol"] + ds * rate["diesel"]
        cost += cost_by_date.get(d, 0)
        if r.get("status") == "needs_review":
            review_flagged_dates.append(d)
    fuel_profit = petrol_l * margin_p + diesel_l * margin_d
    return {
        "totalDays": len(dates), "daysWithEntry": days_with_entry, "missingDates": missing_dates,
        "petrolL": round(petrol_l), "dieselL": round(diesel_l),
        "revenue": round(revenue), "operatingCost": round(cost),
        "netProfit": round(fuel_profit - cost), "reviewFlaggedDates": review_flagged_dates,
    }


def find_unusual_days(dates, readings_by_date):
    present = [d for d in dates if d in readings_by_date]
    if len(present) < 4:
        return []
    avg_petrol = sum((readings_by_date[d].get("totals") or {}).get("petrol") or 0 for d in present) / len(present)
    avg_diesel = sum((readings_by_date[d].get("totals") or {}).get("diesel") or 0 for d in present) / len(present)
    unusual = []
    for d in present:
        totals = readings_by_date[d].get("totals") or {}
        p, ds = totals.get("petrol") or 0, totals.get("diesel") or 0
        if avg_petrol > 0 and (p < avg_petrol * 0.5 or p > avg_petrol * 1.6):
            unusual.append({"date": d, "fuel": "petrol", "litres": round(p), "recentAvg": round(avg_petrol)})
        if avg_diesel > 0 and (ds < avg_diesel * 0.5 or ds > avg_diesel * 1.6):
            unusual.append({"date": d, "fuel": "diesel", "litres": round(ds), "recentAvg": round(avg_diesel)})
    return unusual


def shift_month(month_key, delta):
    y, m = (int(x) for x in month_key.split("-"))
    idx = (y * 12 + (m - 1)) + delta
    return f"{idx // 12}-{(idx % 12) + 1:02d}"


def build_briefing_context():
    rates = get_rates()
    targets = get_targets()
    all_readings = db.list_readings(None, None, 1000)
    all_costs = db.list_costs(None, None, 1000)
    readings_by_date = {r["date"]: r for r in all_readings}
    cost_by_date = {}
    for c in all_costs:
        total = sum((it.get("amount") or 0) for it in (c.get("items") or []))
        cost_by_date[c["date"]] = cost_by_date.get(c["date"], 0) + total

    this_week = summarize_date_window(sum_range(0, 6), readings_by_date, cost_by_date, rates)
    last_week = summarize_date_window(sum_range(7, 13), readings_by_date, cost_by_date, rates)
    last_30 = sum_range(0, 29)
    this_month_key = today_str()[:7]
    this_month = monthly_figures(this_month_key, rates, targets)
    prev_month_key = shift_month(this_month_key, -1)
    prev_month = monthly_figures(prev_month_key, rates, targets)
    unusual_days = find_unusual_days(last_30, readings_by_date)

    costs_by_category_last_30 = {}
    last_30_set = set(last_30)
    for c in all_costs:
        if c["date"] in last_30_set:
            for it in (c.get("items") or []):
                costs_by_category_last_30[it["category"]] = costs_by_category_last_30.get(it["category"], 0) + (it.get("amount") or 0)

    return {
        "today": today_str(),
        "thisWeek": this_week, "lastWeek": last_week,
        "thisMonthToDate": {"month": this_month_key, "petrolL": round(this_month["petrolL"]), "dieselL": round(this_month["dieselL"]),
                             "revenue": round(this_month["revenue"]), "operatingCost": round(this_month["operatingCost"]), "netProfit": round(this_month["netProfit"])},
        "previousMonth": {"month": prev_month_key, "petrolL": round(prev_month["petrolL"]), "dieselL": round(prev_month["dieselL"]),
                           "revenue": round(prev_month["revenue"]), "operatingCost": round(prev_month["operatingCost"]), "netProfit": round(prev_month["netProfit"])},
        "unusualDaysLast30": unusual_days,
        "costsByCategoryLast30": {k: round(v) for k, v in costs_by_category_last_30.items()},
        "dailyTargetsL": targets,
        "currentRates": {"petrol": rates.get("petrol"), "diesel": rates.get("diesel"),
                          "marginPetrolPerL": rates.get("marginPetrol"), "marginDieselPerL": rates.get("marginDiesel")},
    }


def briefing_prompt(ctx):
    return (
        'You are the built-in AI analyst inside "Pump Readings", a daily entry and analytics app for a '
        'Bharat Petroleum-franchised fuel station in India. The owner just opened the app. Write a short daily '
        "briefing — the kind of 30-second update a sharp manager would give, not a report to study.\n\n"
        "Cover, in a natural paragraph or two (not rigid labeled sections, no markdown headers): how sales for the "
        "week look (litres and revenue — petrol and diesel), how sales for the month look so far (and vs. last "
        "month if that comparison is meaningful), how costs are trending, and anything that stands out — a notably "
        "good or bad day, a cost spike, a reading flagged for review, missing entries, or any other clear anomaly. "
        'If "missingDates" is non-empty for the current week, say plainly which recent days have no reading logged '
        "at all — that's important, don't bury it. If there is truly nothing unusual, say so briefly instead of "
        "inventing concern. If there is barely any data at all, say that plainly instead of guessing.\n\n"
        "Be concise — aim for under 120 words. Numbers-first, ₹ for money, L for litres, no fluff or greetings. "
        "Do not repeat raw JSON back. Do not offer to do anything else or ask questions — this is a one-way "
        "briefing, not a chat turn.\n\n"
        "Data (JSON):\n" + json.dumps(ctx)
    )


async def generate_briefing():
    if not GEMINI_API_KEY:
        raise AiNotConfigured("GEMINI_API_KEY is not set on the server.")
    ctx = build_briefing_context()
    payload = {"contents": [{"role": "user", "parts": [{"text": briefing_prompt(ctx)}]}]}
    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.post(GEMINI_URL, params={"key": GEMINI_API_KEY}, json=payload)
    if resp.status_code != 200:
        raise RuntimeError(f"Gemini API error {resp.status_code}: {resp.text[:500]}")
    data = resp.json()
    candidates = data.get("candidates") or []
    parts = (candidates[0]["content"].get("parts") or []) if candidates else []
    text = "".join(p.get("text", "") for p in parts).strip()
    return text or "(no briefing generated)"


def system_instruction():
    snapshot = build_ai_snapshot()
    return (
        'You are the built-in AI analyst inside "Pump Readings" — the daily entry and analytics app for a '
        'Bharat Petroleum-franchised fuel station in India. Only the owner can see or talk to you. Speak directly to the owner.\n\n'
        "What you do: analyze the station's fuel sales, costs, stock and margins; answer questions about performance; "
        "point out anomalies or trends worth their attention; and forecast future sales/profit when asked. "
        'Be concise and numbers-first — this is a busy owner checking in, not reading a report. Use ₹ for money and "L" for litres. '
        "Round to whole numbers unless precision matters.\n\n"
        "Forecasting: there is no dedicated forecast tool — reason over the daily data below, pulling more history with the "
        "read tools whenever that beats eyeballing the snapshot. State your method in one short clause, give a clear number or "
        "range, and note briefly that it's an estimate, not a guarantee.\n\n"
        "Looking up more data: the snapshot below only covers the last 90 days plus totals, so use the read tools whenever a "
        "question needs more than that — never say you lack visibility into something a tool can answer. get_readings_range / "
        "get_reading_detail for pump-by-pump fuel readings; get_costs_range for itemized expenses over a range; get_cost_detail "
        "for one date's full breakdown; get_cost_category_totals to total spend per category; get_stock_range / get_stock_detail "
        "for tank dips and litres received; get_rate_history for every past change to the selling rate.\n\n"
        "Changing data: if the owner asks you to add, correct, or delete a reading, cost entry, stock entry, target, or "
        "margin/rate, call the matching tool directly — do not just describe the change and do not ask for confirmation in your "
        "own text first. Every one of those tools shows the owner a Confirm/Cancel card and will not save or delete anything "
        "until the owner clicks Confirm there — so just call the tool with your best understanding of what they asked for. "
        "If the result has cancelledByOwner: true, tell them plainly that nothing was changed. If it has confirmed: true, "
        "confirm plainly what changed (old value → new value where relevant). If a request is ambiguous (which date, which "
        "pump, which category), ask one short clarifying question before calling the tool, rather than guessing. Deleting is "
        'permanent (update_reading_pump corrects one field — prefer it over delete_reading unless the owner wants the whole '
        "day's reading gone; delete_cost_item removes a whole category's entries for a date; delete_stock_entry removes a whole "
        'day\'s tank entry and clears its linked Fuel Purchase cost). "Fuel Purchase" costs are calculated automatically from '
        "Stock tab deliveries — never add or delete them directly with add_cost/delete_cost_item; change litres received instead.\n\n"
        "Data schema notes: pump IDs are petrolA1, petrolA2, petrolB1, petrolB2 (petrol) and dieselA1, dieselA2, dieselB1, "
        "dieselB2 (diesel). A reading's litres = final − initial − test. Net profit = (petrol L × margin/L) + "
        "(diesel L × margin/L) − operating costs (excluding Fuel Purchase).\n\n"
        "Live data snapshot (JSON, last 90 days plus summary totals):\n" + json.dumps(snapshot)
    )


# ---------------------------------------------------------------------------
# tool schemas (Gemini functionDeclarations format)
# ---------------------------------------------------------------------------

def _schema(properties, required=None):
    return {"type": "OBJECT", "properties": properties, **({"required": required} if required else {})}


def _str(desc=None, enum=None):
    d = {"type": "STRING"}
    if desc:
        d["description"] = desc
    if enum:
        d["enum"] = enum
    return d


def _num(desc=None):
    d = {"type": "NUMBER"}
    if desc:
        d["description"] = desc
    return d


READ_TOOL_DECLS = [
    {
        "name": "get_readings_range",
        "description": "Get daily petrol/diesel litres totals and status for a date range beyond the last-90-days snapshot. Range capped at 180 days.",
        "parameters": _schema({"from": _str("YYYY-MM-DD"), "to": _str("YYYY-MM-DD")}, ["from", "to"]),
    },
    {
        "name": "get_reading_detail",
        "description": "Get the full pump-by-pump reading (initial/final/test/litres for every pump) for one date.",
        "parameters": _schema({"date": _str("YYYY-MM-DD")}, ["date"]),
    },
    {
        "name": "get_costs_range",
        "description": "Get every itemized expense line (category, amount, note) for each date in a range. Range capped at 180 days.",
        "parameters": _schema({"from": _str("YYYY-MM-DD"), "to": _str("YYYY-MM-DD")}, ["from", "to"]),
    },
    {
        "name": "get_cost_detail",
        "description": "Get the full expense breakdown for one date.",
        "parameters": _schema({"date": _str("YYYY-MM-DD")}, ["date"]),
    },
    {
        "name": "get_cost_category_totals",
        "description": "Total spend per expense category over a date range — use for 'where is the money going?' type questions.",
        "parameters": _schema({"from": _str("YYYY-MM-DD"), "to": _str("YYYY-MM-DD")}, ["from", "to"]),
    },
    {
        "name": "get_stock_range",
        "description": "Get tank dip readings and litres received for each date in a range. Range capped at 180 days.",
        "parameters": _schema({"from": _str("YYYY-MM-DD"), "to": _str("YYYY-MM-DD")}, ["from", "to"]),
    },
    {
        "name": "get_stock_detail",
        "description": "Get the full stock entry (both tanks) for one date.",
        "parameters": _schema({"date": _str("YYYY-MM-DD")}, ["date"]),
    },
    {
        "name": "get_rate_history",
        "description": "Get every past change to the selling rate (petrol/diesel price per litre, with effective date).",
        "parameters": _schema({}),
    },
]

WRITE_TOOL_DECLS = [
    {
        "name": "update_reading_pump",
        "description": "Correct one pump's reading on one date. field is 'initial', 'final' or 'test'. Recomputes that pump's litres and the day's totals automatically. Requires owner confirmation before saving.",
        "parameters": _schema({
            "date": _str("YYYY-MM-DD"), "pumpId": _str(enum=PUMP_IDS),
            "field": _str(enum=["initial", "final", "test"]), "value": _num(),
        }, ["date", "pumpId", "field", "value"]),
    },
    {
        "name": "delete_reading",
        "description": "Delete the ENTIRE reading for one date (every pump). Use only when the whole day's reading should be removed — for a single wrong number use update_reading_pump instead. Requires owner confirmation.",
        "parameters": _schema({"date": _str("YYYY-MM-DD")}, ["date"]),
    },
    {
        "name": "add_cost",
        "description": "Add one expense line item on a date (appends). category should be one of: Salary, Electricity, Minor Tools, Rent for Swiping Machines, Tea, Watercan, Cleaning, Miscellaneous, Other. ('Fuel Purchase' is calculated automatically — never add it here.) Requires owner confirmation.",
        "parameters": _schema({"date": _str("YYYY-MM-DD"), "category": _str(), "amount": _num(), "note": _str()}, ["date", "category", "amount"]),
    },
    {
        "name": "delete_cost_item",
        "description": "Remove all expense line items of one category on one date. Requires owner confirmation.",
        "parameters": _schema({"date": _str("YYYY-MM-DD"), "category": _str()}, ["date", "category"]),
    },
    {
        "name": "update_stock",
        "description": "Set one tank's dip reading and/or litres received on a date. Only overwrites that tank. 'Fuel Purchase' cost is recalculated automatically if litres received changes. Requires owner confirmation.",
        "parameters": _schema({
            "date": _str("YYYY-MM-DD"), "fuel": _str(enum=["petrol", "diesel"]),
            "dip": _num(), "received": _num(), "note": _str(),
        }, ["date", "fuel"]),
    },
    {
        "name": "delete_stock_entry",
        "description": "Delete the entire stock entry (both tanks) for one date, and clear its auto-calculated Fuel Purchase cost. Requires owner confirmation.",
        "parameters": _schema({"date": _str("YYYY-MM-DD")}, ["date"]),
    },
    {
        "name": "update_targets",
        "description": "Change the daily litre targets. Pass only the ones that change. Requires owner confirmation.",
        "parameters": _schema({"petrol": _num(), "diesel": _num()}),
    },
    {
        "name": "update_rates",
        "description": "Change the current selling rate, profit margin, and/or purchase cost per litre. Pass only the fields that change. Requires owner confirmation.",
        "parameters": _schema({
            "petrol": _num(), "diesel": _num(), "marginPetrol": _num(), "marginDiesel": _num(),
            "purchaseCostPetrol": _num(), "purchaseCostDiesel": _num(),
        }),
    },
]

ALL_TOOLS = [{"functionDeclarations": READ_TOOL_DECLS + WRITE_TOOL_DECLS}]


# ---------------------------------------------------------------------------
# read-tool execution (safe, no confirmation needed)
# ---------------------------------------------------------------------------

def run_read_tool(name, args):
    if name == "get_readings_range":
        rows = db.list_readings(args.get("from"), args.get("to"), 200)
        return [{"date": r["date"], "petrolL": (r.get("totals") or {}).get("petrol"),
                 "dieselL": (r.get("totals") or {}).get("diesel"), "status": r.get("status")} for r in rows]
    if name == "get_reading_detail":
        return db.get_reading(args.get("date")) or {"found": False}
    if name == "get_costs_range":
        return db.list_costs(args.get("from"), args.get("to"), 200)
    if name == "get_cost_detail":
        return db.get_cost(args.get("date")) or {"found": False}
    if name == "get_cost_category_totals":
        rows = db.list_costs(args.get("from"), args.get("to"), 500)
        totals = {}
        for c in rows:
            for it in (c.get("items") or []):
                totals[it["category"]] = totals.get(it["category"], 0) + (it.get("amount") or 0)
        return totals
    if name == "get_stock_range":
        return db.list_stock(args.get("from"), args.get("to"), 200)
    if name == "get_stock_detail":
        return db.get_stock(args.get("date")) or {"found": False}
    if name == "get_rate_history":
        return RATE_CHANGES
    return {"error": f"unknown read tool {name}"}


# ---------------------------------------------------------------------------
# write-tool confirmation summaries + execution (only after owner confirms)
# ---------------------------------------------------------------------------

def summarize_write_call(name, args):
    """Human-readable 'about to do X' text shown on the confirm card, built
    from CURRENT state — mirrors the artifact's per-tool confirmation copy."""
    if name == "update_reading_pump":
        date, pump_id, field = args.get("date"), args.get("pumpId"), args.get("field")
        reading = db.get_reading(date)
        old = ((reading or {}).get("pumps") or {}).get(pump_id, {}).get(field)
        pump_label = PUMP_LABEL.get(pump_id, pump_id)
        return f"Change {pump_label} {field} reading on {date}: {old if old is not None else '—'} → {args.get('value')}"
    if name == "delete_reading":
        return f"Delete the ENTIRE reading for {args.get('date')} — every pump's meter entry for that day. This cannot be undone."
    if name == "add_cost":
        note = f" ({args.get('note')})" if args.get("note") else ""
        return f"Add expense on {args.get('date')}: {args.get('category')} — ₹{args.get('amount')}{note}"
    if name == "delete_cost_item":
        date, category = args.get("date"), args.get("category")
        cost = db.get_cost(date)
        items = [it for it in ((cost or {}).get("items") or []) if it.get("category") == category]
        total = sum(it.get("amount") or 0 for it in items)
        return f"Delete {category} expense(s) on {date}, totalling ₹{total}"
    if name == "update_stock":
        date, fuel = args.get("date"), args.get("fuel")
        stock = db.get_stock(date) or {}
        prev = stock.get(fuel) or {}
        parts = []
        if args.get("dip") is not None:
            parts.append(f"dip {prev.get('dip', '—')} → {args.get('dip')}")
        if args.get("received") is not None:
            parts.append(f"received {prev.get('received', 0)} → {args.get('received')} L")
        return f"Update {fuel} tank on {date}: {', '.join(parts) or 'no change'}"
    if name == "delete_stock_entry":
        return f"Delete the entire stock entry for {args.get('date')} (both tanks) and clear its Fuel Purchase cost. This cannot be undone."
    if name == "update_targets":
        current = get_targets()
        p = args.get("petrol", current.get("petrol"))
        d = args.get("diesel", current.get("diesel"))
        return f"Change daily targets: petrol {current.get('petrol')} → {p} L, diesel {current.get('diesel')} → {d} L"
    if name == "update_rates":
        current = get_rates()
        changes = []
        for key, label, prefix in [("petrol", "petrol rate", "₹"), ("diesel", "diesel rate", "₹"),
                                    ("marginPetrol", "petrol margin", "₹"), ("marginDiesel", "diesel margin", "₹"),
                                    ("purchaseCostPetrol", "petrol purchase cost", "₹"),
                                    ("purchaseCostDiesel", "diesel purchase cost", "₹")]:
            if args.get(key) is not None and args.get(key) != current.get(key):
                changes.append(f"{label} {prefix}{current.get(key)} → {prefix}{args.get(key)}")
        return "Change rates: " + ", ".join(changes) if changes else "No rate changes to make"
    return f"Run {name} with {json.dumps(args)}"


def execute_write_call(name, args):
    """Actually perform the database change. Only ever called after the
    owner has clicked Confirm on this specific call."""
    now = datetime.datetime.utcnow().isoformat() + "Z"

    if name == "update_reading_pump":
        date, pump_id, field, value = args["date"], args["pumpId"], args["field"], float(args["value"])
        reading = db.get_reading(date)
        if not reading:
            return {"confirmed": False, "error": f"No reading exists for {date} yet."}
        pumps = dict(reading.get("pumps") or {})
        old_pump = dict(pumps.get(pump_id) or {"initial": None, "final": None, "test": 0, "litres": 0})
        old_value = old_pump.get(field)
        new_pump = dict(old_pump)
        new_pump[field] = value
        if new_pump.get("final") is not None and new_pump.get("initial") is not None:
            litres = new_pump["final"] - new_pump["initial"] - (new_pump.get("test") or 0)
        else:
            litres = old_pump.get("litres", 0)
        new_pump["litres"] = litres
        pumps[pump_id] = new_pump
        petrol_total = sum((pumps.get(p["id"]) or {}).get("litres") or 0 for p in PUMPS if p["fuel"] == "petrol")
        diesel_total = sum((pumps.get(p["id"]) or {}).get("litres") or 0 for p in PUMPS if p["fuel"] == "diesel")
        doc = dict(reading)
        doc["pumps"] = pumps
        doc["totals"] = {"petrol": petrol_total, "diesel": diesel_total}
        db.upsert_reading(date, doc)
        return {"confirmed": True, "date": date, "pumpId": pump_id, "field": field,
                "oldValue": old_value, "newValue": value, "newLitres": litres,
                "newDayTotals": {"petrol": petrol_total, "diesel": diesel_total}}

    if name == "delete_reading":
        date = args["date"]
        if not db.get_reading(date):
            return {"confirmed": False, "notFound": True, "date": date}
        db.delete_reading(date)
        return {"confirmed": True, "deleted": True, "date": date}

    if name == "add_cost":
        date, category, amount = args["date"], args["category"], float(args["amount"])
        note = args.get("note", "")
        if category == "Fuel Purchase":
            return {"confirmed": False, "error": "Fuel Purchase is calculated automatically from Stock tab deliveries."}
        existing = db.get_cost(date)
        items = list((existing or {}).get("items") or [])
        new_item = {"category": category, "amount": amount, "note": note, "enteredBy": "AI Assistant", "addedAt": now}
        items.append(new_item)
        db.upsert_cost(date, items, (existing or {}).get("enteredBy", "AI Assistant"), now)
        return {"confirmed": True, "date": date, "added": new_item}

    if name == "delete_cost_item":
        date, category = args["date"], args["category"]
        db.delete_cost_category(date, category)
        return {"confirmed": True, "date": date, "category": category}

    if name == "update_stock":
        date, fuel = args["date"], args["fuel"]
        existing = db.get_stock(date) or {"date": date, "petrol": {}, "diesel": {}, "cost": 0, "note": "", "enteredBy": ""}
        prev_tank = existing.get(fuel) or {}
        next_dip = float(args["dip"]) if args.get("dip") is not None else prev_tank.get("dip", 0)
        next_received = float(args["received"]) if args.get("received") is not None else prev_tank.get("received", 0)
        petrol = dict(existing.get("petrol") or {})
        diesel = dict(existing.get("diesel") or {})
        tank = {"dip": next_dip, "received": next_received, "note": ""}
        if fuel == "petrol":
            petrol = tank
        else:
            diesel = tank
        rates = get_rates()
        cost = (petrol.get("received") or 0) * rates.get("purchaseCostPetrol", 0) + (diesel.get("received") or 0) * rates.get("purchaseCostDiesel", 0)
        note = args.get("note", existing.get("note", ""))
        db.upsert_stock(date, petrol, diesel, cost, note, existing.get("enteredBy", "AI Assistant"), now)
        if args.get("received") is not None:
            db.upsert_cost_category_amount(date, "Fuel Purchase", cost, "AI Assistant (via Stock update)")
        return {"confirmed": True, "date": date, "fuel": fuel, "tank": tank}

    if name == "delete_stock_entry":
        date = args["date"]
        if not db.get_stock(date):
            return {"confirmed": False, "notFound": True, "date": date}
        db.delete_stock(date)
        db.upsert_cost_category_amount(date, "Fuel Purchase", 0, "AI Assistant (via Stock delete)")
        return {"confirmed": True, "deleted": True, "date": date}

    if name == "update_targets":
        current = get_targets()
        next_targets = {
            "petrol": args.get("petrol", current.get("petrol")),
            "diesel": args.get("diesel", current.get("diesel")),
        }
        db.set_setting("targets", next_targets)
        return {"confirmed": True, "old": current, "new": next_targets}

    if name == "update_rates":
        current = get_rates()
        next_rates = dict(current)
        for key in ["petrol", "diesel", "marginPetrol", "marginDiesel", "purchaseCostPetrol", "purchaseCostDiesel"]:
            if args.get(key) is not None:
                next_rates[key] = args[key]
        db.set_setting("rates", next_rates)
        return {"confirmed": True, "old": current, "new": next_rates}

    return {"confirmed": False, "error": f"unknown write tool {name}"}


# ---------------------------------------------------------------------------
# Gemini call + conversation loop
# ---------------------------------------------------------------------------

class AiNotConfigured(Exception):
    pass


async def send_message(contents, message):
    """contents: the prior Gemini conversation (empty list for a fresh
    chat). message: the owner's new text. Appends it as a user turn and
    runs the tool-call loop."""
    contents = list(contents) + [{"role": "user", "parts": [{"text": message}]}]
    return await run_turn(contents)


async def call_gemini(contents):
    if not GEMINI_API_KEY:
        raise AiNotConfigured("GEMINI_API_KEY is not set on the server.")
    payload = {
        "system_instruction": {"parts": [{"text": system_instruction()}]},
        "contents": contents,
        "tools": ALL_TOOLS,
    }
    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.post(GEMINI_URL, params={"key": GEMINI_API_KEY}, json=payload)
    if resp.status_code != 200:
        raise RuntimeError(f"Gemini API error {resp.status_code}: {resp.text[:500]}")
    data = resp.json()
    candidates = data.get("candidates") or []
    if not candidates:
        return {"role": "model", "parts": [{"text": "(no response)"}]}
    return candidates[0]["content"]


async def run_turn(contents):
    """Calls Gemini, auto-executing any READ tool calls and looping, until
    the model either returns plain text or calls a WRITE tool (which must
    pause for owner confirmation). Returns one of:
      {"status": "done", "text": "...", "contents": [...]}
      {"status": "confirm", "pending": [{"name","args"}...], "contents": [...]}
    `contents` is the full updated Gemini conversation, to be resent as-is
    next time (send another message, or resolve a confirmation).
    """
    contents = list(contents)
    for _ in range(8):  # hard cap so a tool-call loop can't run forever
        model_turn = await call_gemini(contents)
        contents.append(model_turn)
        parts = model_turn.get("parts") or []
        calls = [p["functionCall"] for p in parts if "functionCall" in p]
        if not calls:
            text = "".join(p.get("text", "") for p in parts).strip() or "(no response)"
            return {"status": "done", "text": text, "contents": contents}

        write_calls = [c for c in calls if c["name"] in WRITE_TOOL_NAMES]
        if write_calls:
            # Pause here. Any read calls in this same turn are re-run (safe,
            # idempotent) once resolve_turn() is called, alongside the writes.
            pending = [{"name": c["name"], "args": c.get("args") or {},
                        "summary": summarize_write_call(c["name"], c.get("args") or {})} for c in write_calls]
            return {"status": "confirm", "pending": pending, "contents": contents}

        # All read-only calls — execute and feed results straight back.
        response_parts = []
        for c in calls:
            result = run_read_tool(c["name"], c.get("args") or {})
            response_parts.append({"functionResponse": {"name": c["name"], "response": {"result": result}}})
        contents.append({"role": "user", "parts": response_parts})

    return {"status": "done", "text": "I got stuck in a loop looking things up — try asking again, maybe more specifically.", "contents": contents}


async def resolve_turn(contents, decisions):
    """Called after the owner has clicked Confirm/Cancel on each pending
    write call from the last run_turn()/resolve_turn() result. `decisions`
    is a list of booleans in the same order as that `pending` list (i.e. in
    the order the write functionCalls appeared in the last model turn — any
    read calls in that same turn are skipped over here and just re-run).
    Executes the confirmed writes, feeds all results back to the model, and
    continues the loop exactly like run_turn().
    """
    contents = list(contents)
    last_turn = contents[-1]
    calls = [p["functionCall"] for p in (last_turn.get("parts") or []) if "functionCall" in p]

    response_parts = []
    decision_iter = iter(decisions)
    for c in calls:
        name, args = c["name"], c.get("args") or {}
        if name in WRITE_TOOL_NAMES:
            confirmed = next(decision_iter, False)
            if confirmed:
                result = execute_write_call(name, args)
            else:
                result = {"confirmed": False, "cancelledByOwner": True}
        else:
            result = run_read_tool(name, args)
        response_parts.append({"functionResponse": {"name": name, "response": {"result": result}}})

    contents.append({"role": "user", "parts": response_parts})
    return await run_turn(contents)
