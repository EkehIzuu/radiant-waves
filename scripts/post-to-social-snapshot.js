import fs from "fs";
import path from "path";
import zlib from "zlib";
import sharp from "sharp";

/** Increment when posting logic changes; Actions logs should show this (if not, fork `main` is behind). */
const SOCIAL_POST_SCRIPT_REV = 11;

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const SNAPSHOT_LOCAL = path.join(process.cwd(), "snapshots", "latest.json.gz");
const STATE_PATH = path.join(process.cwd(), "social_state.json");

/**
 * Article pool = snapshots/latest.json.gz + snapshots/feeds/{politics,football,celebrity}.json.gz (deduped by URL).
 * - SNAPSHOT_URL: explicit override for latest (HTTPS .json.gz).
 * - SNAPSHOT_FEED_BASE: optional override for feeds folder URL (…/snapshots/feeds/); else derived from latest URL.
 * - Else in GitHub Actions: raw.githubusercontent.com/OWNER/REPO/REF/snapshots/latest.json.gz (+ feeds/).
 * - Else local dev: snapshots/latest.json.gz and snapshots/feeds/*.json.gz on disk.
 */
function resolveSnapshotFetchUrl() {
  const explicit = env("SNAPSHOT_URL");
  if (explicit) return explicit;
  const repo = env("GITHUB_REPOSITORY");
  const ref = env("SNAPSHOT_REF") || env("GITHUB_REF_NAME") || "main";
  if (repo) {
    return `https://raw.githubusercontent.com/${repo}/${ref}/snapshots/latest.json.gz`;
  }
  return "";
}

/** Base URL for per-feed snapshots (…/snapshots/feeds/). Optional env or derived from latest.json.gz URL. */
function resolveFeedBaseUrl() {
  const explicit = env("SNAPSHOT_FEED_BASE");
  if (explicit) return explicit.replace(/\/+$/, "/");
  const latest = resolveSnapshotFetchUrl();
  if (latest && latest.includes("latest.json.gz")) {
    return latest.replace("latest.json.gz", "feeds/");
  }
  return "";
}

const SNAPSHOT_FEED_NAMES = ["politics", "football", "celebrity"];

/** Hourly UTC: 0→politics, 1→football, 2→celebrity, then repeat. Override with SOCIAL_TARGET_FEED or workflow_dispatch. */
function resolveTargetFeed() {
  const explicit = env("SOCIAL_TARGET_FEED").toLowerCase();
  if (explicit && explicit !== "auto" && SNAPSHOT_FEED_NAMES.includes(explicit)) return explicit;
  const h = new Date().getUTCHours();
  return SNAPSHOT_FEED_NAMES[h % 3];
}

function filterItemsByFeed(items, feed) {
  const f = String(feed || "").toLowerCase();
  return (items || []).filter((it) => String(it?.feed || "").toLowerCase() === f);
}

function prependSkippedUrl(state, url) {
  const k = normalizeUrlForDedupe(url);
  if (!k) return;
  const prev = Array.isArray(state?.skipped_urls) ? state.skipped_urls : [];
  state.skipped_urls = [k, ...prev.filter((u) => normalizeUrlForDedupe(u) !== k)].slice(0, 5000);
}

function parseSnapshotGzBuffer(gz) {
  const raw = zlib.gunzipSync(gz).toString("utf8");
  const data = JSON.parse(raw);
  return Array.isArray(data?.items) ? data.items : [];
}

function env(name, fallback = "") {
  return (process.env[name] || fallback).trim();
}

/** FB / story toggles: unset = ON. Set to 0 / false / no / off to disable. */
function envSocialEnabled(name) {
  const v = env(name).toLowerCase();
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  if (v === "1" || v === "true" || v === "yes") return true;
  return true;
}

const GRAPH = "https://graph.facebook.com/v21.0";

function stripHtml(str) {
  return String(str || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) || {};
  } catch {
    return {};
  }
}

function writeState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf8");
}

