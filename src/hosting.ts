import type { Env } from "./types";
import { Telegram, type TgMessage } from "./telegram";
import { insertSong } from "./db";
import { splitArtistTitle } from "./upload";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const PLAYABLE = [
  "audio/mpeg", "audio/mp4", "audio/ogg", "audio/opus", "audio/flac", "audio/wav",
  "audio/aac", "audio/x-m4a", "audio/webm",
  "video/mp4", "video/webm", "video/quicktime", "video/x-matroska", "video/x-msvideo",
  "video/mp2t", "video/3gpp", "video/mpeg",
];
const PLAYABLE_EXT = [
  ".mp3", ".m4a", ".ogg", ".oga", ".opus", ".flac", ".wav", ".aac", ".weba",
  ".mp4", ".mkv", ".webm", ".mov", ".avi", ".m4v", ".ts", ".3gp", ".mpeg", ".mpg",
];

export function encodeFileId(fileId: string): string {
  const base64 = btoa(fileId);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeFileId(encoded: string): string | null {
  try {
    const padded = encoded + "=".repeat((4 - (encoded.length % 4)) % 4);
    return atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return null;
  }
}

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
}

function isPlayable(mime: string, name: string): boolean {
  const m = mime.toLowerCase();
  if (PLAYABLE.includes(m) || m.startsWith("audio/") || m.startsWith("video/")) return true;
  return PLAYABLE_EXT.includes(extOf(name));
}

function guessMime(name: string): string {
  const map: Record<string, string> = {
    mp3: "audio/mpeg", m4a: "audio/mp4", ogg: "audio/ogg", opus: "audio/ogg",
    flac: "audio/flac", wav: "audio/wav", aac: "audio/aac", weba: "audio/webm",
    mp4: "video/mp4", m4v: "video/mp4", mkv: "video/x-matroska", webm: "video/webm",
    mov: "video/quicktime", avi: "video/x-msvideo", ts: "video/mp2t", "3gp": "video/3gpp",
  };
  return map[extOf(name).slice(1)] ?? "application/octet-stream";
}

// simple in-memory rate limit (per isolate): 15 uploads / 60s
const rateBuckets = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const arr = (rateBuckets.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (arr.length >= 15) {
    rateBuckets.set(ip, arr);
    return true;
  }
  arr.push(now);
  rateBuckets.set(ip, arr);
  return false;
}

export async function handleWebUpload(request: Request, env: Env): Promise<Response> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (rateLimited(ip)) {
    return json({ error: "Too many uploads, slow down" }, 429);
  }

  let file: File;
  try {
    const form = await request.formData();
    file = form.get("file") as File;
  } catch {
    return json({ error: "Invalid multipart body" }, 400);
  }
  if (!file || !(file instanceof File)) {
    return json({ error: "Missing 'file' field" }, 400);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const size = bytes.byteLength;
  const name = file.name || `song_${Date.now()}.mp3`;
  const mime = file.type || guessMime(name);

  if (size === 0) return json({ error: "Empty file" }, 400);
  if (size > MAX_UPLOAD_BYTES) {
    return json({ error: "File too large — max 50 MB via web (send bigger files to the bot on Telegram)" }, 413);
  }
  if (!isPlayable(mime, name)) {
    return json({ error: `Unsupported format: ${mime || extOf(name)}` }, 415);
  }

  const tg = Telegram.of(env.BOT_TOKEN);
  const form = new FormData();
  form.append("chat_id", env.CHANNEL_ID);
  const blob = new Blob([bytes], { type: mime });

  let msg: TgMessage;
  if (mime.startsWith("audio/")) {
    const { title, artist } = splitArtistTitle(name);
    form.append("audio", blob, name);
    form.append("title", title);
    form.append("performer", artist ?? "");
    msg = await tg.uploadMultipart("sendAudio", form);
  } else if (mime.startsWith("video/")) {
    form.append("video", blob, name);
    form.append("supports_streaming", "true");
    msg = await tg.uploadMultipart("sendVideo", form);
  } else {
    form.append("document", blob, name);
    msg = await tg.uploadMultipart("sendDocument", form);
  }

  const media =
    msg.audio ?? msg.video ?? msg.document ?? ({} as NonNullable<TgMessage["audio"]>);
  const fileId = media.file_id;
  if (!fileId) return json({ error: "Telegram did not return a file_id" }, 502);

  const kind: "audio" | "video" | "document" =
    mime.startsWith("audio/") ? "audio" : mime.startsWith("video/") ? "video" : "document";

  const song = await insertSong(env, {
    tg_file_id: fileId,
    tg_unique_id: media.file_unique_id ?? null,
    chat_id: env.CHANNEL_ID,
    message_id: msg.message_id,
    file_name: name,
    title: msg.audio?.title ?? null,
    artist: msg.audio?.performer ?? null,
    mime_type: media.mime_type ?? mime,
    media_type: kind,
    size: media.file_size ?? size,
    duration: media.duration ?? msg.audio?.duration ?? msg.video?.duration ?? null,
    width: media.width ?? msg.video?.width ?? null,
    height: media.height ?? msg.video?.height ?? null,
    added_at: Date.now(),
    added_by: null,
  });

  const encoded = encodeFileId(fileId);
  return json({
    success: true,
    url: `/file/${encoded}`,
    encodedFileId: encoded,
    fileId,
    originalName: name,
    size,
    fileType: mime,
    uploadedAt: Date.now(),
    song: song ? { id: song.id } : null,
  });
}

export async function handleFileServe(
  request: Request,
  env: Env,
  encodedId: string,
): Promise<Response> {
  const fileId = decodeFileId(encodedId);
  if (!fileId) return json({ error: "Invalid file reference" }, 400);

  const tg = Telegram.of(env.BOT_TOKEN);
  const info = await tg.getFile(fileId).catch(() => null);
  if (!info || !info.file_path) return json({ error: "File not found on Telegram" }, 404);

  const originalName = info.file_path.split("/").pop() || "media";
  const mime = info.mime_type || guessMime(originalName);

  if (new URL(request.url).searchParams.get("info") === "true") {
    return json({
      fileId,
      encodedFileId: encodedId,
      url: `/file/${encodedId}`,
      originalName,
      fileType: mime,
      size: info.file_size ?? 0,
    });
  }

  const { getSongByFileId } = await import("./db");
  const song = await getSongByFileId(env, fileId);

  const { handleStream } = await import("./stream");
  return handleStream(request, env, {
    id: 0,
    tg_file_id: fileId,
    tg_unique_id: null,
    chat_id: env.CHANNEL_ID,
    message_id: 0,
    file_name: originalName,
    title: null,
    artist: null,
    mime_type: mime,
    media_type: "document",
    size: info.file_size ?? 0,
    duration: null,
    width: null,
    height: null,
    added_at: 0,
    added_by: null,
  });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
