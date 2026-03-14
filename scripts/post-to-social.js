/**
 * Post latest unposted article to Telegram (and optionally Twitter).
 * Sends a Sahara-style headline card image + caption (title + article URL).
 *
 * Required env: FIREBASE_SERVICE_ACCOUNT_JSON, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 * Optional env: TWITTER_*, FIRESTORE_COLLECTION, FIRESTORE_ORDER_FIELD
 */

import admin from "firebase-admin";
import sharp from "sharp";
import fs from "fs";
import path from "path";

const SITE = "https://radiant-waves.com.ng";
const COLLECTION = process.env.FIRESTORE_COLLECTION || "articles";
const ORDER_FIELD = process.env.FIRESTORE_ORDER_FIELD || "publishedAt";

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 120);
}

function stripHtml(str) {
  return String(str || "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 280);
}

function escapeXml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function initFirestore() {
  const raw = mustEnv("FIREBASE_SERVICE_ACCOUNT_JSON");
  const cred = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(cred) });
  }
  return admin.firestore();
}

async function getNextUnpostedArticle(db) {
  const snap = await db
    .collection(COLLECTION)
    .orderBy(ORDER_FIELD, "desc")
    .limit(50)
    .get();

  for (const doc of snap.docs) {
    const data = doc.data() || {};
    if (data.postedToTelegramAt) continue;
    if (data.noImageSkippedAt) continue; // skip articles we already skipped (no image)
    return { id: doc.id, ref: doc.ref, data };
  }
  return null;
}

/** Get slug for an article (same logic as build-seo-pages). */
function getArticleSlug(data, docId) {
  const title = data.title || data.headline || "";
  return data.slug || slugify(title) || docId || "story";
}

/** Build article URL: prefer stored canonical URL if it's our site, else build from slug (same as build-seo-pages). */
function buildArticleUrl(data, docId) {
  const canonical =
    data.canonicalUrl ||
    data.pageUrl ||
    data.url ||
    data.link ||
    "";
  if (
    canonical &&
    typeof canonical === "string" &&
    canonical.includes("radiant-waves.com.ng")
  ) {
    return canonical.replace(/\#.*$/, "").replace(/\?.*$/, "").replace(/\/?$/, "") + "/";
  }
  const slug = getArticleSlug(data, docId);
  return `${SITE}/news/${slug}/`;
}

/** Get image URL from built article page (news/{slug}/index.html) og:image meta. Used when Firestore has no image. */
function getImageFromBuiltPage(slug) {
  const htmlPath = path.join(process.cwd(), "news", slug, "index.html");
  try {
    if (!fs.existsSync(htmlPath)) return "";
    const html = fs.readFileSync(htmlPath, "utf8");
    const match = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
    return match ? match[1].replace(/&amp;/g, "&") : "";
  } catch {
    return "";
  }
}

// Card styling – keep in sync with card-preview.html (edit there, then update here)
const CARD_BG = "#f47429";
const HEADLINE_COLOR = "#55a2ce";
const HEADLINE_FILL = "#ffffff";
const ACCENT_COLOR = "#55a2ce";
const SEPARATOR_LINE = "#e0e0e0";
const SEPARATOR_DOTS = "#999";
const READMORE_COLOR = "#ffffff";

/** Word-wrap into lines of at most maxChars. Keeps words intact so nothing gets cut off (e.g. "TAKE" not "TAKI"). */
function wrapLines(text, maxChars = 28) {
  const words = String(text).trim().split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    const need = line.length + (line ? 1 : 0) + w.length;
    if (need <= maxChars) {
      line = line ? line + " " + w : w;
    } else {
      if (line) lines.push(line);
      line = w.length > maxChars ? w.slice(0, maxChars) : w;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 5);
}

/** Fetch and prepare article image: resize, white border. Returns buffer or null. */
async function fetchArticleImage(imageUrl) {
  if (!imageUrl || typeof imageUrl !== "string") return null;
  const url = imageUrl.trim();
  if (!url.startsWith("http")) return null;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: { "User-Agent": "RadiantWaves/1.0 (News Bot)" },
      redirect: "follow",
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 100) return null;
    return await sharp(buf)
      .resize(1180, 680, { fit: "cover" })
      .extend({ top: 10, bottom: 10, left: 10, right: 10, background: "#ffffff" })
      .toBuffer();
  } catch (e) {
    console.warn("Article image fetch failed:", url.slice(0, 50) + "...", e.message);
    return null;
  }
}

