#!/bin/bash
# Tele Music Scanner — cron driver.
# Loads WORKER_URL / WEBHOOK_SECRET / optional START_ID + END_ID from env file,
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
