// app.js
import {
  API_BASE,
  REFRESH_INTERVAL_MS,
  YOUTUBE_LIVE_ID,
  WEATHER_FALLBACK
} from "./settings.js";

/* =======================
   INFINITE SCROLL CONFIG
======================= */
const PAGE_SIZE = 12;         // how many to add per scroll
const MAX_LIMIT = 150;        // backend browse cap
let loadedLimit = PAGE_SIZE;  // current limit for infinite
let infiniteObserver = null;
let infiniteSentinel = null;
let homeObserver = null;
let homeSentinel = null;

/* =======================
   DOM
======================= */
const els = {
  navLinks: document.querySelectorAll(".nav-link"),
  form: document.getElementById("searchForm"),
  q: document.getElementById("q"),
  status: document.getElementById("status"),
  home: document.getElementById("home"),
  results: document.getElementById("results"),
};

let currentFeed = "";      // "" = Home; else feed
let currentView = "home";  // "home" | "match-center"
const HOME_LIMIT = 80;
const HOME_FEEDS = ["politics","football","celebrity"];
let homeLoadedLimit = 24; // per-feed limit for home (infinite)
const POLL_MS = Number.isFinite(REFRESH_INTERVAL_MS) ? REFRESH_INTERVAL_MS : 30 * 60 * 1000;

const FEED_TITLES = {
  politics: "Politics",
  football: "Football",
  celebrity: "Celebrity",
};

/* =======================
   UTILS
======================= */
function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  }[c]));
}
function stripTags(html) {
  const tmp = document.createElement("div");
  tmp.innerHTML = html || "";
  return (tmp.textContent || tmp.innerText || "").trim();
}
function fmtTime(iso) {
  if (!iso) return "";
  try { return new Date(iso).toLocaleString(); } catch { return ""; }
}
function isLogoish(url) {
  const s = String(url || "").toLowerCase();
  return s.includes("logo") || s.includes("favicon") || s.includes("sprite") ||
         s.includes("placeholder") || s.includes("default") || s.includes("brand") ||
         s.endsWith(".svg");
}
function makePlaceholder(label = "News") {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#0f1720"/><stop offset="100%" stop-color="#1e2935"/></linearGradient></defs>
      <rect width="100%" height="100%" fill="url(#g)"/>
      <g font-family="Inter, Segoe UI, Roboto, Arial, sans-serif" fill="#ff7a00" text-anchor="middle">
        <text x="50%" y="45%" font-size="84" font-weight="800">RADIANT</text>
        <text x="50%" y="58%" font-size="38" fill="#e5e7eb">${label}</text>
      </g>
    </svg>`;
  return "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(svg);
}
function makeSlug(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/** GitHub Pages-safe base URL (keeps /radiant-waves/) */
function baseSiteUrl() {
  return `${location.origin}${location.pathname}`;
}

/**
 * INTERNAL ARTICLE URL:
 * We include BOTH:
 * - article=slug-id (pretty)
 * - u=encodedOriginalUrl (so we can fetch full content reliably from backend)
 */
// function internalArticleUrl(a) {
//   const base = makeSlug(a.slug || a.title || "article");
//   const id = String(a.id || a.ingestedAt || Date.now());
//   const src = a.url ? `&u=${encodeURIComponent(a.url)}` : "";
//   return `${baseSiteUrl()}?article=${encodeURIComponent(`${base}-${id}`)}${src}`;
// }
function internalArticleUrl(a) {
  // Use backend SSR page (has OG tags for sharing)
  if (a?.id) return `${API_BASE}/r/${encodeURIComponent(a.id)}`; // redirects to /read/<slug>?id=<id>
  return a?.url || "#"; // fallback
}

function getArticleParams() {
  const p = new URLSearchParams(location.search);
  return {
    key: p.get("article") || "",
    srcUrl: p.get("u") || ""
  };
}

function navigateTo(url) {
  history.pushState({}, "", url);
  safeLoad();
}

function clearArticleRoute() {
  const p = new URLSearchParams(location.search);
  p.delete("article");
  p.delete("u");
  const next = p.toString();
  history.pushState({}, "", `${baseSiteUrl()}${next ? `?${next}` : ""}`);
}

/* =======================
   FETCH
======================= */
async function fetchJSON(u) {
  const url = (u instanceof URL) ? u : new URL(u, API_BASE);
  url.searchParams.set("_t", Date.now());
  const res = await fetch(url.toString(), { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
async function fetchJSONRelaxed(u, fallback = []) {
  try { return await fetchJSON(u); }
  catch { return Array.isArray(fallback) ? fallback : fallback; }
}

/* =======================
   IMAGE PIPE
======================= */
function proxied(u) { return `${API_BASE}/img?url=${encodeURIComponent(u)}`; }

async function resolveImageFor(imgEl, articleUrl) {
  try {
    const { imageUrl } = await fetchJSON(`${API_BASE}/pick_image?url=${encodeURIComponent(articleUrl)}`);
    if (imageUrl && !isLogoish(imageUrl)) {
      imgEl.src = proxied(imageUrl);
      imgEl.dataset.lazy = "0";
    }
  } catch {}
}
function hydrateLazyImages(root) {
  const imgs = (root || document).querySelectorAll('img[data-lazy="1"]');
  imgs.forEach(img => {
    const url = img.dataset.articleUrl;
    if (url) resolveImageFor(img, url);
  });
}

/* =======================
   SHARE (FB/WA + Copy; IG/TikTok = copy + open)
======================= */
function sharePayloadFromDataset(btn) {
  const url = btn?.dataset?.url || "";
  const title = btn?.dataset?.title || "Radiant Waves";
  return { url, title, text: title };
}

function shareUrls({ url, title }) {
  const u = encodeURIComponent(url);
  const t = encodeURIComponent(title);
  return {
    whatsapp: `https://wa.me/?text=${t}%20${u}`,
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${u}`,
    instagram: `https://www.instagram.com/`,
    tiktok: `https://www.tiktok.com/`,
  };
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      return true;
    } catch {
      return false;
    }
  }
}

function closeAllShareMenus() {
  document.querySelectorAll(".rw-share-menu").forEach(m => m.remove());
}

