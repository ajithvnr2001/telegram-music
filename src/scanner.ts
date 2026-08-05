import MTProto from "@mtproto/core/envs/browser";
import { parseFileId, serializeFileId, type FileType } from "@yaebal/file-id";
import type { Env, Song } from "./types";
import { insertSong } from "./db";

const BOT_API = "https://api.telegram.org";
const SUB_VERSION = 61;
const HISTORY_LIMIT = 50;
const SLEEP_MS = 700;
const SCAN_BUDGET_MS = 150_000;

const DEFAULT_API_ID = 2040;
const DEFAULT_API_HASH = "b18441a1ff607e10a989891a5462e627";

const PLAYABLE_DOC_EXTS = [
  ".mp3", ".m4a", ".ogg", ".oga", ".opus", ".flac", ".wav", ".aac", ".weba",
  ".mp4", ".mkv", ".webm", ".mov", ".avi", ".m4v", ".ts", ".3gp", ".mpeg", ".mpg",
];

interface DocAttr {
  _: string;
  duration?: number;
  title?: string;
  performer?: string;
  voice?: boolean;
  round_message?: boolean;
  w?: number;
  h?: number;
  file_name?: string;
}

interface TLDoc {
  _: string;
  id: bigint;
  access_hash: bigint;
  file_reference: Uint8Array;
  dc_id: number;
  mime_type?: string;
  size?: bigint;
  attributes?: DocAttr[];
}

interface TLMessage {
  _: string;
  id: number;
  out?: boolean;
  message?: string;
  media?: { _: string; document?: TLDoc };
  date?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

// ---------------------------------------------------------------- D1 storage

function stateRes(env: Env) {
  return {
    get: async (key: string): Promise<string | null> => {
      const row = await env.DB.prepare("SELECT value FROM scanner_state WHERE key = ?")
        .bind(key)
        .first();
      return row ? String(row.value) : null;
    },
    set: async (key: string, value: string): Promise<void> => {
      await env.DB.prepare(
        "INSERT INTO scanner_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
        .bind(key, value)
        .run();
    },
  };
}

export function scannerState(env: Env) {
  return stateRes(env);
}

export async function mtpGetChunk(
  env: Env,
  location: Record<string, unknown>,
  offset: number,
  limit: number,
  _dcId?: number,
): Promise<{ _: string; bytes?: Uint8Array; type?: unknown; mtime?: number }> {
  await ensureLoggedIn(env);
  const res = await rpc(env, "upload.getFile", { location, offset, limit });
  return res as { _: string; bytes?: Uint8Array; type?: unknown; mtime?: number };
}

export function mtDocLocation(
  fileId: string,
): { location: Record<string, unknown>; dcId: number } | null {
  try {
    const p = parseFileId(fileId);
    if (!p || p.kind !== "document") return null;
    return {
      location: {
        _: "inputDocumentFileLocation",
        id: p.id,
        access_hash: p.accessHash,
        file_reference: p.fileReference ?? new Uint8Array(0),
        thumb_size: "",
      },
      dcId: p.dcId,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch the current document from a channel message over MTProto. Channel
 * posts periodically rotate `file_reference`, so a stored file_id goes stale;
 * this returns a fresh `inputDocumentFileLocation` (id, access_hash, current
 * file_reference, dc) for the given message.
 */
export async function mtpFreshDocument(
  env: Env,
  messageId: number,
): Promise<{ location: Record<string, unknown>; dcId: number; size: number } | null> {
  try {
    const peer = await getChannelPeer(env);
    const channel = {
      _: "inputChannel",
      channel_id: peer.channel_id,
      access_hash: peer.access_hash,
    };
    const res = await rpc(env, "channels.getMessages", {
      channel,
      id: [{ _: "inputMessageID", id: messageId }],
    });
    const msgs: TLMessage[] = (res?.messages ?? []).filter((m: any) => m && m._ === "message");
    const doc = msgs[0]?.media?.document;
    if (!doc || doc._ !== "document") return null;
    return {
      location: {
        _: "inputDocumentFileLocation",
        id: doc.id,
        access_hash: doc.access_hash,
        file_reference: doc.file_reference,
        thumb_size: "",
      },
      dcId: doc.dc_id,
      size: doc.size ? Number(doc.size) : 0,
    };
  } catch (e: any) {
    console.error("mtpFreshDocument failed", messageId, e?.error_message ?? e?.message ?? String(e));
    return null;
  }
}

let mtproto: InstanceType<typeof MTProto> | null = null;

export function resetMTProto(): void {
  mtproto = null;
}

async function getMTProto(env: Env): Promise<InstanceType<typeof MTProto>> {
  if (mtproto) return mtproto;
  mtproto = new MTProto({
    api_id: Number(env.MT_PROTO_API_ID || DEFAULT_API_ID),
    api_hash: env.MT_PROTO_API_HASH || DEFAULT_API_HASH,
    storageOptions: { instance: stateRes(env) },
  }) as InstanceType<typeof MTProto>;
  return mtproto;
}

function apiId(env: Env): number {
  return Number(env.MT_PROTO_API_ID || DEFAULT_API_ID);
}
function apiHash(env: Env): string {
  return env.MT_PROTO_API_HASH || DEFAULT_API_HASH;
}

async function rpc(env: Env, method: string, params: Record<string, unknown>, retries = 3): Promise<any> {
  const m = await getMTProto(env);
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await withTimeout(m.call(method, params), 45000, `${method} timed out`);
    } catch (err: any) {
      const msg = err?.error_message ?? err?.message ?? String(err);
      if (msg.includes("timed out")) {
        resetMTProto();
                continue;
      }
      const code = err?.code ?? err?.error_code ?? -1;
      const isFlood = code === 420 || msg.includes("FLOOD_WAIT") || msg.includes("ConnectionError");
      if (isFlood && attempt < retries - 1) {
        await sleep(Math.min(parseFloodSeconds(msg), 10) * 1000);
        continue;
      }
      if (String(code) === "401" || msg.includes("AUTH_KEY_UNREGISTERED")) {
        await stateRes(env).set("logged_in", "0");
        continue;
      }
      throw err;
    }
  }
  throw new Error(`rpc ${method} failed`);
}

// ------------------------------------------------------------------- auth

async function loggedIn(env: Env): Promise<boolean> {
  return (await stateRes(env).get("logged_in")) === "1";
}

async function ensureLoggedIn(env: Env): Promise<void> {
  if (await loggedIn(env)) return;
  throw new Error("Scanner not logged in: complete one-time login at POST /scanner/auth");
}

async function callAuth(env: Env, run: () => Promise<any>): Promise<any> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await withTimeout(run(), 45000, "auth RPC timed out");
    } catch (err: any) {
      const msg = err?.error_message ?? err?.message ?? String(err);
      if (msg.includes("timed out")) {
        resetMTProto();
                continue;
      }
      const migrate = msg.match(/(USER|PHONE|NETWORK)_MIGRATE_(\d+)/);
      if (migrate) {
        const dc = Number(migrate[2]);
        const m = await getMTProto(env);
        await m.setDefaultDc(dc);
        await stateRes(env).set("defaultDcId", String(dc));
        continue;
      }
      throw err;
    }
  }
  throw new Error("auth retries exhausted");
}

