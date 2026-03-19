/**
 * Telegram → Instagram workflow
 *
 * Fetches the latest photo post from your Telegram channel, then posts it to
 * Instagram (Business) via the Graph API. No Firebase Storage needed.
 *
 * Requires:
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (channel where the bot posts)
 *   FB_PAGE_ACCESS_TOKEN (Page token; IG must be linked to the Page)
 *
 * Optional: IMGBB_API_KEY — if Instagram rejects the Telegram file URL,
 * we upload the image to imgbb and use that URL instead.
 */

import fs from "fs";
import path from "path";

const TELEGRAM_API = "https://api.telegram.org/bot";
const STATE_PATH = path.join(process.cwd(), "state.json");

function stripHtml(str) {
  if (typeof str !== "string") return "";
  return str.replace(/<[^>]*>/g, "").trim();
}

function readState() {
  try {
    const raw = fs.readFileSync(STATE_PATH, "utf8");
    const data = JSON.parse(raw);
    const n = Number(data?.last_update_id || 0);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function writeState(lastUpdateId) {
  const n = Number(lastUpdateId || 0);
  fs.writeFileSync(STATE_PATH, JSON.stringify({ last_update_id: n }, null, 2) + "\n", "utf8");
}

/** Get updates since last_update_id, find latest channel photo post + return its update_id. */
async function getLatestChannelPhoto(botToken, chatId, afterUpdateId) {
  // If a webhook is set, getUpdates will fail with a conflict error.
  // In CI we always want polling, so clear any webhook.
  try {
    await fetch(`${TELEGRAM_API}${botToken}/deleteWebhook?drop_pending_updates=false`);
  } catch (_) {}

  const params = new URLSearchParams({
    limit: "100",
    allowed_updates: "message,channel_post,edited_channel_post",
  });
  if (afterUpdateId && Number(afterUpdateId) > 0) {
    params.set("offset", String(Number(afterUpdateId) + 1));
  }

  const res = await fetch(`${TELEGRAM_API}${botToken}/getUpdates?` + params.toString());
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || "Telegram getUpdates failed");

  const updates = data.result || [];
  console.log("getUpdates returned", updates.length, "updates");
  const maxUpdateId = updates.reduce((m, u) => Math.max(m, Number(u?.update_id || 0)), 0);

  const pick = (u) => u?.channel_post || u?.message || u?.edited_channel_post || null;
  const withPhoto = updates
    .map((u) => ({ update_id: u.update_id, msg: pick(u) }))
    .filter((x) => x.msg && String(x.msg.chat?.id) === String(chatId) && x.msg.photo?.length)
    .sort((a, b) => (b.msg.date || 0) - (a.msg.date || 0));

  console.log("Updates from our channel with photo:", withPhoto.length);
  const latest = withPhoto[0];
  if (!latest?.msg?.photo?.length) return { item: null, maxUpdateId };

  const photoSizes = latest.msg.photo;
  const largest = photoSizes[photoSizes.length - 1];
  const fileId = largest.file_id;
  const caption = latest.msg.caption || "";

  const fileRes = await fetch(`${TELEGRAM_API}${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const fileData = await fileRes.json();
  if (!fileData.ok) throw new Error(fileData.description || "Telegram getFile failed");

  const filePath = fileData.result?.file_path;
  if (!filePath) throw new Error("No file_path from getFile");

  const imageUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
  return { item: { imageUrl, caption, update_id: latest.update_id }, maxUpdateId };
}

/** Optional: shorten a URL. Set SHORTEN_LINK=1. Uses TinyURL (no key) or Bitly if BITLY_ACCESS_TOKEN is set. */
async function shortenUrl(longUrl) {
  if (!longUrl || typeof longUrl !== "string") return longUrl;
  const useBitly = process.env.BITLY_ACCESS_TOKEN;
  try {
    if (useBitly) {
      const res = await fetch("https://api-ssl.bitly.com/v4/shorten", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.BITLY_ACCESS_TOKEN}`,
        },
        body: JSON.stringify({ long_url: longUrl }),
      });
      const data = await res.json();
      if (data.link) return data.link;
      throw new Error(data.message || "Bitly shorten failed");
    }
    const res = await fetch(
      `https://tinyurl.com/api-create.php?url=${encodeURIComponent(longUrl)}`,
      { signal: AbortSignal.timeout(10000) }
    );
    const text = (await res.text()).trim();
    if (text && text.startsWith("http")) return text;
    throw new Error("TinyURL returned invalid response");
  } catch (e) {
    console.warn("Shorten failed, using long URL:", e?.message || e);
    return longUrl;
  }
}

