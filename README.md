# Tele Music Player

A music library and player hosted entirely on **Cloudflare Workers (+ D1 + Durable Objects)** that streams a private Telegram channel's songs straight to a web player.

Send music to your Telegram bot once — the channel is the storage backend, the worker indexes every song (with scheduled cron re-scans), and a single-page player serves search, playback, playlists and uploads to any device. No VPS, no paid storage.

---

## Features

- 🎵 **Full library player** — browse every song in the channel, native seek / pause / next / prev.
- 🔍 **Live search** by filename, title or artist.
- 📁 **Playlists** — create, rename-less lists, add songs with a single `＋`, stored in D1 so they follow you to **any device**.
- 🧠 **Cron auto-indexing** — a scheduled Cloudflare cron scans the channel for new music every 6h; no manual rescans.
- 📤 **Web uploads** — drag & drop files into the browser; they're pushed to the channel via the bot and indexed on the spot.
- 🤖 **Telegram bot** — `/scan`, `/list`, `/search`, `/delete`, `/stats`, `/help`, plus auto-import of forwarded songs and channel posts.
- 🎬 **Audio + video** — mp3 / m4a / flac / ogg / opus / wav / aac / mp4 / webm / mkv / mov / avi … (media in the channel).
- 🔐 **Optional password gate** for the player and its API.
- 📶 **Range streaming** — real `206 Partial Content` seeks through Cloudflare.

---

## How it works

```
                    ┌──────────────────────────────────────────────┐
                    │  Telegram (api.telegram.org)                 │
                    │  - your private channel = the storage        │
                    │  - bot musicvnrbot pushes / reads media      │
                    └───────────────┬──────────────────────────────┘
                                    │  Bot API (upload / getFile URL / webhook)
                                    ▼
                        ┌───────────────────────┐
                        │   Cloudflare Worker   │
                        │   tele-music-player   │
                        │  src/┐                │
                        │  index.ts  → routes, webhook, scheduler
                        │  upload.ts → index new channel posts
                        │  hosting.ts→ browser uploads
                        │  stream.ts → Range streaming
                        │  db.ts     → D1 CRUD + playlists
                        │  web.ts    → player HTML/JS/CSS
                        │  scanner.ts→ MTProto user-session channel scan
                        └───────────┬───────────┘
                                    │
                    ┌───────────────┴──────────────┐
                    │  D1 (music-db)               │
                    │  songs · stats · playlists    │
                    └──────────────────────────────┘
```

Two indexing paths keep the library in sync:

1. **Live indexing** — every `channel_post` or forwarded media message that reaches the bot is recorded to D1 immediately (`indexFile`).
2. **Cron re-index** — `0 */6 * * *` runs the MTProto scanner (`scanner.ts`) as the logged-in **user session** (not the bot), crawling the channel history and inserting anything missing. This is why you never have to manually scan again.

Playback goes: browser → `/stream?id=N` → worker → `getFile` download URL from the Telegram CDN → `206` range responses. Files signed as `audio/*` or `video/*` and videos stream with full seeking.

---

## Repository layout

```
src/
  index.ts           Worker entry — routing, Telegram webhook, cron, auth, all /api/* handlers
  web.ts             The web player (HTML + CSS + inline JS) served at "/"
  stream.ts          Range-capable streaming proxy (parseRange, handleStream)
  db.ts              D1: songs, stats, playlists CRUD
  scanner.ts         MTProto (user session) scanner + ChannelScanner Durable Object (+ /scanner/* routes)
  hosting.ts         Browser web-upload handler (sends media into the channel)
  telegram.ts        Minimal Telegram Bot API client (getFile, send*, uploadMultipart)
  upload.ts          indexFile/extractMedia/splitArtistTitle helpers
  types.ts           Env + Song + shared types & helpers
migrations/
  0001_init.sql      songs + stats schema
  0002_scanner_state.sql  cursor state for the MTProto cron scan
  0003_playlists.sql      playlists + playlist_songs
wrangler.jsonc       Worker config — D1, DO, cron, vars
scripts/backfill.py  Python import helper (optional)
```

---

## Prerequisites

