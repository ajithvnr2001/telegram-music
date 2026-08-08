# Tele Music Player — Progress Log

> Status as of **Aug 8, 2026**. Everything below is verified on the production VPS
> and this repo is the single source of truth for deployable code.

---

## What this is

A Telegram-channel music library served by a Cloudflare Worker + D1 database,
with a VPS doing the heavy lifting: downloading every song from the channel,
extracting rich metadata (title, artist, album, genre, codec, sample rate,
bitrate, duration, **language**), and auto-syncing it to Cloudflare on a
schedule — no manual steps.

---

## Architecture (end-to-end)

```
[Telegram Channel]  (all audio lives here — the storage backend)
        │
        ▼
[VPS — /opt/tele-music-scanner]
        ├─ run_scan.sh     cron driver (flock guard, RUN/SKIP logging)
        ├─ scan_songs.py   resumable scanner + metadata/language extractor
        └─ /etc/tele-music-scan.env   secrets (WEBHOOK_SECRET, SYNC_EVERY)
        │  cron: 0 */5 * * *  → resume scan → periodic + end-of-run sync
        ▼
[Cloudflare Worker + D1]
        ├─ web player (search, playlists, upload, streaming up to 200MB)
        └─ /api/import (upsert, chunked 200 songs/request, non-destructive)
        ▼
[User's Browser]
```

---

## Current production state

| Component | Status |
|-----------|--------|
| Scanner | ✅ Running (started by cron at 10:00 UTC), resumable via `songs.json` |
| Songs indexed | ✅ 2,004 done songs (all synced) |
| Cloudflare sync | ✅ `SYNC chunk … {'ok': True, 'songsUpserted': …}` verified |
| Cron (every 5h) | ✅ `/etc/cron.d/tele-music-scan` + `@reboot` catch-up |
| Work — repo | ✅ Updated & pushed — `ajithvnr2001/telegram-music` (master) |

---

## What was fixed / added (Aug 7→8, 2026)

1. **Cron was silently no-op'ing.**
   - Root cause: the old one-liner driver used
     `exec flock -n … || echo SKIP` — `exec` replaces the shell, so the
     `||` branch never ran and every cron tick exited 1 with **zero logging**.
   - Fix: `run_scan.sh` opens `/run/tele-music-scan.lock` (fd 9) and uses
     `flock -n 9`; it now logs `RUN START (lock acquired)`, `RUN END` or
     `SKIP run: previous scan still in progress`.

2. **Auto-deploy was stuck to the end of a multi-day backfill.**
   Before: sync happened only after the entire channel was scanned.
   Now: **periodic sync** — every `SYNC_EVERY` newly scanned songs (default
   100, `0` disables) the done songs are exported to `songs_export.json` and
   POSTed to `/api/import` in chunks of 200 (idempotent upsert), plus a final
   sync at the end of each run. Whatever is scanned gets deployed fast.

3. **Resume-safe restarts.** Each song is checkpointed to `songs.json`; the
   scanner auto-detects the newest message and scans backwards, skipping done
   IDs — a run that takes days can be killed and resumed freely.

4. **Upload hardening.** Browser-style `User-Agent` (Cloudflare rejects the
   default Python-urllib UA) and 120 s per-request timeout; errors are logged
   as `SYNC chunk N FAILED: …` without aborting the scan.

5. **Better language detection.** Genre fallback + `ALBUM_LANG` table maps
   movie titles ("Roja …", "Bombay Dreams", "Tirumala" …) to Hindi / Tamil /
   Telugu / Kannada / Malayalam / Bengali.

---

## Validation evidence (from /opt/tele-music-scanner/scan.log)

```
[2026-08-08 10:00:01] RUN START (lock acquired)          ← cron tick at 10:00 UTC
[2026-08-08 10:00:05] Loaded 1933 song(s) … (1933 already done)
[2026-08-08 10:00:22] [11489] OK … | lang=Telugu | audio
[2026-08-08 10:01:50] SYNC chunk 7: {'ok': True, 'songsUpserted': 200}
[2026-08-08 10:03:11] Periodic sync (every 100 songs this run)…
[2026-08-08 10:05:01] SKIP run: previous scan still in progress   ← flock guard works
[2026-08-08 10:32:27] SYNC chunk 9: {'ok': True, 'songsUpserted': 200}
[2026-08-08 10:32:30] SYNC chunk 11: {'ok': True, 'songsUpserted': 3}
```

---

## Files in this repo

| File | Purpose |
|------|---------|
| `src/`, `wrangler.jsonc` | Cloudflare Worker (player UI, streaming, D1, uploads) |
| `migrations/` | D1 SQL migrations |
| `scan_songs.py` | Resumable scanner (auto-resume, period sync, language detection) |
| `run_scan.sh` | Cron driver — env load, **flock guard**, RUN/SKIP logging |
| `login.py` | One-time Telethon session login |
| `setup_vps.sh` (in `scanner_package/`) | VPS auto-setup — deps, env file, cron.d entry |
| `scanner_package/README.md` | Scanner package guide |
| `scanner_package/DEPLOYMENT_GUIDE.md` | **End-to-end deployment guide** (Cloudflare + VPS + cron + verification) |

---

## Deployment checklist (summary — full guide: `scanner_package/DEPLOYMENT_GUIDE.md`)

1. `scanner_package/DEPLOYMENT_GUIDE.md` — Cloudflare Worker setup (secrets,
   migrations, deploy; Worker cron disabled).
2. `sudo bash scanner_package/setup_vps.sh` on the VPS → creates
   `/opt/tele-music-scanner/`, `/etc/tele-music-scan.env`, `run_scan.sh`,
   `/etc/cron.d/tele-music-scan`:
   ```cron
   0 */5 * * * root /opt/tele-music-scanner/run_scan.sh
   @reboot root /opt/tele-music-scanner/run_scan.sh
   ```
3. Copy `scan_songs.py run_scan.sh login.py telethon_session.session songs.json`
   → `/opt/tele-music-scanner/`, set the real `WEBHOOK_SECRET` in the env file,
   `chmod 600`.
4. Test manually: `bash /opt/tele-music-scanner/run_scan.sh`, watch
   `tail -f scan.log` for `SYNC chunk … songsUpserted`.
5. Verify playback: `worker@YOUR_WORKER.workers.dev` lists the songs.

---

## Known gaps (deliberately not done — revisit later)

- Error songs are marked and skipped forever — a retry-errors mode would help.
- No alerting when cron/sync fails (health endpoint / heartbeat not present).
- Unbounded `scan.log` growth (needs logrotate) and `_tmp_*` cleanup on kill.
- UI: language/album browse tabs, queue + shuffle, PWA installable option —
  deferred.