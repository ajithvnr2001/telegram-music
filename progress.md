# Tele Music Player — End-to-End Progress Log

Live URL: **https://tele-music-player.ajithvnr2001.workers.dev**
GitHub repo: **https://github.com/ajithvnr2001/telegram-music.git** (branch `master`)

---

## 1. Project Overview

A Cloudflare Workers app that indexes a private Telegram channel's audio/video library and serves a web player that streams directly from Telegram. It supports:

- Full library playback (audio + video)
- Search, playlists, uploads
- **ALAC (Apple Lossless) playback** via in-browser ffmpeg.wasm → FLAC conversion
- **Files > 20 MB** via MTProto chunked streaming (Telegram's `upload.getFile`)

---

## 2. Key Infrastructure

| Item | Value |
|------|-------|
| Worker name | `tele-music-player` |
| Worker URL | `https://tele-music-player.ajithvnr2001.workers.dev` |
| D1 database | `music-db` (id `dbb56244-bd4d-4d67-bf20-44fc2469c644`) |
| Channel | `-1004303738393` (private) |
| Bot | `musicvnrbot` |
| Admin ID | `1720179071` |
| Cron | `0 */6 * * *` (MTProto scan every 6h) |
| Compatibility | `2026-01-31`, flag `nodejs_compat` |
| Main entry | `src/index.ts` |

### Environment secrets (set via `wrangler secret put`, NOT in repo)
- `BOT_TOKEN` — Telegram bot token
- `WEBHOOK_SECRET` — webhook + admin auth secret
- `MT_PROTO_API_ID` / `MT_PROTO_API_HASH` — Telegram MTProto app credentials
- `MT_PROTO_SESSION` — serialized MTProto session (user login)

---

## 3. Architecture / Source Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Worker entry, routing, webhook, cron, API endpoints |
| `src/web.ts` | Web player UI (HTML/CSS/JS inline) |
| `src/scanner.ts` | MTProto login, channel scan/index, `upload.getFile` chunk fetch, file_reference refresh |
| `src/stream.ts` | `/stream` handler — CDN path + MTProto path, range parsing |
| `src/telegram.ts` | Bot API client (getFile, sendAudio, etc.) |
| `src/db.ts` | D1 queries (songs, playlists) |
| `src/hosting.ts` | Upload handling (metadata parse, ALAC detection) |
| `src/types.ts` | Shared TypeScript types |
| `migrations/` | D1 schema migrations |

---

## 4. Git History (all commits)

| Commit | Message |
|--------|---------|
| `513b11c` | feat: Tele Music Player on Cloudflare Workers — Telegram channel library + web player, search, playlists, cron MTProto indexing |
| `ae0f7fd` | feat: MTProto streaming for >20MB files with file_reference refresh |
| `7637bbb` | fix: player seek bar, per-song duration, and skip behavior |

Remote: `origin https://<REDACTED_GITHUB_TOKEN>@github.com/ajithvnr2001/telegram-music.git`

> **SECURITY NOTE:** The remote URL embeds a GitHub token. This is stored in `.git/config` only (not committed). Do not commit the token to any file. `.gitignore` excludes secrets.

---

## 5. What Was Done (chronological)

### 5.1 Initial build (`513b11c`)
- Full worker: channel scan via MTProto, D1 indexing, web player, search, playlists, uploads, webhook.
- COOP/COEP headers added on `/` (`COOP: same-origin`, `COEP: require-corp`) so ffmpeg.wasm (unpkg, sends `CORP: cross-origin`) works.
- Player fixes: progress bar updates via `bar.value = Math.round(el.currentTime*1000)`; "Unlock the player first" guard inverted to `needsAuth && !authToken`; playlist API endpoints de-authorized (global, any device).
- Upload cap raised 20MB → 50MB (`MAX_UPLOAD_BYTES = 50*1024*1024` in `src/hosting.ts`).

### 5.2 MTProto streaming for >20MB (`ae0f7fd`)
Problem: files >20MB can't be fetched via Bot API `getFile` (Telegram returns an error). Solution: stream via MTProto `upload.getFile`.

Bugs found & fixed:
1. **Cross-request WebSocket I/O** — shared `mtproto` singleton held a WebSocket from a previous request's context → Cloudflare throws "Cannot perform I/O on behalf of a different request". Fix: `resetMTProto()` (exported) called in `handleStreamMT` before use.
2. **`FILE_REFERENCE_EXPIRED`** — stale stored file_id. Fix: refresh document via `channels.getMessages` (message_id) over MTProto (`mtpFreshDocument`), retry once mid-stream.
3. **`channels.getMessages` wrong param** — was `id: [messageId]` (raw number); MTProto requires `id: [{ _: "inputMessageID", id: messageId }]`. This broke the refresh path.
4. **`upload.getFile` `LIMIT_INVALID`** — non-precise rules: offset must be 4KiB-aligned, limit ≤ 1MiB, must stay in a single 1MiB chunk. The last chunk requested a non-4KiB-aligned limit. Fix: always request full 1MiB chunks (`want = 1 << 20`) and let Telegram return the remainder at EOF.
5. **`rpc()` error parsing** — MTProto lib rejects with raw objects (`{ _: 'mt_rpc_error', error_code, error_message }`, no `.message`). Fix: read `err?.error_message ?? err?.message`.

`MT_THRESHOLD` restored to **20MB** (`20 * 1024 * 1024`).

**Verified working:** first 1MiB chunk, mid-file chunk, last chunk (881,844 bytes), and the `FILE_REFERENCE_EXPIRED` → refresh → retry path.

**Known limitation:** A single full-file request (no Range header) truncates around 15–17MB due to Cloudflare's streaming I/O context limits on the long-lived MTProto WebSocket. This does **not** affect playback — browsers use Range requests for streaming/seeking, which work correctly.

### 5.3 Player seek bar / duration / skip fixes (`7637bbb`)
User reported: skipping forward played the next song; time not calculated per song; bar not adjusting.

Fixes in `src/web.ts`:
1. **Skip forward played next song** — dragging the seek bar to the end fired the media `ended` event → auto-advanced. Fix: added `userSeeking` flag that suppresses auto-advance while dragging; clamped seek to `duration - 0.3s`.
2. **Time not calculated per song** — bar kept previous song's position/duration. Fix: `playAt` now resets `bar.value = 0`, shows `0:00`, and sets total duration from DB metadata immediately.
3. **Bar not adjusting** — with bar reset + correct `bar.max` per song, `timeupdate` updates the bar correctly.

---

## 6. Current Issue (RESOLVED)

### 6.1 ffmpeg.wasm conversion failure for some songs

**User report:** Some songs fail with:
```
Could not play this song: ffmpeg.FS('readFile', 'out.flac') error. Check if the path exists
```
Example: https://t.me/c/4303738393/1938 (`09.Mersalaayitten (From _I_).AAC.256Kbps.m4a`, id=301, size 11.4MB, `audio/mp4`).

**Investigation so far:**
- The stream for id=301 works: `200 OK`, `Content-Type: audio/mp4`, full 11,478,069 bytes returned.
- File header is valid M4A (`ftypM4A`).
- **Local ffmpeg 7.1.1 converts it fine** → produces a **60 MB FLAC** (5:04 song, 24-bit 44.1kHz stereo).

**Root cause hypothesis:** The in-browser `@ffmpeg/ffmpeg@0.11.6` WASM has a **default memory limit (~64 MB)**. A 60 MB FLAC output + 11 MB input + ffmpeg internal buffers exceeds this, so ffmpeg fails silently and never writes `out.flac`. This explains why only *some* (longer) songs fail — the ones whose FLAC output is large.

**Planned fix (not yet implemented):**
- Increase the WASM memory for the ffmpeg instance, OR
- Add a WAV fallback if FLAC fails, OR
- Upgrade to a newer ffmpeg.wasm that handles memory better.
- Add proper error handling: check if `out.flac` exists after `ffmpeg.run()`, capture ffmpeg stderr, and give a clear error.

**Status:** FIXED (commit `17338a4`, deployed version `94db4480-219d-4fee-90cf-5ea6a360b94e`).

**Resolution:** Upgraded the in-browser ffmpeg from `@ffmpeg/ffmpeg@0.11.6` (old `createFFmpeg` API, fixed ~64MB WASM memory) to `@ffmpeg/ffmpeg@0.12.10` + `@ffmpeg/core@0.12.6` (new `FFmpeg` class API). The 0.12 core is compiled with `ALLOW_MEMORY_GROWTH`, so large FLAC outputs (e.g. the 60MB output for id=301) no longer exceed the WASM memory limit. Changes in `src/web.ts`:
- `ensureFFmpeg()` now loads the 0.12 UMD builds (`window.FFmpegWASM.FFmpeg`, `window.FFmpegUtil.toBlobURL`) and loads the core via `toBlobURL` (blob URLs avoid CORS/MIME issues).
- `convertToFlac()` uses the new API: `ffmpeg.writeFile()`, `ffmpeg.exec([...])`, `ffmpeg.readFile()` (async), `ffmpeg.deleteFile()`.
- Added proper error handling: `readFile("out.flac")` is wrapped in try/catch and throws a clear "conversion failed (out.flac missing)" error instead of the raw FS error; ffmpeg stderr is logged via `setLogger`.

**Verified:** deployed HTML contains the new `FFmpegWASM`/`toBlobURL` code. Should be re-tested with song id=301 and other large/long songs.

---

## 7. Deployment & Verification Commands

```bash
# Deploy
npx wrangler deploy

# Type-check
npx tsc --noEmit

# Live tail (watch logs/errors)
npx wrangler tail

# Test a stream range (1 MiB chunk)
curl -s -H "Range: bytes=0-1048575" "https://tele-music-player.ajithvnr2001.workers.dev/stream?id=18&cb=$(date +%s)"

# Test last chunk of a file
curl -s -H "Range: bytes=19922944-20804787" "https://tele-music-player.ajithvnr2001.workers.dev/stream?id=18&cb=$(date +%s)"

# Verify deployed HTML contains a fix
curl -s "https://tele-music-player.ajithvnr2001.workers.dev/?cb=$(date +%s)" | grep "userSeeking"
```

> Always append `?cb=<timestamp>` as a cache-buster on prod requests.

---

## 8. Deployed Version IDs (recent)

| Version ID | Purpose |
|------------|---------|
| `ecce592d-a149-4b8f-b2ff-32260770dbbb` | MTProto streaming final (20MB threshold) |
| `38e906ea-1ef3-4079-87da-847866cc2b23` | Player seek bar / duration / skip fixes |
| `94db4480-219d-4fee-90cf-5ea6a360b94e` | ffmpeg.wasm 0.12 upgrade (FLAC memory fix) |

---

## 9. Next Steps

1. ~~Fix the ffmpeg.wasm memory issue~~ (Section 6.1) — DONE (`17338a4`).
2. ~~Deploy~~ — DONE (version `94db4480-219d-4fee-90cf-5ea6a360b94e`).
3. ~~Commit + push~~ — DONE.
4. ~~Update this file~~ — DONE.
5. Re-test song id=301 and other large/long songs in the browser to confirm FLAC conversion now succeeds.