/** Placeholder for image area when article has no image: darker strip + "Radiant Waves". */
async function makePlaceholderImage() {
  const W = 1200;
  const H = 700;
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#e65c1a"/>
  <rect x="10" y="10" width="${W - 20}" height="${H - 20}" fill="#f47429" stroke="#fff" stroke-width="2" rx="8"/>
  <text x="${W / 2}" y="${H / 2}" font-family="Arial, sans-serif" font-size="36" font-weight="700" fill="#ffffff" text-anchor="middle" dominant-baseline="middle" opacity="0.9">RADIANT WAVES</text>
  <text x="${W / 2}" y="${H / 2 + 50}" font-family="Arial, sans-serif" font-size="18" fill="#ffffff" text-anchor="middle" opacity="0.7">Article image unavailable</text>
</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/**
 * Generate card – layout and style match card-preview.html.
 * When you change the preview, copy the same values here (pad, image-h, text-h, font sizes, etc.).
 */
async function generateArticleCard(title, articleImageUrl, imageBufferPreloaded = null) {
  // Layout – header at top (Radiant Waves + arrow), then image, then headline
  const W = 1200;
  const PAD = 56;
  const SIDE_PAD = PAD;
  const HEADER_H = 70;
  const IMAGE_H = 660;
  const TEXT_H = 846;
  const TOTAL_H = HEADER_H + IMAGE_H + TEXT_H;
  const IMAGE_TOP = HEADER_H;
  const TEXT_TOP = HEADER_H + IMAGE_H;

  const lines = wrapLines(title, 28);
  const lineHeight = 72;
  const startY = 120 + PAD;
  const tspans = lines
    .map(
      (ln, i) =>
        `<tspan x="${SIDE_PAD}" dy="${i === 0 ? 0 : lineHeight}">${escapeXml(ln.toUpperCase())}</tspan>`
    )
    .join("\n    ");

  const sepY = 48;

  // Orange background
  const orangeBuf = await sharp({
    create: {
      width: W,
      height: TOTAL_H,
      channels: 3,
      background: CARD_BG,
    },
  })
    .png()
    .toBuffer();

  // Top header: left = read more (line + ▶▶), right = Radiant Waves + tagline + accent line
  const headerSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${HEADER_H}" viewBox="0 0 ${W} ${HEADER_H}">
  <!-- left: arrow / read more -->
  <line x1="${SIDE_PAD}" y1="${HEADER_H / 2}" x2="${SIDE_PAD + 80}" y2="${HEADER_H / 2}" stroke="${READMORE_COLOR}" stroke-width="4"/>
  <text x="${SIDE_PAD + 96}" y="${HEADER_H / 2 + 6}" font-family="Arial, sans-serif" font-size="22" font-weight="900" fill="${READMORE_COLOR}">▶▶</text>
  <!-- right: Radiant Waves + tagline + line -->
  <text x="${W - SIDE_PAD}" y="28" font-family="Arial, sans-serif" font-size="28" font-weight="900" fill="${HEADLINE_FILL}" text-anchor="end">Radiant Waves</text>
  <text x="${W - SIDE_PAD}" y="48" font-family="Arial, sans-serif" font-size="12" fill="${HEADLINE_FILL}" text-anchor="end" opacity="0.9">Fresh Naija vibes, daily.</text>
  <line x1="${W - SIDE_PAD - 200}" y1="62" x2="${W - SIDE_PAD}" y2="62" stroke="${ACCENT_COLOR}" stroke-width="4"/>
</svg>`;
  const headerBuf = await sharp(Buffer.from(headerSvg)).png().toBuffer();

  // Text section – separator + left accent bar + headline only (no brand/arrow at bottom)
  const textSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${TEXT_H}" viewBox="0 0 ${W} ${TEXT_H}">
  <!-- left accent bar -->
  <rect x="${SIDE_PAD}" y="${sepY}" width="5" height="220" fill="${ACCENT_COLOR}" opacity="0.85"/>
  <!-- separator -->
  <line x1="${SIDE_PAD + 24}" y1="${sepY}" x2="${W - SIDE_PAD - 24}" y2="${sepY}" stroke="${SEPARATOR_LINE}" stroke-width="2"/>
  <rect x="${SIDE_PAD}" y="${sepY - 10}" width="12" height="14" fill="${SEPARATOR_DOTS}"/>
  <rect x="${W - SIDE_PAD - 12}" y="${sepY - 10}" width="12" height="14" fill="${SEPARATOR_DOTS}"/>
  <!-- headline: clean white -->
  <text x="${SIDE_PAD + 14}" y="${startY}" font-family="Arial, sans-serif" font-size="56" font-weight="900" fill="${HEADLINE_FILL}" text-anchor="start">
    ${tspans}
  </text>
</svg>`;

  const textBuf = await sharp(Buffer.from(textSvg))
    .png()
    .toBuffer();

  // Corner frame accents
  const cornerLen = 40;
  const cornerStroke = 3;
  const cornerSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${TOTAL_H}" viewBox="0 0 ${W} ${TOTAL_H}">
  <path d="M ${PAD} ${PAD + cornerLen} V ${PAD} H ${PAD + cornerLen}" fill="none" stroke="${HEADLINE_FILL}" stroke-width="${cornerStroke}"/>
  <path d="M ${W - PAD - cornerLen} ${PAD} H ${W - PAD} V ${PAD + cornerLen}" fill="none" stroke="${HEADLINE_FILL}" stroke-width="${cornerStroke}"/>
</svg>`;
  const cornerBuf = await sharp(Buffer.from(cornerSvg)).png().toBuffer();

  const imgW = W - 2 * SIDE_PAD;
  const imageBuf = imageBufferPreloaded || await fetchArticleImage(articleImageUrl);
  const imageForCard = imageBuf
    ? await sharp(imageBuf).resize(imgW, IMAGE_H, { fit: "cover" }).toBuffer()
    : await sharp(await makePlaceholderImage()).resize(imgW, IMAGE_H, { fit: "cover" }).toBuffer();

  const composites = [
    { input: cornerBuf, top: 0, left: 0 },
    { input: headerBuf, top: 0, left: 0 },
    { input: imageForCard, top: IMAGE_TOP, left: SIDE_PAD },
    { input: textBuf, top: TEXT_TOP, left: 0 },
  ];

  return sharp(orangeBuf)
    .composite(composites)
    .png()
    .toBuffer();
}

/** Post to Telegram: photo (buffer or URL) with caption, or fallback to message only. */
async function postToTelegram(caption, link, options = {}) {
  const token = mustEnv("TELEGRAM_BOT_TOKEN");
  const chatId = mustEnv("TELEGRAM_CHAT_ID");
  const text = `${caption}\n\n${link}`;

  const apiBase = `https://api.telegram.org/bot${token}`;

  if (options.imageBuffer) {
    const form = new FormData();
    form.append("chat_id", chatId);
    form.append("caption", text);
    form.append("photo", new Blob([options.imageBuffer], { type: "image/png" }), "card.png");
    const res = await fetch(`${apiBase}/sendPhoto`, {
      method: "POST",
      body: form,
    });
    const body = await res.json();
    if (!body.ok) {
      throw new Error(`Telegram API: ${body.description || res.statusText}`);
    }
    return body;
  }

  if (options.imageUrl) {
    const res = await fetch(`${apiBase}/sendPhoto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        photo: options.imageUrl,
        caption: text,
      }),
    });
    const body = await res.json();
    if (!body.ok) {
      throw new Error(`Telegram API: ${body.description || res.statusText}`);
    }
    return body;
  }

  const res = await fetch(`${apiBase}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: false,
    }),
  });
  const body = await res.json();
  if (!body.ok) {
    throw new Error(`Telegram API: ${body.description || res.statusText}`);
  }
  return body;
}

