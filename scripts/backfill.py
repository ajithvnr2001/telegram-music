"""
One-time backfill: import ALL existing media (mp3/m4a/mp4/...) already in the
Telegram channel into the player index.

Why this exists: the Telegram Bot API has no method to read channel history,
so songs that were posted before the bot existed are invisible to it. This
script (Pyrogram / MTProto, same approach as Telegram-Leecher) walks the
channel history and forwards every media message to the bot. The Worker
indexes each forward against its ORIGINAL channel message - no copies,
no duplicates, safe to re-run.

Setup:
  1. pip install pyrogram
  2. Get API_ID and API_HASH from https://my.telegram.org  (API development tools)
  3. Fill in the values below and run:
       python backfill.py
     On first run you'll be asked for your phone number + the login code
     Telegram sends you (a session file "backfill_session.session" is saved).
"""

import asyncio
import sys

from pyrogram import Client
from pyrogram.enums import MessageMediaType
from pyrogram.errors import FloodWait

# --- CONFIGURE THESE -------------------------------------------------------
API_ID = 0  # from https://my.telegram.org -> API development tools
API_HASH = ""  # from https://my.telegram.org
CHANNEL = -1004303738393  # your channel id
BOT_USERNAME = "musicvnrbot"  # the bot that powers the player
DRY_RUN = False  # True = list what would be imported without forwarding
SLEEP_SECONDS = 0.6  # delay between forwards (avoid rate limits)
# ---------------------------------------------------------------------------

MEDIA_TYPES = {
    MessageMediaType.AUDIO,
    MessageMediaType.VIDEO,
    MessageMediaType.DOCUMENT,
    MessageMediaType.VOICE,
    MessageMediaType.VIDEO_NOTE,
    MessageMediaType.ANIMATION,
}

PLAYABLE_DOC_EXTS = {
    ".mp3", ".m4a", ".ogg", ".oga", ".opus", ".flac", ".wav", ".aac",
    ".mp4", ".mkv", ".webm", ".mov", ".avi", ".m4v", ".ts", ".3gp",
}


def is_media(msg) -> bool:
    if msg.media in MEDIA_TYPES:
        if msg.media == MessageMediaType.DOCUMENT:
            name = (msg.document.file_name or "").lower()
            return any(name.endswith(e) for e in PLAYABLE_DOC_EXTS)
        return True
    return False


def describe(msg) -> str:
    name = ""
    if msg.audio:
        name = msg.audio.file_name or (msg.audio.performer or "") + " - " + (msg.audio.title or "")
    elif msg.video:
        name = msg.video.file_name or f"video_{msg.id}.mp4"
    elif msg.document:
        name = msg.document.file_name or ""
    return name


async def main() -> None:
    if API_ID == 0 or not API_HASH:
        sys.exit("Set API_ID and API_HASH first (my.telegram.org).")

    app = Client("backfill_session", api_id=API_ID, api_hash=API_HASH)
    async with app:
        me = await app.get_me()
        print(f"Logged in as: {me.first_name} ({me.id})")

        bot = await app.get_users(BOT_USERNAME)
        print(f"Target bot: {bot.first_name} ({bot.id})")

        total = imported = skipped = failed = 0
        async for msg in app.get_chat_history(CHANNEL):
            if not is_media(msg):
                continue
            total += 1
            if not msg.media:
                continue
            try:
                if not DRY_RUN:
                    await app.forward_messages(bot.id, CHANNEL, msg.id)
                imported += 1
                print(f"[{imported}/{total}] msg {msg.id}: {describe(msg) or msg.media}")
            except FloodWait as e:
                print(f"  flood wait {e.value}s, pausing...")
                await asyncio.sleep(e.value)
            except Exception as e:  # noqa: BLE001
                failed += 1
                print(f"  FAILED msg {msg.id}: {e}")
            await asyncio.sleep(SLEEP_SECONDS)

        print("\n" + "=" * 50)
        print(f"Scanned: {total} media messages")
        print(f"Imported: {imported} (skipped/not playable: {skipped}, failed: {failed})")
        if DRY_RUN:
            print("DRY RUN - nothing was forwarded. Re-run with DRY_RUN = False.")
        else:
            print("Done. Open the player and refresh - the count should be growing.")


if __name__ == "__main__":
    asyncio.run(main())
