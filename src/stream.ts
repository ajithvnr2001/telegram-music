import type { Env, Song } from "./types";
import { Telegram } from "./telegram";

const CDN_FETCH_TIMEOUT_MS = 25000;

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
  const tg = Telegram.of(env.BOT_TOKEN);
  let downloadUrl: string;
  try {
    downloadUrl = await resolveDownloadUrl(env, song.tg_file_id);
  } catch {
    return new Response("File is not available on Telegram (may exceed 20MB).", { status: 404 });
  }

  const baseHeaders = {
    "Content-Type": song.mime_type ?? "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Access-Control-Allow-Origin": "*",
    "Content-Disposition": `inline; filename="${sanitizeFileName(song.file_name ?? "song")}"`,
    ETag: `"${song.tg_unique_id ?? song.id}"`,
    "Cache-Control": "public, max-age=86400",
  };

  const rangeHeader = request.headers.get("range");
  const ifNoneMatch = request.headers.get("if-none-match");

  if (ifNoneMatch && ifNoneMatch.includes(`"${song.tg_unique_id ?? song.id}"`)) {
    return new Response(null, { status: 304, headers: baseHeaders });
  }

  const upstreamHeaders: Record<string, string> = {};
  if (rangeHeader) upstreamHeaders["Range"] = rangeHeader;

  let upstream: Response;
  try {
    upstream = await fetch(downloadUrl, {
      method: "GET",
      headers: upstreamHeaders,
      signal: AbortSignal.timeout(CDN_FETCH_TIMEOUT_MS),
    });
  } catch {
    return new Response("Telegram CDN unreachable", { status: 502 });
  }

  const total = song.size > 0 ? song.size : parseContentLength(upstream.headers.get("content-length"));

  if (!upstream.ok && upstream.status !== 206) {
    if (upstream.status === 416 && total > 0) {
      return new Response(null, {
        status: 416,
        headers: { ...baseHeaders, "Content-Range": `bytes */${total}` },
      });
    }
    return new Response(`Telegram CDN error: ${upstream.status}`, { status: 502 });
  }

  if (!rangeHeader) {
    return new Response(upstream.body, {
      status: 200,
      headers: {
        ...baseHeaders,
        ...(total > 0 ? { "Content-Length": String(total) } : {}),
      },
    });
  }

  const parsed = parseRange(rangeHeader, total);

  if (parsed === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { ...baseHeaders, "Content-Range": `bytes */${total}` },
    });
  }

  if (parsed && upstream.status === 206) {
    return new Response(upstream.body, {
      status: 206,
      headers: {
        ...baseHeaders,
        "Content-Length": upstream.headers.get("content-length") ?? String(parsed.end - parsed.start + 1),
        "Content-Range": upstream.headers.get("content-range") ?? `bytes ${parsed.start}-${parsed.end}/${total}`,
      },
    });
  }

  if (parsed) {
    const buf = await upstream.arrayBuffer();
    const sliced = buf.slice(parsed.start, parsed.end + 1);
    return new Response(sliced, {
      status: 206,
      headers: {
        ...baseHeaders,
        "Content-Length": String(sliced.byteLength),
        "Content-Range": `bytes ${parsed.start}-${parsed.end}/${total}`,
      },
    });
  }

  return new Response(upstream.body, {
    status: 200,
    headers: { ...baseHeaders, "Content-Length": String(total) },
  });
}

function parseContentLength(v: string | null): number {
  const n = v ? parseInt(v, 10) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function sanitizeFileName(name: string): string {
  return name.replace(/["\\\r\n]/g, "_");
}
