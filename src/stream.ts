import type { Env, Song } from "./types";
import { Telegram } from "./telegram";
import { mtDocLocation, mtpFreshDocument, mtpGetChunk, resetMTProto } from "./scanner";

const CDN_FETCH_TIMEOUT_MS = 25000;
// 1 MiB = upload.getFile max part size (defined implicitly via 1 << 20 in the stream loop).
// Files up to 200MB stream via MTProto (Bot API getFile caps at 20MB).
const MT_THRESHOLD = 200 * 1024 * 1024;

// Telegram's file server caps every single HTTP response at ~8 MiB: range-less
// downloads and ranges longer than that are silently truncated mid-body. To
// guarantee intact delivery the CDN path fetches upstream in slices that fit
// comfortably under the cap and stitches them together.
const CDN_SLICE_BYTES = 4 * 1024 * 1024;

// MTProto upload.getFile non-precise rules: offset must be divisible by 4 KiB,
// limit ≤ 1 MiB, and the whole read must stay inside a single 1 MiB chunk. The
// simplest compliant strategy is to read 1 MiB-aligned chunks and slice out the
// exact range the client asked for.
const MT_ALIGN = 1024 * 1024;

function alignDown(n: number): number {
  return Math.floor(n / MT_ALIGN) * MT_ALIGN;
}

function sliceBetween(buf: Uint8Array, start: number, endExclusive: number): Uint8Array {
  const lo = Math.max(0, start);
  const hi = Math.min(buf.byteLength, endExclusive);
  return lo >= hi ? new Uint8Array(0) : buf.subarray(lo, hi);
}

function mtStreamBytes(
  env: Env,
  holder: { current: { location: Record<string, unknown>; dcId: number } },
  song: Song,
  total: number,
  range: { start: number; end: number } | null,
): ReadableStream<Uint8Array> {
  const start = range?.start ?? 0;
  const end = range?.end ?? total - 1;
  let cursor = alignDown(start);
  let done = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (done) {
        controller.close();
        return;
      }
      while (cursor <= end && (controller.desiredSize ?? 1) > 0) {
        const want = 1 << 20;
        let res: { _: string; bytes?: Uint8Array };
        try {
          res = await mtpGetChunk(env, holder.current.location, cursor, want, holder.current.dcId);
        } catch (e: any) {
          const msg = e?.error_message ?? e?.message ?? String(e);
          if (msg.includes("FILE_REFERENCE_EXPIRED")) {
            const fresh = await mtpFreshDocument(env, song.message_id);
            if (fresh) {
              holder.current = { location: fresh.location, dcId: fresh.dcId };
            } else {
              console.error("mt refresh failed, message_id", song.message_id);
              controller.error(new Error(`FILE_REFERENCE_EXPIRED and refresh failed: ${msg}`));
              return;
            }
            try {
              res = await mtpGetChunk(env, holder.current.location, cursor, want, holder.current.dcId);
            } catch (e2: any) {
              console.error("mt chunk error after refresh", cursor, e2?.error_message ?? e2?.message ?? String(e2));
              controller.error(new Error(`chunk after refresh failed: ${e2?.error_message ?? e2?.message ?? String(e2)}`));
              return;
            }
          } else {
            console.error("mt chunk error", cursor, want, holder.current.dcId, msg);
            controller.error(new Error(`MTProto chunk failed at ${cursor}: ${msg}`));
            return;
          }
        }
        if (res._ === "upload.fileCdnRedirect") {
          console.error("mt upload.fileCdnRedirect not handled", cursor);
          controller.error(new Error("upload.fileCdnRedirect not handled"));
          return;
        }
        const bytes = res.bytes;
        if (!bytes || bytes.byteLength === 0) {
          console.error("mt chunk empty bytes at cursor", cursor, "res:", JSON.stringify(res, (k, v) => k === "bytes" ? `Uint8Array(${v?.byteLength})` : v));
          done = true;
          controller.close();
          return;
        }
        const chunkStart = cursor;
        cursor += bytes.byteLength;
        controller.enqueue(sliceBetween(bytes, start - chunkStart, end - chunkStart + 1));
      }
      if (cursor > end) {
        done = true;
        controller.close();
      }
    },
    cancel() {
      done = true;
    },
  });
}

