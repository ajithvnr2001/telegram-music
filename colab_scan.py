# -*- coding: utf-8 -*-
"""
Tele Music Player — Manual Channel Scanner & Indexer (Google Colab)

Scans a private Telegram channel via MTProto (Telethon) and indexes every
playable media message (message_id 492 → 2878) into the Cloudflare D1
database through the worker's non-destructive /api/import endpoint.

It does NOT download audio files — it only records metadata (file_id,
message_id, filename, size, mime, duration) so the web player can stream
them on demand.

HOW TO RUN IN COLAB:
  1. Runtime → Run all (or run cells top to bottom).
  2. When prompted, enter your phone number, then the login code Telegram
     sends you (and password if you have 2FA).
  3. Enter your worker URL and WEBHOOK_SECRET when prompted.
  4. The script scans the channel and uploads the index in batches.
"""

# ---------------------------------------------------------------------------
# 0. Install dependencies
# ---------------------------------------------------------------------------
# !pip install -q telethon

import asyncio
import base64
import json
import struct
import time
import urllib.request

from telethon import TelegramClient
from telethon.tl.types import (
    Message,
    MessageMediaDocument,
    Document,
    DocumentAttributeAudio,
    DocumentAttributeVideo,
    DocumentAttributeFilename,
)

# ---------------------------------------------------------------------------
# 1. Configuration — EDIT THESE
# ---------------------------------------------------------------------------
API_ID = 0            # <-- your api_id from my.telegram.org
API_HASH = ""         # <-- your api_hash from my.telegram.org
PHONE = ""            # <-- your phone number in international format, e.g. "+916381445515"

CHANNEL_ID = -1004303738393   # the private channel
START_MSG_ID = 492            # first message to index
END_MSG_ID = 2878             # last message to index (inclusive)

WORKER_URL = "https://tele-music-player.ajithvnr2001.workers.dev"
WEBHOOK_SECRET = ""           # <-- your WEBHOOK_SECRET (used to auth /api/import)

BATCH_SIZE = 200              # songs per POST to the worker
SLEEP_BETWEEN_MSGS = 0.15     # seconds between messages (avoid flood)

# Playable document extensions (mirrors src/scanner.ts PLAYABLE_DOC_EXTS)
PLAYABLE_EXTS = {
    ".mp3", ".m4a", ".ogg", ".oga", ".opus", ".flac", ".wav", ".aac", ".weba",
    ".mp4", ".mkv", ".webm", ".mov", ".avi", ".m4v", ".ts", ".3gp", ".mpeg", ".mpg",
}

# ---------------------------------------------------------------------------
# 2. Telegram file_id serialization (mirrors @yaebal/file-id, version 4, subVersion 61)
# ---------------------------------------------------------------------------
SUB_VERSION = 61
VERSION = 4
FILE_REFERENCE_FLAG = 0x02000000

# FileType enum (TDLib)
FT_VOICE_NOTE = 3
FT_VIDEO = 4
FT_DOCUMENT = 5
FT_AUDIO = 9
FT_VIDEO_NOTE = 13

_B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"


def _b64url_encode(data: bytes) -> str:
    s = base64.b64encode(data).decode("ascii")
    s = s.replace("+", "-").replace("/", "_").rstrip("=")
    return s


def _rle_encode(data: bytes) -> bytes:
    out = bytearray()
    zeros = 0
    for b in data:
        if b == 0:
            zeros += 1
            continue
        if zeros > 0:
            out += bytes([0, zeros])
            zeros = 0
        out.append(b)
    if zeros > 0:
        out += bytes([0, zeros])
    return bytes(out)


def _pack_tl_string(data: bytes) -> bytes:
    length = len(data)
    if length <= 253:
        pad = (4 - ((length + 1) % 4)) % 4
        return bytes([length]) + data + b"\x00" * pad
    pad = (4 - (length % 4)) % 4
    return (
        bytes([254, length & 0xFF, (length >> 8) & 0xFF, (length >> 16) & 0xFF])
        + data
        + b"\x00" * pad
    )


def serialize_file_id(file_type: int, dc_id: int, file_id: int, access_hash: int,
                      file_reference: bytes) -> str:
    """Build a Telegram document file_id string (version 4, subVersion 61)."""
    type_id = file_type | FILE_REFERENCE_FLAG
    parts = [
        struct.pack("<I", type_id & 0xFFFFFFFF),
        struct.pack("<I", dc_id & 0xFFFFFFFF),
        _pack_tl_string(file_reference),
        struct.pack("<q", file_id),
        struct.pack("<q", access_hash),
        bytes([SUB_VERSION]),
        bytes([VERSION]),
    ]
    raw = b"".join(parts)
    return _b64url_encode(_rle_encode(raw))


