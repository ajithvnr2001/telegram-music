import type { Env, Song } from "./types";
import { Telegram, type TgMedia, type TgMessage } from "./telegram";
import { bumpStat, insertSong } from "./db";

const AUDIO_EXT = new Set(["mp3", "m4a", "ogg", "oga", "opus", "flac", "wav", "aac", "weba"]);
const VIDEO_EXT = new Set(["mp4", "mkv", "webm", "mov", "avi", "m4v", "ts", "3gp", "mpeg", "mpg"]);

export interface ExtractedMedia {
  kind: "audio" | "video" | "document";
  media: TgMedia;
  fileName: string;
  mime: string;
}

export function extractMedia(msg: TgMessage): ExtractedMedia | null {
  if (msg.audio) {
    return {
      kind: "audio",
      media: msg.audio,
      fileName: msg.audio.title
        ? `${msg.audio.performer ? msg.audio.performer + " - " : ""}${msg.audio.title}.mp3`
        : `audio_${msg.message_id}`,
      mime: msg.audio.mime_type ?? "audio/mpeg",
    };
  }
  if (msg.video) {
    return {
      kind: "video",
      media: msg.video,
      fileName: `video_${msg.message_id}.mp4`,
      mime: msg.video.mime_type ?? "video/mp4",
    };
  }
  if (msg.document) {
    const name = msg.document.file_name ?? `file_${msg.message_id}`;
    const mime = msg.document.mime_type ?? guessMime(name);
    const kind: "audio" | "video" | "document" =
      mime.startsWith("audio/") ? "audio" : mime.startsWith("video/") ? "video" : guessKind(name);
    return { kind, media: msg.document, fileName: name, mime };
  }
  if (msg.voice) {
    return {
      kind: "audio",
      media: msg.voice,
      fileName: `voice_${msg.message_id}.ogg`,
      mime: msg.voice.mime_type ?? "audio/ogg",
    };
  }
  if (msg.video_note) {
    return {
      kind: "video",
      media: msg.video_note,
      fileName: `video_note_${msg.message_id}.mp4`,
      mime: "video/mp4",
    };
  }
  if (msg.animation) {
    return {
      kind: "document",
      media: msg.animation,
      fileName: msg.animation.file_name ?? `animation_${msg.message_id}.gif`,
      mime: msg.animation.mime_type ?? "image/gif",
    };
  }
  return null;
}

function guessKind(name: string): "audio" | "video" | "document" {
  const ext = extension(name);
  if (AUDIO_EXT.has(ext)) return "audio";
  if (VIDEO_EXT.has(ext)) return "video";
  return "document";
}

function guessMime(name: string): string {
  const ext = extension(name);
  const audio: Record<string, string> = {
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    ogg: "audio/ogg",
    opus: "audio/ogg",
    flac: "audio/flac",
    wav: "audio/wav",
    aac: "audio/aac",
    weba: "audio/webm",
  };
  const video: Record<string, string> = {
    mp4: "video/mp4",
    m4v: "video/mp4",
    mkv: "video/x-matroska",
    webm: "video/webm",
    mov: "video/quicktime",
    avi: "video/x-msvideo",
    ts: "video/mp2t",
    "3gp": "video/3gpp",
  };
  return audio[ext] ?? video[ext] ?? "application/octet-stream";
}