function openShareMenu(btn) {
  closeAllShareMenus();

  const { url, title } = sharePayloadFromDataset(btn);
  if (!url) return;

  const links = shareUrls({ url, title });
  const menu = document.createElement("div");
  menu.className = "rw-share-menu";
  menu.innerHTML = `
    <button class="rw-share-item" data-act="native" type="button">Share…</button>
    <button class="rw-share-item" data-act="copy" type="button">Copy link</button>
    <a class="rw-share-item" data-act="wa" href="${links.whatsapp}" target="_blank" rel="noopener">WhatsApp</a>
    <a class="rw-share-item" data-act="fb" href="${links.facebook}" target="_blank" rel="noopener">Facebook</a>
    <button class="rw-share-item" data-act="ig" type="button">Instagram</button>
    <button class="rw-share-item" data-act="tt" type="button">TikTok</button>
  `;

  const rect = btn.getBoundingClientRect();
  menu.style.position = "fixed";
  menu.style.zIndex = "9999";
  menu.style.minWidth = "170px";
  menu.style.borderRadius = "10px";
  menu.style.boxShadow = "0 12px 30px rgba(0,0,0,.15)";
  menu.style.background = "#fff";
  menu.style.border = "1px solid rgba(0,0,0,.08)";
  menu.style.padding = "8px";
  menu.style.display = "grid";
  menu.style.gap = "6px";

  const top = Math.min(window.innerHeight - 12, rect.bottom + 8);
  const left = Math.min(window.innerWidth - 12, rect.left);
  menu.style.top = `${Math.max(12, top)}px`;
  menu.style.left = `${Math.max(12, left)}px`;

  menu.querySelectorAll(".rw-share-item").forEach(el => {
    el.style.display = "flex";
    el.style.alignItems = "center";
    el.style.justifyContent = "center";
    el.style.gap = "8px";
    el.style.padding = "10px 10px";
    el.style.borderRadius = "10px";
    el.style.border = "1px solid rgba(0,0,0,.08)";
    el.style.background = "#fff";
    el.style.cursor = "pointer";
    el.style.textDecoration = "none";
    el.style.color = "#111";
    el.style.fontWeight = "700";
    el.style.fontSize = "13px";
  });

  document.body.appendChild(menu);

  menu.addEventListener("click", async (e) => {
    const el = e.target.closest(".rw-share-item");
    if (!el) return;

    const act = el.dataset.act;

    if (act === "native") {
      if (navigator.share) {
        try { await navigator.share({ title, text: title, url }); } catch {}
      } else {
        await copyToClipboard(url);
      }
      closeAllShareMenus();
      return;
    }

    if (act === "copy") {
      await copyToClipboard(url);
      closeAllShareMenus();
      return;
    }

    if (act === "ig") {
      await copyToClipboard(url);
      window.open(links.instagram, "_blank", "noopener");
      closeAllShareMenus();
      return;
    }

    if (act === "tt") {
      await copyToClipboard(url);
      window.open(links.tiktok, "_blank", "noopener");
      closeAllShareMenus();
      return;
    }

    closeAllShareMenus();
  });

  setTimeout(() => {
    const onDoc = (ev) => {
      if (!menu.contains(ev.target) && ev.target !== btn) closeAllShareMenus();
    };
    const onKey = (ev) => {
      if (ev.key === "Escape") closeAllShareMenus();
    };
    document.addEventListener("click", onDoc, { once: true });
    document.addEventListener("keydown", onKey, { once: true });
  }, 0);
}

/* =======================
   CARDS
======================= */
function shareBtnHtml(a) {
  const title = escapeHtml(stripTags(a.title || "Radiant Waves"));
  const url = escapeHtml(internalArticleUrl(a));
  return `
    <button class="rw-share-btn" type="button"
      aria-label="Share"
      data-title="${title}"
      data-url="${url}"
      style="margin-left:auto;border:1px solid rgba(0,0,0,.08);background:#fff;border-radius:999px;
             padding:8px 10px;cursor:pointer;font-weight:800;font-size:12px;">
      Share
    </button>
  `;
}

function cardHtml(a, { sectionLabel = "News" } = {}) {
  const titleText = stripTags(a.title || "(untitled)");
  const summaryText = stripTags(a.summary || "").slice(0, 240);

  let imgSrc = "";
  let lazyAttr = "";
  if (a.imageUrl && !isLogoish(a.imageUrl)) {
    imgSrc = proxied(a.imageUrl);
  } else {
    imgSrc = makePlaceholder(sectionLabel);
    lazyAttr = ` data-lazy="1" data-article-url="${escapeHtml(a.url || "")}"`;
  }

  const href = internalArticleUrl(a);

  return `
    <li class="card">
      <div class="thumb-wrap">
        <img class="thumb" src="${imgSrc}" alt="" loading="lazy" decoding="async"
             onerror="this.dataset.fallback='1'; this.src='${makePlaceholder(sectionLabel)}';"${lazyAttr}>
        <div class="headline-overlay">
          <a class="title headline-title" href="${href}" rel="noopener">${escapeHtml(titleText)}</a>
        </div>
      </div>
      <div class="content">
        <div class="meta" style="display:flex;align-items:center;gap:10px;">
          <span>${escapeHtml(a.source || "")} • ${fmtTime(a.publishedAt)}</span>
          ${shareBtnHtml(a)}
        </div>
        <p class="summary">${escapeHtml(summaryText)}</p>
      </div>
    </li>`;
}

function renderEmptyState(container, msg = "No articles available right now.") {
  container.innerHTML = `<li class="card" style="padding:16px; text-align:center;">${escapeHtml(msg)}</li>`;
}

/* =======================
   ARTICLE READER (FULL VIEW)
======================= */
async function fetchArticleByUrl(sourceUrl) {
  if (!sourceUrl) return null;

  const attempts = [
    `${API_BASE}/article?url=${encodeURIComponent(sourceUrl)}`,
    `${API_BASE}/read?url=${encodeURIComponent(sourceUrl)}`,
    `${API_BASE}/extract?url=${encodeURIComponent(sourceUrl)}`,
  ];

  for (const u of attempts) {
    try {
      const data = await fetchJSON(u);
      if (data && typeof data === "object") return data;
    } catch {}
  }
  return null;
}