const filePathCache = new Map<string, { path: string; at: number }>();
const FILE_PATH_CACHE_TTL = 24 * 60 * 60 * 1000;

async function resolveDownloadUrl(env: Env, fileId: string): Promise<string> {
  const cached = filePathCache.get(fileId);
  if (cached && Date.now() - cached.at < FILE_PATH_CACHE_TTL) {
    return `${cached.path}`;
  }
  const tg = Telegram.of(env.BOT_TOKEN);
  const url = await tg.getFileDownloadUrl(fileId);
  filePathCache.set(fileId, { path: url, at: Date.now() });
  return url;
}

export function parseRange(
  header: string | null,
  totalSize: number,
): { start: number; end: number } | "unsatisfiable" | null {
  if (!header || !header.startsWith("bytes=")) return null;
  const spec = header.slice(6).trim();
  if (spec.includes(",")) return null;
  const [startStr, endStr] = spec.split("-");
  let start: number;
  let end: number;
  if (startStr === "") {
    const suffix = Number(endStr);
    if (Number.isNaN(suffix) || suffix <= 0) return "unsatisfiable";
    start = Math.max(0, totalSize - suffix);
    end = totalSize - 1;
  } else {
    start = Number(startStr);
    end = endStr === "" ? totalSize - 1 : Number(endStr);
  }
  if (Number.isNaN(start) || Number.isNaN(end) || start < 0 || start >= totalSize || end < start) {
    return "unsatisfiable";
  }
  end = Math.min(end, totalSize - 1);
  return { start, end };
}

export async function handleStream(
  request: Request,
  env: Env,
  song: Song,
): Promise<Response> {
  const baseHeaders = {
    "Content-Type": song.mime_type ?? "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Access-Control-Allow-Origin": "*",
    "Content-Disposition": `inline; filename="${sanitizeFileName(song.file_name ?? "song")}"`,
    ETag: `"${song.tg_unique_id ?? song.id}"`,
    "Cache-Control": "public, max-age=86400",
  };

  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch && ifNoneMatch.includes(`"${song.tg_unique_id ?? song.id}"`)) {
    return new Response(null, { status: 304, headers: baseHeaders });
  }

  const loc = mtDocLocation(song.tg_file_id);
  const needsMT = song.size > MT_THRESHOLD;

  if (needsMT && !loc) {
    return new Response("File is larger than 200MB and cannot be located via MTProto.", { status: 502 });
  }

  if (needsMT) {
    try {
      return await handleStreamMT(request, env, song, loc!, baseHeaders);
    } catch (e: any) {
      const detail = e?.error_message ?? e?.message ?? JSON.stringify(e);
      console.error("mtproto stream failed", detail, e?.error_code, e?.code);
      return new Response(`MTProto stream error: ${detail ?? "unknown"}`, { status: 502 });
    }
  }

  const cdn = await handleStreamCDN(request, env, song, baseHeaders);
  if (cdn) return cdn;
  if (!loc) return new Response("File is not available on Telegram.", { status: 404 });

  // CDN said the file is not available or truncated it — try the MTProto path.
  try {
    return await handleStreamMT(request, env, song, loc, baseHeaders);
  } catch (e: any) {
    console.error("mtproto fallback stream failed", e?.message ?? e);
    return new Response("File is not available on Telegram.", { status: 404 });
  }
}

