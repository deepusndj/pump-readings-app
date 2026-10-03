"""
Instant push notifications via ntfy.sh (free, no account/API key needed).

How it works: the backend POSTs a short message to a private topic URL
(https://ntfy.sh/<topic>) whenever data is entered, edited, or deleted.
Anyone with the ntfy app (iOS/Android/web) who has subscribed to that exact
topic name gets a push notification within a second or two. The topic name
itself is the only "secret" — treat it like a shared password and don't
post it publicly (set a hard-to-guess one via the NTFY_TOPIC env var).

This is entirely best-effort for normal calls: a notification failure
(ntfy down, network hiccup, topic not configured) must never block or
fail the actual data save, so push() swallows its own errors — but it
logs them first, and `/api/notify/test` (see main.py) surfaces the same
diagnostic info on demand for troubleshooting.
"""
import logging
import os
import httpx

logger = logging.getLogger("notify")

NTFY_TOPIC = os.environ.get("NTFY_TOPIC", "").strip()
NTFY_URL = f"https://ntfy.sh/{NTFY_TOPIC}" if NTFY_TOPIC else None


def _send(title: str, message: str, priority: str = "default"):
    """Does the actual HTTP call. Raises on failure — callers decide
    whether to swallow or surface that."""
    resp = httpx.post(
        NTFY_URL,
        data=message.encode("utf-8"),
        headers={"Title": title, "Priority": priority},
        timeout=5.0,
    )
    resp.raise_for_status()
    return resp


def push(title: str, message: str, priority: str = "default"):
    """Fire-and-forget push notification. Silently does nothing if
    NTFY_TOPIC isn't configured. Logs (but swallows) any delivery error,
    so a bad topic or ntfy outage never breaks the actual save."""
    if not NTFY_URL:
        logger.info("notify.push skipped (NTFY_TOPIC not set): %s — %s", title, message)
        return
    try:
        _send(title, message, priority)
        logger.info("notify.push sent: %s — %s", title, message)
    except Exception as e:
        logger.error("notify.push FAILED: %s — %s (%r)", title, message, e)


def test() -> dict:
    """Used by GET /api/notify/test. Returns exactly what happened, for
    troubleshooting — does not swallow errors."""
    if not NTFY_URL:
        return {"configured": False, "detail": "NTFY_TOPIC env var is not set on the server."}
    try:
        resp = _send("Test notification", "If you see this, push notifications are working.", "default")
        return {"configured": True, "ok": True, "statusCode": resp.status_code}
    except Exception as e:
        return {"configured": True, "ok": False, "error": str(e)}
