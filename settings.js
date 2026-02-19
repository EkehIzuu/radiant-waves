// settings.js

// Backend (Render)
export const API_BASE = "https://radiant-waves-1.onrender.com";
// export const API_BASE = "http://127.0.0.1:8080";

// Refresh (30 mins)
export const REFRESH_INTERVAL_MS = 30 * 60 * 1000;

// ✅ Live Broadcast (YouTube)
// Put your LIVE stream video id here (or normal video id). Example: "dQw4w9WgXcQ"
export const YOUTUBE_LIVE_ID = "";

// ✅ Weather (uses Open-Meteo: no key needed)
// fallback location if user denies geolocation
export const WEATHER_FALLBACK = { name: "Lagos", lat: 6.5244, lon: 3.3792 };

/* =========================================================
   SNAPSHOT FRONT-MAN (Firebase Storage / GCS)

   What it does:
   - Frontend loads snapshots from Storage (FAST for thousands)
   - If Storage fails → fallback to last snapshot in localStorage
   - If localStorage empty → show offline/stale UI (not blank)

   You will upload snapshots like:
     snapshots/latest.json.gz
     snapshots/feeds/politics.json.gz
     snapshots/feeds/football.json.gz
     snapshots/feeds/celebrity.json.gz

   Put your public URLs here.
========================================================= */

// ✅ change these when you upload snapshots
export const SNAPSHOT_LATEST_URL =
  ""; // e.g. "https://storage.googleapis.com/<bucket>/snapshots/latest.json.gz"

export const SNAPSHOT_FEED_BASE_URL =
  ""; // e.g. "https://storage.googleapis.com/<bucket>/snapshots/feeds/"

// helper: build feed snapshot url
export function snapshotFeedUrl(feed) {
  const f = String(feed || "").trim().toLowerCase();
  if (!SNAPSHOT_FEED_BASE_URL) return "";
  const base = SNAPSHOT_FEED_BASE_URL.endsWith("/")
    ? SNAPSHOT_FEED_BASE_URL
    : `${SNAPSHOT_FEED_BASE_URL}/`;
  return `${base}${encodeURIComponent(f)}.json.gz`;
}
