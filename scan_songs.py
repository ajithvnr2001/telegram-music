# -*- coding: utf-8 -*-
"""
Tele Music Player — Resumable Channel Scanner + Metadata/Language Extractor

Scans a private Telegram channel via MTProto (Telethon), downloads each media
file, extracts rich metadata (title, artist, album, duration, codec, sample
rate, channels, bitrate, language), and stores everything as RAW JSON
(songs.json) for later processing / bulk upload to Cloudflare D1.

Crash-proof & resumable:
  - Every song is written to songs.json immediately after processing.
  - On restart, already-processed message_ids are skipped (no re-download).
  - A single bad file never aborts the run.

Usage:
  python scan_songs.py --start 492 --end 2878
  python scan_songs.py --resume            # continue from last checkpoint
  python scan_songs.py --export            # dump done songs to songs_export.json
"""

import argparse
import asyncio
import json
import os
import re
import sys
import time

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
# Configuration
# ---------------------------------------------------------------------------
API_ID = 10870161
API_HASH = "81ca4e214e172c32768809cbb9463d51"
PHONE = "+916381445515"

CHANNEL_ID = -1004303738393
JSON_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "songs.json")
SESSION_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "telethon_session")

BATCH_SIZE = 50          # messages fetched per MTProto call
SLEEP_BETWEEN_MSGS = 0.2 # seconds between messages (avoid flood)
DOWNLOAD_TIMEOUT = 300   # seconds per file download
DOWNLOAD_RETRIES = 3     # retries per file download

# Playable document extensions (mirrors src/scanner.ts)
PLAYABLE_EXTS = {
    ".mp3", ".m4a", ".ogg", ".oga", ".opus", ".flac", ".wav", ".aac", ".weba",
    ".mp4", ".mkv", ".webm", ".mov", ".avi", ".m4v", ".ts", ".3gp", ".mpeg", ".mpg",
}

# Language hints found in filenames (case-insensitive substring match)
LANG_HINTS = {
    "hindi": "Hindi", "bollywood": "Hindi", "hind": "Hindi",
    "tamil": "Tamil", "kollywood": "Tamil",
    "telugu": "Telugu", "tollywood": "Telugu",
    "malayalam": "Malayalam", "mollywood": "Malayalam",
    "kannada": "Kannada", "sandalwood": "Kannada",
    "punjabi": "Punjabi", "bhangra": "Punjabi",
    "bengali": "Bengali", "marathi": "Marathi",
    "gujarati": "Gujarati", "odia": "Odia", "oriya": "Odia",
    "english": "English", "hollywood": "English",
    "spanish": "Spanish", "french": "French", "korean": "Korean",
    "japanese": "Japanese", "chinese": "Chinese", "arabic": "Arabic",
    "nepali": "Nepali", "sanskrit": "Sanskrit", "urdu": "Urdu",
}

# Genre → language mapping (from ID3/MP4 genre tags)
GENRE_LANG = {
    "bollywood": "Hindi", "hindustani": "Hindi", "filmi": "Hindi",
    "kollywood": "Tamil", "tamil": "Tamil",
    "tollywood": "Telugu", "telugu": "Telugu",
    "mollywood": "Malayalam", "malayalam": "Malayalam",
    "sandalwood": "Kannada", "kannada": "Kannada",
    "punjabi": "Punjabi", "bhangra": "Punjabi",
    "bengali": "Bengali", "marathi": "Marathi", "gujarati": "Gujarati",
    "odia": "Odia", "english": "English", "pop": "English",
    "rock": "English", "jazz": "English", "classical": "English",
    "k-pop": "Korean", "kpop": "Korean", "j-pop": "Japanese", "jpop": "Japanese",
    "arabic": "Arabic", "nepali": "Nepali", "urdu": "Urdu",
}

# ---------------------------------------------------------------------------
# Local JSON store (raw data, resumable)
# ---------------------------------------------------------------------------
def load_songs():
    """Load the songs list from the JSON file (empty list if missing/corrupt)."""
    if os.path.exists(JSON_PATH):
        try:
            with open(JSON_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, list):
                    return data
        except Exception as e:
            print(f"  (warning: could not read {JSON_PATH}: {e}; starting fresh)")
    return []


def save_songs(songs):
    """Atomically write the songs list to the JSON file (temp file + rename)."""
    tmp = JSON_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(songs, f, ensure_ascii=False, indent=2)
    os.replace(tmp, JSON_PATH)


def is_done(songs, message_id):
    return any(s.get("message_id") == message_id for s in songs)


def upsert_song(songs, song):
    """Add or replace a song by message_id; returns the updated list."""
    for i, s in enumerate(songs):
        if s.get("message_id") == song["message_id"]:
            songs[i] = song
            return songs
    songs.append(song)
    return songs


def get_checkpoint(songs):
    ids = [s.get("message_id") for s in songs if s.get("message_id") is not None]
    return max(ids) if ids else None