function normalizeArticlePayload(raw, fallback = {}) {
  const title = stripTags(raw?.title || fallback?.title || "Article");
  const source = raw?.source || fallback?.source || "";
  const publishedAt = raw?.publishedAt || fallback?.publishedAt || fallback?.ingestedAt || "";
  const author = raw?.author || "";
  const imageUrl = raw?.imageUrl || raw?.image || fallback?.imageUrl || "";
  const summary = stripTags(raw?.summary || raw?.description || fallback?.summary || "");

  // content fields your backend might return
  const contentText =
    stripTags(raw?.content || raw?.body || raw?.text || raw?.article || raw?.html || "");

  return { title, source, publishedAt, author, imageUrl, summary, contentText };
}

async function showArticleView(articleKey, sourceUrl = "") {
  stopInfiniteScroll();
  stopHomeInfinite();
  closeAllShareMenus();

  els.status.textContent = "Loading article…";

  // Hide results; render into home container
  els.results.innerHTML = "";
  els.results.style.display = "none";
  els.home.style.display = "";

  // Minimal fallback object (in case backend returns partial)
  const fallback = { title: articleKey, url: sourceUrl };

  const raw = await fetchArticleByUrl(sourceUrl);
  const a = normalizeArticlePayload(raw || {}, fallback);

  // If backend didn’t give image, try pick_image using original url
  let heroImg = a.imageUrl;
  if (!heroImg && sourceUrl) {
    try {
      const picked = await fetchJSON(`${API_BASE}/pick_image?url=${encodeURIComponent(sourceUrl)}`);
      if (picked?.imageUrl && !isLogoish(picked.imageUrl)) heroImg = picked.imageUrl;
    } catch {}
  }

  const heroSrc = heroImg && !isLogoish(heroImg) ? proxied(heroImg) : makePlaceholder("Article");

  // If backend didn't extract content, we still show summary + a "Read original" button
  const hasContent = Boolean((a.contentText || "").trim().length);

  els.home.innerHTML = `
    <section class="rw-article" style="max-width:980px;margin:16px auto;padding:0 12px;">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">
        <button id="rwBackBtn" type="button"
          style="border:1px solid rgba(0,0,0,.10);background:#fff;border-radius:999px;padding:8px 12px;cursor:pointer;font-weight:800;">
          ← Back
        </button>

        <button class="rw-share-btn" type="button"
          data-title="${escapeHtml(a.title)}"
          data-url="${escapeHtml(location.href)}"
          style="margin-left:auto;border:1px solid rgba(0,0,0,.10);background:#fff;border-radius:999px;padding:8px 12px;cursor:pointer;font-weight:800;">
          Share
        </button>
      </div>

      <article style="background:var(--card,#fff);border:1px solid rgba(0,0,0,.06);border-radius:16px;overflow:hidden;box-shadow:var(--shadow,0 12px 30px rgba(0,0,0,.10));">
        <img src="${heroSrc}" alt="" style="width:100%;height:360px;object-fit:cover;display:block;"
             onerror="this.src='${makePlaceholder("Article")}';">

        <div style="padding:16px 16px 18px;">
          <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;color:#667085;font-size:13px;font-weight:700;">
            <span>${escapeHtml(a.source || "")}</span>
            <span>•</span>
            <span>${escapeHtml(fmtTime(a.publishedAt))}</span>
            ${a.author ? `<span>•</span><span>${escapeHtml(a.author)}</span>` : ``}
          </div>

          <h1 style="margin:10px 0 10px;font-size:clamp(22px,4vw,34px);line-height:1.15;">
            ${escapeHtml(a.title)}
          </h1>

          ${a.summary ? `<p style="margin:0 0 14px;color:#344054;font-size:16px;line-height:1.55;">${escapeHtml(a.summary)}</p>` : ""}

          ${
            hasContent
              ? `<div style="color:#101828;font-size:16px;line-height:1.75;white-space:pre-wrap;">${escapeHtml(a.contentText)}</div>`
              : `<div style="margin-top:10px;color:#667085;font-size:14px;">
                   Full content isn’t available from the extractor yet.
                 </div>
                 ${sourceUrl ? `
                   <div style="margin-top:12px;">
                     <a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener"
                        style="display:inline-flex;align-items:center;gap:8px;border:1px solid rgba(0,0,0,.10);background:#fff;border-radius:999px;padding:10px 14px;font-weight:900;text-decoration:none;color:#111;">
                       Read original source →
                     </a>
                   </div>` : ``}
                `
          }
        </div>
      </article>
    </section>
  `;

  const backBtn = document.getElementById("rwBackBtn");
  if (backBtn) {
    backBtn.addEventListener("click", () => {
      // If user came directly from a shared link, just go home
      clearArticleRoute();
      currentView = "home";
      currentFeed = "";
      els.q.value = "";
      els.navLinks.forEach(a => {
        a.classList.remove("active");
        a.removeAttribute("aria-current");
      });
      const homeLink = [...els.navLinks].find(x => (x.dataset.feed || "") === "");
      if (homeLink) {
        homeLink.classList.add("active");
        homeLink.setAttribute("aria-current", "page");
      }
      safeLoad();
    });
  }

  els.status.textContent = "";
}

/* =======================
   HOME BLOCKS (breaking/top/latest/weather/broadcast)
======================= */
function scoreBreaking(a) {
  const t = (a?.title || "").toLowerCase();
  const s = (a?.summary || "").toLowerCase();
  const txt = `${t} ${s}`;

  let score = 0;
  const ageMins = (() => {
    try {
      const d = new Date(a.publishedAt || a.ingestedAt || Date.now());
      return Math.max(0, (Date.now() - d.getTime()) / 60000);
    } catch { return 999999; }
  })();

  score += Math.max(0, 600 - ageMins);
  const hot = ["breaking", "alert", "just in", "live", "exclusive", "major", "update", "confirmed", "crisis"];
  hot.forEach(k => { if (txt.includes(k)) score += 120; });
  score += Math.min(60, (a.title || "").length);
  if (a.imageUrl && !isLogoish(a.imageUrl)) score += 40;

  return score;
}