async function postToTwitter(text, link) {
  const apiKey = process.env.TWITTER_API_KEY;
  const apiSecret = process.env.TWITTER_API_SECRET;
  const accessToken = process.env.TWITTER_ACCESS_TOKEN;
  const accessSecret = process.env.TWITTER_ACCESS_SECRET;

  if (!apiKey || !apiSecret || !accessToken || !accessSecret) {
    return null;
  }

  const { TwitterApi } = await import("twitter-api-v2");
  const client = new TwitterApi({
    appKey: apiKey,
    appSecret: apiSecret,
    accessToken,
    accessSecret,
  });

  const tweetText = link ? `${stripHtml(text)}\n\n${link}` : stripHtml(text);
  const tweet = await client.v2.tweet(tweetText);
  return tweet;
}

/** Get image URL for an article (Firestore first, then built page og:image). */
function getArticleImageUrl(article) {
  const slug = getArticleSlug(article.data, article.id);
  let url =
    article.data.image ||
    article.data.imageUrl ||
    article.data.ogImage ||
    article.data.thumbnail ||
    article.data.enclosure?.url ||
    article.data.media?.url ||
    "";
  if (!url) url = getImageFromBuiltPage(slug);
  return url;
}

async function main() {
  const db = await initFirestore();
  let article = await getNextUnpostedArticle(db);
  let imageBuf = null;

  while (article) {
    const articleImageUrl = getArticleImageUrl(article);
    if (!articleImageUrl) {
      console.log("Skipping article (no image URL):", (article.data.title || article.data.headline || "").slice(0, 50) + "...");
      await article.ref.update({ noImageSkippedAt: admin.firestore.FieldValue.serverTimestamp() });
      article = await getNextUnpostedArticle(db);
      continue;
    }
    imageBuf = await fetchArticleImage(articleImageUrl);
    if (!imageBuf) {
      console.log("Skipping article (image failed to load):", (article.data.title || article.data.headline || "").slice(0, 50) + "...");
      await article.ref.update({ noImageSkippedAt: admin.firestore.FieldValue.serverTimestamp() });
      article = await getNextUnpostedArticle(db);
      continue;
    }
    break;
  }

  if (!article) {
    console.log("No unposted article with a working image found. Nothing to post.");
    return;
  }

  const title = article.data.title || article.data.headline || "Radiant Waves";
  const cleanTitle = stripHtml(title);
  const url = buildArticleUrl(article.data, article.id);
  const articleImageUrl = getArticleImageUrl(article);

  console.log("Posting:", cleanTitle.slice(0, 60) + "...");
  console.log("Link:", url);

  const imageBuffer = await generateArticleCard(cleanTitle, articleImageUrl, imageBuf);

  try {
    await postToTelegram(cleanTitle, url, { imageBuffer });
    console.log("Posted to Telegram (with headline card).");
  } catch (e) {
    console.error("Telegram error:", e.message);
    throw e;
  }

  let tweeted = false;
  try {
    const tw = await postToTwitter(cleanTitle, url);
    if (tw) {
      console.log("Posted to Twitter.");
      tweeted = true;
    }
  } catch (e) {
    console.warn("Twitter skip or error:", e.message);
  }

  const update = { postedToTelegramAt: admin.firestore.FieldValue.serverTimestamp() };
  if (tweeted) update.postedToTwitterAt = admin.firestore.FieldValue.serverTimestamp();
  await article.ref.update(update);
  console.log("Marked article as posted.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