# ---------------------------------------------------------------------------
# Telegram file_id serialization (mirrors @yaebal/file-id, v4, subVersion 61)
# ---------------------------------------------------------------------------
SUB_VERSION = 61
VERSION = 4
FILE_REFERENCE_FLAG = 0x02000000
FT_VOICE_NOTE, FT_VIDEO, FT_DOCUMENT, FT_AUDIO, FT_VIDEO_NOTE = 3, 4, 5, 9, 13


def _b64url_encode(data: bytes) -> str:
    s = __import__("base64").b64encode(data).decode("ascii")
    return s.replace("+", "-").replace("/", "_").rstrip("=")


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
    return bytes([254, length & 0xFF, (length >> 8) & 0xFF, (length >> 16) & 0xFF]) + data + b"\x00" * pad


def serialize_file_id(file_type, dc_id, file_id, access_hash, file_reference):
    type_id = file_type | FILE_REFERENCE_FLAG
    parts = [
        __import__("struct").pack("<I", type_id & 0xFFFFFFFF),
        __import__("struct").pack("<I", dc_id & 0xFFFFFFFF),
        _pack_tl_string(file_reference),
        __import__("struct").pack("<q", file_id),
        __import__("struct").pack("<q", access_hash),
        bytes([SUB_VERSION]),
        bytes([VERSION]),
    ]
    return _b64url_encode(_rle_encode(b"".join(parts)))


# ---------------------------------------------------------------------------
# Classification (mirrors src/scanner.ts)
# ---------------------------------------------------------------------------
def classify_document(doc: Document):
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

    ext = file_name[file_name.rfind("."):].lower() if file_name else ""
    if not mime.startswith(("audio/", "video/")) and ext not in PLAYABLE_EXTS:
        return None
    kind = "video" if mime.startswith("video/") else ("audio" if mime.startswith("audio/") else "document")
    return (FT_DOCUMENT, kind, None, None, None, None, None, file_name)


# ---------------------------------------------------------------------------
# Language detection
# ---------------------------------------------------------------------------
def detect_language(file_name, title, artist, genre=None, album=None):
    text = " ".join(filter(None, [file_name, title, artist, album])).lower()
    for hint, lang in LANG_HINTS.items():
        if hint in text:
            return lang
    if genre:
        g = genre.lower()
        for hint, lang in GENRE_LANG.items():
            if hint in g:
                return lang
    return None


# ---------------------------------------------------------------------------
# Metadata extraction (downloads the file, reads tags)
# ---------------------------------------------------------------------------
def extract_metadata(file_path, mime):
    """Return dict of metadata from a downloaded file using mutagen."""
    meta = {
        "title": None, "artist": None, "album": None, "genre": None, "year": None,
        "codec": None, "sample_rate": None, "channels": None, "bitrate": None,
        "duration": None, "language": None,
    }
    try:
        from mutagen import File as MFile
        audio = MFile(file_path, easy=False)
        if audio is None:
            return meta

        # duration
        try:
            meta["duration"] = float(audio.info.length) if audio.info and audio.info.length else None
        except Exception:
            pass
        # codec / sample rate / channels / bitrate
        try:
            meta["codec"] = getattr(audio.info, "codec", None) or getattr(audio, "mime", [None])[0]
        except Exception:
            pass
        try:
            meta["sample_rate"] = getattr(audio.info, "sample_rate", None)
        except Exception:
            pass
        try:
            meta["channels"] = getattr(audio.info, "channels", None)
        except Exception:
            pass
        try:
            meta["bitrate"] = getattr(audio.info, "bitrate", None)
        except Exception:
            pass

        # tags
        tags = audio.tags
        if tags:
            def get_tag(*keys):
                for k in keys:
                    try:
                        v = tags.get(k)
                        if v:
                            return str(v[0] if isinstance(v, list) else v)
                    except Exception:
                        pass
                return None
            meta["title"] = get_tag("title", "TIT2", "\xa9nam")
            meta["artist"] = get_tag("artist", "TPE1", "\xa9ART")
            meta["album"] = get_tag("album", "TALB", "\xa9alb")
            meta["genre"] = get_tag("genre", "TCON", "\xa9gen")
            meta["year"] = get_tag("date", "TDRC", "TYER", "\xa9day")
            meta["language"] = get_tag("language", "TLAN")
    except Exception:
        pass
    return meta


# ---------------------------------------------------------------------------
# Main scan
# ---------------------------------------------------------------------------
async def scan_range(client, songs, start_id, end_id):
    channel = await client.get_entity(CHANNEL_ID)
    print(f"Channel: {channel.title}")

    total = 0
    skipped = 0
    errors = 0
    last_id = end_id

    while last_id >= start_id:
        msgs = await client.get_messages(channel, limit=BATCH_SIZE, offset_id=last_id + 1)
        if not msgs:
            break
        for msg in msgs:
            if msg.id < start_id:
                break
            if is_done(songs, msg.id):
                skipped += 1
                continue
            try:
                song = await process_message(client, msg)
                if song:
                    upsert_song(songs, song)
                    save_songs(songs)  # checkpoint after every song (crash-proof)
                    total += 1
                    print(f"  [{msg.id}] {song['file_name']} | lang={song['language']} | {song['media_type']}")
                else:
                    skipped += 1
            except Exception as e:
                errors += 1
                print(f"  [{msg.id}] ERROR: {e}")
                # mark as done so we don't retry forever on a corrupt file
                upsert_song(songs, {
                    "message_id": msg.id, "tg_file_id": None, "chat_id": str(CHANNEL_ID),
                    "file_name": None, "title": None, "artist": None, "album": None,
                    "genre": None, "year": None,
                    "mime_type": None, "media_type": None, "size": None, "duration": None,
                    "width": None, "height": None, "codec": None, "sample_rate": None,
                    "channels": None, "bitrate": None, "language": None,
                    "added_at": int(time.time() * 1000), "status": "error",
                })
                save_songs(songs)
            await asyncio.sleep(SLEEP_BETWEEN_MSGS)

        last_id = msgs[-1].id - 1
        print(f"  ... checkpoint at message {last_id} (total {total}, skipped {skipped}, errors {errors})")

    print(f"\nDONE. Indexed {total}, skipped {skipped}, errors {errors}.")
    return total


