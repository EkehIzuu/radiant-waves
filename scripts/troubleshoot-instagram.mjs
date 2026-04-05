#!/usr/bin/env node
/**
 * Run where secrets are available (local: export vars, or GitHub Actions manual workflow).
 * Does NOT post to Telegram — only checks Meta + optional imgbb smoke upload.
 *
 *   FB_PAGE_ACCESS_TOKEN=... FB_PAGE_ID=... IMGBB_API_KEY=... node scripts/troubleshoot-instagram.mjs
 */
const GRAPH = "https://graph.facebook.com/v21.0";

function env(k) {
  return (process.env[k] || "").trim();
}

async function main() {
  console.log("=== Radiant Waves — Instagram troubleshoot ===\n");

  const token = env("FB_PAGE_ACCESS_TOKEN");
  const pageIdHint = env("FB_PAGE_ID");
  const igUserHint = env("IG_USER_ID");
  const imgbb = env("IMGBB_API_KEY");

  console.log("Secrets / env:");
  console.log("  FB_PAGE_ACCESS_TOKEN:", token ? `set (${token.length} chars)` : "MISSING");
  console.log("  FB_PAGE_ID:", pageIdHint || "(unset)");
  console.log("  IG_USER_ID:", igUserHint || "(unset — script resolves from Page)");
  console.log("  IMGBB_API_KEY:", imgbb ? "set" : "MISSING — Instagram needs a public image URL; add this.");
  console.log("");

  if (!token) {
    console.error("Set FB_PAGE_ACCESS_TOKEN and re-run.");
    process.exit(1);
  }

  console.log("1) GET /me?fields=id,name,category,fan_count,tasks,instagram_business_account");
  const meRes = await fetch(
    `${GRAPH}/me?fields=id,name,category,fan_count,tasks,instagram_business_account&access_token=${encodeURIComponent(token)}`
  );
  const me = await meRes.json();
  console.log(JSON.stringify(me, null, 2));
  if (me.error) {
    console.error("\n→ Token invalid or expired:", me.error.message, me.error.code);
    process.exit(1);
  }

  const pageId = pageIdHint || me.id;
  console.log("\n2) GET /{page-id}?fields=instagram_business_account (pageId=" + pageId + ")");
  const pageRes = await fetch(
    `${GRAPH}/${encodeURIComponent(pageId)}?fields=id,name,instagram_business_account&access_token=${encodeURIComponent(token)}`
  );
  const page = await pageRes.json();
  console.log(JSON.stringify(page, null, 2));

  const igBiz = page.instagram_business_account?.id || me.instagram_business_account?.id;
  if (!igBiz) {
    console.error(
      "\n→ No instagram_business_account. In Meta Business Suite: connect this Facebook Page to an Instagram Business/Creator account."
    );
  } else {
    console.log("\n→ OK: Instagram business account id for Graph API:", igBiz);
  }

  if (imgbb) {
    console.log("\n3) imgbb smoke upload (1×1 PNG) — checks API key");
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64"
    );
    const form = new FormData();
    form.append("key", imgbb);
    form.append("image", new Blob([png], { type: "image/png" }), "probe.png");
    const up = await fetch("https://api.imgbb.com/1/upload", { method: "POST", body: form });
    const upJson = await up.json();
    console.log("imgbb response success=", upJson.success, "url=", upJson?.data?.image?.url || upJson?.data?.url || "(none)");
    if (!upJson.success) console.log("full:", JSON.stringify(upJson).slice(0, 500));
  } else {
    console.log("\n3) Skip imgbb (no IMGBB_API_KEY)");
  }

  console.log("\n=== Done. If (2) shows instagram_business_account and imgbb URL works, run the main post script with SOCIAL_DEBUG_IG=1 for full Graph errors. ===");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
