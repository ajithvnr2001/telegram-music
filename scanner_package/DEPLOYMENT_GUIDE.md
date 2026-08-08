# Tele Music Player — End-to-End VPS Deployment Guide

Complete guide to run the **Tele Music Player** fully relying on a VPS for
scanning + metadata, with Cloudflare serving the player and streaming audio.
The VPS rescans the channel every **5 hours** and **automatically deploys
every newly-scanned song to Cloudflare D1** (no manual step, no waiting for
the full backfill to finish).

---

## Table of Contents
1. [Architecture Overview](#1-architecture-overview)
2. [What You Need](#2-what-you-need)
3. [Part A — Cloudflare Worker Setup](#part-a--cloudflare-worker-setup)
4. [Part B — Oracle VPS Setup](#part-b--oracle-vps-setup)
5. [Part C — Scanner Deployment](#part-c--scanner-deployment)
6. [Part D — First Full Scan](#part-d--first-full-scan)
7. [Part E — Automatic Sync (cron every 5h)](#part-e--automatic-sync-cron-every-5h)
8. [Part F — Verification](#part-f--verification)
9. [Troubleshooting](#troubleshooting)
10. [File Reference](#file-reference)

---

## 1. Architecture Overview

```
[Telegram Channel]  (the storage backend — all audio lives here)
        │
        ▼
[VPS 1GB/1core]  ← run_scan.sh (cron every 5h, flock-guarded)
        │  downloads each audio file
        │  extracts metadata + language (mutagen)
        │  deletes temp file
        │  PERIODICALLY (every SYNC_EVERY songs) AND at end of run:
        ▼  POSTs enriched metadata to /api/import (chunked, upsert)
[Cloudflare Worker + D1]  ← serves the web player, streams audio (up to 200MB)
        │
        ▼
[User's Browser]  ← plays music
```

**Division of work:**
- **VPS**: scans channel, downloads, extracts metadata, auto-syncs to D1 every 5h.
- **Cloudflare**: serves the player UI, streams audio from Telegram, stores metadata in D1.

---

## 2. What You Need

| Item | Details |
|------|---------|
| Telegram account | The one that has access to the private channel |
| Telegram API credentials | `api_id` + `api_hash` from https://my.telegram.org |
| Cloudflare account | For the Worker |
| Oracle Cloud account | Free tier VPS (Always Free) |
| The channel ID | `-1004303738393` |

---

## Part A — Cloudflare Worker Setup

The Worker is already deployed. If setting up fresh:

```bash
# 1. Install Node + npm, then:
npm install

# 2. Login to Cloudflare
npx wrangler login

# 3. Create the D1 database (once)
npx wrangler d1 create music-db
# → copy the database_id into wrangler.jsonc

# 4. Set secrets (production values!)
npx wrangler secret put BOT_TOKEN
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put MT_PROTO_API_ID
npx wrangler secret put MT_PROTO_API_HASH

# 5. Run migrations
npm run db:migrate

# 6. Deploy (Worker cron is DISABLED — VPS handles scanning)
npm run deploy
```

> **IMPORTANT**: The Worker's cron is disabled — the VPS does all scanning.
> `/api/import` requires the production `WEBHOOK_SECRET`.

---

## Part B — Oracle VPS Setup

### Choose the machine (both Always Free)
- **ARM Ampere A1 Flex** (`VM.Standard.A1.Flex`) — 1 OCPU + 6GB RAM, fastest downloads
- **AMD** `VM.Standard.E2.1.Micro` — 1GB RAM + 1 OCPU, minimum viable

1. Oracle Console → Compute → Instances → Create Instance → pick a free shape.
2. Upload your SSH public key, create, wait for boot.
3. Connect:
```bash
ssh -i ~/.ssh/your_key ubuntu@<VPS_PUBLIC_IP>
```

---

## Part C — Scanner Deployment

### 1. Copy files to the VPS
```bash
scp -i ~/.ssh/your_key -r scanner_package/* ubuntu@<VPS_PUBLIC_IP>:~/
```

### 2. Install everything (as root)
```bash
sudo bash setup_vps.sh
```
Installs: Python 3 + pip, `telethon` + `mutagen`, `/opt/tele-music-scanner/`,
`/etc/tele-music-scan.env` (secrets), `run_scan.sh` (flock driver) and
`/etc/cron.d/tele-music-scan` (every 5h + @reboot).

### 3. Set the real WEBHOOK_SECRET
```bash
echo 'WEBHOOK_SECRET=YOUR_PRODUCTION_SECRET' >> /etc/tele-music-scan.env
chmod 600 /etc/tele-music-scan.env
```
> `WEBHOOK_SECRET` must EXACTLY match the one on the Worker
> (`npx wrangler secret put WEBHOOK_SECRET`).

### 4. Verify the Telegram session
```bash
python3 -c "from telethon import TelegramClient; import asyncio; \
c=TelegramClient('telethon_session', 10870161, '81ca4e214e172c32768809cbb9463d51'); \
asyncio.run(c.start()); print('OK:', asyncio.run(c.get_me()).username)"
```
If the session is invalid: `python3 login.py` (phone + code).

---

## Part D — First Full Scan

Start the first scan manually. Everything is resumable, so a long backfill
never has to restart:

```bash
bash /opt/tele-music-scanner/run_scan.sh
tail -f /opt/tele-music-scanner/scan.log
```

Expected log flow:
```
RUN START (lock acquired)
Loaded 1933 song(s) from songs.json (1933 already done)
Channel: muscchannel | scanning 482 -> 11490
[11489] OK ... | lang=Telugu | audio
Periodic sync (every 5 songs this run)...
SYNC chunk 1: {'ok': True, 'songsUpserted': 200}
...
```

- Auto-detects the newest message, scans backwards, skips songs already in `songs.json`.
- **Periodic sync**: every `SYNC_EVERY` newly-scanned songs (default **100**,
  `0` disables), whatever has been scanned so far is POSTed to Cloudflare in
  chunks of 200 (`SYNC chunk N: {'ok': True, 'songsUpserted': 200}`).
- **End sync**: after the last song, one final full sync happens.

---

## Part E — Automatic Sync (cron every 5h)

### The cron file — `/etc/cron.d/tele-music-scan` (installed by setup_vps.sh)
```cron
# Tele Music Scanner - every 5h: resume indefinite scan + push to Cloudflare
0 */5 * * * root /opt/tele-music-scanner/run_scan.sh

# Catch up right after boot if the VM was off at a scheduled slot
@reboot root /opt/tele-music-scanner/run_scan.sh
```

### The driver — `/opt/tele-music-scanner/run_scan.sh`
```bash
#!/bin/bash
# Tele Music Scanner — cron driver.
# Loads WORKER_URL / WEBHOOK_SECRET / SYNC_EVERY from the env file,
# runs the resumable scanner and syncs newly scanned songs to Cloudflare.
# A flock guard prevents overlapping runs on long backfill scans.

DIR=/opt/tele-music-scanner
ENV_FILE=/etc/tele-music-scan.env
LOCK_FILE=/run/tele-music-scan.lock
LOG=/opt/tele-music-scanner/scan.log

if [ -f "$ENV_FILE" ]; then
    set -a
    . "$ENV_FILE"
    set +a
fi

export WORKER_URL="${WORKER_URL:-https://tele-music-player.ajithvnr2001.workers.dev}"
cd "$DIR"
exec 9>>"$LOCK_FILE"

if flock -n 9; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] RUN START (lock acquired)" >> "$LOG"
    /bin/python3 "$DIR/scan_songs.py" --sync >> "$LOG" 2>&1
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] RUN END (scanner exit $?)" >> "$LOG"
else
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] SKIP run: previous scan still in progress" >> "$LOG"
fi
```

### What happens every 5 hours
1. Cron fires → `run_scan.sh` → `flock -n` acquires `/run/tele-music-scan.lock`.
2. `scan_songs.py --sync` **resumes** the search from the last checkpoint
   (`songs.json`) — so a scan that takes days keeps progressing across runs,
   never restarts from zero.
3. During the run, **every `SYNC_EVERY` songs** (and at the end) the done
   songs are exported to `songs_export.json` and POSTed to
   `WORKER_URL/api/import` in chunks of 200 — **idempotent upsert**.
4. If a previous scan is still running, the next cron tick logs
   `SKIP run: previous scan still in progress` — never a second concurrent scan.

### Optional: the 5-hourly cadence can be changed
- `*/10 * * * *` = every 10 minutes (testing),
- `0 */8 * * *` = every 8 hours,
- and `SYNC_EVERY` in `/etc/tele-music-scan.env` controls how often the scan syncs mid-run.
After editing `/etc/cron.d/tele-music-scan`, cron auto-reloads within a minute
(`journalctl -u crond | grep CROND` shows the run).

---

## Part F — Verification

### 1. Cron actually fired
```bash
journalctl -u crond --no-pager -n 10 | grep -i "run_scan\|CROND"
# expect: CROND: (root) CMD (/opt/tele-music-scanner/run_scan.sh)
```

### 2. Scan ran + Cloudflare accepted the data
```bash
tail -30 /opt/tele-music-scanner/scan.log
# look for: RUN START (lock acquired)
#           SYNC chunk 1: {'ok': True, 'songsUpserted': 200}
#           RUN END (scanner exit 0)   or   SKIP run: ...
```
Each `SYNC chunk ...: {'ok': True, 'songsUpserted': N}` means N/200 songs were
written to D1.

### 3. Client actually sees the songs
```bash
curl -s "https://tele-music-player.ajithvnr2001.workers.dev/api/songs" | python3 -m json.tool | head -20
```

### 4. (Optional) quick 5-min validation on a fresh VPS
Change the cron to `*/5 * * * *`, restart crond, watch two ticks:
first tick `RUN START` + scanner + `SYNC chunk`s; second tick `SKIP` (lock).
Then restore `0 */5 * * *`.

---

## Troubleshooting

**» `SYNC chunk N FAILED: HTTP Error 401`**
`WEBHOOK_SECRET` mismatch — set the same on both sides (env file vs
`wrangler secret put WEBHOOK_SECRET`).

**» `SYNC chunk N FAILED: HTTP Error 502`**
The Worker's `/api/import` errored. Check `npx wrangler tail`.

**» Cron fired but scan.log has a `SKIP` line**
Expected! A previous scan still holds the flock — that run is still
progressing. If it always skips and is stuck for days, check
`ps -ef | grep scan_songs`; if it's hung, kill it and `@reboot`/next cron
tick will resume cleanly (checkpoint makes restarts safe).

**» No `SYNC chunk` lines at all**
`WEBHOOK_SECRET` missing/blank in `/etc/tele-music-scan.env` prints
`SKIP sync: WEBHOOK_SECRET not set`. Fix the env file.

**» Session expired**
`cd /opt/tele-music-scanner && python3 login.py` → refresh
`telethon_session.session`.

**» Downloads slow / failing (Telegram TimeoutError)**
The VPS→Telegram network may be slow; the script retries 3× per file and picks
up where it stopped. Bad songs are marked `error` and skipped on re-runs.

**» Songs missing metadata**
Some files have no tags — the scanner falls back to Telegram-provided
title/artist and filename-based language detection.

---

## File Reference

| File | Purpose |
|------|---------|
| `scan_songs.py` | Resumable scanner (`--sync`, periodic + end-of-run Cloudflare sync) |
| `run_scan.sh` | Cron driver — env load, flock guard, RUN/SKIP logging |
| `login.py` | One-time Telethon login helper |
| `requirements.txt` | Python deps (`telethon`, `mutagen`) |
| `setup_vps.sh` | VPS auto-setup (Python, deps, env, run_scan.sh, cron.d entry) |
| `telethon_session.session` | Your Telegram session |
| `songs.json` | Resumable checkpoint (processed songs) |
| `songs_export.json` | Done songs exported for D1 |
| `scan.log` | Run + sync log (RUN/SKIP/SYNC chunk) |