#!/bin/bash
# =============================================================================
# Tele Music Player — VPS Scanner Setup (Ubuntu / AlmaLinux / RHEL / CentOS)
# Run as root:  sudo bash setup_vps.sh
#
# Installs the resumable scanner + run_scan.sh driver and schedules it via
# /etc/cron.d every 5 hours (with a @reboot catch-up). The scanner resumes
# from songs.json and syncs whatever has been scanned so far to Cloudflare.
# =============================================================================
set -e

echo "=== Detecting OS ==="
if [ -f /etc/os-release ]; then
    . /etc/os-release
    echo "OS: $PRETTY_NAME"
else
    echo "Cannot detect OS. Assuming Debian/Ubuntu."
    ID="ubuntu"
fi

echo "=== Installing Python 3 + pip ==="
if [ "$ID" = "ubuntu" ] || [ "$ID" = "debian" ]; then
    apt-get update -y
    apt-get install -y python3 python3-pip python3-venv unzip
else
    dnf install -y python3 python3-pip python3-devel gcc unzip
fi

echo "=== Installing scanner dependencies ==="
pip3 install --upgrade pip
pip3 install telethon mutagen

echo "=== Creating scanner directory ==="
mkdir -p /opt/tele-music-scanner
echo "Place scan_songs.py, run_scan.sh, login.py, telethon_session.session, songs.json here: /opt/tele-music-scanner"

echo "=== Creating the env file (secrets) ==="
cat > /etc/tele-music-scan.env <<'EOF'
WORKER_URL=https://tele-music-player.ajithvnr2001.workers.dev
WEBHOOK_SECRET=YOUR_PRODUCTION_SECRET
# Optional: sync to Cloudflare every N newly-scanned songs (default 100). 0 disables periodic sync.
SYNC_EVERY=100
EOF
chmod 600 /etc/tele-music-scan.env
echo "EDIT /etc/tele-music-scan.env and set the real WEBHOOK_SECRET (chmod 600 already applied)."

echo "=== Installing run_scan.sh (cron driver with flock) ==="
cat > /opt/tele-music-scanner/run_scan.sh <<'EOF'
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
EOF
chmod 755 /opt/tele-music-scanner/run_scan.sh

echo "=== Setting up cron (every 5 hours + catch-up on boot) ==="
cat > /etc/cron.d/tele-music-scan <<'EOF'
# Tele Music Scanner - every 5h: resume indefinite scan + push to Cloudflare
0 */5 * * * root /opt/tele-music-scanner/run_scan.sh

# Catch up right after boot if the VM was off at a scheduled slot
@reboot root /opt/tele-music-scanner/run_scan.sh
EOF

echo ""
echo "=== NEXT STEPS ==="
echo "1. Copy scanner files into /opt/tele-music-scanner:"
echo "     scp scan_songs.py login.py telethon_session.session songs.json root@YOUR_VPS:/opt/tele-music-scanner/"
echo ""
echo "2. Set the real WEBHOOK_SECRET in /etc/tele-music-scan.env"
echo ""
echo "3. Test manually (validates lock, resume + Cloudflare sync):"
echo "     bash /opt/tele-music-scanner/run_scan.sh"
echo "     tail -f /opt/tele-music-scanner/scan.log   # look for \"SYNC chunk ... songsUpserted\""
echo ""
echo "4. Cron runs itself every 5 hours. While a run is in progress, extra triggers"
echo "   log 'SKIP run: previous scan still in progress' to scan.log (flock guard)."
echo ""
echo "DONE."