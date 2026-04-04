// tools/build-seo-pages.js
import fs from "fs";
import path from "path";
import admin from "firebase-admin";

function must(v, name) {
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

const SITE = "https://radiant-waves.com.ng";
const OUT_DIR = process.cwd(); // repo root
const NEWS_DIR = path.join(OUT_DIR, "news");

const saJson = JSON.parse(must(process.env.FIREBASE_SERVICE_ACCOUNT_JSON, "FIREBASE_SERVICE_ACCOUNT_JSON"));

admin.initializeApp({
  credential: admin.credential.cert(saJson),
});

const db = admin.firestore();

// change this to your real collection name
const COLLECTION = process.env.FIRESTORE_COLLECTION || "articles";

// safe slug helper
function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 120);
}

function esc(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function pageHtml({ url, title, description, image }) {
  const t = esc(title);
  const d = esc(description);
  const img = image ? esc(image) : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${t} | Radiant Waves</title>

  <link rel="canonical" href="${url}" />
  <meta name="robots" content="index,follow" />

  <meta name="description" content="${d}" />

  <meta property="og:site_name" content="Radiant Waves" />
  <meta property="og:type" content="article" />
  <meta property="og:title" content="${t}" />
  <meta property="og:description" content="${d}" />
  <meta property="og:url" content="${url}" />
  ${img ? `<meta property="og:image" content="${img}" />` : ""}

  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${t}" />
  <meta name="twitter:description" content="${d}" />
  ${img ? `<meta name="twitter:image" content="${img}" />` : ""}

  <!-- brand schema -->
  <script type="application/ld+json">
  ${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    headline: title,
    description,
    image: image ? [image] : undefined,
    mainEntityOfPage: url,
    publisher: {
      "@type": "Organization",
      name: "Radiant Waves",
      url: SITE
    }
  }).replace(/</g, "\\u003c")}
  </script>

  <meta http-equiv="refresh" content="0; url=/${url.replace(SITE + "/", "")}" />
</head>
<body>
  <noscript>
    <h1>${t}</h1>
    <p>${d}</p>
    <p><a href="${url}">Open article</a></p>
  </noscript>
</body>
</html>`;
}

function sitemapXml(urls) {
  const now = new Date().toISOString().slice(0, 10);
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url>
    <loc>${u}</loc>
    <lastmod>${now}</lastmod>
  </url>`).join("\n")}
</urlset>`;
}

function rssXml(items) {
  const now = new Date().toUTCString();
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Radiant Waves</title>
    <link>${SITE}</link>
    <description>Breaking news, match updates, predictions, and 24/7 live coverage.</description>
    <lastBuildDate>${now}</lastBuildDate>
${items.map(it => `    <item>
      <title>${esc(it.title)}</title>
      <link>${it.url}</link>
      <guid>${it.url}</guid>
      <pubDate>${new Date(it.date || Date.now()).toUTCString()}</pubDate>
      <description>${esc(it.description || "")}</description>
    </item>`).join("\n")}
  </channel>
</rss>`;
}

(async () => {
  console.log("Fetching Firestore docs...");
  const snap = await db.collection(COLLECTION).orderBy("publishedAt", "desc").limit(5000).get();

  if (!fs.existsSync(NEWS_DIR)) fs.mkdirSync(NEWS_DIR, { recursive: true });

  const urls = [SITE + "/"];
  const rssItems = [];

  for (const doc of snap.docs) {
    const data = doc.data() || {};

    const title = data.title || data.headline || "Radiant Waves";
    const desc = data.summary || data.excerpt || data.description || "Read more on Radiant Waves.";
    const image = data.image || data.imageUrl || data.ogImage || "";

    const slug = data.slug || slugify(title) || doc.id;
    const pagePath = path.join(NEWS_DIR, slug, "index.html");
    fs.mkdirSync(path.dirname(pagePath), { recursive: true });

    const url = `${SITE}/news/${slug}/`;
    urls.push(url);

    fs.writeFileSync(pagePath, pageHtml({ url, title, description: desc, image }), "utf8");

    rssItems.push({ title, url, description: desc, date: data.publishedAt || data.createdAt });
  }

  console.log("Writing sitemap.xml + rss.xml ...");
  fs.writeFileSync(path.join(OUT_DIR, "sitemap.xml"), sitemapXml(urls), "utf8");
  fs.writeFileSync(path.join(OUT_DIR, "rss.xml"), rssXml(rssItems.slice(0, 50)), "utf8");

  console.log(`Done. URLs: ${urls.length}`);
})();
