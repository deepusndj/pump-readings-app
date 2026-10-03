# Pump Readings — standalone app

A self-hosted version of the Pump Readings app (originally a Claude Artifact).
Core features only: daily meter **Readings**, **Cost** entry (employee
one-at-a-time + owner month-grid), **Stock** (tank dip + fuel received),
owner password gate, and History. The AI Assistant tab from the original
is not included in this version.

Everyone (employees and the owner) can enter Readings/Cost/Stock freely —
no login needed for that, same as the original. Only destructive or
"owner-table" actions (editing the cost/stock month-grid, deleting entries,
changing rates/targets) require the owner password.

## Project structure

```
pump-readings-app/
├── backend/
│   ├── main.py            FastAPI app — the HTTP API + serves the frontend
│   ├── database.py        SQLite data layer (readings / costs / stock / settings)
│   ├── requirements.txt
│   └── .env.example        copy to .env and set your own OWNER_PASSWORD
├── frontend/
│   ├── index.html
│   ├── styles.css
│   └── app.js              talks to the backend via fetch('/api/...')
└── render.yaml             one-click config for Render's free tier
```

The backend serves the frontend itself (no separate frontend host needed) —
when you open the backend's URL in a browser, you get the app.

## Run it locally (in VS Code)

1. Open the `pump-readings-app` folder in VS Code (**File → Open Folder…**).
2. Open a terminal in VS Code (**Terminal → New Terminal**) and run:
   ```
   cd backend
   pip install -r requirements.txt
   ```
3. Copy `.env.example` to `.env` and change `OWNER_PASSWORD` to something
   only you know. (Or just set it as an environment variable when you run
   the server — see below.)
4. Start the server:
   ```
   # Windows PowerShell:
   $env:OWNER_PASSWORD="yourpassword"; uvicorn main:app --reload --port 8000

   # macOS/Linux:
   OWNER_PASSWORD=yourpassword uvicorn main:app --reload --port 8000
   ```
5. Open **http://localhost:8000** in your browser. That's the app.

Data is stored in `backend/pump_readings.db` (a single SQLite file) — back
this file up occasionally if you're running locally long-term, since it's
not backed up anywhere automatically.

## Deploy for free so employees can reach it from their phones

[Render](https://render.com) has a free web-service tier that's a good fit
here. Steps:

1. Push this folder to a GitHub repository (Render deploys from GitHub).
2. On Render: **New → Blueprint**, point it at your repo. Render will read
   `render.yaml` and set everything up automatically (it already knows the
   build/start commands and that a persistent 1GB disk is needed so your
   data survives restarts).
3. When prompted, set the `OWNER_PASSWORD` environment variable to your
   chosen password (this is marked `sync: false` in `render.yaml` so Render
   will ask you for it rather than committing it to the repo).
4. Click deploy. Render gives you a URL like `https://pump-readings.onrender.com`
   — share that with your employees. It works on any phone browser.

**Free-tier caveat:** Render's free web services "spin down" after 15
minutes of no traffic and take 30-60 seconds to wake back up on the next
request. That means the first person to open the app after a quiet spell
will see a loading delay once. Data is never lost during spin-down (it's on
the persistent disk you configured), it's purely a startup-speed thing. If
that delay becomes annoying, Render's paid tier removes it — but the free
tier is perfectly usable for a small daily-entry tool like this.

If you don't want to use Render, any host that can run a Python/FastAPI
app and give it a persistent disk works the same way (Railway, Fly.io,
PythonAnywhere, etc.) — the `backend/` folder is a standard FastAPI app,
nothing Render-specific is baked into the code itself (only `render.yaml`,
which you can ignore on another host).

## Changing the owner password later

Just change the `OWNER_PASSWORD` environment variable (in Render's
dashboard, or your local `.env`/shell) and restart the server. There's no
password stored in the database — it's purely an environment variable
checked on each owner-only request.

## What's different from the original Claude Artifact version

- Employees get **real, working write access** without needing a paid
  Claude Team/Enterprise plan — that was the whole reason this version
  exists. Anyone with the app's URL can enter Readings/Cost/Stock.
- Data lives in a plain SQLite file you fully own, instead of inside
  Claude's artifact storage.
- The AI Assistant tab isn't included (it needed a paid Anthropic API key
  to keep running on its own server — can be added back later if wanted).
- Rates/targets (used for petrol/diesel margin and target-litres
  calculations) can be read via the API but there's no settings-editor
  screen in this version; reach out if you want one added, or edit them
  directly via `PUT /api/settings/rates` / `/api/settings/targets` with
  a tool like `curl` or Postman, sending the `X-Owner-Password` header.