function pickTopStories(all, n = 6) {
  const pool = all;
  const seen = new Set();
  const out = [];
  for (const a of pool) {
    const k = (a.title || "").toLowerCase().trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(a);
    if (out.length >= n) break;
  }
  return out;
}

function pickLatestTextOnly(all, n = 6) {
  const out = [];
  const seen = new Set();
  for (const a of all) {
    const noImg = !a.imageUrl || isLogoish(a.imageUrl);
    if (!noImg) continue;
    const k = (a.title || "").toLowerCase().trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(a);
    if (out.length >= n) break;
  }
  return out;
}

async function getWeather() {
  const fallback = WEATHER_FALLBACK || { name: "Lagos", lat: 6.5244, lon: 3.3792 };

  const coords = await new Promise(resolve => {
    if (!navigator.geolocation) return resolve(fallback);
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ name: "Your location", lat: pos.coords.latitude, lon: pos.coords.longitude }),
      () => resolve(fallback),
      { enableHighAccuracy: false, timeout: 4000, maximumAge: 60_000 }
    );
  });

  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", coords.lat);
  url.searchParams.set("longitude", coords.lon);
  url.searchParams.set("current", "temperature_2m,weather_code,wind_speed_10m");
  url.searchParams.set("timezone", "auto");

  try {
    const r = await fetch(url.toString(), { cache: "no-store" });
    const data = await r.json();
    const cur = data?.current || {};
    return { ok: true, name: coords.name, temp: cur.temperature_2m, wind: cur.wind_speed_10m, code: cur.weather_code };
  } catch {
    return { ok: false, name: coords.name };
  }
}

function weatherText(code) {
  const map = {
    0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Overcast",
    45: "Fog", 48: "Rime fog",
    51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle",
    61: "Light rain", 63: "Rain", 65: "Heavy rain",
    71: "Light snow", 73: "Snow", 75: "Heavy snow",
    80: "Rain showers", 81: "Showers", 82: "Violent showers",
    95: "Thunderstorm",
  };
  return map[code] || "Weather";
}

function mixByFeed(items, feeds) {
  const order = (Array.isArray(feeds) && feeds.length) ? feeds : ["politics","football","celebrity"];
  const buckets = {}; order.forEach(f => buckets[f] = []);
  const rest = [];
  for (const a of (items || [])) {
    const f = String((a && a.feed) || "").toLowerCase();
    if (buckets[f]) buckets[f].push(a); else rest.push(a);
  }
  const outArr = [];
  while (outArr.length < (items || []).length) {
    let added = false;
    for (const f of order) {
      if (buckets[f].length) { outArr.push(buckets[f].shift()); added = true; }
    }
    if (!added) break;
  }
  const merged = outArr.concat(order.flatMap(f => buckets[f])).concat(rest);
  const seen = new Set();
  const final = [];
  for (const a of merged) {
    const k = String((a && a.title) || "").toLowerCase().trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    final.push(a);
  }
  return final;
}