function extension(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

export function splitArtistTitle(fileName: string): { title: string; artist: string | null } {
  const base = fileName.replace(/\.[^.]+$/, "").trim();
  const m = base.match(/^(.+?)\s*-\s*(.+)$/);
  if (m) return { title: m[2].trim(), artist: m[1].trim() };
  return { title: base || "Unknown", artist: null };
}

async function publishToChannel(
  tg: Telegram,
  env: Env,
  extracted: ExtractedMedia,
  caption?: string,
): Promise<TgMessage> {
  const { kind, media } = extracted;
  if (kind === "audio") {
    const { title, artist } = splitArtistTitle(extracted.fileName);
    return tg.sendAudio(env.CHANNEL_ID, media.file_id, {
      title,
      performer: artist ?? undefined,
      duration: media.duration,
      caption,
    });
  }
  if (kind === "video") {
    return tg.sendVideo(env.CHANNEL_ID, media.file_id, {
      duration: media.duration,
      width: media.width,
      height: media.height,
      caption,
    });
  }
  return tg.sendDocument(env.CHANNEL_ID, media.file_id, { caption });
}

export async function indexFile(
  env: Env,
  msg: TgMessage,
  opts: { notifyChat?: string | number; user?: number; source?: "dm" | "channel" } = {},
): Promise<Song | null> {
  const extracted = extractMedia(msg);
  if (!extracted) return null;
  const tg = Telegram.of(env.BOT_TOKEN);

  const fo = msg.forward_origin;
  const isChannelForward =
    fo?.type === "channel" &&
    fo.chat &&
    fo.chat.id != null &&
    String(fo.chat.id) === env.CHANNEL_ID &&
    !!fo.message_id;

  if (isChannelForward) {
    const song = await insertSong(env, {
      tg_file_id: extracted.media.file_id,
      tg_unique_id: extracted.media.file_unique_id ?? null,
      chat_id: env.CHANNEL_ID,
      message_id: fo.message_id!,
      file_name: extracted.fileName,
      title: msg.audio?.title ?? null,
      artist: msg.audio?.performer ?? null,
      mime_type: extracted.mime,
      media_type: extracted.kind,
      size: extracted.media.file_size ?? 0,
      duration: extracted.media.duration ?? null,
      width: extracted.media.width ?? null,
      height: extracted.media.height ?? null,
      added_at: (fo.date ?? msg.date) * 1000 || Date.now(),
      added_by: opts.user ?? null,
    });
    await bumpStat(env, "added");
    return song;
  }

  const chat = msg.chat ?? { id: env.CHANNEL_ID, type: "channel" };

  if (opts.notifyChat) {
    const action =
      extracted.kind === "audio" ? "upload_audio" : extracted.kind === "video" ? "upload_video" : "upload_document";
    await tg.sendChatAction(opts.notifyChat, action).catch(() => undefined);
  }

  let published: TgMessage;
  try {
    published = await publishToChannel(tg, env, extracted, msg.caption);
  } catch (err) {
    if (opts.notifyChat) {
      await tg
        .sendMessage(opts.notifyChat, `Failed to publish to channel: ${(err as Error).message}`)
        .catch(() => undefined);
    }
    return null;
  }

  const { media } = extracted;
  const song = await insertSong(env, {
    tg_file_id: media.file_id,
    tg_unique_id: media.file_unique_id ?? null,
    chat_id: env.CHANNEL_ID,
    message_id: published.message_id,
    file_name: extracted.fileName,
    title: published.audio?.title ?? null,
    artist: published.audio?.performer ?? null,
    mime_type: extracted.mime,
    media_type: extracted.kind,
    size: media.file_size ?? 0,
    duration: media.duration ?? published.audio?.duration ?? published.video?.duration ?? null,
    width: media.width ?? published.video?.width ?? null,
    height: media.height ?? published.video?.height ?? null,
    added_at: msg.date * 1000 || Date.now(),
    added_by: opts.user ?? null,
  });

  await bumpStat(env, "added");

  if (opts.notifyChat && song) {
    const base = baseUrl(env);
    const link = `${base}/#/song/${song.id}`;
    await tg
      .sendMessage(
        opts.notifyChat,
        `Added <b>${escapeText(extracted.fileName)}</b> (${fmtSize(song.size)}) to the library.\nOpen: ${link}`,
      )
      .catch(() => undefined);
  }
  return song;
}

let workerUrlCache = "";

export function setWorkerUrl(url: string): void {
  workerUrlCache = url;
}

export function baseUrl(env: Env): string {
  return workerUrlCache || `https://${env.BOT_USERNAME ?? "tele-music-player"}.workers.dev`;
}

export function fmtSize(bytes: number): string {
  if (!bytes) return "?";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