async def process_message(client, msg: Message):
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

    # ONLY index audio files — exclude videos, documents, and other non-audio media
    if media_kind != "audio":
        return None

    tg_file_id = serialize_file_id(
        file_type=file_type, dc_id=doc.dc_id, file_id=doc.id,
        access_hash=doc.access_hash, file_reference=bytes(doc.file_reference),
    )

    song = {
        "message_id": msg.id,
        "tg_file_id": tg_file_id,
        "chat_id": str(CHANNEL_ID),
        "file_name": file_name,
        "title": title,
        "artist": artist,
        "album": None,
        "genre": None,
        "year": None,
        "mime_type": doc.mime_type,
        "media_type": media_kind,
        "size": doc.size,
        "duration": duration,
        "width": width,
        "height": height,
        "codec": None,
        "sample_rate": None,
        "channels": None,
        "bitrate": None,
        "language": None,
        "added_at": int(msg.date.timestamp() * 1000) if msg.date else int(time.time() * 1000),
        "status": "done",
    }

    # Download and extract metadata (only for audio; skip huge videos to save time)
    if media_kind == "audio" and doc.size and doc.size < 60 * 1024 * 1024:
        tmp_base = os.path.join(os.path.dirname(os.path.abspath(__file__)), f"_tmp_{msg.id}")
        downloaded_path = None
        for attempt in range(1, DOWNLOAD_RETRIES + 1):
            try:
                path = await asyncio.wait_for(
                    client.download_media(msg, file=tmp_base),
                    timeout=DOWNLOAD_TIMEOUT,
                )
                # download_media returns the actual path (with extension)
                if path and os.path.exists(path) and os.path.getsize(path) > 0:
                    downloaded_path = path
                    break
                print(f"    (download produced empty file for {msg.id}, retrying)")
            except Exception as e:
                print(f"    (download attempt {attempt}/{DOWNLOAD_RETRIES} failed for {msg.id}: {e})")
            finally:
                await asyncio.sleep(2 * attempt)
        if downloaded_path:
            try:
                meta = extract_metadata(downloaded_path, doc.mime_type)
                for k, v in meta.items():
                    if v is not None:
                        song[k] = v
                # fall back to Telegram-provided title/artist if tags are empty
                if not song["title"] and title:
                    song["title"] = title
                if not song["artist"] and artist:
                    song["artist"] = artist
                if not song["duration"] and duration:
                    song["duration"] = duration
            except Exception as e:
                print(f"    (metadata skip for {msg.id}: {e})")
            finally:
                if os.path.exists(downloaded_path):
                    os.remove(downloaded_path)
        else:
            print(f"    (download failed for {msg.id} after {DOWNLOAD_RETRIES} attempts; saving without metadata)")

    # language: metadata first, then filename hints, then genre
    song["language"] = song.get("language") or detect_language(
        file_name, song["title"], song["artist"], song.get("genre"), song.get("album")
    )

    return song


# ---------------------------------------------------------------------------
# Export to JSON for D1 bulk upload
# ---------------------------------------------------------------------------
def export_json():
    songs = load_songs()
    done = [s for s in songs if s.get("status") == "done"]
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "songs_export.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(done, f, ensure_ascii=False, indent=2)
    print(f"Exported {len(done)} songs to {out}")
    return done


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--start", type=int, default=492)
    parser.add_argument("--end", type=int, default=2878)
    parser.add_argument("--resume", action="store_true", help="continue from last checkpoint")
    parser.add_argument("--export", action="store_true", help="export local JSON to songs_export.json")
    args = parser.parse_args()

    if args.export:
        export_json()
        return

    songs = load_songs()
    start_id = args.start
    end_id = args.end
    if args.resume:
        cp = get_checkpoint(songs)
        if cp is not None:
            start_id = min(start_id, cp + 1)
            print(f"Resuming from message {start_id}")

    client = TelegramClient(SESSION_PATH, API_ID, API_HASH)
    await client.start(phone=PHONE)
    me = await client.get_me()
    print("Logged in as:", me.username or me.first_name)

    try:
        await scan_range(client, songs, start_id, end_id)
    finally:
        await client.disconnect()


if __name__ == "__main__":
    asyncio.run(main())