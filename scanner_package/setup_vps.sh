#!/bin/bash
# =============================================================================
# Tele Music Player — VPS Scanner Setup (Ubuntu / AlmaLinux / RHEL / CentOS)
# Run as root:  sudo bash setup_vps.sh
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
echo "Place scan_songs.py, login.py, telethon_session.session, songs.json here: /opt/tele-music-scanner"

echo "=== Setting up systemd service (auto-run on boot) ==="
cat > /etc/systemd/system/tele-music-scan.service <<'EOF'
[Unit]
Description=Tele Music Scanner
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=/opt/tele-music-scanner
Environment=WORKER_URL=https://tele-music-player.ajithvnr2001.workers.dev
EnvironmentFile=/etc/tele-music-scan.env
ExecStart=/usr/bin/python3 /opt/tele-music-scanner/scan_songs.py --sync
EOF

echo "=== Setting up systemd timer (daily at 02:00) ==="
cat > /etc/systemd/system/tele-music-scan.timer <<'EOF'
[Unit]
Description=Run Tele Music Scanner daily at 02:00

[Timer]
OnCalendar=*-*-* 02:00:00
Persistent=true

[Install]
WantedBy=timers.target
EOF

echo "=== Setting up cron (daily at 02:00) as a fallback ==="
cat > /etc/cron.d/tele-music-scan <<'EOF'
# Run the scanner daily at 02:00, push metadata to Cloudflare
0 2 * * * root cd /opt/tele-music-scanner && WORKER_URL=https://tele-music-player.ajithvnr2001.workers.dev /usr/bin/python3 /opt/tele-music-scanner/scan_songs.py --sync >> /opt/tele-music-scanner/scan.log 2>&1
EOF

echo ""
echo "=== NEXT STEPS ==="
echo "1. Copy the scanner files into /opt/tele-music-scanner:"
echo "     scp scan_songs.py login.py telethon_session.session songs.json root@YOUR_VPS:/opt/tele-music-scanner/"
echo ""
echo "2. Set the production WEBHOOK_SECRET (needed for --sync):"
echo "     echo 'WEBHOOK_SECRET=YOUR_PRODUCTION_SECRET' > /etc/tele-music-scan.env"
echo "     chmod 600 /etc/tele-music-scan.env"
echo ""
echo "3. Enable the timer:"
echo "     systemctl daemon-reload"
echo "     systemctl enable --now tele-music-scan.timer"
echo ""
echo "4. Test manually:"
echo "     cd /opt/tele-music-scanner && python3 scan_songs.py --sync"
echo ""
echo "DONE."