async function loadHome() {
  stopInfiniteScroll();

  els.status.textContent = "Loading…";

  const per = Math.max(6, Math.min(homeLoadedLimit, HOME_LIMIT));
  const lists = await Promise.all(
    HOME_FEEDS.map(feed => fetchJSONRelaxed(`${API_BASE}/articles?feed=${feed}&limit=${per}`, []))
  );
  const all = lists.flat();
  all.sort((a,b) => new Date(b.publishedAt||b.ingestedAt||0) - new Date(a.publishedAt||a.ingestedAt||0));
  const mixed = mixByFeed(all, HOME_FEEDS);
  els.status.textContent = "";

  const breaking = [...mixed].sort((a, b) => scoreBreaking(b) - scoreBreaking(a))[0];
  const topStories = pickTopStories(mixed, 150);
  const heroStories = topStories.slice(0, 4);
  const moreStories = topStories.slice(4);
  const moreGrid = moreStories.length ? moreStories.map(a => cardHtml(a, { sectionLabel: "News" })).join("") : "";
  const latestText = pickLatestTextOnly(mixed, 7);
  const weather = await getWeather();

  const yt = (YOUTUBE_LIVE_ID || "").trim();
  const broadcastVideo = yt
    ? `<iframe src="https://www.youtube.com/embed/${encodeURIComponent(yt)}?autoplay=0&mute=0"
         title="Radiant Waves Live"
         allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
         allowfullscreen
         style="width:100%;height:500px;border:0;display:block;"></iframe>`
    : `<div class="broadcast-fallback" style="height:500px;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#fff;">
         <i class="fab fa-youtube" style="font-size:54px;color:#ff2a2a;margin-bottom:12px;"></i>
         <h3 style="margin:0 0 6px;">Live Broadcast</h3>
         <p style="margin:0;color:rgba(255,255,255,.8);text-align:center;max-width:520px;padding:0 16px;">
           Set <b>YOUTUBE_LIVE_ID</b> in <b>settings.js</b> to show your stream here.
         </p>
       </div>`;

  const breakingHtml = breaking ? `
    <div class="breaking-news">
      <h3><i class="fas fa-exclamation-circle"></i> BREAKING</h3>
      <a href="${internalArticleUrl(breaking)}" rel="noopener">${escapeHtml(stripTags(breaking.title))}</a>
      <p>${escapeHtml(stripTags(breaking.summary || "").slice(0, 140))}</p>
      <div style="margin-top:10px;display:flex;gap:10px;align-items:center;">
        ${shareBtnHtml(breaking)}
      </div>
    </div>
  ` : "";

  const weatherHtml = `
    <div class="weather-widget">
      <div class="weather-header">
        <h3><i class="fas fa-cloud-sun"></i> Weather</h3>
        <span class="weather-meta">${escapeHtml(weather.name || "Location")}</span>
      </div>
      ${
        weather.ok
          ? `<div class="weather-info">
               <div class="temperature">${Math.round(weather.temp)}°</div>
               <div class="weather-meta">
                 <div>${escapeHtml(weatherText(weather.code))}</div>
                 <div><i class="fas fa-wind"></i> Wind: ${Math.round(weather.wind)} km/h</div>
               </div>
             </div>`
          : `<div class="weather-meta">Weather unavailable right now.</div>`
      }
    </div>
  `;

  const heroGrid = heroStories.length
    ? heroStories.map(a => {
        const title = stripTags(a.title || "");
        const sum = stripTags(a.summary || "");
        const img = a.imageUrl && !isLogoish(a.imageUrl) ? proxied(a.imageUrl) : makePlaceholder("Top");
        const feed = escapeHtml((a.feed || "").toUpperCase() || "TOP");
        return `
          <article class="news-card">
            <a target="_blank" rel="noopener" rel="noopener" aria-label="${escapeHtml(title)}">
              <img src="${img}" alt="" loading="lazy" decoding="async"
                   ${(!a.imageUrl || isLogoish(a.imageUrl)) ? `data-lazy="1" data-article-url="${escapeHtml(a.url || "")}"` : ""}>
            </a>
            <div class="news-card-content">
              <div class="news-category">${feed}</div>
              <h3>
                <a target="_blank" rel="noopener" rel="noopener" style="text-decoration:none;color:inherit;">
                  ${escapeHtml(title)}
                </a>
              </h3>
              <p>${escapeHtml(sum)}</p>
              <div class="news-meta" style="display:flex;gap:10px;align-items:center;">
                <span><i class="far fa-clock"></i> ${escapeHtml(fmtTime(a.publishedAt))}</span>
                <span style="opacity:.8;">${escapeHtml(a.source || "")}</span>
                ${shareBtnHtml(a)}
              </div>
            </div>
          </article>
        `;
      }).join("")
    : `<div class="card" style="padding:14px;">No top stories yet.</div>`;

  const latestList = latestText.length
    ? latestText.map(a => {
        const title = stripTags(a.title || "");
        const sum = stripTags(a.summary || "");
        return `
          <li style="display:flex;gap:10px;align-items:flex-start;justify-content:space-between;">
            <div style="min-width:0;">
              <a target="_blank" rel="noopener" rel="noopener" style="font-weight:800;color:#111;text-decoration:none;">
                ${escapeHtml(title)}
              </a>
              <div class="small" style="margin-top:4px;color:#666;font-size:13px;">
                ${escapeHtml(sum)}
              </div>
            </div>
            <div style="flex:0 0 auto;">
              ${shareBtnHtml(a)}
            </div>
          </li>
        `;
      }).join("")
    : `<li style="padding:12px 14px; color: var(--muted);">No text-only updates.</li>`;

  els.home.innerHTML = `
    <div class="home-shell">
      <div class="main-content">
        <div class="left-column">
          <section class="live-broadcast">
            <div class="rw-section-title">
              <h2>Live Broadcast</h2>
              <span class="rw-badge">LIVE</span>
            </div>
            <div class="broadcast-card">
              <div class="broadcast-video" style="background:#000;">
                ${broadcastVideo}
              </div>
              <div class="broadcast-info">
                <div>
                  <h3>Radiant Waves Live</h3>
                  <p>Breaking updates • Top stories • Football coverage</p>
                </div>
                <div class="broadcast-stats">
                  <span><i class="fas fa-signal"></i> ${yt ? "Online" : "Offline"}</span>
                  <span>
                    <button class="rw-share-btn" type="button"
                      data-title="Radiant Waves Live"
                      data-url="${escapeHtml(location.href)}"
                      style="border:1px solid rgba(0,0,0,.08);background:#fff;border-radius:999px;padding:8px 10px;cursor:pointer;font-weight:800;font-size:12px;">
                      Share
                    </button>
                  </span>
                </div>
              </div>
            </div>
          </section>

          <section class="top-news">
            <div class="rw-section-title">
              <h2>Top Stories</h2>
            </div>
            <div class="top-news-grid">
              ${heroGrid}
            </div>
          </section>
        </div>

        <div class="right-column">
          ${breakingHtml}
          ${weatherHtml}

          <section class="news-sidebar">
            <div class="rw-section-title">
              <h2>Latest Updates</h2>
            </div>
            <ul class="sidebar-list">
              ${latestList}
            </ul>
          </section>
        </div>
      </div>
    </div>
  `;

  const shell = els.home.querySelector(".home-shell");
  if (shell && moreGrid) {
    const sec = document.createElement("section");
    sec.className = "rw-more-wrapper";
    sec.innerHTML = `
      <div class="rw-section-title">
        <h2>More Stories</h2>
      </div>
      <ul class="rw-more-grid">${moreGrid}</ul>
    `;
    shell.appendChild(sec);
  }

  hydrateLazyImages(els.home);
  setupHomeInfinite();

  els.results.innerHTML = "";
  els.results.style.display = "none";
  els.home.style.display = "";
}

/* =======================
   INFINITE SCROLL (Feed/Search only)
======================= */
function stopHomeInfinite() {
  if (homeObserver) { homeObserver.disconnect(); homeObserver = null; }
  if (homeSentinel) { homeSentinel.remove(); homeSentinel = null; }
}

function setupHomeInfinite() {
  stopHomeInfinite();
  if (els.home.style.display === "none") return;
  if (homeLoadedLimit >= HOME_LIMIT) return;

  homeSentinel = document.createElement("div");
  homeSentinel.id = "homeSentinel";
  homeSentinel.style.height = "1px";
  homeSentinel.style.width = "100%";
  homeSentinel.style.margin = "16px 0";
  els.home.appendChild(homeSentinel);

  homeObserver = new IntersectionObserver(async (entries) => {
    if (!entries.some(e => e.isIntersecting)) return;
    if (inflight) return;
    const next = Math.min(homeLoadedLimit + PAGE_SIZE, HOME_LIMIT);
    if (next === homeLoadedLimit) return;
    const prevY = window.scrollY;
    homeLoadedLimit = next;
    await loadHome();
    window.scrollTo(0, prevY);
  }, { rootMargin: "900px 0px" });

  homeObserver.observe(homeSentinel);
}

function stopInfiniteScroll() {
  if (infiniteObserver) {
    infiniteObserver.disconnect();
    infiniteObserver = null;
  }
  if (infiniteSentinel) {
    infiniteSentinel.remove();
    infiniteSentinel = null;
  }
}