export async function handleAuth(request: Request, env: Env): Promise<Response> {
  try {
    return await handleAuthInner(request, env);
  } catch (err: any) {
    console.error("scanner auth error", err);
    return json(
      { ok: false, error: err?.error_message ?? err?.message ?? String(err) },
      502,
    );
  }
}

async function handleAuthInner(request: Request, env: Env): Promise<Response> {
  resetMTProto();
  const url = new URL(request.url);
  const token = request.headers.get("X-Auth-Secret") ?? url.searchParams.get("token");
  if (token !== env.WEBHOOK_SECRET) return json({ ok: false, error: "unauthorized" }, 401);

  const st = stateRes(env);

  if (request.method === "GET") {
    return json({ ok: true, loggedIn: await loggedIn(env), phone: await st.get("auth_phone") });
  }

  let body: { step?: string; phone?: string; code?: string } = {};
  const raw = await request.text().catch(() => "");
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      /* ignore */
    }
  }
  const phone = body.phone ?? url.searchParams.get("phone") ?? "";
  const code = body.code ?? url.searchParams.get("code") ?? "";
  const step = body.step ?? url.searchParams.get("step") ?? "status";

  if (step === "status") {
    return json({ ok: true, loggedIn: await loggedIn(env), phone: await st.get("auth_phone") });
  }

  if (step === "reset") {
    await env.DB.prepare("DELETE FROM scanner_state").run();
    resetMTProto();
        return json({ ok: true, message: "session cleared — run sendCode again" });
  }

  const m = await getMTProto(env);

  if (step === "sendCode") {
    if (!phone) return json({ ok: false, error: "phone required" }, 400);
    try {
      const res = await callAuth(env, () =>
        m.call("auth.sendCode", {
          phone_number: phone,
          api_id: apiId(env),
          api_hash: apiHash(env),
          settings: { _: "codeSettings", flags: 0 },
        }),
      );
      if (res?._ === "auth.sentCode" && res.phone_code_hash) {
        await st.set("auth_phone", phone);
        await st.set("phone_code_hash", String(res.phone_code_hash));
        return json({
          ok: true,
          message: "code sent to your Telegram app",
          next: "signIn with code",
          timeout: res.timeout ?? null,
        });
      }
      return json({ ok: false, error: "unexpected sendCode response" }, 502);
    } catch (err: any) {
      return json({ ok: false, error: err?.error_message ?? err?.message ?? String(err) }, 502);
    }
  }

  if (step === "signIn") {
    if (!phone || !code) return json({ ok: false, error: "phone and code required" }, 400);
    const storedPhone = await st.get("auth_phone");
    const pcHash = await st.get("phone_code_hash");
    if (!pcHash || storedPhone !== phone) {
      return json({ ok: false, error: "run step=sendCode first" }, 400);
    }
    try {
      const res = await callAuth(env, () =>
        m.call("auth.signIn", {
          phone_number: phone,
          phone_code_hash: pcHash,
          phone_code: code,
        }),
      );
      if (res?._ === "auth.authorization") {
        await st.set("logged_in", "1");
        return json({ ok: true, message: "logged in. Now trigger /scan." });
      }
      return json({ ok: false, error: "unexpected signIn response" }, 502);
    } catch (err: any) {
      const msg = err?.error_message ?? err?.message ?? String(err);
      if (msg.includes("SESSION_PASSWORD_NEEDED")) {
        return json({
          ok: false,
          error: "Your account has two-step verification. Disable it temporarily in Telegram Settings, then retry.",
        });
      }
      if (msg.includes("PHONE_CODE_INVALID") || msg.includes("CODE_INVALID")) {
        return json({ ok: false, error: "invalid code — try again" });
      }
      return json({ ok: false, error: msg }, 502);
    }
  }

  return json({ ok: false, error: "unknown step (sendCode | signIn | status | reset)" }, 400);
}

