/**
 * Post latest unposted article to Telegram (and optionally Twitter).
 * Run on a schedule (e.g. GitHub Actions) to auto-share new content.
 *
 * Required env: FIREBASE_SERVICE_ACCOUNT_JSON, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 * Optional env: TWITTER_API_KEY, TWITTER_API_SECRET, TWITTER_ACCESS_TOKEN, TWITTER_ACCESS_SECRET
 */

import admin from "firebase-admin";

const SITE = "https://radiant-waves.com.ng";
const COLLECTION = process.env.FIRESTORE_COLLECTION || "articles";
// Field to sort by (must exist on docs). Use "ts" if your ingest only has timestamp as "ts".
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

async function initFirestore() {
  const raw = mustEnv("FIREBASE_SERVICE_ACCOUNT_JSON");
  const cred = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(cred) });
  }
  return admin.firestore();
}

/** Get the next article that hasn't been posted to Telegram yet. */
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

function buildArticleUrl(data) {
  const title = data.title || data.headline || "";
  const slug = data.slug || slugify(title) || "story";
  return `${SITE}/news/${slug}/`;
}

async function postToTelegram(text, link) {
  const token = mustEnv("TELEGRAM_BOT_TOKEN");
  const chatId = mustEnv("TELEGRAM_CHAT_ID");
  const message = `${text}\n\n${link}`;

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: message,
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
  const url = buildArticleUrl(article.data);
  const cleanTitle = stripHtml(title);

  console.log("Posting:", cleanTitle.slice(0, 60) + "...");

  try {
    await postToTelegram(cleanTitle, url);
    console.log("Posted to Telegram.");
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