function setupInfiniteScroll(currentCount) {
  stopInfiniteScroll();
  if (els.results.style.display === "none") return;
  if (currentCount >= MAX_LIMIT) return;

  infiniteSentinel = document.createElement("div");
  infiniteSentinel.id = "infiniteSentinel";
  infiniteSentinel.style.height = "1px";
  infiniteSentinel.style.width = "100%";
  infiniteSentinel.style.margin = "12px 0 0";
  els.results.parentElement.appendChild(infiniteSentinel);

  infiniteObserver = new IntersectionObserver(async (entries) => {
    if (!entries.some(e => e.isIntersecting)) return;

    const next = Math.min(loadedLimit + PAGE_SIZE, MAX_LIMIT);
    if (next === loadedLimit) return;

    loadedLimit = next;

    if (inflight) return;
    await loadFeed({ append: true });
  }, { rootMargin: "900px 0px" });

  infiniteObserver.observe(infiniteSentinel);
}

/* =======================
   FEED/SEARCH VIEW
======================= */
async function loadFeed({ append = false } = {}) {
  if (currentView === "match-center") return;

  const q = els.q.value.trim();

  if (!append) loadedLimit = PAGE_SIZE;

  const url = new URL(`${API_BASE}/articles`);
  if (q) url.searchParams.set("q", q);
  if (currentFeed) url.searchParams.set("feed", currentFeed);
  url.searchParams.set("limit", String(Math.min(loadedLimit, MAX_LIMIT)));

  if (!append) els.status.textContent = "Loading…";

  const items = await fetchJSONRelaxed(url, []);
  const label = FEED_TITLES[currentFeed] || (q ? "Results" : "News");

  els.home.innerHTML = "";
  els.home.style.display = "none";

  els.results.innerHTML = items.map(a => cardHtml(a, { sectionLabel: label })).join("");
  els.results.style.display = "";

  if (!items.length) renderEmptyState(els.results, "Nothing to show yet.");
  hydrateLazyImages(els.results);

  els.status.textContent = q ? `${items.length} result(s)` : `${items.length} latest`;

  setupInfiniteScroll(items.length);
}

