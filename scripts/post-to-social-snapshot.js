import fs from "fs";
import path from "path";
import zlib from "zlib";
import sharp from "sharp";

const SNAPSHOT_LOCAL = path.join(process.cwd(), "snapshots", "latest.json.gz");
const STATE_PATH = path.join(process.cwd(), "social_state.json");

function env(name, fallback = "") {
  return (process.env[name] || fallback).trim();
}

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
  const sorted = [...items].sort((a, b) => parseTs(b.ingestedAt || b.publishedAt) - parseTs(a.ingestedAt || a.publishedAt));
  for (const it of sorted) {
    const url = normalizeUrl(it.url || it.link || "");
    const imageUrl = normalizeUrl(it.imageUrl || it.image || "");
    if (!url) continue;
    if (!imageUrl) continue;
    if (postedSet.has(url)) continue;
    return {
      id: it.id || "",
      title: stripHtml(it.title || "Radiant Waves"),
      url,
      imageUrl,
    };
  }
  return null;
}

async function generateCard(title, articleImageUrl) {
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

  let image;
  try {
    if (articleImageUrl) {
      const res = await fetch(articleImageUrl, { signal: AbortSignal.timeout(15000) });
      if (res.ok) image = Buffer.from(await res.arrayBuffer());
    }
  } catch {}
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

async function uploadToImgbb(imageBuffer, apiKey) {
  if (!apiKey || !imageBuffer?.length) return "";
  const form = new FormData();
  form.append("key", apiKey);
  form.append("image", new Blob([imageBuffer], { type: "image/png" }), "image.png");
  const res = await fetch("https://api.imgbb.com/1/upload", { method: "POST", body: form });
  const data = await res.json();
  const url = data?.data?.image?.url ?? data?.data?.url;
  return url && url.startsWith("http") ? url : "";
}

async function postInstagram(caption, imageUrl) {
  const token = env("FB_PAGE_ACCESS_TOKEN");
  const pageId = env("FB_PAGE_ID", "me");
  const igUserIdFromEnv = env("IG_USER_ID");
  if (!token || !imageUrl) return null;

  const graph = "https://graph.facebook.com/v18.0";
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
  const graph = "https://graph.facebook.com/v18.0";
  const pageRes = await fetch(
    `${graph}/${encodeURIComponent(pageId)}?fields=instagram_business_account&access_token=${encodeURIComponent(token)}`
  );
  const pageData = await pageRes.json();
  if (pageData.error) throw new Error(pageData.error.message || "IG page lookup failed");
  const id = pageData.instagram_business_account?.id || "";
  if (!id) throw new Error("No Instagram Business account linked.");
  return id;
}

async function postInstagramStory(imageUrl) {
  const token = env("FB_PAGE_ACCESS_TOKEN");
  const pageId = env("FB_PAGE_ID", "me");
  if (!token || !imageUrl) return null;
  const graph = "https://graph.facebook.com/v18.0";
  const igUserId = await resolveIgUserId(token, pageId);

  const createParams = new URLSearchParams({
    image_url: imageUrl,
    media_type: "STORIES",
    access_token: token,
  });
  const createRes = await fetch(`${graph}/${igUserId}/media`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: createParams,
  });
  const createData = await createRes.json();
  if (createData.error) throw new Error(createData.error.message || "Instagram story media create failed");

  const pubParams = new URLSearchParams({ creation_id: createData.id, access_token: token });
  const pubRes = await fetch(`${graph}/${igUserId}/media_publish`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: pubParams,
  });
  const pubData = await pubRes.json();
  if (pubData.error) throw new Error(pubData.error.message || "Instagram story publish failed");
  return pubData;
}

async function postToFacebook(caption, link, imageBuffer) {
  const token = env("FB_PAGE_ACCESS_TOKEN");
  const pageId = env("FB_PAGE_ID", "me");
  if (!token || !imageBuffer?.length) return null;
  const message = link ? `${caption}\n\n${link}` : caption;

  const form = new FormData();
  form.append("message", message);
  form.append("source", new Blob([imageBuffer], { type: "image/png" }), "card.png");
  form.append("access_token", token);
  const res = await fetch(`https://graph.facebook.com/v18.0/${pageId}/photos`, {
    method: "POST",
    body: form,
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "Facebook post failed");
  return data;
}

async function postFacebookStory(imageBuffer) {
  const token = env("FB_PAGE_ACCESS_TOKEN");
  const pageId = env("FB_PAGE_ID", "me");
  if (!token || !imageBuffer?.length) return null;

  const form = new FormData();
  form.append("source", new Blob([imageBuffer], { type: "image/png" }), "story.png");
  form.append("published", "false");
  form.append("access_token", token);
  const uploadRes = await fetch(`https://graph.facebook.com/v18.0/${pageId}/photos`, {
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
  const storyRes = await fetch(`https://graph.facebook.com/v18.0/${pageId}/stories`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: storyParams,
  });
  const storyData = await storyRes.json();
  if (storyData.error) throw new Error(storyData.error.message || "Facebook story publish failed");
  return storyData;
}

async function main() {
  const items = await loadSnapshotItems();
  if (!items.length) {
    console.log("No items in snapshot.");
    return;
  }

  const state = readState();
  const art = pickLatestUnposted(items, state);
  if (!art) {
    console.log("No new snapshot article to post.");
    return;
  }

  console.log("Posting from snapshot:", art.title.slice(0, 80));
  const longSiteLink = buildSiteArticleViewUrl(art.url);
  const postLink =
    (env("SHORTEN_LINK") === "1" || env("SHORTEN_LINK").toLowerCase() === "true")
      ? await shortenUrl(longSiteLink)
      : longSiteLink;

  const card = await generateCard(art.title, art.imageUrl);
  const tg = await postTelegram(art.title, postLink, card);
  console.log("Posted to Telegram.");

  let imageUrlForIg = "";
  try {
    imageUrlForIg = await getTelegramFileUrl(env("TELEGRAM_BOT_TOKEN"), tg);
  } catch {}

  if (env("FB_PAGE_ACCESS_TOKEN") && imageUrlForIg) {
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

  if (env("POST_TO_FACEBOOK") === "1" && env("FB_PAGE_ACCESS_TOKEN")) {
    try {
      const fb = await postToFacebook(art.title, postLink, card);
      if (fb?.id) console.log("Posted to Facebook. Post id:", fb.id);
    } catch (e) {
      console.error("Facebook error:", e?.message || e);
    }
  }

  if (env("POST_TO_FACEBOOK_STORY") === "1" && env("FB_PAGE_ACCESS_TOKEN")) {
    try {
      const fbs = await postFacebookStory(card);
      if (fbs?.id || fbs?.post_id) console.log("Posted to Facebook Story.");
    } catch (e) {
      console.error("Facebook Story error:", e?.message || e);
    }
  }

  if (env("POST_TO_IG_STORY") === "1" && env("FB_PAGE_ACCESS_TOKEN") && imageUrlForIg) {
    try {
      const igs = await postInstagramStory(imageUrlForIg);
      if (igs?.id) console.log("Posted to Instagram Story. Media id:", igs.id);
    } catch (e) {
      console.error("Instagram Story error:", e?.message || e);
    }
  }

  writeState({
    ...state,
    last_posted_url: art.url,
    last_posted_title: art.title,
    posted_urls: [art.url, ...(Array.isArray(state?.posted_urls) ? state.posted_urls : []).filter((u) => u !== art.url)].slice(0, 5000),
    updated_at: new Date().toISOString(),
  });
  console.log("Updated social_state.json");
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});