/** Replace article URLs in caption with shortened version when SHORTEN_LINK=1. */
async function maybeShortenUrlsInCaption(caption) {
  if (!caption || typeof caption !== "string") return caption;
  if (process.env.SHORTEN_LINK !== "1" && process.env.SHORTEN_LINK !== "true") return caption;
  const urlRe = /https?:\/\/[^\s]+/g;
  const urls = caption.match(urlRe);
  if (!urls?.length) return caption;
  let out = caption;
  for (const u of urls) {
    const short = await shortenUrl(u.trim());
    if (short !== u) out = out.replace(u, short);
  }
  return out;
}

/** If IMGBB_API_KEY is set, upload buffer to imgbb and return the direct image URL. */
async function uploadToImgbb(imageBuffer, apiKey) {
  if (!apiKey || !imageBuffer?.length) return null;
  const form = new FormData();
  form.append("key", apiKey);
  form.append("image", new Blob([imageBuffer], { type: "image/png" }), "image.png");
  const res = await fetch("https://api.imgbb.com/1/upload", { method: "POST", body: form });
  const data = await res.json();
  const url = data?.data?.image?.url ?? data?.data?.url;
  return url && url.startsWith("http") ? url : null;
}

/** Post to Instagram (Business) via Graph API. */
async function postToInstagram(caption, options = {}) {
  const token = process.env.FB_PAGE_ACCESS_TOKEN;
  if (!token || !options.imageUrl) return null;

  const captionText = typeof caption === "string" ? stripHtml(caption) : "";
  const graph = "https://graph.facebook.com/v18.0";
  const pageId = process.env.FB_PAGE_ID || "me";
  const igUserIdFromEnv = process.env.IG_USER_ID;

  let igUserId = igUserIdFromEnv || "";
  if (!igUserId) {
    const pageRes = await fetch(
      `${graph}/${encodeURIComponent(pageId)}?fields=instagram_business_account&access_token=${encodeURIComponent(token)}`
    );
    const pageData = await pageRes.json();
    if (pageData.error) throw new Error(pageData.error.message || "Facebook Graph: page lookup");
    igUserId = pageData.instagram_business_account?.id || "";
  }
  if (!igUserId) throw new Error("No Instagram Business account linked to this Page. Connect IG in Page settings.");

  const createParams = new URLSearchParams({
    image_url: options.imageUrl,
    caption: captionText.slice(0, 2200),
    access_token: token,
  });
  const createRes = await fetch(`${graph}/${igUserId}/media`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: createParams,
  });
  const createData = await createRes.json();
  if (createData.error) throw new Error(createData.error.message || "Instagram media create failed");
  const creationId = createData.id;
  if (!creationId) throw new Error("No creation_id from Instagram");

  const pubParams = new URLSearchParams({ creation_id: creationId, access_token: token });
  const pubRes = await fetch(`${graph}/${igUserId}/media_publish`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: pubParams,
  });
  const pubData = await pubRes.json();
  if (pubData.error) throw new Error(pubData.error.message || "Instagram publish failed");
  return pubData;
}

async function main() {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const pageToken = process.env.FB_PAGE_ACCESS_TOKEN;

  if (!botToken || !chatId) {
    console.error("Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.");
    process.exit(1);
  }
  if (!pageToken) {
    console.error("Set FB_PAGE_ACCESS_TOKEN for Instagram.");
    process.exit(1);
  }

  const lastUpdateId = readState();
  console.log("State last_update_id:", lastUpdateId);

  console.log("Fetching Telegram updates for chat_id=" + chatId + "...");
  const { item: latest, maxUpdateId } = await getLatestChannelPhoto(botToken, chatId, lastUpdateId);
  if (!latest) {
    console.log("No NEW photo post found since last_update_id. Updating state to:", maxUpdateId);
    if (maxUpdateId && maxUpdateId > lastUpdateId) writeState(maxUpdateId);
    return;
  }
  console.log("Found latest NEW post (update_id=" + latest.update_id + "), caption length:", (latest.caption || "").length);

  let imageUrl = latest.imageUrl;
  const imgbbKey = process.env.IMGBB_API_KEY;

  if (imgbbKey) {
    console.log("Downloading image to re-upload to imgbb...");
    try {
      const res = await fetch(imageUrl, { signal: AbortSignal.timeout(15000) });
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        const imgbbUrl = await uploadToImgbb(buf, imgbbKey);
        if (imgbbUrl) {
          imageUrl = imgbbUrl;
          console.log("Using imgbb URL for Instagram.");
        }
      }
    } catch (e) {
      console.warn("imgbb fallback failed:", e.message);
    }
  }

  let caption = latest.caption || "";
  caption = await maybeShortenUrlsInCaption(caption);
  console.log("Posting to Instagram...");
  const ig = await postToInstagram(caption, { imageUrl });
  if (ig?.id) {
    console.log("Posted to Instagram. Media id:", ig.id);
  } else {
    console.log("Instagram post completed.");
  }

  // Mark processed so we don't repost.
  if (latest.update_id) {
    console.log("Updating state last_update_id →", latest.update_id);
    writeState(latest.update_id);
  }
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
