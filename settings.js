// settings.js

// Backend (Render)
export const API_BASE = "https://radiant-waves-1.onrender.com";
// export const API_BASE = "http://127.0.0.1:8080";

// Refresh (30 mins)
export const REFRESH_INTERVAL_MS = 30 * 60 * 1000;

/** 0 = no day cutoff; match API `HOME_ARTICLE_MAX_AGE_DAYS` if you set it on Render */
export const HOME_ARTICLE_MAX_AGE_DAYS = 0;

// ✅ Live Broadcast (YouTube)
export const YOUTUBE_LIVE_ID = "";

// ✅ Weather (Open-Meteo: no key needed)
export const WEATHER_FALLBACK = { name: "Lagos", lat: 6.5244, lon: 3.3792 };

/* =========================================================
   SNAPSHOT FRONT-MAN (Firebase Storage / GCS)
========================================================= */

// ✅ Put your public URLs here (IMPORTANT)
export const SNAPSHOT_LATEST_URL =
  "https://storage.googleapis.com/<YOUR_BUCKET>/snapshots/latest.json.gz";

export const SNAPSHOT_FEED_BASE_URL =
  "https://storage.googleapis.com/<YOUR_BUCKET>/snapshots/feeds/";

// helper: build feed snapshot url
export function snapshotFeedUrl(feed) {
  const f = String(feed || "").trim().toLowerCase();
  if (!SNAPSHOT_FEED_BASE_URL) return "";
  const base = SNAPSHOT_FEED_BASE_URL.endsWith("/")
    ? SNAPSHOT_FEED_BASE_URL
    : `${SNAPSHOT_FEED_BASE_URL}/`;
  return `${base}${encodeURIComponent(f)}.json.gz`;
}

/* =========================================================
   SNAPSHOT FETCH HELPERS (Browser)
   - Reads .json.gz using DecompressionStream (modern browsers)
   - Falls back to normal JSON if server returns plain JSON
========================================================= */

async function gunzipToText(arrayBuffer) {
  // If browser supports DecompressionStream (Chrome/Edge/Firefox new), use it
  if ("DecompressionStream" in window) {
    const ds = new DecompressionStream("gzip");
    const stream = new Response(arrayBuffer).body.pipeThrough(ds);
    return await new Response(stream).text();
  }
  // No gzip support → we can't decode .gz in-browser
  // So caller should fallback to API_BASE
  throw new Error("NO_GZIP_SUPPORT");
}

export async function fetchSnapshotJson(url, { timeoutMs = 12000 } = {}) {
  if (!url) throw new Error("NO_SNAPSHOT_URL");

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(url + (url.includes("?") ? "&" : "?") + "_t=" + Date.now(), {
      signal: ctrl.signal,
      cache: "no-store",
    });

    if (!res.ok) throw new Error(`SNAPSHOT_HTTP_${res.status}`);

    // try parse as JSON directly first (in case you later store non-gz)
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    if (ct.includes("application/json") && !url.endsWith(".gz")) {
      return await res.json();
    }

    // gz path:
    const buf = await res.arrayBuffer();
    const text = await gunzipToText(buf);
    return JSON.parse(text);
  } finally {
    clearTimeout(t);
  }
}

/* =========================================================
   FALLBACK: build API /articles url
========================================================= */
export function apiArticlesUrl({ feed = "", limit = 150, q = "" } = {}) {
  const u = new URL(API_BASE.replace(/\/$/, "") + "/articles");
  if (feed) u.searchParams.set("feed", feed);
  if (q) u.searchParams.set("q", q);
  u.searchParams.set("limit", String(limit));
  u.searchParams.set("_t", String(Date.now())); // cache-bust
  return u.toString();
}
