const ASSETS: Record<string, { url: string; type: string }> = {
  "ffmpeg.js": {
    url: "https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/umd/ffmpeg.js",
    type: "text/javascript",
  },
  "util.js": {
    url: "https://unpkg.com/@ffmpeg/util@0.12.1/dist/umd/index.js",
    type: "text/javascript",
  },
  "core.js": {
    url: "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.js",
    type: "text/javascript",
  },
  "core.wasm": {
    url: "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.wasm",
    type: "application/wasm",
  },
  "814.ffmpeg.js": {
    url: "https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/umd/814.ffmpeg.js",
    type: "text/javascript",
  },
};

const CACHE_TTL = 60 * 60 * 24 * 30; // 30 days

export async function handleFfmpegAsset(path: string): Promise<Response | null> {
  const name = path.replace(/^\/+/, "");
  const asset = ASSETS[name];
  if (!asset) return null;

  const cache = caches.default;
  const cacheKey = new Request(`https://ffmpeg.local/${name}`);
  const cached = await cache.match(cacheKey);
  if (cached) {
    return new Response(cached.body, {
      headers: {
        "Content-Type": asset.type,
        "Cache-Control": `public, max-age=${CACHE_TTL}, immutable`,
        "Access-Control-Allow-Origin": "*",
        "Cross-Origin-Resource-Policy": "cross-origin",
      },
    });
  }

  const upstream = await fetch(asset.url);
  if (!upstream.ok) {
    return new Response(`Failed to fetch ffmpeg asset: ${upstream.status}`, { status: 502 });
  }

  const body = await upstream.arrayBuffer();
  const headers = {
    "Content-Type": asset.type,
    "Cache-Control": `public, max-age=${CACHE_TTL}, immutable`,
    "Access-Control-Allow-Origin": "*",
    "Cross-Origin-Resource-Policy": "cross-origin",
  };
  const response = new Response(body, { headers });
  ctxWaitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

let waitUntilFn: ((p: Promise<unknown>) => void) | null = null;
export function setWaitUntil(fn: (p: Promise<unknown>) => void) {
  waitUntilFn = fn;
}
function ctxWaitUntil(p: Promise<unknown>) {
  if (waitUntilFn) waitUntilFn(p);
}