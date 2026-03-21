import fs from "fs";
import path from "path";
import zlib from "zlib";
import sharp from "sharp";

const SNAPSHOT_LOCAL = path.join(process.cwd(), "snapshots", "latest.json.gz");
const STATE_PATH = path.join(process.cwd(), "social_state.json");

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
  const cleaned = arr.filter((u) => typeof u === "string" && /^https?:\/\//i.test(u));
  return new Set(cleaned);
}

function getSkippedUrlSet(state) {
  const arr = Array.isArray(state?.skipped_urls) ? state.skipped_urls : [];
  const cleaned = arr.filter((u) => typeof u === "string" && /^https?:\/\//i.test(u));
  return new Set(cleaned);
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

async function fetchValidatedImageBuffer(imageUrl) {
  if (!imageUrl || isLowQualityImageUrl(imageUrl)) return null;
  try {
    const res = await fetch(imageUrl, {
      signal: AbortSignal.timeout(15000),
      headers: { "User-Agent": "RadiantWaves/1.0 (Social Bot)" },
      redirect: "follow",
    });
    if (!res.ok) return null;
    const ct = String(res.headers.get("content-type") || "").toLowerCase();
    if (!ct.startsWith("image/")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf?.length || buf.length < 15000) return null;
    const meta = await sharp(buf).metadata();
    const w = Number(meta.width || 0);
    const h = Number(meta.height || 0);
    if (w < 600 || h < 315) return null;
    const ar = w / Math.max(1, h);
    if (ar < 0.6 || ar > 2.5) return null;
    return buf;
  } catch {
    return null;
  }
}

async function loadSnapshotItems() {
  const snapshotUrl = env("SNAPSHOT_URL");

  if (snapshotUrl) {
    const res = await fetch(snapshotUrl, { headers: { "User-Agent": "RadiantWaves/1.0" } });
    if (!res.ok) throw new Error(`SNAPSHOT_URL fetch failed: ${res.status}`);
    const gz = Buffer.from(await res.arrayBuffer());
    const raw = zlib.gunzipSync(gz).toString("utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data?.items) ? data.items : [];
  }

  if (!fs.existsSync(SNAPSHOT_LOCAL)) {
    throw new Error("No snapshot source found. Set SNAPSHOT_URL or commit snapshots/latest.json.gz.");
  }
  const gz = fs.readFileSync(SNAPSHOT_LOCAL);
  const raw = zlib.gunzipSync(gz).toString("utf8");
  const data = JSON.parse(raw);
  return Array.isArray(data?.items) ? data.items : [];
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

function pickLatestUnposted(items, state) {
  const postedSet = getPostedUrlSet(state);
  const skippedSet = getSkippedUrlSet(state);
  const sorted = [...items].sort((a, b) => parseTs(b.ingestedAt || b.publishedAt) - parseTs(a.ingestedAt || a.publishedAt));
  for (const it of sorted) {
    const url = normalizeUrlForDedupe(it.url || it.link || "");
    const imageUrl = normalizeUrl(it.imageUrl || it.image || "");
    if (!url) continue;
    if (!imageUrl) continue;
    if (isLowQualityImageUrl(imageUrl)) continue;
    if (postedSet.has(url)) continue;
    const siteArticleView = normalizeUrlForDedupe(buildSiteArticleViewUrl(url));
    if (siteArticleView && postedSet.has(siteArticleView)) continue;
    if (skippedSet.has(url)) continue;
    return {
      id: it.id || "",
      title: stripHtml(it.title || "Radiant Waves"),
      url,
      imageUrl,
    };
  }
  return null;
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
      const res = await fetch(articleImageUrl, { signal: AbortSignal.timeout(15000) });
      if (res.ok) image = Buffer.from(await res.arrayBuffer());
    } catch {}
  }
  const imageBuf = image
    ? await sharp(image).resize(IMAGE_W, IMAGE_H, { fit: "cover" }).toBuffer()
    : await sharp({
        create: { width: IMAGE_W, height: IMAGE_H, channels: 3, background: "#161a1f" },
      }).png().toBuffer();

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

async function uploadToImgbb(imageBuffer, apiKey, opts = {}) {
  if (!apiKey || !imageBuffer?.length) return "";
  const name = opts.name || "image.png";
  const mime = opts.mime || "image/png";
  const form = new FormData();
  form.append("key", apiKey);
  form.append("image", new Blob([imageBuffer], { type: mime }), name);
  const res = await fetch("https://api.imgbb.com/1/upload", { method: "POST", body: form });
  const data = await res.json();
  const url = data?.data?.image?.url ?? data?.data?.url;
  return url && url.startsWith("http") ? url : "";
}

/** IG Stories + FB Stories expect photo/video; 9:16 JPEG is most reliable. */
async function buildStoryJpegFromCard(cardPngBuffer) {
  return sharp(cardPngBuffer)
    .resize(1080, 1920, { fit: "cover", position: "centre" })
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer();
}

/**
 * User tokens hit /me/feed as the USER → publish_actions errors.
 * Resolve a Page access token: GET /{page-id}?fields=access_token or GET /me/accounts.
 */
async function ensurePageAccessToken() {
  const raw = env("FB_PAGE_ACCESS_TOKEN");
  if (!raw) return;

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

async function postInstagram(caption, imageUrl) {
  const token = env("FB_PAGE_ACCESS_TOKEN");
  const pageId = env("FB_PAGE_ID", "me");
  const igUserIdFromEnv = env("IG_USER_ID");
  if (!token || !imageUrl) return null;

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
    image_url: imageUrl,
    caption: caption.slice(0, 2200),
    access_token: token,
  });
  const createRes = await fetch(`${graph}/${igUserId}/media`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: createParams });
  const createData = await createRes.json();
  if (createData.error) throw new Error(createData.error.message || "Instagram media create failed");

  const creationId = createData.id;
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
    const retryable = msg.includes("Media ID is not available");
    if (!retryable || attempt === 4) throw new Error(msg);
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

/** Wait until IG container is ready (feed + stories). */
async function waitForIgMediaContainer(containerId, token, label = "IG") {
  for (let i = 0; i < 12; i++) {
    const res = await fetch(
      `${GRAPH}/${encodeURIComponent(containerId)}?fields=status_code&access_token=${encodeURIComponent(token)}`
    );
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || `${label} container status failed`);
    const code = data.status_code;
    if (code === "FINISHED" || code === "PUBLISHED") return;
    if (code === "ERROR") throw new Error(`${label} container failed`);
    // undefined / IN_PROGRESS / EXPIRED — keep polling
    await sleep(2500);
  }
}

async function verifyHttpsImageUrlForInstagram(imageUrl) {
  if (!imageUrl || !/^https:\/\//i.test(imageUrl)) {
    throw new Error("Instagram Stories require a public HTTPS image_url");
  }
  const res = await fetch(imageUrl, {
    method: "GET",
    signal: AbortSignal.timeout(15000),
    redirect: "follow",
    headers: { "User-Agent": "RadiantWaves/1.0 (Social Bot)" },
  });
  if (!res.ok) throw new Error(`Story image_url returned HTTP ${res.status}`);
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  if (!ct.startsWith("image/")) {
    throw new Error(`Story image_url must be an image (got Content-Type: ${ct || "unknown"})`);
  }
}

async function postInstagramStory(imageUrl) {
  const token = env("FB_PAGE_ACCESS_TOKEN");
  const pageId = env("FB_PAGE_ID", "me");
  if (!token || !imageUrl) return null;
  await verifyHttpsImageUrlForInstagram(imageUrl);
  const igUserId = await resolveIgUserId(token, pageId);

  const createParams = new URLSearchParams({
    image_url: imageUrl,
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
    const retryable = msg.includes("Media ID is not available");
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

async function main() {
  const items = await loadSnapshotItems();
  if (!items.length) {
    console.log("No items in snapshot.");
    return;
  }

  const state = readState();
  let art = pickLatestUnposted(items, state);
  let imageBufferValidated = null;
  while (art) {
    imageBufferValidated = await fetchValidatedImageBuffer(art.imageUrl);
    if (imageBufferValidated) break;
    const skipKey = normalizeUrlForDedupe(art.url);
    state.skipped_urls = [
      skipKey,
      ...(Array.isArray(state?.skipped_urls) ? state.skipped_urls : []).filter((u) => normalizeUrlForDedupe(u) !== skipKey),
    ].slice(0, 5000);
    art = pickLatestUnposted(items, state);
  }
  if (!art) {
    console.log("No new snapshot article with a quality image to post.");
    return;
  }

  console.log("Posting from snapshot:", art.title.slice(0, 80));
  console.log("[social] POST_TO_* env (empty = default on):", {
    POST_TO_FACEBOOK: env("POST_TO_FACEBOOK") || "(unset)",
    POST_TO_FACEBOOK_STORY: env("POST_TO_FACEBOOK_STORY") || "(unset)",
    POST_TO_IG_STORY: env("POST_TO_IG_STORY") || "(unset)",
  });
  const longSiteLink = buildSiteArticleViewUrl(art.url);
  const postLink =
    (env("SHORTEN_LINK") === "1" || env("SHORTEN_LINK").toLowerCase() === "true")
      ? await shortenUrl(longSiteLink)
      : longSiteLink;

  const card = await generateCard(art.title, art.imageUrl, imageBufferValidated);
  const tg = await postTelegram(art.title, postLink, card);
  console.log("Posted to Telegram.");

  let imageUrlForIg = "";
  try {
    imageUrlForIg = await getTelegramFileUrl(env("TELEGRAM_BOT_TOKEN"), tg);
  } catch {}

  await ensurePageAccessToken();
  const fbToken = env("FB_PAGE_ACCESS_TOKEN");
  if (fbToken) {
    await logFacebookTokenIdentity(fbToken);
  }

  // Facebook feed: photo = postcard. Link-only feed scrapes your site og:image → logo.
  if (envSocialEnabled("POST_TO_FACEBOOK") && fbToken) {
    console.log("[social] Facebook Page feed (postcard photo)…");
    try {
      const fb = await postToFacebook(art.title, postLink, card);
      if (fb?.id) console.log("Posted to Facebook (photo / postcard). Post id:", fb.id);
    } catch (e) {
      console.error("Facebook photo error:", e?.message || e);
      try {
        const fb2 = await postFacebookFeedTextOnly(art.title, postLink);
        if (fb2?.id) console.log("Posted to Facebook (text + URL, no link preview). Post id:", fb2.id);
      } catch (e2) {
        console.error("Facebook text fallback error:", e2?.message || e2);
        if (env("POST_TO_FACEBOOK_LINK_PREVIEW") === "1") {
          try {
            const fb3 = await postFacebookFeedLink(art.title, postLink);
            if (fb3?.id) console.log("Posted to Facebook (link preview — may show site logo). Post id:", fb3.id);
          } catch (e3) {
            console.error("Facebook link-preview error:", e3?.message || e3);
          }
        }
      }
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

  if (fbToken && imageUrlForIg) {
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
          const hosted = await uploadToImgbb(buf, imgbbKey);
          if (!hosted) throw new Error("imgbb upload failed");
          const ig2 = await postInstagram(`${art.title}\n\n${postLink}`, hosted);
          if (ig2?.id) console.log("Posted to Instagram (imgbb fallback). Media id:", ig2.id);
        } catch (e2) {
          console.error("Instagram error:", e2?.message || e2);
        }
      } else {
        console.error("Instagram error:", firstErr);
      }
    }
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

  const postedKey = normalizeUrlForDedupe(art.url);
  const postLinkKey = normalizeUrlForDedupe(postLink);
  const longSiteLinkNorm = normalizeUrlForDedupe(longSiteLink);
  const prevPosted = Array.isArray(state?.posted_urls) ? state.posted_urls : [];
  const mergedPosted = [postedKey, postLinkKey, longSiteLinkNorm, ...prevPosted.map((u) => normalizeUrlForDedupe(u))]
    .filter((u, i, a) => u && a.indexOf(u) === i)
    .slice(0, 5000);

  writeState({
    ...state,
    last_posted_url: postedKey,
    last_posted_title: art.title,
    posted_urls: mergedPosted,
    skipped_urls: (Array.isArray(state?.skipped_urls) ? state.skipped_urls : []).slice(0, 5000),
    updated_at: new Date().toISOString(),
  });
  console.log("Updated social_state.json");
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});

