# Tele Music Player — End-to-End VPS Deployment Guide

Complete guide to run the **Tele Music Player** fully relying on a VPS for
scanning + metadata, with Cloudflare serving the player and streaming audio.

---

## Table of Contents
1. [Architecture Overview](#1-architecture-overview)
2. [What You Need](#2-what-you-need)
3. [Part A — Cloudflare Worker Setup](#part-a--cloudflare-worker-setup)
4. [Part B — Oracle VPS Setup](#part-b--oracle-vps-setup)
5. [Part C — Scanner Deployment](#part-c--scanner-deployment)
6. [Part D — First Full Scan](#part-d--first-full-scan)
7. [Part E — Automatic Daily Sync](#part-e--automatic-daily-sync)
8. [Part F — Verification](#part-f--verification)
9. [Troubleshooting](#troubleshooting)
10. [File Reference](#file-reference)

---

## 1. Architecture Overview

```
[Telegram Channel]  (the storage backend — all audio lives here)
        │
        ▼
[VPS 1GB/1core]  ← scan_songs.py --sync (daily cron)
        │  downloads each audio file
        │  extracts metadata + language (mutagen)
        │  deletes temp file
        │  POSTs enriched metadata to /api/import
        ▼
[Cloudflare Worker + D1]  ← serves the web player, streams audio (up to 200MB)
        │
        ▼
[User's Browser]  ← plays music
```

**Division of work:**
- **VPS**: scans channel, downloads, extracts metadata, syncs to D1. Background worker only.
- **Cloudflare**: serves the player UI, streams audio from Telegram, stores metadata in D1.

---

## 2. What You Need

| Item | Details |
|------|---------|
| Telegram account | The one that has access to the private channel |
| Telegram API credentials | `api_id` + `api_hash` from https://my.telegram.org |
| Cloudflare account | For the Worker + D1 |
| Oracle Cloud account | Free tier VPS (Always Free) |
| The channel ID | `-1004303738393` |
| The bot token | `musicvnrbot` |

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

# 6. Deploy (cron is DISABLED — VPS handles scanning)
npm run deploy

# 7. Set the webhook
curl "https://<worker>.workers.dev/setwebhook"
```

> **IMPORTANT**: The Worker's cron is disabled. The VPS handles all scanning.
> The `/api/import` endpoint (used by the VPS) requires `WEBHOOK_SECRET`.

---

## Part B — Oracle VPS Setup

### Choose the machine
- **Recommended**: ARM Ampere A1 Flex (`VM.Standard.A1.Flex`) — 1 OCPU + 6GB RAM, **Always Free**
- **Minimum**: AMD `VM.Standard.E2.1.Micro` — 1GB RAM + 1 OCPU, **Always Free**
- **OS**: Ubuntu 22.04 (easiest) or Oracle Linux 8

### Create the instance
1. Oracle Cloud Console → Compute → Instances → Create Instance
2. Choose the Always Free shape above
3. Upload your SSH public key
4. Create → wait for it to boot

### Connect
```bash
ssh -i ~/.ssh/your_key ubuntu@<VPS_PUBLIC_IP>
```

---

## Part C — Scanner Deployment

### 1. Copy the package to the VPS
From your local machine:
```bash
scp -i ~/.ssh/your_key tele-music-scanner.zip ubuntu@<VPS_PUBLIC_IP>:~/
```

### 2. On the VPS, extract and install
```bash
cd ~
unzip tele-music-scanner.zip -d tele-music-scanner
cd tele-music-scanner

# Install Python + deps (Ubuntu)
sudo apt update
sudo apt install -y python3 python3-pip unzip
pip3 install --user -r requirements.txt
```

> If you used **AlmaLinux/Oracle Linux** instead, run `sudo bash setup_vps.sh`
> (it uses `dnf` and sets up systemd + cron automatically).

### 3. Set the production WEBHOOK_SECRET
```bash
echo 'export WEBHOOK_SECRET="YOUR_PRODUCTION_SECRET"' >> ~/.bashrc
echo 'export WORKER_URL="https://tele-music-player.ajithvnr2001.workers.dev"' >> ~/.bashrc
source ~/.bashrc
```

> The `WEBHOOK_SECRET` must match the one set on the Worker (`wrangler secret put WEBHOOK_SECRET`).

### 4. Verify the session works
The package includes `telethon_session.session`. Test login:
```bash
python3 -c "from telethon import TelegramClient; import asyncio; \
c=TelegramClient('telethon_session', 10870161, '81ca4e214e172c32768809cbb9463d51'); \
asyncio.run(c.start()); print('OK:', asyncio.run(c.get_me()).username)"
```

If the session is invalid, re-login:
```bash
python3 login.py
# enter phone + code
```

---

## Part D — First Full Scan

Run the scanner once to index everything (this takes a while — it downloads
every audio file to read its metadata):
```bash
cd ~/tele-music-scanner
python3 scan_songs.py --sync
```

- It auto-detects the newest message and scans backwards.
- It skips songs already in `songs.json` (resumable).
- Each song: download → extract metadata → log → delete temp → next.
- At the end it POSTs `songs_export.json` to Cloudflare `/api/import`.

Watch progress:
```bash
tail -f scan.log
```

---

## Part E — Automatic Daily Sync

### Option 1: systemd service + timer (recommended)
Create a systemd timer that runs the scan daily:

```bash
sudo tee /etc/systemd/system/tele-music-scan.service > /dev/null <<'EOF'
[Unit]
Description=Tele Music Scanner
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=/home/ubuntu/tele-music-scanner
Environment=WORKER_URL=https://tele-music-player.ajithvnr2001.workers.dev
EnvironmentFile=/etc/tele-music-scan.env
ExecStart=/usr/bin/python3 /home/ubuntu/tele-music-scanner/scan_songs.py --sync
EOF

sudo tee /etc/systemd/system/tele-music-scan.timer > /dev/null <<'EOF'
[Unit]
Description=Run Tele Music Scanner daily at 02:00

[Timer]
OnCalendar=*-*-* 02:00:00
Persistent=true

[Install]
WantedBy=timers.target
EOF

# Set the secret
echo 'WEBHOOK_SECRET=YOUR_PRODUCTION_SECRET' | sudo tee /etc/tele-music-scan.env
sudo chmod 600 /etc/tele-music-scan.env

# Enable
sudo systemctl daemon-reload
sudo systemctl enable --now tele-music-scan.timer
```

### Option 2: cron (simpler)
```bash
crontab -e
# add:
0 2 * * * cd /home/ubuntu/tele-music-scanner && WORKER_URL=https://tele-music-player.ajithvnr2001.workers.dev WEBHOOK_SECRET=YOUR_PRODUCTION_SECRET /usr/bin/python3 scan_songs.py --sync >> scan.log 2>&1
```

---

## Part F — Verification

### Check the scan ran
```bash
tail -20 ~/tele-music-scanner/scan.log
# look for: SYNC OK: {'ok': true, 'songsUpserted': N}
```

### Check the worker has the songs
```bash
curl "https://tele-music-player.ajithvnr2001.workers.dev/api/songs" | python3 -m json.tool | head
```

### Check the player
Open `https://tele-music-player.ajithvnr2001.workers.dev` — songs should appear
with full metadata (title, artist, album, language).

---

## Troubleshooting

**» `SYNC FAILED: HTTP Error 401`**
The `WEBHOOK_SECRET` doesn't match the Worker's. Re-set it on both sides.

**» `SYNC FAILED: HTTP Error 502`**
The Worker's `/api/import` errored. Check `npx wrangler tail` on the Worker.

**» Session expired**
Run `python3 login.py` again to refresh `telethon_session.session`.

**» Downloads slow / failing**
The VPS network to Telegram may be slow. The script retries 3× per file. For a
large first scan, let it run — it's resumable.

**» Songs missing metadata**
Some files have no tags. The scanner falls back to Telegram-provided title/artist
and filename-based language detection.

---

## File Reference

| File | Purpose |
|------|---------|
| `scan_songs.py` | The scanner (single command, auto-resume, auto-export, `--sync`) |
| `login.py` | One-time Telethon login helper |
| `requirements.txt` | Python deps (`telethon`, `mutagen`) |
| `setup_vps.sh` | AlmaLinux/RHEL auto-setup (systemd + cron) |
| `telethon_session.session` | Your Telegram session (no re-login) |
| `songs.json` | Already-scanned songs (resumable checkpoint) |
| `songs_export.json` | Done songs, ready for D1 upload |
| `scan.log` | Scan progress log |