# Tele Music Player — Scanner Package

Resumable Telegram channel scanner that downloads audio files, extracts rich
metadata (title, artist, album, genre, year, codec, sample rate, channels,
bitrate, duration) and **language**, and stores everything as raw JSON for
later bulk upload to Cloudflare D1. Designed to run on a small VPS and to
**auto-deploy whatever has been scanned so far every 5 hours** via cron.

---

## 1. What's in this package

| File | Purpose |
|------|---------|
| `scan_songs.py` | The scanner (single command, auto-resume, auto-export, `--sync`) |
| `run_scan.sh` | Cron driver: sources the env file, guards with `flock`, logs RUN/SKIP |
| `login.py` | One-time Telethon login helper (creates the session) |
| `requirements.txt` | Python dependencies (`telethon`, `mutagen`) |
| `setup_vps.sh` | Ubuntu/AlmaLinux VPS setup script (installs dep + cron.d entry) |
| `DEPLOYMENT_GUIDE.md` | **Full end-to-end guide** (Cloudflare + VPS + scanner + 5-hourly auto-sync) |
| `telethon_session.session` | Your existing Telegram session (no re-login needed) |
| `songs.json` | Already-scanned songs (raw data, resumable checkpoint) |
| `songs_export.json` | Done songs, ready for D1 upload |
| `scan.log` | Log of the scan progress (RUN/OK/SKIP/SYNC entries) |

---

## 2. Installations needed

1. **Python 3.8+** — https://www.python.org/downloads/
   - On Windows, tick **"Add Python to PATH"** during install.

2. **Python packages** (run in a terminal in this folder):
   ```
   pip install -r requirements.txt
   ```

---

## 3. How to run

### Option A — Resume the existing scan (recommended)
```
python scan_songs.py
```
It will:
- Auto-detect the channel's newest message and scan backwards from it.
- Skip songs already in `songs.json` (no re-download).
- Download each audio file → extract metadata + language → log it → delete the temp file → move on.
- Sync to Cloudflare (see section 5).

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
| `songs_export.json` | Only `status == "done"` songs — this is what gets uploaded to D1. |
| `scan.log` | Timestamped log (song lines + `RUN START/END`, `SKIP run`, `SYNC chunk`). |

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

## 5. Syncing to Cloudflare (`--sync`) — every 5h auto-deploy

`/api/import` on the worker accepts the `songs_export.json` array (upserts by
`chat_id` + `message_id`, does **not** wipe the DB). It requires the production
`WEBHOOK_SECRET` in the `X-Auth-Secret` header.

The scanner pushes metadata **twice**:
1. **Periodically during the scan** — every `SYNC_EVERY` newly-scanned songs
   (env var, default `100`; `0` disables). Whatever is scanned so far is
   deployed to Cloudflare immediately.
2. **At the end of each run** — after the last song.

Uploads are chunked (200 songs per POST) and idempotent (`songsUpserted` in
each response confirms how many were upserted).

```bash
export WORKER_URL="https://tele-music-player.ajithvnr2001.workers.dev"
export WEBHOOK_SECRET="YOUR_PRODUCTION_SECRET"
python scan_songs.py --sync
```

Manual upload (without the scanner):
```bash
curl -X POST "https://tele-music-player.ajithvnr2001.workers.dev/api/import" \
  -H "Content-Type: application/json" \
  -H "X-Auth-Secret: YOUR_WEBHOOK_SECRET" \
  --data @songs_export.json
```

---

## 6. Running on a VPS — fully automatic (cron every 5h)

A 1GB / 1-core VPS is enough — metadata extraction is light (mutagen reads
tags, doesn't decode audio). The bottleneck is download speed, not CPU/RAM.

> **Full step-by-step guide:** see **`DEPLOYMENT_GUIDE.md`**.

### Quick setup
```bash
# 1. Copy the package to the VPS, then run the setup script as root:
sudo bash setup_vps.sh

# 2. Copy the scanner files into /opt/tele-music-scanner:
#    scp scan_songs.py run_scan.sh login.py telethon_session.session songs.json root@YOUR_VPS:/opt/tele-music-scanner/

# 3. Set the real production WEBHOOK_SECRET:
echo 'WEBHOOK_SECRET=YOUR_PRODUCTION_SECRET' >> /etc/tele-music-scan.env
chmod 600 /etc/tele-music-scan.env

# 4. Test manually (validates lock + resume + Cloudflare sync):
bash /opt/tele-music-scanner/run_scan.sh

# 5. Watch it work:
tail -f /opt/tele-music-scanner/scan.log
```

### The cron file (`/etc/cron.d/tele-music-scan`)
```cron
# Tele Music Scanner - every 5h: resume indefinite scan + push to Cloudflare
0 */5 * * * root /opt/tele-music-scanner/run_scan.sh

# Catch up right after boot if the VM was off at a scheduled slot
@reboot root /opt/tele-music-scanner/run_scan.sh
```

### How it stays automatic
- Every 5 hours cron runs `run_scan.sh`, which resumes scanning from the
  last checkpoint in `songs.json` and, at the end, POSTs `songs_export.json`
  to Cloudflare `/api/import` (plus periodic syncs every `SYNC_EVERY` songs).
- **flock guard** (`/run/tele-music-scan.lock`): if a previous scan is still
  in progress, the new trigger logs
  `SKIP run: previous scan still in progress` to `scan.log` and exits —
  no overlapping scans, no double work.
- If the VM boots at an unscheduled time, `@reboot` catches up automatically.

---

## 7. Notes

- **Audio-only**: videos and documents are excluded.
- **Language** is detected from filename, album name, and genre (e.g. "Bollywood" → Hindi).
- **Crash-proof**: every song is saved to `songs.json` immediately. If it crashes,
  just run `run_scan.sh` / `python scan_songs.py` again — it resumes.
- **Temp files**: downloaded files are deleted after processing. If the process is
  force-killed mid-download, a `_tmp_<id>.m4a` may remain — delete it manually.
- **Network**: downloads need a stable connection to Telegram. The script retries 3× per file.

---

## 8. Playable file size limit (200MB)

The worker streams files up to **200MB** seamlessly via MTProto
(`upload.getFile` chunked streaming). Files >20MB can't use the Bot API
`getFile` (Telegram caps it at 20MB), so they stream via MTProto instead.
Browsers use Range requests, so playback is lossless and seamless.