function mtRangeResponse(
  body: ReadableStream<Uint8Array>,
  baseHeaders: Record<string, string>,
  total: number,
  range: { start: number; end: number } | null,
): Response {
  const start = range?.start ?? 0;
  const end = range?.end ?? total - 1;
  return new Response(body, {
    status: range ? 206 : 200,
    headers: {
      ...baseHeaders,
      "Content-Length": String(end - start + 1),
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${total}` } : {}),
    },
  });
}

async function handleStreamMT(
  request: Request,
  env: Env,
  song: Song,
  loc: { location: Record<string, unknown>; dcId: number },
  baseHeaders: Record<string, string>,
): Promise<Response> {
  const total = song.size;
  if (total <= 0) throw new Error("unknown file size");

  // The shared MTProto client in the scanner module keeps a WebSocket from a
  // previous request's context, which Cloudflare forbids touching from this
  // request. Recreate it so the connection is bound to the current request.
  resetMTProto();

  const holder = { current: loc };
  const parsed = parseRange(request.headers.get("range"), total);

  if (parsed === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { ...baseHeaders, "Content-Range": `bytes */${total}` },
    });
  }
  return mtRangeResponse(mtStreamBytes(env, holder, song, total, parsed), baseHeaders, total, parsed);
}

async function handleStreamCDN(
  request: Request,
  env: Env,
  song: Song,
  baseHeaders: Record<string, string>,
): Promise<Response | null> {
  const tg = Telegram.of(env.BOT_TOKEN);
  let downloadUrl: string;
  try {
    downloadUrl = await resolveDownloadUrl(env, song.tg_file_id);
  } catch {
    return null; // caller decides fallback
  }

  const total = song.size > 0 ? song.size : 0;
  const rangeHeader = request.headers.get("range");
  const parsed = parseRange(rangeHeader, total);

  if (parsed === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { ...baseHeaders, "Content-Range": `bytes */${total}` },
    });
  }

  const start = parsed?.start ?? 0;
  const end = parsed?.end ?? total - 1;

  // Single-range requests that fit under the slice cap can go straight to a
  // one-shot upstream fetch (fast path, preserves the previous behavior).
  if (parsed && end - start + 1 <= CDN_SLICE_BYTES) {
    const upstream = await fetchCdnRange(downloadUrl, start, end);
    if (!upstream) return new Response("Telegram CDN unreachable", { status: 502 });
    if (upstream.status !== 206 && upstream.status !== 200) {
      return new Response(`Telegram CDN error: ${upstream.status}`, { status: 502 });
    }
    return new Response(upstream.body, {
      status: 206,
      headers: {
        ...baseHeaders,
        "Content-Length": upstream.headers.get("content-length") ?? String(end - start + 1),
        "Content-Range": upstream.headers.get("content-range") ?? `bytes ${start}-${end}/${total}`,
      },
    });
  }

  // Full-body / long-range: fetch upstream in slices that stay under the
  // Telegram ~8 MiB per-response cap, then stitch them into one stream.
  return sliceResponse(downloadUrl, start, end, total, !!parsed, baseHeaders);
}

function fetchCdnRange(
  downloadUrl: string,
  start: number,
  end: number,
): Promise<Response> {
  return fetch(downloadUrl, {
    method: "GET",
    headers: { Range: `bytes=${start}-${end}` },
    signal: AbortSignal.timeout(CDN_FETCH_TIMEOUT_MS),
  });
}

function sliceResponse(
  downloadUrl: string,
  start: number,
  end: number,
  total: number,
  isRange: boolean,
  baseHeaders: Record<string, string>,
): Response {
  let cursor = start;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (cursor > end) {
        controller.close();
        return;
      }
      const sliceEnd = Math.min(end, cursor + CDN_SLICE_BYTES - 1);
      let res: Response;
      try {
        res = await fetchCdnRange(downloadUrl, cursor, sliceEnd);
      } catch {
        controller.error(new Error(`CDN slice unreachable at ${cursor}`));
        return;
      }
      if (res.status !== 206 && res.status !== 200) {
        controller.error(new Error(`CDN slice HTTP ${res.status} at ${cursor}`));
        return;
      }
      const reader = res.body?.getReader();
      if (!reader) {
        controller.error(new Error(`CDN slice body missing at ${cursor}`));
        return;
      }
      while (cursor <= sliceEnd) {
        const { done, value } = await reader.read();
        if (done) break;
        controller.enqueue(value);
      }
      cursor = sliceEnd + 1;
    },
    cancel() {
      cursor = end + 1;
    },
  });
  const len = end - start + 1;
  return new Response(body, {
    status: isRange ? 206 : 200,
    headers: {
      ...baseHeaders,
      "Content-Length": String(len),
      ...(isRange ? { "Content-Range": `bytes ${start}-${end}/${total}` } : {}),
    },
  });
}

function parseContentLength(v: string | null): number {
  const n = v ? parseInt(v, 10) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function sanitizeFileName(name: string): string {
  return name.replace(/["\\\r\n]/g, "_");
}