/* =======================
   MATCH CENTER (unchanged)
======================= */
async function showMatchCenterShell() {
  stopInfiniteScroll();

  els.status.textContent = "Loading Match Center…";
  els.results.style.display = "none";
  els.home.style.display = "";
  els.home.innerHTML = `
    <div class="mc-wrap">
      <div class="mc-head">
        <h2>Match Center</h2>
        <div class="mc-tools">
          <span id="mcState">Loading…</span>
          <button id="mcRefreshBtn" class="mc-tab" type="button">Refresh</button>
        </div>
      </div>

      <div class="mc-tabs">
        <button class="mc-tab active" data-tab="live" type="button">Live</button>
        <button class="mc-tab" data-tab="predictions" type="button">Predictions</button>
        <button class="mc-tab" data-tab="analysis" type="button">Analysis</button>
      </div>

      <div class="mc-grid">
        <ul id="mcList" class="mc-list"></ul>

        <div id="mcPanel" class="mc-panel">
          <h3>Select a match</h3>
          <div class="mc-kv">Pick a fixture on the left to see predictions + analysis tools.</div>
          <div class="mc-hint">Your picks + notes are saved on this device (localStorage).</div>
        </div>
      </div>
    </div>
  `;

  const mc = { tab: "live", selectedId: null, items: [] };
  const $ = (sel) => els.home.querySelector(sel);

  const listEl = $("#mcList");
  const panelEl = $("#mcPanel");
  const stateEl = $("#mcState");
  const refreshBtn = $("#mcRefreshBtn");

  if (!listEl || !panelEl || !stateEl || !refreshBtn) {
    els.status.textContent = "Match Center UI mount failed.";
    return;
  }

  const STORE_KEY = "rw_mc_matches_v1";
  function loadMatches() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  }
  function saveMatches(arr) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(arr || [])); } catch {}
  }
  function uid() {
    return `m_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }
  function upsertMatch(patch) {
    const all = loadMatches();
    const i = all.findIndex(m => m.id === patch.id);
    if (i >= 0) all[i] = { ...all[i], ...patch, updatedAt: Date.now() };
    else all.unshift({ ...patch, id: patch.id || uid(), createdAt: Date.now(), updatedAt: Date.now() });
    saveMatches(all);
    return all;
  }
  function removeMatch(id) {
    const all = loadMatches().filter(m => m.id !== id);
    saveMatches(all);
    return all;
  }

  const SCOREBAT_IFRAME = `
    <div class="broadcast-container" style="margin-top:12px;">
      <iframe
        src="https://www.scorebat.com/embed/livescore/?token=MjY4NjcyXzE3Njc5NTI1MzlfNTkxNDI3ZDY0YmQyZTk5MzJkMWQ4YmQ4NzYxZmZkNjJhZTcyMTU5NA=="
        frameborder="0"
        allowfullscreen
        allow="autoplay; fullscreen"
        loading="lazy"
        style="width:100%;height:760px;border:0;overflow:hidden;display:block;"
      ></iframe>
    </div>
  `;

  function safeText(s) { return escapeHtml(String(s || "").trim()); }
  function fmtKickoff(ts) {
    if (!ts) return "";
    try {
      const d = new Date(ts);
      if (Number.isNaN(d.getTime())) return "";
      return d.toLocaleString([], { weekday: "short", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    } catch { return ""; }
  }

  function renderList() {
    if (mc.tab === "live") {
      listEl.innerHTML = `
        <li class="mc-item">
          <div class="mc-row">
            <div class="mc-league">Live Scores</div>
            <div class="mc-time"></div>
          </div>
          <div class="mc-kv">Live fixtures are shown on the right (ScoreBat).</div>
          <div class="mc-hint">Use Predictions/Analysis to add matches and save notes.</div>
        </li>
      `;
      return;
    }

    const matches = loadMatches();

    if (!matches.length) {
      listEl.innerHTML = `
        <li class="mc-item">
          <div class="mc-row">
            <div class="mc-league">No saved matches</div>
          </div>
          <div class="mc-kv">Click “Add match” to start saving picks + analysis.</div>
        </li>
      `;
      return;
    }

    listEl.innerHTML = matches.map(m => {
      const selected = mc.selectedId === m.id ? `style="background: rgba(255,61,0,.06)"` : "";
      const pick = (m.pick || "").toUpperCase();
      const conf = m.confidence ? `${m.confidence}%` : "";
      const badge = pick ? ` <span class="mc-badge">${safeText(pick)} ${safeText(conf)}</span>` : "";
      return `
        <li class="mc-item" data-id="${safeText(m.id)}" ${selected}>
          <div class="mc-row">
            <div class="mc-league">${safeText(m.league || "Match")}${badge}</div>
            <div class="mc-time">${safeText(fmtKickoff(m.kickoff))}</div>
          </div>
          <div class="mc-teams">
            <div>${safeText(m.home)} vs ${safeText(m.away)}</div>
            <div class="mc-score">${safeText(m.score || "")}</div>
          </div>
        </li>
      `;
    }).join("");
  }

  function renderLivePanel() {
    panelEl.innerHTML = `
      <h3>Live Scores</h3>
      <div class="mc-kv">Powered by ScoreBat</div>
      ${SCOREBAT_IFRAME}
      <div class="mc-hint">If the embed doesn’t load, check network/adblocker.</div>
    `;
  }

  function renderAddMatchForm() {
    panelEl.innerHTML = `
      <h3>${mc.tab === "analysis" ? "Analysis" : "Predictions"}</h3>
      <div class="mc-kv">Add a match manually (saved on this device).</div>

      <div style="margin-top:12px; display:grid; gap:10px;">
        <div style="display:grid; gap:6px;">
          <label style="font-weight:700;">League (optional)</label>
          <input id="mcLeague" class="mc-notes" style="height:42px; padding:10px;" placeholder="e.g. EPL" />
        </div>

        <div style="display:grid; gap:6px;">
          <label style="font-weight:700;">Home Team</label>
          <input id="mcHome" class="mc-notes" style="height:42px; padding:10px;" placeholder="e.g. Arsenal" />
        </div>

        <div style="display:grid; gap:6px;">
          <label style="font-weight:700;">Away Team</label>
          <input id="mcAway" class="mc-notes" style="height:42px; padding:10px;" placeholder="e.g. Chelsea" />
        </div>

        <div style="display:grid; gap:6px;">
          <label style="font-weight:700;">Kickoff (optional)</label>
          <input id="mcKickoff" type="datetime-local" class="mc-notes" style="height:42px; padding:10px;" />
        </div>

        <div style="display:flex; gap:10px; margin-top:6px;">
          <button id="mcCreate" class="mc-tab" type="button">Save match</button>
          <button id="mcCancel" class="mc-tab" type="button">Cancel</button>
        </div>

        <div class="mc-hint">After saving, click the match on the left to add pick + notes.</div>
      </div>
    `;

    const leagueEl = $("#mcLeague");
    const homeEl = $("#mcHome");
    const awayEl = $("#mcAway");
    const kickoffEl = $("#mcKickoff");

    $("#mcCancel").addEventListener("click", () => {
      mc.selectedId = null;
      renderList();
      renderEmptyPanel();
    });

    $("#mcCreate").addEventListener("click", () => {
      const league = (leagueEl?.value || "").trim();
      const home = (homeEl?.value || "").trim();
      const away = (awayEl?.value || "").trim();
      const kickoff = kickoffEl?.value ? new Date(kickoffEl.value).getTime() : null;

      if (!home || !away) {
        stateEl.textContent = "Home & Away team are required.";
        return;
      }

      const m = { id: uid(), league, home, away, kickoff, pick: "", confidence: "", notes: "" };
      upsertMatch(m);
      mc.selectedId = m.id;

      stateEl.textContent = "Saved.";
      renderList();
      renderMatchPanel(m);
    });
  }

  function renderEmptyPanel() {
    panelEl.innerHTML = `
      <h3>${mc.tab === "analysis" ? "Analysis" : "Predictions"}</h3>
      <div class="mc-kv">Select a saved match on the left, or add a new one.</div>
      <div style="margin-top:12px;">
        <button id="mcAddMatch" class="mc-tab" type="button">Add match</button>
      </div>
      <div class="mc-hint">Everything is saved locally (no backend required).</div>
    `;
    $("#mcAddMatch").addEventListener("click", () => renderAddMatchForm());
  }

  function renderMatchPanel(m) {
    if (!m) return;

    const id = m.id;
    const savedPick = (m.pick || "").toUpperCase();
    const savedConf = m.confidence || "";
    const savedNote = m.notes || "";

    const header = `
      <h3>${safeText(m.home)} vs ${safeText(m.away)}</h3>
      <div class="mc-kv">
        ${safeText(m.league || "Match")}
        ${m.kickoff ? ` • <b>${safeText(fmtKickoff(m.kickoff))}</b>` : ""}
      </div>
    `;

    if (mc.tab === "predictions") {
      panelEl.innerHTML = `
        ${header}

        <div style="margin-top:10px; font-weight:900;">Your pick</div>
        <div class="mc-picks">
          <button class="mc-pick ${savedPick==="H"?"active":""}" data-pick="H" type="button">Home Win</button>
          <button class="mc-pick ${savedPick==="D"?"active":""}" data-pick="D" type="button">Draw</button>
          <button class="mc-pick ${savedPick==="A"?"active":""}" data-pick="A" type="button">Away Win</button>
        </div>

        <div style="margin-top:12px; font-weight:900;">Confidence (%)</div>
        <input id="mcConf" class="mc-notes" style="height:42px; padding:10px;" inputmode="numeric" placeholder="e.g. 65" value="${safeText(savedConf)}"/>

        <div style="margin-top:14px; display:flex; gap:10px; flex-wrap:wrap;">
          <button id="mcDelete" class="mc-tab" type="button">Delete match</button>
        </div>

        <div class="mc-hint">Auto-saved on this device.</div>
      `;

      panelEl.querySelectorAll(".mc-pick").forEach(btn => {
        btn.addEventListener("click", () => {
          const v = (btn.dataset.pick || "").toUpperCase();
          upsertMatch({ id, pick: v });
          renderList();
          const updated = loadMatches().find(x => x.id === id);
          renderMatchPanel(updated);
        });
      });

      const confEl = $("#mcConf");
      let t = null;
      if (confEl) {
        confEl.addEventListener("input", () => {
          clearTimeout(t);
          t = setTimeout(() => {
            let v = (confEl.value || "").replace(/[^\d]/g, "");
            if (v) v = String(Math.max(0, Math.min(100, Number(v))));
            confEl.value = v;
            upsertMatch({ id, confidence: v });
            renderList();
          }, 250);
        });
      }

      $("#mcDelete").addEventListener("click", () => {
        removeMatch(id);
        mc.selectedId = null;
        renderList();
        renderEmptyPanel();
      });

      stateEl.textContent = "Predictions ready.";
      return;
    }

    const analysisTemplate =
      `Quick read:\n` +
      `• Match: ${m.home} vs ${m.away}\n` +
      `${m.league ? `• League: ${m.league}\n` : ""}` +
      `${m.kickoff ? `• Kickoff: ${new Date(m.kickoff).toLocaleString()}\n` : ""}` +
      `\nNotes to consider:\n` +
      `• Form / injuries / motivation\n` +
      `• Home advantage, schedule, weather\n`;

    panelEl.innerHTML = `
      ${header}

      <div style="margin-top:12px; font-weight:900;">Analysis (editable)</div>
      <textarea id="mcNotes" class="mc-notes" placeholder="Write your match analysis...">${safeText(savedNote || analysisTemplate)}</textarea>

      <div style="margin-top:14px; display:flex; gap:10px; flex-wrap:wrap;">
        <button id="mcDelete" class="mc-tab" type="button">Delete match</button>
      </div>

      <div class="mc-hint">Auto-saved on this device.</div>
    `;

    const notes = $("#mcNotes");
    if (notes) {
      let t2 = null;
      notes.addEventListener("input", () => {
        clearTimeout(t2);
        t2 = setTimeout(() => {
          const v = notes.value || "";
          upsertMatch({ id, notes: v });
        }, 250);
      });
    }

    $("#mcDelete").addEventListener("click", () => {
      removeMatch(id);
      mc.selectedId = null;
      renderList();
      renderEmptyPanel();
    });

    stateEl.textContent = "Analysis ready.";
  }

  function renderPanelForTab() {
    if (mc.tab === "live") return renderLivePanel();

    const matches = loadMatches();
    if (!mc.selectedId) return renderEmptyPanel();

    const m = matches.find(x => x.id === mc.selectedId);
    if (!m) {
      mc.selectedId = null;
      return renderEmptyPanel();
    }
    renderMatchPanel(m);
  }

  async function loadTab() {
    stateEl.textContent = mc.tab === "live" ? "Live scores: ScoreBat embed" : "Saved matches (localStorage)";
    renderList();
    renderPanelForTab();
  }

  listEl.addEventListener("click", (e) => {
    const li = e.target.closest(".mc-item[data-id]");
    if (!li) return;
    mc.selectedId = li.dataset.id;
    renderList();
    renderPanelForTab();
  });

  els.home.querySelectorAll(".mc-tab[data-tab]").forEach(btn => {
    btn.addEventListener("click", async () => {
      els.home.querySelectorAll(".mc-tab[data-tab]").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      mc.tab = btn.dataset.tab || "live";
      if (mc.tab === "live") mc.selectedId = null;
      await loadTab();
    });
  });

  refreshBtn.addEventListener("click", () => loadTab());
  await loadTab();
}

/* =======================
   CONTROLLER
======================= */
let inflight = false;
let lastUpdated = null;

function markUpdated() {
  lastUpdated = new Date();
  const rwTime = document.getElementById("rwTime");
  if (rwTime) rwTime.textContent = lastUpdated.toLocaleTimeString();
}

async function safeLoad() {
  if (inflight) return;
  inflight = true;
  try {
    closeAllShareMenus();

    // ✅ ARTICLE ROUTE FIRST
    const { key, srcUrl } = getArticleParams();
    if (key) {
      await showArticleView(key, srcUrl);
      markUpdated();
      return;
    }

    if (currentView === "match-center") {
      await showMatchCenterShell();
    } else {
      const q = els.q.value.trim();
      if (!q && !currentFeed) {
        await loadHome();
      } else {
        await loadFeed({ append: false });
      }
    }

    markUpdated();
  } finally {
    inflight = false;
  }
}

/* =======================
   EVENTS
======================= */
els.navLinks.forEach(link => {
  link.addEventListener("click", (e) => {
    e.preventDefault();

    // clear article route if user clicks nav
    clearArticleRoute();

    if (link.dataset.view === "match-center") {
      currentView = "match-center";
      currentFeed = "";
      els.q.value = "";
    } else {
      currentView = "home";
      currentFeed = link.dataset.feed || "";
      if (!currentFeed) els.q.value = "";
    }

    els.navLinks.forEach(a => {
      a.classList.remove("active");
      a.removeAttribute("aria-current");
    });
    link.classList.add("active");
    link.setAttribute("aria-current", "page");

    stopHomeInfinite();
    safeLoad();
  });
});

els.form?.addEventListener("submit", (e) => {
  e.preventDefault();
  clearArticleRoute();
  currentView = "home";
  stopHomeInfinite();
  safeLoad();
});

// Share button handler
document.addEventListener("click", (e) => {
  const btn = e.target.closest(".rw-share-btn");
  if (!btn) return;
  e.preventDefault();
  openShareMenu(btn);
});

// ✅ Intercept internal article clicks to avoid “refresh back to home”
document.addEventListener("click", (e) => {
  const a = e.target.closest('a[href*="?article="]');
  if (!a) return;

  // only same-origin internal links
  if (!a.href.startsWith(location.origin)) return;

  e.preventDefault();
  navigateTo(a.getAttribute("href"));
});

// ✅ Handle browser back/forward
window.addEventListener("popstate", () => safeLoad());

/* =======================
   BOOT + REFRESH
======================= */
safeLoad();
setInterval(() => safeLoad(), POLL_MS);

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") safeLoad();
});
window.addEventListener("online", () => safeLoad());