function getPostedUrlSet(state) {
  const arr = Array.isArray(state?.posted_urls) ? state.posted_urls : [];
  const set = new Set();
  for (const u of arr) {
    if (typeof u !== "string" || !/^https?:\/\//i.test(u)) continue;
    const n = postedUrlDedupeKey(u);
    if (n) set.add(n);
  }
  return set;
}

function getSkippedUrlSet(state) {
  const arr = Array.isArray(state?.skipped_urls) ? state.skipped_urls : [];
  const set = new Set();
  for (const u of arr) {
    if (typeof u !== "string" || !/^https?:\/\//i.test(u)) continue;
    const n = normalizeUrlForDedupe(u);
    if (n) set.add(n);
  }
  return set;
}

function isLowQualityImageUrl(url) {
  const s = String(url || "").toLowerCase();
  return (
    s.includes("logo") ||
    s.includes("favicon") ||
    s.includes("sprite") ||
    s.includes("placeholder") ||
    s.includes("default") ||
    s.includes("avatar") ||
    s.includes("icon") ||
    s.endsWith(".svg")
  );
}

/**
 * Hero images: skip tiny thumbs and extreme aspect ratios. Wrong Content-Type is OK if sharp decodes.
 * Defaults are a bit looser than OG-1200×630 so more feed images pass; tighten via env if needed.
 * SOCIAL_MIN_IMAGE_BYTES, SOCIAL_MIN_IMAGE_W, SOCIAL_MIN_IMAGE_H, SOCIAL_MIN_PIXELS, SOCIAL_IMAGE_AR_MIN/MAX
 */
async function fetchValidatedImageBuffer(imageUrl, fetchOpts = {}) {
  if (!imageUrl || isLowQualityImageUrl(imageUrl)) return null;
  const minBytes = Math.max(6000, Number(env("SOCIAL_MIN_IMAGE_BYTES", "10000")) || 10000);
  const minW = Math.max(320, Number(env("SOCIAL_MIN_IMAGE_W", "480")) || 480);
  const minH = Math.max(180, Number(env("SOCIAL_MIN_IMAGE_H", "250")) || 250);
  const minPixels = Math.max(40_000, Number(env("SOCIAL_MIN_PIXELS", "120000")) || 120000);
  const arMin = Number(env("SOCIAL_IMAGE_AR_MIN", "0.5")) || 0.5;
  const arMax = Number(env("SOCIAL_IMAGE_AR_MAX", "3")) || 3;
  const ua = fetchOpts.userAgent || "RadiantWaves/1.0 (Social Bot)";
  try {
    const res = await fetch(imageUrl, {
      signal: AbortSignal.timeout(20000),
      headers: { "User-Agent": ua, Accept: "image/avif,image/webp,image/*,*/*;q=0.8" },
      redirect: "follow",
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf?.length || buf.length < minBytes) return null;
    let meta;
    try {
      meta = await sharp(buf).metadata();
    } catch {
      return null;
    }
    const fmt = String(meta.format || "").toLowerCase();
    if (fmt === "svg" || fmt === "gif") return null;
    const w = Number(meta.width || 0);
    const h = Number(meta.height || 0);
    if (w < minW || h < minH) return null;
    if (w * h < minPixels) return null;
    const ar = w / Math.max(1, h);
    if (ar < arMin || ar > arMax) return null;
    return buf;
  } catch {
    return null;
  }
}

/** Parse article HTML for og:image / twitter:image (attribute order varies — use several patterns). */
function extractOgImageCandidates(html, pageUrl) {
  const out = [];
  const seen = new Set();
  const base = pageUrl || "";
  const push = (raw) => {
    if (!raw || typeof raw !== "string") return;
    let s = raw.replace(/&amp;/g, "&").replace(/&#x2F;/gi, "/").trim();
    if (s.startsWith("//")) s = "https:" + s;
    try {
      const abs = new URL(s, base).href;
      if (!/^https?:\/\//i.test(abs)) return;
      if (seen.has(abs)) return;
      seen.add(abs);
      if (!isLowQualityImageUrl(abs)) out.push(abs);
    } catch {}
  };

  const patterns = [
    /<meta[^>]+property=["']og:image:url["'][^>]+content=["']([^"']+)["']/gi,
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/gi,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/gi,
    /<meta[^>]+property=["']og:image:secure_url["'][^>]+content=["']([^"']+)["']/gi,
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/gi,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/gi,
    /<meta[^>]+name=["']twitter:image:src["'][^>]+content=["']([^"']+)["']/gi,
    /<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/gi,
  ];
  for (const re of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(html))) push(m[1]);
  }

  let j;
  const jsonLdImg = /"image"\s*:\s*\[?\s*"([^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/gi;
  while ((j = jsonLdImg.exec(html))) push(j[1]);

  return out;
}

/**
 * Real hero image only: snapshot URL first, then fetch article page and use og:image / twitter:image.
 * Returns null if nothing passes validation (no placeholder posts).
 */
async function resolveHeroImageBuffer(art) {
  const pageUrl = normalizeUrl(art.url || art.link || "");
  const snap = String(art.imageUrl || "").trim();

  if (snap) {
    const buf = await fetchValidatedImageBuffer(snap, { userAgent: BROWSER_UA });
    if (buf) {
      console.log("[social] Hero image from snapshot.");
      return buf;
    }
    console.warn("[social] Snapshot image failed validation or fetch, trying article page OG tags…");
  } else {
    console.log("[social] No imageUrl in snapshot — fetching article page for og:image / twitter:image…");
  }

  if (/^1|true|yes$/i.test(env("SOCIAL_DISABLE_OG_IMAGE"))) return null;
  if (!pageUrl) return null;

  let html = "";
  try {
    const res = await fetch(pageUrl, {
      signal: AbortSignal.timeout(25000),
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });
    if (!res.ok) {
      console.warn("[social] Article page HTTP %s — cannot read OG image.", res.status);
      return null;
    }
    html = await res.text();
  } catch (e) {
    console.warn("[social] Article page fetch failed:", e?.message || e);
    return null;
  }

  const candidates = extractOgImageCandidates(html, pageUrl);
  if (!candidates.length) {
    console.warn("[social] No og:image / twitter:image candidates in HTML.");
    return null;
  }

  for (let i = 0; i < Math.min(candidates.length, 12); i++) {
    const u = candidates[i];
    const buf = await fetchValidatedImageBuffer(u, { userAgent: BROWSER_UA });
    if (buf) {
      console.log("[social] Hero image from article page (candidate %d/%d).", i + 1, candidates.length);
      return buf;
    }
  }
  console.warn("[social] OG image URLs found but none passed size/quality checks.");
  return null;
}

async function fetchRemoteGzJson(url) {
  const bust = new URL(url);
  bust.searchParams.set("_t", String(Date.now()));
  const res = await fetch(bust.toString(), {
    signal: AbortSignal.timeout(60000),
    headers: {
      "User-Agent": "RadiantWaves/1.0 (social)",
      "Cache-Control": "no-cache",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const gz = Buffer.from(await res.arrayBuffer());
  return parseSnapshotGzBuffer(gz);
}

/**
 * Latest + per-feed gz files (same as site). Deduped by URL. Image quality still enforced in pickLatestUnposted / fetchValidatedImageBuffer.
 */
async function loadSnapshotItems() {
  const merged = [];
  const seen = new Set();

  function pushDeduped(items) {
    for (const it of items) {
      const u = normalizeUrlForDedupe(it.url || it.link || "");
      if (!u || seen.has(u)) continue;
      seen.add(u);
      merged.push(it);
    }
  }

  const snapshotUrl = resolveSnapshotFetchUrl();
  const feedBase = resolveFeedBaseUrl();

  if (snapshotUrl) {
    const homeItems = await fetchRemoteGzJson(snapshotUrl);
    pushDeduped(homeItems);
    console.log("[snapshot] remote latest items=%d", homeItems.length);

    if (feedBase && /^https?:\/\//i.test(feedBase)) {
      for (const name of SNAPSHOT_FEED_NAMES) {
        const fu = `${feedBase}${encodeURIComponent(name)}.json.gz`;
        try {
          const feedItems = await fetchRemoteGzJson(fu);
          pushDeduped(feedItems);
          console.log("[snapshot] remote feed %s items=%d (merged total=%d)", name, feedItems.length, merged.length);
        } catch (e) {
          console.warn("[snapshot] skip feed %s: %s", name, e?.message || e);
        }
      }
    }
    return merged;
  }

  if (!fs.existsSync(SNAPSHOT_LOCAL)) {
    throw new Error(
      "No snapshot source. In CI set GITHUB_REPOSITORY (auto) or SNAPSHOT_URL. Locally commit snapshots/latest.json.gz."
    );
  }
  pushDeduped(parseSnapshotGzBuffer(fs.readFileSync(SNAPSHOT_LOCAL)));
  const feedsDir = path.join(process.cwd(), "snapshots", "feeds");
  if (fs.existsSync(feedsDir)) {
    for (const name of fs.readdirSync(feedsDir)) {
      if (!name.endsWith(".json.gz")) continue;
      try {
        const p = path.join(feedsDir, name);
        pushDeduped(parseSnapshotGzBuffer(fs.readFileSync(p)));
      } catch (e) {
        console.warn("[snapshot] skip local feed file %s: %s", name, e?.message || e);
      }
    }
  }
  console.log("[snapshot] source=local merged items=%d", merged.length);
  return merged;
}

function parseTs(v) {
  const t = Date.parse(v || "");
  return Number.isFinite(t) ? t : 0;
}

function normalizeUrl(raw) {
  if (!raw || typeof raw !== "string") return "";
  const s = raw.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim();
  if (!/^https?:\/\//i.test(s)) return "";
  try {
    const u = new URL(s);
    u.hash = "";
    return u.toString();
  } catch {
    return "";
  }
}

/** Same article often appears with ?utm_* or trailing slash — dedupe so we don't repost. */
const TRACKING_QUERY_KEYS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
  "_ga",
  "igshid",
]);

function normalizeUrlForDedupe(raw) {
  const base = normalizeUrl(raw);
  if (!base) return "";
  try {
    const u = new URL(base);
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    for (const k of [...u.searchParams.keys()]) {
      const kl = k.toLowerCase();
      if (kl.startsWith("utm_") || TRACKING_QUERY_KEYS.has(kl)) u.searchParams.delete(k);
    }
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
    return u.toString();
  } catch {
    return base;
  }
}

/**
 * Keys for posted_urls / "already posted" checks. Hash-router article links (`#/article?u=…`) must
 * keep the fragment — normalizeUrl strips `#`, which collapsed every on-site article to the same origin
 * and blocked an entire feed after one post.
 */
function postedUrlDedupeKey(raw) {
  if (!raw || typeof raw !== "string") return "";
  const s = raw.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim();
  if (!/^https?:\/\//i.test(s)) return "";
  try {
    const u = new URL(s);
    const h = u.hash || "";
    if (h.includes("u=") && /article/i.test(h)) {
      u.hostname = u.hostname.toLowerCase();
      if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
      return u.origin + u.pathname + (u.search || "") + h;
    }
  } catch {}
  return normalizeUrlForDedupe(raw);
}

function buildSiteArticleViewUrl(sourceUrl) {
  const site = env("SITE_URL", "https://radiant-waves.com.ng").replace(/\/+$/, "");
  return `${site}/#/article?u=${encodeURIComponent(sourceUrl)}`;
}

async function shortenUrl(longUrl) {
  if (!longUrl || typeof longUrl !== "string") return longUrl;
  const bitlyToken = env("BITLY_ACCESS_TOKEN");
  try {
    if (bitlyToken) {
      const res = await fetch("https://api-ssl.bitly.com/v4/shorten", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${bitlyToken}`,
        },
        body: JSON.stringify({ long_url: longUrl }),
      });
      const data = await res.json();
      if (data?.link) return data.link;
      throw new Error(data?.message || "Bitly shorten failed");
    }

    const res = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(longUrl)}`, {
      signal: AbortSignal.timeout(10000),
    });
    const text = (await res.text()).trim();
    if (text && text.startsWith("http")) return text;
    throw new Error("TinyURL invalid response");
  } catch (e) {
    console.warn("Shorten failed, using original URL:", e?.message || e);
    return longUrl;
  }
}

/** Newest-first; skips URLs already in social_state posted_urls (and in-page hash duplicates). */
function pickLatestUnposted(items, state) {
  const requireImg = /^1|true|yes$/i.test(env("SOCIAL_REQUIRE_ARTICLE_IMAGE"));
  const postedSet = getPostedUrlSet(state);
  const skippedSet = getSkippedUrlSet(state);
  const sorted = [...items].sort((a, b) => parseTs(b.ingestedAt || b.publishedAt) - parseTs(a.ingestedAt || a.publishedAt));
  for (const it of sorted) {
    const url = normalizeUrlForDedupe(it.url || it.link || "");
    const imageUrl = normalizeUrl(it.imageUrl || it.image || "");
    if (!url) continue;
    if (requireImg && !imageUrl) continue;
    if (imageUrl && isLowQualityImageUrl(imageUrl)) continue;
    if (postedSet.has(url)) continue;
    const siteKey = postedUrlDedupeKey(buildSiteArticleViewUrl(url));
    if (siteKey && postedSet.has(siteKey)) continue;
    if (skippedSet.has(url)) continue;
    return {
      id: it.id || "",
      title: stripHtml(it.title || "Radiant Waves"),
      url,
      imageUrl: imageUrl || "",
    };
  }
  return null;
}

function logNoCandidatesDiagnostics(items, state) {
  const postedSet = getPostedUrlSet(state);
  let withUrl = 0;
  let withImageField = 0;
  let blockedByPosted = 0;
  for (const it of items) {
    const url = normalizeUrlForDedupe(it.url || it.link || "");
    if (!url) continue;
    withUrl++;
    if (String(it.imageUrl || it.image || "").trim()) withImageField++;
    if (postedSet.has(url)) {
      blockedByPosted++;
      continue;
    }
    const siteKey = postedUrlDedupeKey(buildSiteArticleViewUrl(url));
    if (siteKey && postedSet.has(siteKey)) blockedByPosted++;
  }
  console.error(
    "[social] Diagnostics (feed pool): articles with url=%d, with image field=%d, blocked by posted_urls≈%d",
    withUrl,
    withImageField,
    blockedByPosted
  );
}

async function generateCard(title, articleImageUrl, imageBufferPreloaded = null) {
  const W = 1000;
  const H = 1500;
  const IMAGE_W = 900;
  const IMAGE_H = 560;
  const IMAGE_LEFT = (W - IMAGE_W) / 2;
  const IMAGE_TOP = 100;
  const ACCENT = "#f47429";
  const SECONDARY = "#53a4cd";

  const lines = stripHtml(title).split(/\s+/);
  const wrapped = [];
  let cur = "";
  for (const w of lines) {
    if ((cur + " " + w).trim().length <= 28) cur = (cur + " " + w).trim();
    else {
      if (cur) wrapped.push(cur);
      cur = w;
    }
  }
  if (cur) wrapped.push(cur);
  const headline = wrapped.slice(0, 5);
  const tspans = headline.map((ln, i) => `<tspan x="68" dy="${i === 0 ? 0 : 72}">${ln.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</tspan>`).join("");

  const bgSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#0f1114"/>
  <rect x="0" y="0" width="6" height="${H}" fill="${ACCENT}"/>
  <circle cx="${W + 100}" cy="-120" r="220" fill="${ACCENT}" opacity="0.2"/>
  <circle cx="-80" cy="${H + 80}" r="180" fill="${SECONDARY}" opacity="0.18"/>
  <text x="70" y="65" font-family="Arial, sans-serif" font-size="45" font-weight="650" fill="${ACCENT}">NEWS</text>
  <line x1="48" y1="784" x2="48" y2="900" stroke="${ACCENT}" stroke-width="4"/>
  <text x="68" y="802" font-family="Arial, sans-serif" font-size="60" font-weight="800" fill="#f0f2f5">${tspans}</text>
  <line x1="150" y1="1205" x2="850" y2="1205" stroke="${ACCENT}" stroke-width="7"/>
  <line x1="150" y1="1220" x2="850" y2="1220" stroke="${SECONDARY}" stroke-width="5.5"/>
  <line x1="150" y1="1235" x2="850" y2="1235" stroke="${ACCENT}" stroke-width="7"/>
  <text x="500" y="1394" font-family="Arial, sans-serif" font-size="40" font-weight="600" fill="#f0f2f5" text-anchor="middle">RADIANT WAVES</text>
  <line x1="350" y1="1434" x2="650" y2="1434" stroke="${SECONDARY}" stroke-width="7"/>
</svg>`;
  const bg = await sharp(Buffer.from(bgSvg)).png().toBuffer();

  let image = imageBufferPreloaded;
  if (!image && articleImageUrl) {
    try {
      const res = await fetch(articleImageUrl, {
        signal: AbortSignal.timeout(15000),
        headers: { "User-Agent": BROWSER_UA, Accept: "image/*,*/*;q=0.8" },
        redirect: "follow",
      });
      if (res.ok) image = Buffer.from(await res.arrayBuffer());
    } catch {}
  }
  if (!image) {
    throw new Error("generateCard: missing hero image (expected validated buffer from resolveHeroImageBuffer)");
  }
  let imageBuf;
  try {
    imageBuf = await sharp(image).resize(IMAGE_W, IMAGE_H, { fit: "cover" }).toBuffer();
  } catch (e) {
    throw new Error(`generateCard: could not decode/resize hero image (${e?.message || e})`);
  }

  return sharp(bg).composite([{ input: imageBuf, top: IMAGE_TOP, left: IMAGE_LEFT }]).png().toBuffer();
}

async function postTelegram(title, link, imageBuffer) {
  const token = env("TELEGRAM_BOT_TOKEN");
  const chatId = env("TELEGRAM_CHAT_ID");
  if (!token || !chatId) throw new Error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");

  const text = `${title}\n\n${link}`;
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("caption", text);
  form.append("photo", new Blob([imageBuffer], { type: "image/png" }), "card.png");
  const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: "POST", body: form });
  const body = await res.json();
  if (!body.ok) throw new Error(`Telegram API: ${body.description || res.statusText}`);
  return body;
}

async function getTelegramFileUrl(botToken, sendPhotoBody) {
  const fileId = sendPhotoBody?.result?.photo?.at?.(-1)?.file_id;
  if (!fileId) return "";
  const fileRes = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const fileData = await fileRes.json();
  const filePath = fileData?.result?.file_path;
  return filePath ? `https://api.telegram.org/file/bot${botToken}/${filePath}` : "";
}

/** imgbb: `data.url` is often https://ibb.co/... (HTML viewer). IG must fetch a raw image — use `data.image.url` (i.ibb.co). */
function imgbbDirectImageUrl(apiJson) {
  const d = apiJson?.data;
  if (!d) return "";
  const fromImage = d.image?.url || d.image?.display_url;
  const disp = typeof d.display_url === "string" ? d.display_url : "";
  const top = typeof d.url === "string" ? d.url : "";
  const candidates = [fromImage, disp, top].filter(Boolean);
  for (const c of candidates) {
    if (!/^https:\/\//i.test(c)) continue;
    if (/^https:\/\/i\.ibb\.co\//i.test(c) || /\.(jpe?g|png|webp)(\?|$)/i.test(c)) return c;
  }
  if (fromImage && /^https:\/\//i.test(fromImage)) return fromImage;
  console.warn("[imgbb] No direct i.ibb.co / image URL in response; got:", JSON.stringify({ url: top, display_url: disp }).slice(0, 200));
  return "";
}

async function uploadToImgbb(imageBuffer, apiKey, opts = {}) {
  if (!apiKey || !imageBuffer?.length) return "";
  const name = opts.name || "image.png";
  const mime = opts.mime || "image/png";
  const form = new FormData();
  form.append("key", apiKey);
  form.append("image", new Blob([imageBuffer], { type: mime }), name);
  const res = await fetch("https://api.imgbb.com/1/upload", { method: "POST", body: form });
  const data = await res.json();
  const url = imgbbDirectImageUrl(data);
  if (url) return url;
  console.error("[imgbb] upload did not return a URL. success=%s status=%s body=%s", data?.success, res.status, JSON.stringify(data).slice(0, 800));
  return "";
}

/** IG Stories + FB Stories expect photo/video; 9:16 JPEG is most reliable. */
async function buildStoryJpegFromCard(cardPngBuffer) {
  return sharp(cardPngBuffer)
    .resize(1080, 1920, { fit: "cover", position: "centre" })
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer();
}

/**
 * IG feed Graph API: image aspect ratio must be between 4:5 and 1.91:1 (width/height).
 * Our postcard is ~2:3 — too tall; Meta returns 2207052. Use 4:5 (1080×1350) cover crop + JPEG.
 */
async function buildInstagramFeedJpegFromCard(cardPngBuffer) {
  const W = 1080;
  const H = 1350; // 4:5
  return sharp(cardPngBuffer)
    .resize(W, H, { fit: "cover", position: "centre" })
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();
}

/**
 * User tokens hit /me/feed as the USER → publish_actions errors.
 * Resolve a Page access token: GET /{page-id}?fields=access_token or GET /me/accounts.
 * Page access tokens: GET /me returns the Page — do NOT call /me/accounts (user-only); that breaks IG.
 */
async function ensurePageAccessToken() {
  const raw = env("FB_PAGE_ACCESS_TOKEN");
  if (!raw) return;

  try {
    const probeRes = await fetch(
      `${GRAPH}/me?fields=id,name,fan_count,instagram_business_account,tasks&access_token=${encodeURIComponent(raw)}`
    );
    const probe = await probeRes.json();
    if (!probe.error) {
      const looksLikePage =
        typeof probe.fan_count === "number" ||
        Array.isArray(probe.tasks) ||
        probe.instagram_business_account != null;
      if (looksLikePage && probe.id) {
        process.env.FB_PAGE_ID = String(probe.id);
        if (probe.instagram_business_account?.id) {
          console.log(
            "[facebook] Page access token detected — Page id=%s, instagram_business_account id=%s (skip /me/accounts)",
            probe.id,
            probe.instagram_business_account.id
          );
        } else {
          console.warn(
            "[facebook] Page access token — Page id=%s but no instagram_business_account. Link IG in Meta Business Suite (Page → settings).",
            probe.id
          );
        }
        return;
      }
    } else {
      console.warn("[facebook] GET /me (token probe):", probe.error.message);
    }
  } catch (e) {
    console.warn("[facebook] Page token probe failed:", e?.message || e);
  }

  let pageId = env("FB_PAGE_ID", "me").trim();

  if (!pageId || pageId === "me") {
    const res = await fetch(
      `${GRAPH}/me/accounts?fields=access_token,id,name&limit=25&access_token=${encodeURIComponent(raw)}`
    );
    const data = await res.json();
    if (data.error) {
      console.warn("[facebook] /me/accounts failed:", data.error.message);
      return;
    }
    const pages = data.data || [];
    if (pages.length === 0) {
      console.warn("[facebook] No Pages returned. Grant pages_show_list and connect a Facebook Page.");
      return;
    }
    if (pages.length > 1) {
      console.warn(
        "[facebook] Multiple Pages — set FB_PAGE_ID in secrets to the numeric id you want. Found:",
        pages.map((p) => `${p.name} (${p.id})`).join(" | ")
      );
      return;
    }
    process.env.FB_PAGE_ID = String(pages[0].id);
    process.env.FB_PAGE_ACCESS_TOKEN = pages[0].access_token;
    console.log("[facebook] Single Page linked — using:", pages[0].name, "id", pages[0].id);
    return;
  }

  const direct = await fetch(
    `${GRAPH}/${encodeURIComponent(pageId)}?fields=access_token&access_token=${encodeURIComponent(raw)}`
  );
  const d1 = await direct.json();
  if (!d1.error && d1.access_token) {
    if (d1.access_token !== raw) {
      console.log("[facebook] Resolved Page access token via GET /{page-id}?fields=access_token");
    }
    process.env.FB_PAGE_ACCESS_TOKEN = d1.access_token;
    return;
  }

  const res2 = await fetch(
    `${GRAPH}/me/accounts?fields=access_token,id,name&limit=25&access_token=${encodeURIComponent(raw)}`
  );
  const data2 = await res2.json();
  const match = data2.data?.find((p) => String(p.id) === String(pageId));
  if (match?.access_token) {
    process.env.FB_PAGE_ACCESS_TOKEN = match.access_token;
    console.log("[facebook] Matched Page token from /me/accounts for:", match.name, match.id);
    return;
  }

  if (d1.error) console.warn("[facebook] Page token resolve failed:", d1.error.message);
}

/** Log who the token is (Page vs user) — helps fix "must post as page itself". */
async function logFacebookTokenIdentity(token) {
  try {
    const res = await fetch(`${GRAPH}/me?fields=id,name,category&access_token=${encodeURIComponent(token)}`);
    const d = await res.json();
    if (d.error) {
      console.warn("[facebook] Could not read token /me:", d.error.message);
      return;
    }
    console.log("[facebook] access token /me:", { id: d.id, name: d.name, category: d.category || "(none)" });
    console.log(
      "[facebook] Tip: use a Page access token + numeric FB_PAGE_ID. User tokens cause publish_actions / 'as the page itself' errors."
    );
  } catch (e) {
    console.warn("[facebook] Token check failed:", e?.message || e);
  }
}

function igPublicImageUrl(imageUrl) {
  if (!imageUrl || typeof imageUrl !== "string") return "";
  const s = imageUrl.trim();
  if (s.startsWith("http://")) return `https://${s.slice("http://".length)}`;
  return s;
}

function igDebugEnabled() {
  return /^1|true|yes$/i.test(env("SOCIAL_DEBUG_IG"));
}

/** Meta Graph `error` objects — log these for support / Graph API Explorer. */
function formatMetaApiError(err) {
  if (!err || typeof err !== "object") return String(err);
  try {
    return JSON.stringify({
      message: err.message,
      type: err.type,
      code: err.code,
      error_subcode: err.error_subcode,
      error_user_title: err.error_user_title,
      error_user_msg: err.error_user_msg,
      fbtrace_id: err.fbtrace_id,
      is_transient: err.is_transient,
    });
  } catch {
    return String(err);
  }
}

/** Log why IG may be skipped + probe Page ↔ IG link (SOCIAL_DEBUG_IG=1). */
async function logInstagramTroubleshoot(imageUrlForIg, fbToken) {
  const wantIg = envSocialEnabled("POST_TO_INSTAGRAM");
  let imageHost = "";
  try {
    if (imageUrlForIg) imageHost = new URL(igPublicImageUrl(imageUrlForIg)).hostname;
  } catch {}
  console.log("[IG troubleshoot] gate:", {
    scriptRev: SOCIAL_POST_SCRIPT_REV,
    POST_TO_INSTAGRAM: env("POST_TO_INSTAGRAM") || "(unset → default on)",
    wantIg,
    hasFbPageToken: !!fbToken,
    hasPublicImageUrl: !!String(imageUrlForIg || "").trim(),
    imageUrlHost: imageHost || "(none)",
    IMGBB_API_KEY: env("IMGBB_API_KEY") ? "set" : "MISSING — add repo secret for hosted image URL",
    IG_USER_ID: env("IG_USER_ID") || "(unset — resolved from Page)",
    FB_PAGE_ID: env("FB_PAGE_ID") || "(unset — use numeric Page id)",
  });

  if (!wantIg) {
    console.warn("[IG troubleshoot] Skipped: POST_TO_INSTAGRAM is off (set var to 1 or unset).");
    return;
  }
  if (!fbToken) {
    console.warn("[IG troubleshoot] Skipped: FB_PAGE_ACCESS_TOKEN missing — IG uses the same Page token.");
    return;
  }
  if (!String(imageUrlForIg || "").trim()) {
    console.warn(
      "[IG troubleshoot] Skipped: no public image URL — add IMGBB_API_KEY secret, or fix Telegram sendPhoto → getFile."
    );
    return;
  }

  if (igDebugEnabled()) {
    const pageId = env("FB_PAGE_ID", "me");
    try {
      const res = await fetch(
        `${GRAPH}/${encodeURIComponent(pageId)}?fields=id,name,instagram_business_account&access_token=${encodeURIComponent(fbToken)}`
      );
      const data = await res.json();
      console.log("[IG troubleshoot] GET /{page-id}?fields=instagram_business_account →", JSON.stringify(data));
      const igAcct = data.instagram_business_account;
      if (!igAcct?.id) {
        console.error(
          "[IG troubleshoot] No instagram_business_account on this Page. In Meta Business Suite: connect this Facebook Page to an Instagram Business/Creator account."
        );
      }
    } catch (e) {
      console.error("[IG troubleshoot] Page probe failed:", e?.message || e);
    }
    try {
      const probe = await fetch(igPublicImageUrl(imageUrlForIg), {
        method: "HEAD",
        signal: AbortSignal.timeout(15000),
        redirect: "follow",
        headers: { "User-Agent": BROWSER_UA },
      });
      console.log("[IG troubleshoot] HEAD image URL → HTTP", probe.status, probe.headers.get("content-type") || "");
    } catch (e) {
      console.error("[IG troubleshoot] Image URL not reachable from runner:", e?.message || e);
    }
  }
}

async function postInstagram(caption, imageUrl) {
  const token = env("FB_PAGE_ACCESS_TOKEN");
  const pageId = env("FB_PAGE_ID", "me");
  const igUserIdFromEnv = env("IG_USER_ID");
  const imageUrlHttps = igPublicImageUrl(imageUrl);
  if (!token || !imageUrlHttps) return null;
  if (!/^https:\/\//i.test(imageUrlHttps)) throw new Error("Instagram requires a public https:// image_url");

  const graph = GRAPH;
  let igUserId = igUserIdFromEnv;
  if (!igUserId) {
    const pageRes = await fetch(`${graph}/${encodeURIComponent(pageId)}?fields=instagram_business_account&access_token=${encodeURIComponent(token)}`);
    const pageData = await pageRes.json();
    if (pageData.error) throw new Error(pageData.error.message || "IG page lookup failed");
    igUserId = pageData.instagram_business_account?.id || "";
  }
  if (!igUserId) throw new Error("No Instagram Business account linked.");

  const createParams = new URLSearchParams({
    image_url: imageUrlHttps,
    caption: caption.slice(0, 2200),
    access_token: token,
  });
  const createRes = await fetch(`${graph}/${igUserId}/media`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: createParams });
  const createData = await createRes.json();
  if (createData.error) {
    console.error("[IG] POST /media failed:", formatMetaApiError(createData.error));
    const er = createData.error;
    throw new Error(
      er.message || "Instagram media create failed" + (er.code != null ? ` [${er.code}]` : "") + (er.error_subcode != null ? ` sub=${er.error_subcode}` : "")
    );
  }
  console.log("[IG] media container created id=%s (ig_user_id=%s)", createData.id, igUserId);

  const creationId = createData.id;
  await waitForIgMediaContainer(creationId, token, "Instagram feed");

  for (let attempt = 1; attempt <= 4; attempt++) {
    const pubParams = new URLSearchParams({ creation_id: creationId, access_token: token });
    const pubRes = await fetch(`${graph}/${igUserId}/media_publish`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: pubParams,
    });
    const pubData = await pubRes.json();
    if (!pubData.error) return pubData;

    const msg = pubData.error?.message || "Instagram publish failed";
    if (!msg.includes("Media ID is not available") && !msg.includes("not ready")) {
      console.error("[IG] POST /media_publish failed:", formatMetaApiError(pubData.error));
    }
    const retryable = msg.includes("Media ID is not available") || msg.includes("not ready");
    if (!retryable || attempt === 4) {
      const er = pubData.error;
      throw new Error(msg + (er?.code != null ? ` [${er.code}]` : ""));
    }
    await new Promise((resolve) => setTimeout(resolve, 4000 * attempt));
  }
  throw new Error("Instagram publish failed");
}

async function resolveIgUserId(token, pageId) {
  const igUserIdFromEnv = env("IG_USER_ID");
  if (igUserIdFromEnv) return igUserIdFromEnv;
  const pageRes = await fetch(
    `${GRAPH}/${encodeURIComponent(pageId)}?fields=instagram_business_account&access_token=${encodeURIComponent(token)}`
  );
  const pageData = await pageRes.json();
  if (pageData.error) throw new Error(pageData.error.message || "IG page lookup failed");
  const id = pageData.instagram_business_account?.id || "";
  if (!id) throw new Error("No Instagram Business account linked.");
  return id;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Wait until IG container is ready (feed + stories). Meta may take 10–40s to process image_url. */
async function waitForIgMediaContainer(containerId, token, label = "IG") {
  for (let i = 0; i < 24; i++) {
    const res = await fetch(
      `${GRAPH}/${encodeURIComponent(containerId)}?fields=status_code,status&access_token=${encodeURIComponent(token)}`
    );
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || `${label} container status failed`);
    const code = data.status_code || data.status;
    if (code === "FINISHED" || code === "PUBLISHED") return;
    if (code === "ERROR") throw new Error(`${label} container failed`);
    if (i === 0 || i % 4 === 3) console.log(`[${label}] container ${containerId} status=${code || "…"} (poll ${i + 1}/24)`);
    await sleep(2500);
  }
  console.warn(`[${label}] container still not FINISHED after ~60s — trying media_publish anyway.`);
}

async function verifyHttpsImageUrlForInstagram(imageUrl) {
  const u = igPublicImageUrl(imageUrl);
  if (!u || !/^https:\/\//i.test(u)) {
    throw new Error("Instagram Stories require a public HTTPS image_url");
  }
  const res = await fetch(u, {
    method: "GET",
    signal: AbortSignal.timeout(20000),
    redirect: "follow",
    headers: { "User-Agent": BROWSER_UA, Accept: "image/*,*/*;q=0.8" },
  });
  if (!res.ok) throw new Error(`Story image_url returned HTTP ${res.status}`);
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  const buf = Buffer.from(await res.arrayBuffer());
  const isJpeg = buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const isPng = buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50;
  const looksImage = isJpeg || isPng || ct.startsWith("image/");
  if (!looksImage && !(ct.includes("octet-stream") && (isJpeg || isPng))) {
    throw new Error(`Story image_url must be an image (got Content-Type: ${ct || "unknown"})`);
  }
}

async function postInstagramStory(imageUrl) {
  const token = env("FB_PAGE_ACCESS_TOKEN");
  const pageId = env("FB_PAGE_ID", "me");
  if (!token || !imageUrl) return null;
  const urlHttps = igPublicImageUrl(imageUrl);
  await verifyHttpsImageUrlForInstagram(urlHttps);
  const igUserId = await resolveIgUserId(token, pageId);

  const createParams = new URLSearchParams({
    image_url: urlHttps,
    media_type: "STORIES",
    access_token: token,
  });
  const createRes = await fetch(`${GRAPH}/${igUserId}/media`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: createParams,
  });
  const createData = await createRes.json();
  if (createData.error) {
    console.error("[IG Story] POST /media failed:", formatMetaApiError(createData.error));
    const err = createData.error;
    throw new Error(
      err.message || "Instagram story media create failed" + (err.code ? ` (code ${err.code})` : "")
    );
  }

  const creationId = createData.id;
  await waitForIgMediaContainer(creationId, token, "Instagram Story");

  for (let attempt = 1; attempt <= 4; attempt++) {
    const pubParams = new URLSearchParams({ creation_id: creationId, access_token: token });
    const pubRes = await fetch(`${GRAPH}/${igUserId}/media_publish`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: pubParams,
    });
    const pubData = await pubRes.json();
    if (!pubData.error) return pubData;

    const msg = pubData.error?.message || "Instagram story publish failed";
    const retryable = msg.includes("Media ID is not available") || msg.includes("not ready");
    if (!retryable || attempt === 4) throw new Error(msg);
    await sleep(4000 * attempt);
  }
  throw new Error("Instagram story publish failed");
}

function appendPngUpload(form, fieldName, buffer, filename) {
  if (typeof File !== "undefined") {
    form.append(fieldName, new File([buffer], filename, { type: "image/png" }));
  } else {
    form.append(fieldName, new Blob([buffer], { type: "image/png" }), filename);
  }
}

async function postToFacebook(caption, link, imageBuffer) {
  const token = env("FB_PAGE_ACCESS_TOKEN");
  const pageId = env("FB_PAGE_ID", "me");
  if (!token || !imageBuffer?.length) return null;
  const message = link ? `${caption}\n\n${link}` : caption;

  const form = new FormData();
  form.append("message", message);
  form.append("published", "true");
  appendPngUpload(form, "source", imageBuffer, "card.png");
  form.append("access_token", token);
  const res = await fetch(`${GRAPH}/${encodeURIComponent(pageId)}/photos`, {
    method: "POST",
    body: form,
  });
  const data = await res.json();
  if (data.error) {
    const msg = data.error.message || "Facebook post failed";
    if (String(msg).includes("(#200)") || String(msg).toLowerCase().includes("permission"))
      console.error(
        "[facebook] Token may lack Page publishing. Re-generate a Page token with pages_manage_posts + pages_read_engagement."
      );
    throw new Error(msg);
  }
  return data;
}

/** Link preview uses your site's og:image (often the logo). Prefer postToFacebook (photo) instead. */
async function postFacebookFeedLink(caption, link) {
  const token = env("FB_PAGE_ACCESS_TOKEN");
  const pageId = env("FB_PAGE_ID", "me");
  if (!token || !link) return null;
  const params = new URLSearchParams({
    message: `${caption}\n\n${link}`.slice(0, 5000),
    link,
    access_token: token,
  });
  const res = await fetch(`${GRAPH}/${encodeURIComponent(pageId)}/feed`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });
  const data = await res.json();
  if (data.error) {
    const msg = data.error.message || "Facebook feed post failed";
    if (String(msg).includes("publish_actions")) {
      console.error(
        "[facebook] /feed failed: use Graph API Explorer → Get Page Access Token for your Page, put it in FB_PAGE_ACCESS_TOKEN, and set FB_PAGE_ID to the numeric Page id."
      );
    }
    throw new Error(msg);
  }
  return data;
}

/** Message + URL in text only — no `link` param, so FB won't scrape og:image (logo). */
async function postFacebookFeedTextOnly(caption, link) {
  const token = env("FB_PAGE_ACCESS_TOKEN");
  const pageId = env("FB_PAGE_ID", "me");
  if (!token || !link) return null;
  const params = new URLSearchParams({
    message: `${caption}\n\n${link}`.slice(0, 5000),
    access_token: token,
  });
  const res = await fetch(`${GRAPH}/${encodeURIComponent(pageId)}/feed`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "Facebook feed text post failed");
  return data;
}

async function postFacebookStory(imageBuffer) {
  const token = env("FB_PAGE_ACCESS_TOKEN");
  const pageId = env("FB_PAGE_ID", "me");
  if (!token || !imageBuffer?.length) return null;

  const form = new FormData();
  appendPngUpload(form, "source", imageBuffer, "story.png");
  form.append("published", "false");
  form.append("access_token", token);
  const uploadRes = await fetch(`${GRAPH}/${encodeURIComponent(pageId)}/photos`, {
    method: "POST",
    body: form,
  });
  const uploadData = await uploadRes.json();
  if (uploadData.error) throw new Error(uploadData.error.message || "Facebook story upload failed");

  const photoId = uploadData.id;
  if (!photoId) throw new Error("No photo id from Facebook upload");

  const storyParams = new URLSearchParams({
    photo_id: photoId,
    access_token: token,
  });
  // Meta Page photo stories edge (not /stories)
  const storyRes = await fetch(`${GRAPH}/${encodeURIComponent(pageId)}/photo_stories`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: storyParams,
  });
  const storyData = await storyRes.json();
  if (storyData.error) {
    const msg = storyData.error.message || "Facebook story publish failed";
    if (String(msg).includes("(#200)") || String(msg).toLowerCase().includes("permission"))
      console.error(
        "[facebook story] Needs Page story permission + publish. Check Meta app (pages_manage_posts) and Page Stories API access."
      );
    throw new Error(msg);
  }
  return storyData;
}

/** When multipart upload fails, Meta can still fetch a public HTTPS image URL (e.g. imgbb). */
async function postFacebookStoryFromPublicUrl(imageUrl) {
  const token = env("FB_PAGE_ACCESS_TOKEN");
  const pageId = env("FB_PAGE_ID", "me");
  if (!token || !imageUrl) return null;
  const uploadParams = new URLSearchParams({
    url: imageUrl,
    published: "false",
    access_token: token,
  });
  const uploadRes = await fetch(`${GRAPH}/${encodeURIComponent(pageId)}/photos`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: uploadParams,
  });
  const uploadData = await uploadRes.json();
  if (uploadData.error) throw new Error(uploadData.error.message || "Facebook story upload (url) failed");
  const photoId = uploadData.id;
  if (!photoId) throw new Error("No photo id from Facebook URL upload");

  const storyParams = new URLSearchParams({
    photo_id: photoId,
    access_token: token,
  });
  const storyRes = await fetch(`${GRAPH}/${encodeURIComponent(pageId)}/photo_stories`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: storyParams,
  });
  const storyData = await storyRes.json();
  if (storyData.error) throw new Error(storyData.error.message || "Facebook story publish (url) failed");
  return storyData;
}

/**
 * Telegram + Facebook Page feed must succeed when POST_TO_FACEBOOK is on (default).
 * IG / Stories: best-effort (logged). Writes social_state.json only after TG + FB pass.
 */
async function performSocialPost(art, imageBufferValidated, state, targetFeed) {
  console.log("[social] posting feed=%s — %s", targetFeed, art.title.slice(0, 80));
  console.log("[social] POST_TO_* env (empty = default on):", {
    POST_TO_FACEBOOK: env("POST_TO_FACEBOOK") || "(unset)",
    POST_TO_FACEBOOK_STORY: env("POST_TO_FACEBOOK_STORY") || "(unset)",
    POST_TO_INSTAGRAM: env("POST_TO_INSTAGRAM") || "(unset)",
    POST_TO_IG_STORY: env("POST_TO_IG_STORY") || "(unset)",
  });
  const longSiteLink = buildSiteArticleViewUrl(art.url);
  const sourceArticleLink = normalizeUrl(art.url) || art.url;
  /** Default: full source article URL (no shortener). Set SOCIAL_USE_SITE_ARTICLE_LINK=1 for Radiant reader link. SHORTEN_LINK=1 still applies to whichever is chosen. */
  let postLink = /^1|true|yes$/i.test(env("SOCIAL_USE_SITE_ARTICLE_LINK")) ? longSiteLink : sourceArticleLink;
  if (env("SHORTEN_LINK") === "1" || env("SHORTEN_LINK").toLowerCase() === "true") {
    postLink = await shortenUrl(postLink);
  }

  const card = await generateCard(art.title, art.imageUrl, imageBufferValidated);
  const tg = await postTelegram(art.title, postLink, card);
  console.log("Posted to Telegram.");

  let imageUrlForIg = "";
  const imgbbKeyForSocial = env("IMGBB_API_KEY");
  if (imgbbKeyForSocial) {
    try {
      const igFeedJpeg = await buildInstagramFeedJpegFromCard(card);
      let hosted = await uploadToImgbb(igFeedJpeg, imgbbKeyForSocial, { name: "ig-feed-4x5.jpg", mime: "image/jpeg" });
      if (!hosted) {
        hosted = await uploadToImgbb(card, imgbbKeyForSocial, { name: "rw-card-fallback.png", mime: "image/png" });
      }
      if (hosted) {
        imageUrlForIg = hosted;
        console.log("[social] Public image URL for Instagram feed (4:5 JPEG via imgbb):", hosted.slice(0, 72) + "…");
      }
    } catch (e) {
      console.warn("[social] imgbb upload for IG feed failed:", e?.message || e);
    }
  }
  if (!imageUrlForIg) {
    try {
      imageUrlForIg = await getTelegramFileUrl(env("TELEGRAM_BOT_TOKEN"), tg);
      if (imageUrlForIg) console.log("[social] Using Telegram file URL for Instagram.");
    } catch {}
  }
  if (!imageUrlForIg) {
    console.warn(
      "[social] No public HTTPS image URL for Instagram — set IMGBB_API_KEY secret, or check Telegram getFile."
    );
  }

  await ensurePageAccessToken();
  const fbToken = env("FB_PAGE_ACCESS_TOKEN");
  if (fbToken) {
    await logFacebookTokenIdentity(fbToken);
  }
  await logInstagramTroubleshoot(imageUrlForIg, fbToken);

  const wantFbFeed = envSocialEnabled("POST_TO_FACEBOOK");
  if (wantFbFeed && !fbToken) {
    throw new Error("POST_TO_FACEBOOK is enabled but FB_PAGE_ACCESS_TOKEN (or Page token) is missing");
  }

  // Facebook feed: photo = postcard; fallbacks until one returns an id (required when wantFbFeed).
  let fbFeedOk = false;
  if (wantFbFeed && fbToken) {
    console.log("[social] Facebook Page feed (postcard photo)…");
    try {
      const fb = await postToFacebook(art.title, postLink, card);
      if (fb?.id) {
        console.log("Posted to Facebook (photo / postcard). Post id:", fb.id);
        fbFeedOk = true;
      }
    } catch (e) {
      console.error("Facebook photo error:", e?.message || e);
    }
    if (!fbFeedOk) {
      try {
        const fb2 = await postFacebookFeedTextOnly(art.title, postLink);
        if (fb2?.id) {
          console.log("Posted to Facebook (text + URL, no link preview). Post id:", fb2.id);
          fbFeedOk = true;
        }
      } catch (e2) {
        console.error("Facebook text fallback error:", e2?.message || e2);
      }
    }
    if (!fbFeedOk && env("POST_TO_FACEBOOK_LINK_PREVIEW") === "1") {
      try {
        const fb3 = await postFacebookFeedLink(art.title, postLink);
        if (fb3?.id) {
          console.log("Posted to Facebook (link preview — may show site logo). Post id:", fb3.id);
          fbFeedOk = true;
        }
      } catch (e3) {
        console.error("Facebook link-preview error:", e3?.message || e3);
      }
    }
    if (!fbFeedOk) {
      console.error(
        "[social] Facebook Page feed failed — continuing with Instagram / stories (fix FB or set POST_TO_FACEBOOK=0 to skip FB only)."
      );
    }
  }

  // FB Story: prefer public JPEG URL (Page token + imgbb); multipart unpublished needs true Page token.
  if (envSocialEnabled("POST_TO_FACEBOOK_STORY") && fbToken) {
    console.log("[social] Facebook Page story…");
    const imgbbKey = env("IMGBB_API_KEY");
    let fbStoryOk = false;
    if (imgbbKey) {
      try {
        const jpg = await buildStoryJpegFromCard(card);
        const hosted = await uploadToImgbb(jpg, imgbbKey, { name: "fb-story.jpg", mime: "image/jpeg" });
        if (hosted) {
          const fbs = await postFacebookStoryFromPublicUrl(hosted);
          if (fbs?.id || fbs?.post_id) {
            console.log("Posted to Facebook Story (JPEG URL).");
            fbStoryOk = true;
          }
        }
      } catch (e) {
        console.error("Facebook Story (JPEG URL) error:", e?.message || e);
      }
    }
    if (!fbStoryOk) {
      try {
        const fbs2 = await postFacebookStory(card);
        if (fbs2?.id || fbs2?.post_id) console.log("Posted to Facebook Story (multipart).");
      } catch (e) {
        console.error("Facebook Story error:", e?.message || e);
        if (imgbbKey) {
          try {
            const hosted = await uploadToImgbb(card, imgbbKey);
            if (hosted) {
              const fbs3 = await postFacebookStoryFromPublicUrl(hosted);
              if (fbs3?.id || fbs3?.post_id) console.log("Posted to Facebook Story (PNG URL fallback).");
            }
          } catch (e2) {
            console.error("Facebook Story PNG URL fallback:", e2?.message || e2);
          }
        }
      }
    }
  }

  if (envSocialEnabled("POST_TO_INSTAGRAM") && fbToken && imageUrlForIg) {
    try {
      const ig = await postInstagram(`${art.title}\n\n${postLink}`, imageUrlForIg);
      if (ig?.id) console.log("Posted to Instagram. Media id:", ig.id);
    } catch (e) {
      const firstErr = e?.message || String(e);
      if (firstErr.includes("Only photo or video can be accepted as media type")) {
        try {
          const imgbbKey = env("IMGBB_API_KEY");
          if (!imgbbKey) throw new Error("IMGBB_API_KEY missing");
          const tgImgRes = await fetch(imageUrlForIg, { signal: AbortSignal.timeout(15000) });
          if (!tgImgRes.ok) throw new Error("Failed to download Telegram image for imgbb");
          const buf = Buffer.from(await tgImgRes.arrayBuffer());
          const igJpeg = await sharp(buf)
            .resize(1080, 1350, { fit: "cover", position: "centre" })
            .jpeg({ quality: 90, mozjpeg: true })
            .toBuffer();
          const hosted = await uploadToImgbb(igJpeg, imgbbKey, { name: "ig-tg-4x5.jpg", mime: "image/jpeg" });
          if (!hosted) throw new Error("imgbb upload failed");
          const ig2 = await postInstagram(`${art.title}\n\n${postLink}`, hosted);
          if (ig2?.id) console.log("Posted to Instagram (imgbb fallback). Media id:", ig2.id);
        } catch (e2) {
          console.error("Instagram error:", e2?.message || e2);
        }
      } else {
        console.error("Instagram error:", firstErr);
        if (igDebugEnabled()) console.error("Instagram error stack:", e?.stack);
      }
    }
  } else if (!envSocialEnabled("POST_TO_INSTAGRAM")) {
    console.warn("[social] Instagram feed skipped: POST_TO_INSTAGRAM is disabled.");
  } else if (!fbToken) {
    console.warn("[social] Instagram feed skipped: no FB_PAGE_ACCESS_TOKEN.");
  } else if (!imageUrlForIg) {
    console.warn("[social] Instagram feed skipped: no image URL (IMGBB_API_KEY or Telegram file URL).");
  }

  if (envSocialEnabled("POST_TO_IG_STORY") && fbToken) {
    console.log("[social] Instagram Story (1080×1920 JPEG via imgbb when set)…");
    const imgbbKey = env("IMGBB_API_KEY");
    try {
      if (imgbbKey) {
        const jpg = await buildStoryJpegFromCard(card);
        const hosted = await uploadToImgbb(jpg, imgbbKey, { name: "ig-story.jpg", mime: "image/jpeg" });
        if (!hosted) throw new Error("imgbb upload failed");
        const igs = await postInstagramStory(hosted);
        if (igs?.id) console.log("Posted to Instagram Story. Media id:", igs.id);
      } else if (imageUrlForIg) {
        console.warn("[IG Story] No IMGBB_API_KEY — trying Telegram URL (often fails for STORIES).");
        const igs = await postInstagramStory(imageUrlForIg);
        if (igs?.id) console.log("Posted to Instagram Story. Media id:", igs.id);
      } else {
        console.warn("[IG Story] Skipped: set IMGBB_API_KEY for reliable Stories, or ensure Telegram image URL exists.");
      }
    } catch (e) {
      console.error("Instagram Story error:", e?.message || e);
    }
  }

  if (wantFbFeed && fbToken && !fbFeedOk) {
    throw new Error(
      "Facebook Page feed post failed (photo + text fallbacks" +
        (env("POST_TO_FACEBOOK_LINK_PREVIEW") === "1" ? " + link preview" : "") +
        "). Enable POST_TO_FACEBOOK_LINK_PREVIEW=1 for a last-resort /feed post, set POST_TO_FACEBOOK=0 to allow IG-only success, or fix Page token permissions."
    );
  }

  const postedKey = normalizeUrlForDedupe(art.url);
  const postLinkKey = normalizeUrlForDedupe(postLink);
  const longSiteLinkKey = postedUrlDedupeKey(longSiteLink);
  const prevPosted = Array.isArray(state?.posted_urls) ? state.posted_urls : [];
  const mergedPosted = [postedKey, postLinkKey, longSiteLinkKey, ...prevPosted.map((u) => postedUrlDedupeKey(u))]
    .filter((u, i, a) => u && a.indexOf(u) === i)
    .slice(0, 5000);

  writeState({
    ...state,
    last_posted_url: postedKey,
    last_posted_title: art.title,
    last_posted_feed: targetFeed,
    posted_urls: mergedPosted,
    skipped_urls: [],
    updated_at: new Date().toISOString(),
  });
  console.log("Updated social_state.json");
}

async function main() {
  console.log(
    "[social] script rev=%s | repo=%s | sha=%s",
    SOCIAL_POST_SCRIPT_REV,
    env("GITHUB_REPOSITORY") || "(local)",
    env("GITHUB_SHA") ? env("GITHUB_SHA").slice(0, 7) : "(local)"
  );
  const targetFeed = resolveTargetFeed();
  let items = await loadSnapshotItems();
  items = filterItemsByFeed(items, targetFeed);

  if (!items.length) {
    console.error(
      "[social] FAILED: no snapshot items for feed=%s (check ingest + snapshots/feeds/%s.json.gz).",
      targetFeed,
      targetFeed
    );
    process.exit(1);
  }

  const state = readState();
  // Stale skipped_urls from older runs blocked every candidate; skips only apply within this run.
  state.skipped_urls = [];
  const withImg = items.filter((it) => String(it.imageUrl || it.image || "").trim()).length;
  console.log(
    "[social] feed=%s | pool=%d items (%d with imageUrl) | %d posted URLs | UTC hour=%d (rotation: politics=h%%3===0, football=1, celebrity=2)",
    targetFeed,
    items.length,
    withImg,
    getPostedUrlSet(state).size,
    new Date().getUTCHours()
  );

  const maxAttempts = 200;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const art = pickLatestUnposted(items, state);
    if (!art) {
      logNoCandidatesDiagnostics(items, state);
      console.error(
        "[social] FAILED: no unposted candidates for feed=%s (all posted, or none pass URL filters%s).",
        targetFeed,
        /^1|true|yes$/i.test(env("SOCIAL_REQUIRE_ARTICLE_IMAGE")) ? " / require image" : ""
      );
      process.exit(1);
    }

    const heroBuf = await resolveHeroImageBuffer(art);
    if (!heroBuf) {
      console.warn("[social] No usable hero image (snapshot + page OG), trying next article… (%s)", art.url.slice(0, 80));
      prependSkippedUrl(state, art.url);
      continue;
    }

    try {
      await performSocialPost(art, heroBuf, state, targetFeed);
      console.log("[social] SUCCESS: posted at least to Telegram (feed=%s).", targetFeed);
      process.exit(0);
    } catch (e) {
      console.error("[social] Post failed, trying next article:", e?.message || e);
      prependSkippedUrl(state, art.url);
    }
  }

  console.error("[social] FAILED: exhausted %d attempts without a successful post.", maxAttempts);
  process.exit(1);
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});

