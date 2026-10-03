"""
Instant push notifications via ntfy.sh (free, no account/API key needed).

How it works: the backend POSTs a short message to a private topic URL
(https://ntfy.sh/<topic>) whenever data is entered, edited, or deleted.
Anyone with the ntfy app (iOS/Android/web) who has subscribed to that exact
topic name gets a push notification within a second or two. The topic name
itself is the only "secret" — treat it like a shared password and don't
post it publicly (set a hard-to-guess one via the NTFY_TOPIC env var).

This is entirely best-effort: a notification failure (ntfy down, network
hiccup, topic not configured) must never block or fail the actual data
save, so every call here swallows its own errors.
"""
import os
import httpx

NTFY_TOPIC = os.environ.get("NTFY_TOPIC", "").strip()
NTFY_URL = f"https://ntfy.sh/{NTFY_TOPIC}" if NTFY_TOPIC else None


def push(title: str, message: str, priority: str = "default"):
    """Fire-and-forget push notification. Silently does nothing if
    NTFY_TOPIC isn't configured, and silently swallows any delivery error."""
    if not NTFY_URL:
        return
    try:
        httpx.post(
            NTFY_URL,
            data=message.encode("utf-8"),
            headers={"Title": title, "Priority": priority},
            timeout=3.0,
        )
    except Exception:
        pass  # never let a notification failure affect the actual request
