/**
 * Post latest unposted article to Telegram (and optionally Twitter).
 * Sends a Sahara-style headline card image + caption (title + article URL).
 *
 * Required env: FIREBASE_SERVICE_ACCOUNT_JSON, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 * Optional env: TWITTER_*, FIRESTORE_COLLECTION, FIRESTORE_ORDER_FIELD
 */

import admin from "firebase-admin";
import sharp from "sharp";

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
    return { id: doc.id, ref: doc.ref, data };
  }
  return null;
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
  const title = data.title || data.headline || "";
  const slug = data.slug || slugify(title) || docId || "story";
  return `${SITE}/news/${slug}/`;
}

/** Word-wrap into lines of at most maxChars. */
function wrapLines(text, maxChars = 42) {
  const words = String(text).trim().split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    if (line.length + w.length + 1 <= maxChars) {
      line = line ? line + " " + w : w;
    } else {
      if (line) lines.push(line);
      line = w.length > maxChars ? w.slice(0, maxChars) : w;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 5);
}

/** Generate Sahara-style headline card: bold headline on dark background, Radiant Waves at bottom. */
async function generateHeadlineImage(title) {
  const W = 1200;
  const H = 800;
  const safeTitle = escapeXml(stripHtml(title));
  const lines = wrapLines(title, 38);
  const lineHeight = 72;
  const startY = 280;
  const tspans = lines
    .map(
      (ln, i) =>
        `<tspan x="${W / 2}" dy="${i === 0 ? 0 : lineHeight}">${escapeXml(ln)}</tspan>`
    )
    .join("\n    ");

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#0f172a"/>
  <text x="${W / 2}" y="${startY}" font-family="Arial, sans-serif" font-size="52" font-weight="700" fill="#ffffff" text-anchor="middle" dominant-baseline="middle">
    ${tspans}
  </text>
  <text x="${W / 2}" y="${H - 80}" font-family="Arial, sans-serif" font-size="28" fill="#94a3b8" text-anchor="middle">Radiant Waves</text>
</svg>`;

  return sharp(Buffer.from(svg))
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

async function main() {
  const db = await initFirestore();
  const article = await getNextUnpostedArticle(db);
  if (!article) {
    console.log("No unposted article found. Skipping.");
    return;
  }

  const title = article.data.title || article.data.headline || "Radiant Waves";
  const cleanTitle = stripHtml(title);
  const url = buildArticleUrl(article.data, article.id);

  console.log("Posting:", cleanTitle.slice(0, 60) + "...");
  console.log("Link:", url);

  const imageBuffer = await generateHeadlineImage(cleanTitle);

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
