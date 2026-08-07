# Tele Music Player — Scanner Package

Resumable Telegram channel scanner that downloads audio files, extracts rich
metadata (title, artist, album, genre, year, codec, sample rate, channels,
bitrate, duration) and **language**, and stores everything as raw JSON for
later bulk upload to Cloudflare D1.

---

## 1. What's in this package

| File | Purpose |
|------|---------|
| `scan_songs.py` | The scanner (single command, auto-resume, auto-export) |
| `login.py` | One-time Telethon login helper (creates the session) |
| `requirements.txt` | Python dependencies |
| `telethon_session.session` | Your existing Telegram session (no re-login needed) |
| `songs.json` | Already-scanned songs (raw data, resumable checkpoint) |
| `songs_export.json` | Done songs, ready for D1 bulk upload |
| `scan.log` | Log of the scan progress |
| `setup_vps.sh` | AlmaLinux/RHEL VPS setup script (systemd + cron) |

---

## 2. Installations needed

1. **Python 3.8+** — https://www.python.org/downloads/
   - On Windows, tick **"Add Python to PATH"** during install.

2. **Python packages** (run in a terminal in this folder):
   ```
   pip install -r requirements.txt
   ```
   (installs `telethon` and `mutagen`)

---

## 3. How to run

### Option A — Resume the existing scan (recommended)
The session and `songs.json` are already here, so just run:
```
python scan_songs.py
```
It will:
- Auto-detect the channel's newest message and scan backwards from it.
- Skip songs already in `songs.json` (no re-download).
- Download each audio file → extract metadata + language → log it → delete the temp file → move on.
- At the end, write done songs to `songs_export.json`.

### Option B — Fresh login (only if the session file is missing/invalid)
```
python login.py
```
Enter your phone number, then the code Telegram sends (and 2FA password if any).
This creates `telethon_session.session`. Then run `python scan_songs.py`.

---

## 4. Output files

| File | What it is |
|------|-----------|
| `songs.json` | Raw list of every processed song (the resumable checkpoint). |
| `songs_export.json` | Only `status == "done"` songs — this is what you upload to D1. |
| `scan.log` | Timestamped log of every song processed. |

### Sample entry in `songs_export.json`
```json
{
  "message_id": 494,
  "tg_file_id": "BQACAgU...",
  "chat_id": "-1004303738393",
  "file_name": "01.Chhoti Si Aasha (Version, 1).ALAC.Lossless.m4a",
  "title": "Chhoti Si Aasha (Version, 1)",
  "artist": "Minmini",
  "album": "Roja (Original Motion Picture Soundtrack)",
  "genre": "Bollywood",
  "year": "1993-01-01",
  "mime_type": "audio/mp4",
  "media_type": "audio",
  "size": 34116027,
  "duration": 297.3,
  "width": null,
  "height": null,
  "codec": "alac",
  "sample_rate": 44100,
  "channels": 2,
  "bitrate": 1411200,
  "language": "Hindi",
  "added_at": 1785873321000,
  "status": "done"
}
```

---

## 5. Notes

- **Audio-only**: videos and documents are excluded.
- **Language** is detected from filename, album name, and genre (e.g. "Bollywood" → Hindi, "Roja (Malayalam)" → Malayalam).
- **Crash-proof**: every song is saved to `songs.json` immediately. If it crashes, just run `python scan_songs.py` again — it resumes from where it left off.
- **Temp files**: downloaded files are deleted after processing. If the process is force-killed mid-download, a `_tmp_<id>.m4a` may remain — delete it manually.
- **Network**: downloads need a stable connection to Telegram. The script retries 3× per file.

---

## 6. Uploading to Cloudflare D1

`/api/import` on the worker accepts the `songs_export.json` array (upserts by
`chat_id` + `message_id`, does not wipe the DB). It requires the production
`WEBHOOK_SECRET` in the `X-Auth-Secret` header.

Example:
```bash
curl -X POST "https://tele-music-player.ajithvnr2001.workers.dev/api/import" \
  -H "Content-Type: application/json" \
  -H "X-Auth-Secret: YOUR_WEBHOOK_SECRET" \
  --data @songs_export.json
```

### Auto-sync after scanning (`--sync`)
The scanner can push metadata to Cloudflare automatically after each run:
```bash
export WORKER_URL="https://tele-music-player.ajithvnr2001.workers.dev"
export WEBHOOK_SECRET="YOUR_PRODUCTION_SECRET"
python scan_songs.py --sync
```
It scans → exports → POSTs `songs_export.json` to `/api/import` (upsert).

---

## 7. Running on a VPS (AlmaLinux / RHEL)

A 1GB / 1-core VPS is enough — metadata extraction is light (mutagen reads
tags, doesn't decode audio). The bottleneck is download speed, not CPU/RAM.

### Quick setup
```bash
# 1. Copy the package to the VPS, then run the setup script as root:
sudo bash setup_vps.sh

# 2. Copy the scanner files into /opt/tele-music-scanner:
#    scp scan_songs.py login.py telethon_session.session songs.json root@YOUR_VPS:/opt/tele-music-scanner/

# 3. Set the production WEBHOOK_SECRET:
echo 'WEBHOOK_SECRET=YOUR_PRODUCTION_SECRET' > /etc/tele-music-scan.env
chmod 600 /etc/tele-music-scan.env

# 4. Enable the systemd service (auto-run on boot + daily):
systemctl daemon-reload
systemctl enable --now tele-music-scan

# 5. Test manually:
cd /opt/tele-music-scanner && python3 scan_songs.py --sync
```

The setup script installs:
- Python 3 + pip + `telethon` + `mutagen`
- A **systemd service** (`tele-music-scan`) that runs `scan_songs.py --sync` on boot
- A **cron job** (daily 02:00) as a fallback

### Recommended: disable the Worker's own 6h scan cron
Since the VPS now handles scanning + metadata + sync, disable the Worker's
`0 */6 * * *` cron to avoid duplicate work. (Edit `wrangler.jsonc` → remove the
`triggers.crons` entry, or remove the cron trigger in the Cloudflare dashboard.)

---

## 8. Playable file size limit (200MB)

The worker streams files up to **200MB** seamlessly via MTProto
(`upload.getFile` chunked streaming). Files >20MB can't use the Bot API
`getFile` (Telegram caps it at 20MB), so they stream via MTProto instead.
Browsers use Range requests for streaming/seeking, so playback is lossless
and seamless up to 200MB.