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

const TELEGRAM_API = "https://api.telegram.org/bot";

function stripHtml(str) {
  if (typeof str !== "string") return "";
  return str.replace(/<[^>]*>/g, "").trim();
}

/** Get recent updates from Telegram, find latest message with photo in our channel. */
async function getLatestChannelPhoto(botToken, chatId) {
  // If a webhook is set, getUpdates will fail with a conflict error.
  // In CI we always want polling, so clear any webhook.
  try {
    await fetch(`${TELEGRAM_API}${botToken}/deleteWebhook?drop_pending_updates=false`);
  } catch (_) {}

  const res = await fetch(
    `${TELEGRAM_API}${botToken}/getUpdates?limit=100&allowed_updates=${encodeURIComponent("message,channel_post,edited_channel_post")}`,
  );
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || "Telegram getUpdates failed");

  const updates = data.result || [];
  console.log("getUpdates returned", updates.length, "updates");
  const pick = (u) => u?.channel_post || u?.message || u?.edited_channel_post || null;
  const withPhoto = updates
    .map((u) => pick(u))
    .filter((m) => m && String(m.chat?.id) === String(chatId) && m.photo?.length)
    .sort((a, b) => (b.date || 0) - (a.date || 0));

  console.log("Updates from our channel with photo:", withPhoto.length);
  const latest = withPhoto[0];
  if (!latest?.photo?.length) return null;

  const photoSizes = latest.photo;
  const largest = photoSizes[photoSizes.length - 1];
  const fileId = largest.file_id;
  const caption = latest.caption || "";

  const fileRes = await fetch(`${TELEGRAM_API}${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const fileData = await fileRes.json();
  if (!fileData.ok) throw new Error(fileData.description || "Telegram getFile failed");

  const filePath = fileData.result?.file_path;
  if (!filePath) throw new Error("No file_path from getFile");

  const imageUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
  return { imageUrl, caption };
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

  const meRes = await fetch(`${graph}/me?fields=instagram_business_account&access_token=${encodeURIComponent(token)}`);
  const meData = await meRes.json();
  if (meData.error) throw new Error(meData.error.message || "Facebook Graph: me");
  const igUserId = meData.instagram_business_account?.id;
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

  // Give Telegram a moment to deliver the channel_post from the previous step.
  console.log("Waiting 3s for Telegram to register the channel post...");
  await new Promise((r) => setTimeout(r, 3000));

  console.log("Fetching latest photo from Telegram channel (chat_id=" + chatId + ")...");
  const latest = await getLatestChannelPhoto(botToken, chatId);
  if (!latest) {
    console.log("No recent photo post found in the channel. Ensure the bot posts to the channel and that we're reading channel_post.");
    return;
  }
  console.log("Found latest post, caption length:", (latest.caption || "").length);

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

  console.log("Posting to Instagram...");
  const ig = await postToInstagram(latest.caption, { imageUrl });
  if (ig?.id) {
    console.log("Posted to Instagram. Media id:", ig.id);
  } else {
    console.log("Instagram post completed.");
  }
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
