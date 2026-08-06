import type { Env, Song } from "./types";
import { channelLink, isAdmin } from "./types";
import { Telegram, type TgUpdate } from "./telegram";
import { deleteSong, getSong, getStats, listSongs, searchSongs, bumpStat, listPlaylists, createPlaylist, deletePlaylist, getPlaylistSongs, addSongToPlaylist, removeSongFromPlaylist } from "./db";
import { handleStream } from "./stream";
import { extractMedia, fmtSize, indexFile, setWorkerUrl } from "./upload";
import { handleFileServe, handleWebUpload } from "./hosting";
import { renderPlayerPage } from "./web";
import { handleAuth, runScan, scannerStatus, scannerState } from "./scanner";
import { handleFfmpegAsset, setWaitUntil } from "./ffmpeg-assets";

export { ChannelScanner } from "./scanner";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function webAuthorized(request: Request, env: Env): boolean {
  if (!env.WEB_PASSWORD) return true;
  const header = request.headers.get("X-Auth");
  if (header === env.WEB_PASSWORD) return true;
  const url = new URL(request.url);
  return url.searchParams.get("p") === env.WEB_PASSWORD;
}

function err(text: string, status = 500): Response {
  return new Response(text, { status });
}

async function handleUpdate(update: TgUpdate, env: Env, baseUrl: string): Promise<void> {
  const tg = Telegram.of(env.BOT_TOKEN);

  const channelMsg = update.channel_post;
  if (channelMsg) {
    if (String(channelMsg.chat.id) === env.CHANNEL_ID) {
      await indexFile(env, channelMsg, { source: "channel" });
    }
    return;
  }

  const msg = update.message;
  if (!msg) return;

  const chatId = msg.chat.id;
  const fromId = msg.from?.id;

  if (extractMedia(msg)) {
    if (!isAdmin(fromId, env)) {
      await tg.sendMessage(chatId, "You are not authorized to upload songs.");
      return;
    }
    if (String(chatId) === env.CHANNEL_ID) {
      await indexFile(env, msg, { source: "channel", user: fromId });
      return;
    }
    await indexFile(env, msg, { notifyChat: chatId, user: fromId, source: "dm" });
    return;
  }

  const text = msg.text?.trim() ?? msg.caption?.trim();
  if (!text) return;

  const [command, ...args] = text.split(/\s+/);
  const arg = args.join(" ");

  if (text.startsWith("/start")) {
    await tg.sendMessage(
      chatId,
      `🎵 <b>Tele Music Player</b>\n\nYour music library is stored in the Telegram channel and streams straight to this player.\n\n• Send me any <b>mp3 / m4a / mp4 / webm</b> file to add it\n• <b>Already have songs in the channel?</b> Forward them to me — I'll import them without making copies\n• <a href="${baseUrl}">Open the player</a>\n\nCommands:\n/list — library stats\n/search <query> — search songs\n/delete <id> — remove a song\n/help — help`,
    );
    return;
  }

  if (text.startsWith("/help")) {
    await tg.sendMessage(
      chatId,
      `🎵 <b>How to use</b>\n\n• <b>Add:</b> send any audio or video file to this chat (mp3, m4a, mp4, webm, flac…)\n• <b>Import existing channel songs:</b> open the channel → select all songs → forward them to me. They are indexed in place, no copies\n• <b>Play:</b> open the web player at <a href="${baseUrl}">${baseUrl}</a> — it streams directly from the Telegram channel, so you can seek, pause and play both audio and video files\n• <b>Search:</b> /search <query>\n• <b>Delete:</b> /delete <id>\n• <b>Stats:</b> /stats`,
    );
    return;
  }

  if (!isAdmin(fromId, env)) {
    await tg.sendMessage(chatId, "You are not authorized to use this bot.");
    return;
  }

  if (text.startsWith("/list")) {
    const stats = await getStats(env);
    await tg.sendMessage(
      chatId,
      `📚 <b>Library</b>\n\nSongs: <b>${stats.songs}</b>\nAudio: ${stats.audio}\nVideo: ${stats.video}\n\n<a href="${baseUrl}">Open player</a>`,
    );
    return;
  }

  if (text.startsWith("/search")) {
    if (!arg) {
      await tg.sendMessage(chatId, "Usage: /search <query>");
      return;
    }
    const results = await searchSongs(env, arg);
    if (!results.length) {
      await tg.sendMessage(chatId, `No results for <b>${escapeText(arg)}</b>`);
      return;
    }
    const lines = results
      .slice(0, 10)
      .map((s) => `• <b>#${s.id}</b> ${escapeText(s.file_name ?? "?")} — ${fmtSize(s.size)}`)
      .join("\n");
    await tg.sendMessage(
      chatId,
      `🔎 <b>Results for</b> "${escapeText(arg)}"\n\n${lines}\n\nPlay in player: <a href="${baseUrl}">Open</a>`,
    );
    return;
  }

  if (text.startsWith("/delete")) {
    const id = Number(arg || (args[0] ?? ""));
    if (!id) {
      await tg.sendMessage(chatId, "Usage: /delete <id> — use /list or /search to find ids");
      return;
    }
    const song = await deleteSong(env, id);
    if (!song) {
      await tg.sendMessage(chatId, `No song with id <b>${id}</b>.`);
      return;
    }
    await bumpStat(env, "deleted");
    let deletedMsg = true;
    try {
      await tg.deleteMessage(song.chat_id, song.message_id);
    } catch {
      deletedMsg = false;
    }
    await tg.sendMessage(
      chatId,
      `🗑 Deleted <b>${escapeText(song.file_name ?? `#${song.id}`)}</b> from the library${deletedMsg ? "" : " (channel message not found — already removed?)"}.`,
    );
    return;
  }

  if (text.startsWith("/stats")) {
    const stats = await getStats(env);
    await tg.sendMessage(
      chatId,
      `📊 <b>Stats</b>\n\nTotal songs: <b>${stats.songs}</b>\nAudio: ${stats.audio}\nVideo: ${stats.video}\nChannel: <a href="${channelLink(env.CHANNEL_ID, 1)}">link</a>`,
    );
    return;
  }

  if (text.startsWith("/scan")) {
    const r = await runScan(env).catch(() => null);
    await tg.sendMessage(
      chatId,
      r
        ? `🔍 <b>Scan finished.</b> Checked ${r.scanned} messages, imported ${r.indexed} song(s). ${r.done ? "Channel fully indexed." : "More to go — run /scan again."}\nStatus: <a href="${baseUrl}">${baseUrl}</a>`
        : `❌ Scan failed — try again in a minute.`,
    );
    return;
  }

  if (text.startsWith("/setwebhook")) {
    const url = new URL(baseUrl);
    const target = `${url.origin}/webhook`;
    const ok = await tg.setWebhook(target, env.WEBHOOK_SECRET);
    await tg.setMyCommands().catch(() => undefined);
    await tg.sendMessage(chatId, ok ? `✅ Webhook set to ${target}` : "❌ Failed to set webhook");
    return;
  }

  await tg.sendMessage(chatId, "Use /help to see what I can do.");
}

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    setWorkerUrl(url.origin);
    setWaitUntil((p) => ctx.waitUntil(p));

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "X-Auth, Content-Type",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    const path = url.pathname;

    if (path.startsWith("/ffmpeg/")) {
      const asset = await handleFfmpegAsset(path.slice("/ffmpeg/".length));
      if (asset) return asset;
    }

    if (path === "/" || path === "/index.html") {
      return new Response(renderPlayerPage(!!env.WEB_PASSWORD), {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }

    if (path === "/health") {
      return json({ ok: true, name: "tele-music-player" });
    }

    if (path === "/api/upload" && request.method === "POST") {
      if (!webAuthorized(request, env)) return json({ error: "unauthorized" }, 401);
      return handleWebUpload(request, env);
    }

    if (path.startsWith("/file/")) {
      const encodedId = path.slice("/file/".length);
      if (!encodedId) return err("Missing file reference", 400);
      return handleFileServe(request, env, encodedId);
    }

    if (path === "/wstest") {
      const host = url.searchParams.get("host") ?? "ws1.telegram.org";
      const result = await new Promise((resolve) => {
        let ws: WebSocket;
        try {
          ws = new WebSocket(`wss://${host}`, "binary");
        } catch (e: any) {
          resolve({ phase: "throw", error: e.message });
          return;
        }
        ws.binaryType = "arraybuffer";
        const t = setTimeout(() => {
          resolve({ phase: "timeout" });
          try { ws.close(); } catch {}
        }, 8000);
        ws.addEventListener("open", () => {
          clearTimeout(t);
          resolve({ phase: "opened" });
          try { ws.close(); } catch {}
        });
        ws.addEventListener("error", (e: any) => {
          clearTimeout(t);
          resolve({ phase: "error", error: e?.message ?? e?.type ?? "unknown" });
        });
      });
      return json({ ws: result });
    }

    if (path === "/api/songs" && request.method === "GET") {
      if (!webAuthorized(request, env)) return json({ error: "unauthorized" }, 401);
      const songs = await listSongs(env, 5000);
      return json(songs.map(pub));
    }

    if (path === "/api/song" && request.method === "GET") {
      if (!webAuthorized(request, env)) return json({ error: "unauthorized" }, 401);
      const id = Number(url.searchParams.get("id"));
      if (!id) return json({ error: "missing id" }, 400);
      const song = await getSong(env, id);
      return song ? json(pub(song)) : json({ error: "not found" }, 404);
    }

    if (path === "/stream" && (request.method === "GET" || request.method === "HEAD")) {
      if (!webAuthorized(request, env)) return err("Unauthorized", 401);
      const id = Number(url.searchParams.get("id"));
      if (!id) return err("Missing id", 400);
      const song = await getSong(env, id);
      if (!song) return err("Song not found", 404);
      if (request.method === "HEAD") {
        return new Response(null, {
          headers: {
            "Content-Type": song.mime_type ?? "application/octet-stream",
            "Accept-Ranges": "bytes",
            "Content-Length": String(song.size),
            "Access-Control-Allow-Origin": "*",
          },
        });
      }
      return handleStream(request, env, song);
    }

    if (path === "/setwebhook" && request.method === "GET") {
      if (url.searchParams.get("token") !== env.WEBHOOK_SECRET) return err("Unauthorized", 401);
      const tg = Telegram.of(env.BOT_TOKEN);
      const target = `${url.origin}/webhook`;
      const ok = await tg.setWebhook(target, env.WEBHOOK_SECRET);
      await tg.setMyCommands().catch(() => undefined);
      return json({ ok, webhook: target });
    }

    if (path === "/webhook" && request.method === "POST") {
      const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (secret !== env.WEBHOOK_SECRET) return err("Unauthorized", 401);
      const update = (await request.json()) as TgUpdate;
      const base = url.origin;
      ctx.waitUntil(
        handleUpdate(update, env, base).catch((e) => console.error("webhook handler failed", e)),
      );
      return json({ ok: true });
    }

    if (path === "/dbg") {
      const tables = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
      const stateRows = url.searchParams.get("songs") === "1"
        ? await env.DB.prepare("SELECT key, value FROM scanner_state ORDER BY key").all()
        : await env.DB.prepare("SELECT key, substr(value,1,20) AS v FROM scanner_state ORDER BY key").all();
      if (url.searchParams.get("songs") === "1") {
        const songs = await env.DB.prepare("SELECT * FROM songs ORDER BY id").all();
        return json({ tables: tables.results.map((r: any) => r.name), state: stateRows.results, songs: songs.results });
      }
      return json({ tables: tables.results.map((r: any) => r.name), state: stateRows.results });
    }

    if (path === "/import" && request.method === "POST") {
      const token = request.headers.get("X-Auth-Secret") ?? url.searchParams.get("token");
      if (token !== env.WEBHOOK_SECRET) return json({ error: "unauthorized" }, 401);
      const body = (await request.json()) as { songs?: any[]; state?: Record<string, string> };
      await env.DB.prepare("DELETE FROM songs").run();
      await env.DB.prepare("DELETE FROM scanner_state").run();
      let inserted = 0;
      for (const s of body.songs ?? []) {
        await env.DB.prepare(
          `INSERT OR REPLACE INTO songs (id, tg_file_id, tg_unique_id, chat_id, message_id, file_name, title, artist,
            mime_type, media_type, size, duration, width, height, added_at, added_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
          .bind(s.id, s.tg_file_id, s.tg_unique_id, s.chat_id, s.message_id, s.file_name, s.title, s.artist,
            s.mime_type, s.media_type, s.size, s.duration, s.width, s.height, s.added_at, s.added_by)
          .run();
        inserted++;
      }
      for (const [k, v] of Object.entries(body.state ?? {})) {
        await env.DB.prepare(
          "INSERT INTO scanner_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
          .bind(k, v)
          .run();
      }
      return json({ ok: true, songsInserted: inserted, stateKeys: Object.keys(body.state ?? {}).length });
    }

    if (path === "/api/import" && request.method === "POST") {
      const token = request.headers.get("X-Auth-Secret") ?? url.searchParams.get("token");
      if (token !== env.WEBHOOK_SECRET) return json({ error: "unauthorized" }, 401);
      const body = (await request.json().catch(() => ({}))) as { songs?: any[] };
      let inserted = 0;
      for (const s of body.songs ?? []) {
        await env.DB.prepare(
          `INSERT INTO songs (tg_file_id, tg_unique_id, chat_id, message_id, file_name, title, artist,
            mime_type, media_type, size, duration, width, height, added_at, added_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(chat_id, message_id) DO UPDATE SET
             tg_file_id = excluded.tg_file_id,
             file_name = excluded.file_name,
             title = excluded.title,
             artist = excluded.artist,
             mime_type = excluded.mime_type,
             media_type = excluded.media_type,
             size = excluded.size,
             duration = excluded.duration,
             width = excluded.width,
             height = excluded.height`,
        )
          .bind(s.tg_file_id, s.tg_unique_id, s.chat_id, s.message_id, s.file_name, s.title, s.artist,
            s.mime_type, s.media_type, s.size, s.duration, s.width, s.height, s.added_at, s.added_by)
          .run();
        inserted++;
      }
      return json({ ok: true, songsUpserted: inserted });
    }

    if (path === "/api/playlists" && request.method === "GET") {
      return json(await listPlaylists(env));
    }

    if (path === "/api/playlists" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { name?: string };
      const name = (body.name ?? "").trim().slice(0, 80);
      if (!name) return json({ error: "name required" }, 400);
      const pl = await createPlaylist(env, name);
      return pl ? json(pl) : json({ error: "failed to create" }, 500);
    }

    if (path === "/api/playlist" && request.method === "GET") {
      const id = Number(url.searchParams.get("id"));
      if (!id) return json({ error: "missing id" }, 400);
      return json(await getPlaylistSongs(env, id));
    }

    if (path === "/api/playlist" && request.method === "DELETE") {
      const id = Number(url.searchParams.get("id"));
      if (!id) return json({ error: "missing id" }, 400);
      return json({ ok: await deletePlaylist(env, id) });
    }

    if (path === "/api/playlist/add" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { playlist_id?: number; song_id?: number };
      if (!body.playlist_id || !body.song_id) return json({ error: "playlist_id and song_id required" }, 400);
      await addSongToPlaylist(env, body.playlist_id, body.song_id);
      return json({ ok: true });
    }

    if (path === "/api/playlist/remove" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { playlist_id?: number; song_id?: number };
      if (!body.playlist_id || !body.song_id) return json({ error: "playlist_id and song_id required" }, 400);
      await removeSongFromPlaylist(env, body.playlist_id, body.song_id);
      return json({ ok: true });
    }

    if (path === "/scanner/status") {
      return scannerStatus(env);
    }

    if (path === "/scanner/auth" && (request.method === "GET" || request.method === "POST")) {
      return handleAuth(request, env);
    }

    if (path === "/scanner/scan" && request.method === "POST") {
      try {
        if (url.searchParams.get("full") === "1") {
          await scannerState(env).set("last_message_id", "0");
        }
        const r = await runScan(env);
        return json({ ok: true, scanned: r.scanned, indexed: r.indexed, done: r.done });
      } catch (e: any) {
        return json({ ok: false, error: e?.error_message ?? e?.message ?? String(e) }, 502);
      }
    }

    return err("Not Found", 404);
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScan(env).catch((e) => console.error("scheduled scan failed", e)));
  },
} satisfies ExportedHandler<Env>;

function pub(s: Song) {
  return {
    id: s.id,
    file_name: s.file_name,
    title: s.title,
    artist: s.artist,
    mime_type: s.mime_type,
    media_type: s.media_type,
    size: s.size,
    duration: s.duration,
    chat_id: s.chat_id,
    message_id: s.message_id,
    added_at: s.added_at,
  };
}
