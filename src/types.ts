export interface Env {
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  CHANNEL_ID: string;
  ADMIN_IDS: string;
  BOT_USERNAME?: string;
  WEB_PASSWORD?: string;
  MT_PROTO_API_ID?: string;
  MT_PROTO_API_HASH?: string;
  DB: D1Database;
  CHANNEL_SCANNER: DurableObjectNamespace;
}

export interface Song {
  id: number;
  tg_file_id: string;
  tg_unique_id: string | null;
  chat_id: string;
  message_id: number;
  file_name: string | null;
  title: string | null;
  artist: string | null;
  mime_type: string | null;
  media_type: 'audio' | 'video' | 'document';
  size: number;
  duration: number | null;
  width: number | null;
  height: number | null;
  added_at: number;
  added_by: number | null;
}

export const TG_API = "https://api.telegram.org";

export function botBase(token: string): string {
  return `${TG_API}/bot${token}`;
}

export function isAdmin(userId: number | undefined, env: Env): boolean {
  if (!userId) return false;
  return env.ADMIN_IDS.split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .some((s) => String(userId) === s);
}

export function channelLink(chatId: string, messageId: number): string {
  const id = chatId.replace(/^-\d{2}/, "");
  return `https://t.me/c/${id}/${messageId}`;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