export async function scannerStatus(env: Env): Promise<Response> {
  const st = stateRes(env);
  const lastId = Number((await st.get("last_message_id")) ?? "0") || null;
  const scanned = Number((await st.get("scanned_count")) ?? "0");
  const scanning = Number((await st.get("scanning_until")) ?? "0") > Date.now();
  return json({
    ok: true,
    loggedIn: await loggedIn(env),
    lastMessageId: lastId,
    scannedCount: scanned,
    scanning,
  });
}

// -------------------------------------------------------------------- chan

async function getChannelPeer(env: Env): Promise<{ _: string; channel_id: bigint; access_hash: bigint }> {
  const st = stateRes(env);
  const channelId = BigInt(String(env.CHANNEL_ID).replace(/^-100/, ""));
  const cached = await st.get("channel_peer_hash");
  if (cached) {
    return { _: "inputPeerChannel", channel_id: channelId, access_hash: BigInt(cached) };
  }

  const dialogs = await rpc(env, "messages.getDialogs", {
    offset_id: 0,
    offset_date: 0,
    offset_peer: { _: "inputPeerEmpty" },
    limit: 200,
    hash: 0,
  });
  const chats: any[] = dialogs?.chats ?? [];
  const channel = chats.find((c) => c?._ === "channel" && String(c.id) === String(channelId));
  if (!channel || !channel.access_hash) {
    const list = chats.map((c) => `${c._}:${c.id}:${c.title ?? c.username ?? "?"}`).slice(0, 20);
    throw new Error(
      `channel not found in dialogs (count=${chats.length}, looking for ${channelId}). dialogs: ${list.join(", ")}`,
    );
  }
  await st.set("channel_peer_hash", String(channel.access_hash));
  return { _: "inputPeerChannel", channel_id: channelId, access_hash: channel.access_hash };
}

export async function scanOnce(env: Env): Promise<{ scanned: number; indexed: number; done: boolean }> {
  await ensureLoggedIn(env);
  const peer = await getChannelPeer(env);
  const st = stateRes(env);

  const offsetId = Number((await st.get("last_message_id")) ?? "0") || 0;
  const res = await rpc(env, "messages.getHistory", {
    peer,
    offset_id: offsetId,
    offset_date: 0,
    add_offset: 0,
    limit: HISTORY_LIMIT,
    max_id: 0,
    min_id: 0,
    hash: 0,
  });

  const messages: TLMessage[] = (res?.messages ?? []).filter((m: any) => m && m._ === "message");
  if (!messages.length) {
    await st.set("last_message_id", "0");
    return { scanned: 0, indexed: 0, done: true };
  }

  let indexed = 0;
  let skipped = 0;
  for (const msg of messages) {
    const row = await indexMessage(env, msg);
    if (row === "media") indexed++;
    else if (row === "skip") skipped++;
    await sleep(SLEEP_MS);
  }

  const lastId = messages[messages.length - 1].id;
  await st.set("last_message_id", String(lastId));
  const total = (Number((await st.get("scanned_count")) ?? "0") || 0) + messages.length;
  await st.set("scanned_count", String(total));

  return { scanned: messages.length, indexed, done: messages.length < HISTORY_LIMIT };
}