- Node.js **18+**
- A Cloudflare account (free tier is enough)
- A **Telegram bot** token (from [@BotFather](https://t.me/BotFather))
- A Telegram **channel** where music is stored; the bot must be **admin** of it
- (For the MTProto scanner) a Telegram **user account** that is a member of the channel

---

## Setup

### 1. Install & authenticate

```bash
npm install
npx wrangler login
```

### 2. Create the D1 database

```bash
npx wrangler d1 create music-db
```

Copy the returned `database_id` into `wrangler.jsonc` → `d1_databases[0].database_id`.

### 3. Secrets

Never commit secrets. Set them as Cloudflare secrets:

```bash
npx wrangler secret put BOT_TOKEN          # 123456:ABC... from BotFather
npx wrangler secret put WEBHOOK_SECRET     # anything long & random
npx wrangler secret put MT_PROTO_API_ID    # optional api_id/hash for the MTProto scanner
npx wrangler secret put MT_PROTO_API_HASH  # optional
npx wrangler secret put WEB_PASSWORD       # optional password — leave unset for public player
```

> For local dev, put the same keys in a local `.dev.vars` file (git-ignored).

### 4. Configure `wrangler.jsonc`

- `vars.CHANNEL_ID` → your channel id, e.g. `-1001234567890` (with the `-100…` prefix)
- `vars.ADMIN_IDS` → comma-separated Telegram user ids allowed to admin
- `vars.BOT_USERNAME` → your bot username, used for the worker URL default
- `trigger.cron` → scan schedule (default `0 */6 * * *`)

### 5. Migrations

```bash
npx wrangler d1 migrations apply music-db
```

### 6. Local dev

```bash
npm run dev
```

`npm run dev` must be running when you point the webhook at it (see below), otherwise local webhook updates 404.

### 7. Deploy

```bash
npm run deploy
```

After every deploy, **bump the cache-buster** when hitting the site (e.g. `/?cb=…`) — the worker itself sets
`Cache-Control: no-store`, but CDN caches can linger.

### 8. Wire the webhook

The worker exposes `GET /setwebhook` you can hit once to point your bot's updates at the worker (or configure it manually in BotFather / `setWebhook` bot-method):

```
https://your-worker.workers.dev/setwebhook
```

The webhook (`POST /webhook`) rejects requests that don't carry `X-Telegram-Bot-Api-Secret-Token` matching `WEBHOOK_SECRET`.

---

## Environment & routing summary

| Route                               | Description                                        |
|-------------------------------------|----------------------------------------------------|
| `/`                                 | Player page (COOP `same-origin` + COEP `require-corp` for the browser ffmpeg build) |
| `/health`                           | liveness probe                                    |
| `/api/songs`                        | List all songs (optionally Web-Auth gated)        |
| `/api/song?id=N`                    | Single song meta                                  |
| `/api/upload`                       | Web upload                                        |
| `/stream?id=N`                      | Range-streamed audio/video bytes                  |
| `/api/playlists`                    | List / create playlists (global, any device)      |
| `/api/playlist?id=N`                | Get / delete a playlist                           |
| `/api/playlist/add` · `/api/playlist/remove` | Add/remove songs                     |
| `/scanner/*`                        | MTProto scanner init / run / status               |
| `/webhook`                          | Telegram updates (webhook)                        |
| `/setwebhook`                       | (Re)configures the webhook                        |
| `/dbg`, `/import`, `/wstest`        | Debug endpoints — remove or guard in prod         |

---

## The browser ALAC note (very important)

This channel stores music as **`.m4a` ALAC (Apple Lossless)** files. No Chromium/Firefox/Android
browser has a native ALAC decoder, so the player **transcodes ALAC → FLAC losslessly in the browser**
using `@ffmpeg/ffmpeg` and plays the resulting blob.

For that to work the page must be **cross-origin isolated**, which is why the worker serves the player
with:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Those headers unlock Chrome/Edge/Firefox's `SharedArrayBuffer`, required by ffmpeg.wasm's multithreaded
core. Do **not** remove them, or songs will fail with `SharedArrayBuffer is not defined`.

In short:
- `.alac` / `.m4a` (ALAC) → lossless FLAC in-browser → plays everywhere. Quality is unchanged.
- `.m4a` (AAC) and `.mp3`, `.flac`, `.ogg`, `.wav` → played natively by the browser with zero conversion.

---

## Telegram integration

### Commands the bot understands:

- `/start` — welcome + how to
- `/help` — usage
- `/list` — library stats (counts audio/video/total)
- `/search <query>` — search results + deep link into the player
- `/stats` — same as `/list`
- `/delete <id>` — remove a song (admin only)
- `/scan` — manual channel re-scan
- `/setvolume` etc. keep shape from typical cloud gatekeepers (synthetic bot commands)

### Automatic indexing

- **Channel posts**: any new audio/video the bot sees in the channel gets indexed into D1.
- **Forwarded messages**: forward songs from the channel into the bot DM → imported in place, no copy.
- **Cron**: the scanner Durable Object re-crawls the channel periodically to pick up anything past the live indexing missed (auth, out-of-order, etc.).

---

## VPS scanner + metadata sync (optional)

The Worker's 6h cron indexes songs but can't extract rich metadata (title,
artist, album, genre, year, codec, sample rate, channels, bitrate, language)
because that requires downloading each file. For that, run the Python scanner
on a small VPS (1GB / 1 core is enough) and auto-sync metadata to D1.

```
[Telegram Channel] ──► [VPS 1GB/1core] ──► POST /api/import ──► [Cloudflare Worker + D1]
                        scan_songs.py --sync
                        (download + metadata + language)
```

- `scan_songs.py` — resumable scanner (auto-detect end, auto-resume, auto-export).
- `login.py` — one-time Telethon login.
- `run_scan.sh` — cron driver; flock-guarded, logs RUN/SKIP, calls `scan_songs.py --sync`.
- `setup_vps.sh` — Ubuntu/AlmaLinux setup; installs deps, env file, cron.d entry.
- `--sync` POSTs `songs_export.json` to `/api/import` (upsert, non-destructive),
  **periodically during scanning** (every `SYNC_EVERY`, default 100) and at run end — so whatever has been scanned is auto-deployed to Cloudflare every 5 hours via cron.

See `scanner_package/README.md` for full instructions (incl. the `/etc/cron.d`
entry: `0 */5 * * * root /opt/tele-music-scanner/run_scan.sh` + `@reboot`).
Once the VPS handles scanning, disable the Worker's `0 */6 * * *` cron to avoid
duplicate work.

## Playable file size limit (200MB)

Files up to **200MB** stream seamlessly and losslessly. Files >20MB can't use
the Bot API `getFile` (Telegram caps it at 20MB), so they stream via MTProto
(`upload.getFile` chunked streaming). Browsers use Range requests for
streaming/seeking, so playback is lossless up to 200MB.

---

## Deployment checklist (end-to-end)

1. `npm install`
2. `wrangler login`
3. `wrangler d1 create music-db` → paste id into `wrangler.jsonc`
4. `wrangler secret put BOT_TOKEN WEBHOOK_SECRET MT_PROTO_API_ID MT_PROTO_API_HASH WEB_PASSWORD`
5. Edit `wrangler.jsonc` → `CHANNEL_ID`, `ADMIN_IDS`, `BOT_USERNAME`, cron
6. `npm run db:migrate`
7. `npm run deploy`
8. `curl "https://<worker>.workers.dev/setwebhook"`
9. Open the player — hard-refresh once (Ctrl+Shift+R) so `SharedArrayBuffer`-required ffmpeg core loads the new headers.

---

## Troubleshooting

**» Songs play, then stop with `SharedArrayBuffer is not defined`.**
The player page isn't cross-origin isolated (COOP/COEP headers missing) or the browser cached the old page. Hard-refresh / add `?cb=different`.

**» "File too large — max 20 MB via web".**
The HTTP Bot API caps downloads at 20 MB. The channel `getFile` storage is unlimited, *processing* files above 50 MB already uploadable, but streaming them requires the "bot API to a client session" route.

**» `/stream` says "File is not available on Telegram (may exceed 20MB)".**
The file could not be located; bot re-request or file was removed from the channel.

**» Player shows 401.**
`WEB_PASSWORD` is set; lock the player by entering the password once (stored in sessionStorage) or unset the secret.

**» Library empty after deploy.**
Cron last ran on schedule or the scanner needs a user session authorized first (`/scanner/status` shows state). Then run `/scan` once or send any song to the bot to seed.

---

## License

GPL-compatible attribution noted: audio transcoding via [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm), Telegram protocol via
`@mtproto/core`, file-id parsing via `@yaebal/file-id`.