"""
Instant push notifications, fanned out to every configured channel.

Two channels are supported, each independent and optional:

  - ntfy.sh (free, no account needed): set NTFY_TOPIC. POSTs to
    https://ntfy.sh/<topic>; anyone subscribed to that exact topic name in
    the ntfy app gets a push. Known limitation: ntfy.sh rate-limits by the
    server's outbound IP, which on Render's free tier is shared with many
    unrelated apps — so this can occasionally 429 for reasons outside this
    app's control (see /api/notify/test for diagnostics).
  - Telegram bot (free, no IP-sharing issue — limits are per-bot-token):
    set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID. POSTs to the Bot API's
    sendMessage endpoint.

Both are attempted on every push() call if configured, so one channel
being down doesn't take out the other. This is entirely best-effort: a
notification failure here must never block or fail the actual data save,
so push() swallows all errors — but logs them first, and /api/notify/test
(see main.py) surfaces the same diagnostic info per channel on demand.
"""
import logging
import os
import httpx

logger = logging.getLogger("notify")

NTFY_TOPIC = os.environ.get("NTFY_TOPIC", "").strip()
NTFY_URL = f"https://ntfy.sh/{NTFY_TOPIC}" if NTFY_TOPIC else None

TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "").strip()
TELEGRAM_URL = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage" if TELEGRAM_BOT_TOKEN else None


def _send_ntfy(title: str, message: str, priority: str = "default"):
    resp = httpx.post(
        NTFY_URL,
        data=message.encode("utf-8"),
        headers={"Title": title, "Priority": priority},
        timeout=5.0,
    )
    resp.raise_for_status()
    return resp


def _send_telegram(title: str, message: str):
    resp = httpx.post(
        TELEGRAM_URL,
        json={"chat_id": TELEGRAM_CHAT_ID, "text": f"{title}\n{message}"},
        timeout=5.0,
    )
    resp.raise_for_status()
    return resp


def push(title: str, message: str, priority: str = "default"):
    """Fire-and-forget push notification to every configured channel.
    Does nothing for a channel that isn't configured. Logs (but swallows)
    any delivery error per channel, so one bad/rate-limited channel never
    breaks the other or the actual save."""
    if NTFY_URL:
        try:
            _send_ntfy(title, message, priority)
            logger.info("notify[ntfy] sent: %s — %s", title, message)
        except Exception as e:
            logger.error("notify[ntfy] FAILED: %s — %s (%r)", title, message, e)

    if TELEGRAM_URL and TELEGRAM_CHAT_ID:
        try:
            _send_telegram(title, message)
            logger.info("notify[telegram] sent: %s — %s", title, message)
        except Exception as e:
            logger.error("notify[telegram] FAILED: %s — %s (%r)", title, message, e)

    if not NTFY_URL and not (TELEGRAM_URL and TELEGRAM_CHAT_ID):
        logger.info("notify.push skipped (no channel configured): %s — %s", title, message)


def test() -> dict:
    """Used by GET /api/notify/test. Fires one real test message through
    every configured channel and reports exactly what happened per
    channel, for troubleshooting — does not swallow errors."""
    result = {}

    if NTFY_URL:
        try:
            resp = _send_ntfy("Test notification", "ntfy channel is working.", "default")
            result["ntfy"] = {"configured": True, "ok": True, "statusCode": resp.status_code}
        except Exception as e:
            result["ntfy"] = {"configured": True, "ok": False, "error": str(e)}
    else:
        result["ntfy"] = {"configured": False, "detail": "NTFY_TOPIC env var is not set."}

    if TELEGRAM_URL and TELEGRAM_CHAT_ID:
        try:
            resp = _send_telegram("Test notification", "Telegram channel is working.")
            result["telegram"] = {"configured": True, "ok": True, "statusCode": resp.status_code}
        except Exception as e:
            result["telegram"] = {"configured": True, "ok": False, "error": str(e)}
    else:
        result["telegram"] = {"configured": False, "detail": "TELEGRAM_BOT_TOKEN and/or TELEGRAM_CHAT_ID env var not set."}

    return result