async function indexMessage(
  env: Env,
  msg: TLMessage,
): Promise<"media" | "skip" | "none"> {
  const media = msg.media;
  if (!media || media._ !== "messageMediaDocument" || !media.document) return "none";
  const d = media.document;
  if (d._ !== "document") return "none";

  const attrs = d.attributes ?? [];
  const audioAttr = attrs.find((a) => a._ === "documentAttributeAudio");
  const videoAttr = attrs.find((a) => a._ === "documentAttributeVideo");
  const fileAttr = attrs.find((a) => a._ === "documentAttributeFilename");
  const mime = (d.mime_type ?? "").toLowerCase();
  const fileName =
    fileAttr?.file_name ??
    (audioAttr?.title ? `${audioAttr?.performer ?? ""} - ${audioAttr.title}.mp3` : `media_${msg.id}.mp4`);

  let fileType: number;
  let mediaKind: Song["media_type"];
  let duration: number | null = null;
  let title: string | null = null;
  let artist: string | null = null;
  let width: number | null = null;
  let height: number | null = null;

  if (audioAttr) {
    if (audioAttr.voice) {
      fileType = 3;
      mediaKind = "audio";
      duration = audioAttr.duration ?? null;
    } else {
      fileType = 9;
      mediaKind = "audio";
      duration = audioAttr.duration ?? null;
      title = audioAttr.title ?? null;
      artist = audioAttr.performer ?? null;
    }
  } else if (videoAttr) {
    fileType = videoAttr.round_message ? 13 : 4;
    mediaKind = "video";
    duration = videoAttr.duration ?? null;
    width = videoAttr.w ?? null;
    height = videoAttr.h ?? null;
  } else {
    if (!mime.startsWith("audio/") && !mime.startsWith("video/")) {
      const name = (fileName ?? "").toLowerCase();
      const ext = name.slice(name.lastIndexOf("."));
      if (!PLAYABLE_DOC_EXTS.includes(ext)) return "skip";
    }
    fileType = 5;
    mediaKind = mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : "document";
  }

  const fileId = serializeFileId({
    kind: "document",
    source: "",
    fileType: fileType as unknown as FileType,
    dcId: d.dc_id,
    id: d.id,
    accessHash: d.access_hash,
    fileReference: d.file_reference,
    version: 4,
    subVersion: SUB_VERSION,
  });

  const valid = await validateFileId(env, fileId);
  if (!valid) {
    console.log(`scanner: file_id rejected by Bot API for msg ${msg.id}`);
    return "skip";
  }

  const file: Song = {
    id: 0,
    tg_file_id: fileId,
    tg_unique_id: null,
    chat_id: env.CHANNEL_ID,
    message_id: msg.id,
    file_name: fileName ?? null,
    title,
    artist,
    mime_type: mime || null,
    media_type: mediaKind,
    size: d.size ? Number(d.size) : 0,
    duration,
    width,
    height,
    added_at: (msg.date ?? 0) * 1000 || Date.now(),
    added_by: null,
  };
  await insertSong(env, file);
  return "media";
}

async function validateFileId(env: Env, fileId: string): Promise<boolean> {
  try {
    const res = await fetch(`${BOT_API}/bot${env.BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`);
    const j = (await res.json()) as { ok: boolean };
    return j.ok === true;
  } catch {
    return false;
  }
}

export async function runScan(env: Env): Promise<{ scanned: number; indexed: number; done: boolean }> {
  resetMTProto();
  const st = stateRes(env);
  if (Number((await st.get("scanning_until")) ?? "0") > Date.now()) {
    return { scanned: 0, indexed: 0, done: false };
  }
  await st.set("scanning_until", String(Date.now() + SCAN_BUDGET_MS));
  let scanned = 0;
  let indexed = 0;
  const start = Date.now();
  let done = false;
  try {
    while (Date.now() - start < SCAN_BUDGET_MS) {
      const r = await scanOnce(env);
      scanned += r.scanned;
      indexed += r.indexed;
      if (r.done || r.scanned === 0) {
        done = true;
        break;
      }
    }
  } finally {
    await st.set("scanning_until", "0");
  }
  return { scanned, indexed, done };
}

function parseFloodSeconds(msg: string): number {
  const m = msg.match(/FLOOD_WAIT_(\d+)/);
  return m ? Number(m[1]) : 2;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Dormant DO stub — kept so the durable-object binding in wrangler.jsonc stays valid.
export class ChannelScanner {
  constructor(private state: DurableObjectState, private env: Env) {}
  fetch(): Response {
    return new Response("Scanner moved to main worker", { status: 410 });
  }
  alarm(): void {}
}