# ---------------------------------------------------------------------------
# 3. Helpers
# ---------------------------------------------------------------------------
def classify_document(doc: Document):
    """Return (file_type, media_kind, duration, title, artist, width, height, file_name)."""
    attrs = doc.attributes or []
    audio_attr = next((a for a in attrs if isinstance(a, DocumentAttributeAudio)), None)
    video_attr = next((a for a in attrs if isinstance(a, DocumentAttributeVideo)), None)
    file_attr = next((a for a in attrs if isinstance(a, DocumentAttributeFilename)), None)

    mime = (doc.mime_type or "").lower()
    file_name = file_attr.file_name if file_attr else None
    if file_name is None and audio_attr and audio_attr.title:
        file_name = f"{audio_attr.performer or ''} - {audio_attr.title}.mp3"
    if file_name is None:
        file_name = f"media_{0}.mp4"

    if audio_attr:
        if audio_attr.voice:
            return (FT_VOICE_NOTE, "audio", audio_attr.duration, None, None, None, None, file_name)
        return (FT_AUDIO, "audio", audio_attr.duration, audio_attr.title,
                audio_attr.performer, None, None, file_name)
    if video_attr:
        ft = FT_VIDEO_NOTE if video_attr.round_message else FT_VIDEO
        return (ft, "video", video_attr.duration, None, None,
                video_attr.w, video_attr.h, file_name)

    # generic document — only index if it looks playable
    ext = file_name[file_name.rfind("."):].lower() if file_name else ""
    if not mime.startswith(("audio/", "video/")) and ext not in PLAYABLE_EXTS:
        return None
    kind = "video" if mime.startswith("video/") else ("audio" if mime.startswith("audio/") else "document")
    return (FT_DOCUMENT, kind, None, None, None, None, None, file_name)


def song_from_message(msg: Message):
    """Build a song dict from a media message, or None if not indexable."""
    media = msg.media
    if not isinstance(media, MessageMediaDocument):
        return None
    doc = media.document
    if not isinstance(doc, Document):
        return None

    classified = classify_document(doc)
    if classified is None:
        return None
    file_type, media_kind, duration, title, artist, width, height, file_name = classified

    file_id = serialize_file_id(
        file_type=file_type,
        dc_id=doc.dc_id,
        file_id=doc.id,
        access_hash=doc.access_hash,
        file_reference=bytes(doc.file_reference),
    )

    return {
        "tg_file_id": file_id,
        "tg_unique_id": None,
        "chat_id": str(CHANNEL_ID),
        "message_id": msg.id,
        "file_name": file_name,
        "title": title,
        "artist": artist,
        "mime_type": doc.mime_type,
        "media_type": media_kind,
        "size": doc.size,
        "duration": duration,
        "width": width,
        "height": height,
        "added_at": (msg.date.timestamp() * 1000) if msg.date else int(time.time() * 1000),
        "added_by": None,
    }


def post_songs(songs):
    """POST a batch of songs to the worker's /api/import endpoint."""
    url = WORKER_URL.rstrip("/") + "/api/import"
    payload = json.dumps({"songs": songs}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "X-Auth-Secret": WEBHOOK_SECRET,
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


# ---------------------------------------------------------------------------
# 4. Main scan loop
# ---------------------------------------------------------------------------
async def main():
    assert API_ID and API_HASH, "Set API_ID and API_HASH first."
    assert WEBHOOK_SECRET, "Set WEBHOOK_SECRET first."

    client = TelegramClient("session", API_ID, API_HASH)
    await client.start(phone=PHONE)
    me = await client.get_me()
    print("Logged in as:", me.username or me.first_name)

    channel = await client.get_entity(CHANNEL_ID)
    print("Channel:", channel.title)

    songs = []
    total = 0
    skipped = 0
    last_id = END_MSG_ID

    # Walk backwards from END_MSG_ID down to START_MSG_ID
    while last_id >= START_MSG_ID:
        msgs = await client.get_messages(channel, limit=100, offset_id=last_id + 1)
        if not msgs:
            break
        for msg in msgs:
            if msg.id < START_MSG_ID:
                break
            song = song_from_message(msg)
            if song:
                songs.append(song)
                total += 1
            else:
                skipped += 1
            await asyncio.sleep(SLEEP_BETWEEN_MSGS)

            if len(songs) >= BATCH_SIZE:
                res = post_songs(songs)
                print(f"  uploaded {len(songs)} (total {total}, skipped {skipped}) -> {res}")
                songs = []

        last_id = msgs[-1].id - 1
        print(f"  ... reached message {last_id}")

    # upload any remaining
    if songs:
        res = post_songs(songs)
        print(f"  uploaded final {len(songs)} -> {res}")

    print(f"\nDONE. Indexed {total} songs, skipped {skipped} non-media messages.")
    await client.disconnect()


if __name__ == "__main__":
    asyncio.run(main())