/**
 * Post latest unposted article to Telegram (and optionally Twitter).
 * Sends a custom card image (dark theme, primary #f47429, secondary #53a4cd)
 * + caption (title + article URL). Preview design: card-preview.html.
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

// Card styling – primary #f47429, secondary #53a4cd (sync with card-preview.html)
const CARD_BG = "#0f1114";
const ACCENT_COLOR = "#f47429";
const ACCENT_WARM = "#ff9a5c";
const SECONDARY_COLOR = "#53a4cd";
const HEADLINE_FILL = "#f0f2f5";

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
    return await sharp(buf).resize(1180, 680, { fit: "cover" }).toBuffer();
  } catch (e) {
    console.warn("Article image fetch failed:", url.slice(0, 50) + "...", e.message);
    return null;
  }
}

/** Placeholder for image area when article has no image. */
async function makePlaceholderImage() {
  const W = 900;
  const H = 560;
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#161a1f" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>
  <text x="${W / 2}" y="${H / 2 - 12}" font-family="Arial, sans-serif" font-size="24" font-weight="700" fill="#8b929e" text-anchor="middle">No image</text>
  <text x="${W / 2}" y="${H / 2 + 20}" font-family="Arial, sans-serif" font-size="24" font-weight="700" fill="#8b929e" text-anchor="middle">for this article</text>
</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/**
 * Generate card – layout/colors match card-preview.html (see CARD-DESIGN.md).
 */
async function generateArticleCard(title, articleImageUrl, imageBufferPreloaded = null) {
  const W = 1000;
  const TOTAL_H = 1500;
  const PAD = 48;
  const IMAGE_W = 900;
  const IMAGE_H = 560;
  const IMAGE_LEFT = (W - IMAGE_W) / 2;
  const IMAGE_TOP = 100;
  const HEADLINE_GAP = 100;
  const HEADLINE_TOP = IMAGE_TOP + IMAGE_H + HEADLINE_GAP;
  const HEADLINE_LINE_HEIGHT = 72;
  const LINES_TOP = 1200;
  const LINE_LEN = 700;
  const LINE_LEFT = (W - LINE_LEN) / 2;
  const BRAND_TOP = 1380;

  const lines = wrapLines(title, 28);
  const headlineX = PAD + 20;
  const tspans = lines
    .map(
      (ln, i) =>
        `<tspan x="${headlineX}" dy="${i === 0 ? 0 : HEADLINE_LINE_HEIGHT}">${escapeXml(ln)}</tspan>`
    )
    .join("\n    ");

  // Background: dark + left stripe (gradient) + soft orbs
  const STRIPE_W = 6;
  const bgSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${TOTAL_H}" viewBox="0 0 ${W} ${TOTAL_H}">
  <defs>
    <linearGradient id="stripeGrad" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" style="stop-color:${ACCENT_COLOR}"/>
      <stop offset="100%" style="stop-color:${ACCENT_WARM}"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${TOTAL_H}" fill="${CARD_BG}"/>
  <rect x="0" y="0" width="${STRIPE_W}" height="${TOTAL_H}" fill="url(#stripeGrad)"/>
  <circle cx="${W + 100}" cy="-120" r="220" fill="${ACCENT_COLOR}" opacity="0.2"/>
  <circle cx="-80" cy="${TOTAL_H + 80}" r="180" fill="${SECONDARY_COLOR}" opacity="0.18"/>
</svg>`;
  const bgBuf = await sharp(Buffer.from(bgSvg)).png().toBuffer();

  const starR = 5;
  const starPath = (cx, cy, r = starR) => {
    const points = [];
    for (let i = 0; i < 5; i++) {
      const a = (i * 72 - 90) * Math.PI / 180;
      points.push(`${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`);
    }
    return `M ${points[0]} L ${points[2]} L ${points[4]} L ${points[1]} L ${points[3]} Z`;
  };
  const starEl = (x, y, r = starR, fill = ACCENT_COLOR) =>
    `<path d="${starPath(x, y, r)}" fill="${fill}"/>`;
  // Top-right: tight arc (lead + 4), eye-catching
  const starsTr = [
    starEl(W - 24 - 10, 24 + 10, 7, ACCENT_COLOR),
    starEl(W - 24 - 32, 24 + 14, 4, ACCENT_COLOR),
    starEl(W - 24 - 48, 24 + 38, 4, SECONDARY_COLOR),
    starEl(W - 24 - 38, 24 + 56, 5, ACCENT_COLOR),
    starEl(W - 24 - 16, 24 + 42, 4, ACCENT_COLOR),
  ];
  // Bottom-left: mirror cluster
  const starsBl = [
    starEl(PAD + 24 + 58, TOTAL_H - PAD - 24 - 58, 7, ACCENT_COLOR),
    starEl(PAD + 24 + 36, TOTAL_H - PAD - 24 - 54, 4, ACCENT_COLOR),
    starEl(PAD + 24 + 20, TOTAL_H - PAD - 24 - 38, 4, SECONDARY_COLOR),
    starEl(PAD + 24 + 30, TOTAL_H - PAD - 24 - 20, 5, ACCENT_COLOR),
    starEl(PAD + 24 + 52, TOTAL_H - PAD - 24 - 34, 4, ACCENT_COLOR),
  ];

  const lineY1 = LINES_TOP + 5;
  const lineY2 = LINES_TOP + 20;
  const lineY3 = LINES_TOP + 35;
  const decoSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${TOTAL_H}" viewBox="0 0 ${W} ${TOTAL_H}">
  <text x="${PAD + STRIPE_W + 16}" y="65" font-family="Arial, sans-serif" font-size="45" font-weight="650" fill="${ACCENT_COLOR}" text-anchor="start">NEWS</text>
  <rect x="${IMAGE_LEFT}" y="${IMAGE_TOP}" width="${IMAGE_W}" height="${IMAGE_H}" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>
  ${starsTr.join("\n  ")}
  ${starsBl.join("\n  ")}
  <line x1="${PAD}" y1="${HEADLINE_TOP + 24}" x2="${PAD}" y2="${HEADLINE_TOP + 140}" stroke="${ACCENT_COLOR}" stroke-width="4"/>
  <text x="${headlineX}" y="${HEADLINE_TOP + 42}" font-family="Arial, sans-serif" font-size="60" font-weight="800" fill="${HEADLINE_FILL}" text-anchor="start">
    ${tspans}
  </text>
  <line x1="${LINE_LEFT}" y1="${lineY1}" x2="${LINE_LEFT + LINE_LEN}" y2="${lineY1}" stroke="${ACCENT_COLOR}" stroke-width="7" opacity="0.9"/>
  <line x1="${LINE_LEFT}" y1="${lineY2}" x2="${LINE_LEFT + LINE_LEN}" y2="${lineY2}" stroke="${SECONDARY_COLOR}" stroke-width="5.5" opacity="0.9"/>
  <line x1="${LINE_LEFT}" y1="${lineY3}" x2="${LINE_LEFT + LINE_LEN}" y2="${lineY3}" stroke="${ACCENT_COLOR}" stroke-width="7" opacity="0.9"/>
  <text x="${W / 2}" y="${BRAND_TOP + 14}" font-family="Arial, sans-serif" font-size="40" font-weight="600" fill="${HEADLINE_FILL}" text-anchor="middle">RADIANT WAVES</text>
  <line x1="${W / 2 - 150}" y1="${BRAND_TOP + 54}" x2="${W / 2 + 150}" y2="${BRAND_TOP + 54}" stroke="${SECONDARY_COLOR}" stroke-width="7" opacity="0.9"/>
</svg>`;
  const decoBuf = await sharp(Buffer.from(decoSvg)).png().toBuffer();

  const imageBuf = imageBufferPreloaded || await fetchArticleImage(articleImageUrl);
  const imageForCard = imageBuf
    ? await sharp(imageBuf).resize(IMAGE_W, IMAGE_H, { fit: "cover" }).toBuffer()
    : await makePlaceholderImage();

  const composites = [
    { input: imageForCard, top: IMAGE_TOP, left: IMAGE_LEFT },
    { input: decoBuf, top: 0, left: 0 },
  ];

  return sharp(bgBuf)
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
  const msg = err?.message || String(err);
  const code = err?.code ?? err?.details;
  if (err?.code === 8 || msg.includes("RESOURCE_EXHAUSTED") || msg.includes("Quota exceeded")) {
    console.error("Firestore quota exceeded. Check Firebase Console → Usage and billing.");
    console.error("See DEPLOY.md for options (upgrade plan or reduce read/write usage).");
  } else {
    console.error(err);
  }
  process.exit(1);
});
