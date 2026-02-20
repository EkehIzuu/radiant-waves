# api.py
import os
# Silence noisy gRPC logs before importing Google libs
os.environ.setdefault("GRPC_VERBOSITY", "ERROR")
os.environ.setdefault("GRPC_TRACE", "")

import re
import json
import time
import gzip
import hashlib
import logging
from datetime import datetime, timezone
from urllib.parse import urlparse, urljoin

import requests
import feedparser  # ← for football RSS
from flask import Flask, jsonify, request, Response, redirect, render_template, url_for, abort
from flask_cors import CORS
from google.cloud import firestore
from google.oauth2 import service_account
from google.api_core.exceptions import ResourceExhausted

# ----------------- Config -----------------
PROJECT_ID = (os.getenv("GOOGLE_CLOUD_PROJECT") or "").strip()
FETCH_WINDOW = int(os.getenv("FETCH_WINDOW", "500"))  # newest docs window for /articles

FALLBACK_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

PICKER_VERSION = "v5-snapshots"   # bump marker

# Disk cache (fallback if Firestore quota fails)
CACHE_PATH = os.path.join(os.path.dirname(__file__), "cache_articles.json")

# Gate the scheduler so it runs in exactly ONE process
RUN_JOBS = os.getenv("RUN_JOBS", "0") == "1"

# Memory cache TTLs
_MEM_TTL = int(os.getenv("MEM_TTL_SECONDS", "90"))  # general /articles TTL
_PICK_TTL = int(os.getenv("PICK_CACHE_SECONDS", "86400"))  # pick_image TTL

# ✅ SNAPSHOT URLs (public GCS/Firebase Storage URLs)
# Example:
#   SNAPSHOT_LATEST_URL=https://storage.googleapis.com/<bucket>/snapshots/latest.json.gz
#   SNAPSHOT_FEED_BASE=https://storage.googleapis.com/<bucket>/snapshots/feeds/
SNAPSHOT_LATEST_URL = (os.getenv("SNAPSHOT_LATEST_URL") or "").strip()
SNAPSHOT_FEED_BASE = (os.getenv("SNAPSHOT_FEED_BASE") or "").strip().rstrip("/") + "/" if os.getenv("SNAPSHOT_FEED_BASE") else ""
SNAPSHOT_TTL = int(os.getenv("SNAPSHOT_TTL_SECONDS", "90"))  # how often backend refetches snapshot

# ------------------------------------------

# Flask
app = Flask(__name__)
app.url_map.strict_slashes = False
CORS(app)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("api")

# ----------------- Helpers (cache + time) -----------------
def _write_cache(rows: list) -> None:
    try:
        with open(CACHE_PATH, "w", encoding="utf-8") as f:
            json.dump(rows, f, ensure_ascii=False)
    except Exception as e:
        log.warning("Cache write skipped: %s", e)

def _read_cache() -> list:
    try:
        with open(CACHE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []

def _parse_ts_maybe(v):
    """Accept datetime or ISO string; fallback to epoch."""
    if isinstance(v, datetime):
        return v
    if isinstance(v, str):
        s = v.replace("Z", "+00:00")
        try:
            return datetime.fromisoformat(s)
        except Exception:
            pass
    return datetime(1970, 1, 1, tzinfo=timezone.utc)

def doc_to_public(d):
    out = dict(d)
    for k in ("publishedAt", "ingestedAt"):
        v = out.get(k)
        if hasattr(v, "isoformat"):
            out[k] = v.isoformat()
    return out

def _sha1(s: str) -> str:
    return hashlib.sha1(s.encode("utf-8")).hexdigest()

# ---------- Ensure imageUrl/image_url for outbound articles ----------
def ensure_image_fields(d: dict) -> dict:
    """Guarantee imageUrl/image_url on an article dict by pulling from page (expensive)."""
    url = d.get("url") or d.get("link")
    img = d.get("imageUrl") or d.get("image_url") or d.get("image")

    if (not img) and url:
        try:
            img = _pick_image_from_page(url)
        except Exception:
            img = None

    if img:
        d["imageUrl"]  = img      # camelCase
        d["image_url"] = img      # snake_case mirror
        d["image"]     = img      # alias
    return d
# -------------------------------------------------------------------

# ----------------- Firestore (credential-aware) -----------------
CREDS_PATH = (os.getenv("GOOGLE_APPLICATION_CREDENTIALS") or "").strip()

def _is_service_account_json(path: str) -> bool:
    try:
        if not path or not os.path.exists(path):
            return False
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return (
            data.get("type") == "service_account"
            and data.get("client_email")
            and data.get("token_uri")
        )
    except Exception:
        return False

if _is_service_account_json(CREDS_PATH):
    creds = service_account.Credentials.from_service_account_file(CREDS_PATH)
    db = firestore.Client(project=(PROJECT_ID or creds.project_id), credentials=creds)
    log.info(f"Firestore: using service account at {CREDS_PATH}")
else:
    db = firestore.Client(project=(PROJECT_ID or None))
    log.info("Firestore: using Application Default Credentials")

coll = db.collection("articles")

# ----------------- Slugs / doc helpers (for SSR) -----------------
def slugify(text: str) -> str:
    if not text:
        return ""
    s = re.sub(r"[^a-zA-Z0-9\s-]", "", text).strip().lower()
    s = re.sub(r"\s+", "-", s)
    return s[:80]

def ensure_slug(rec: dict) -> dict:
    if not rec:
        return rec
    if not rec.get("slug"):
        rec["slug"] = slugify(rec.get("cleanTitle") or rec.get("title") or "")
    return rec

def _get_doc_by_id(doc_id: str):
    return coll.document(doc_id).get()

def _get_doc_by_slug(slug: str):
    q = coll.where("slug", "==", slug).limit(1).stream()
    return next(q, None)

# ----------------- CORS + cache headers -----------------
@app.after_request
def add_cors(resp):
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Methods"] = "GET, HEAD, OPTIONS, POST"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"

    # Allow short caching for lists (frontend already cache-busts with _t)
    if request.path.startswith("/articles") or request.path.startswith("/search_articles"):
        resp.headers["Cache-Control"] = "public, max-age=30"
    elif request.path.startswith("/img"):
        resp.headers["Cache-Control"] = "public, max-age=86400"
    elif request.path.startswith(("/pick_image", "/latest")):
        resp.headers["Cache-Control"] = "public, max-age=60"
    return resp

# ----------------- Root (simple info) -----------------
@app.route("/", methods=["GET"])
def root():
    return jsonify({
        "ok": True,
        "service": "radiant-waves",
        "snapshots": {
            "latest": bool(SNAPSHOT_LATEST_URL),
            "feedBase": bool(SNAPSHOT_FEED_BASE),
        },
        "endpoints": [
            "/articles",
            "/search_articles",
            "/football",
            "/livescore",
            "/img",
            "/pick_image",
            "/diag",
            "/health",
            "/latest",
            "/read/<slug>",
            "/r/<id>",
            "/sitemap.xml",
        ]
    })

# =========================================================
# SNAPSHOT FETCH (public GCS URLs) + TTL memory cache
# =========================================================
_SNAP_MEM = {
    "latest": {"ts": 0.0, "payload": None},
    "feeds": {},  # feed -> {ts, payload}
}

def _snapshot_url_for_feed(feed: str) -> str:
    if not feed or not SNAPSHOT_FEED_BASE:
        return ""
    return f"{SNAPSHOT_FEED_BASE}{feed}.json.gz"

def _maybe_gunzip_bytes(b: bytes) -> bytes:
    # If payload is already JSON, return as-is; otherwise try gzip
    if not b:
        return b
    # gzip magic number
    if len(b) >= 2 and b[0] == 0x1F and b[1] == 0x8B:
        try:
            return gzip.decompress(b)
        except Exception:
            return b
    return b

def _fetch_snapshot_payload(url: str) -> dict | None:
    if not url:
        return None
    try:
        # Add cache-buster to avoid stale edge caches during testing
        u = url + ("&" if "?" in url else "?") + "_t=" + str(int(time.time()))
        r = requests.get(u, timeout=10, headers={"User-Agent": FALLBACK_USER_AGENT, "Accept": "application/json,*/*"})
        if r.status_code >= 400:
            return None

        # requests usually auto-decompress when Content-Encoding: gzip,
        # but if it's a .json.gz served as bytes, this covers it.
        raw = r.content
        raw2 = _maybe_gunzip_bytes(raw)

        try:
            data = json.loads(raw2.decode("utf-8"))
        except Exception:
            # fallback: maybe requests already decoded and r.text is JSON
            try:
                data = r.json()
            except Exception:
                return None

        if not isinstance(data, dict) or "items" not in data or not isinstance(data.get("items"), list):
            return None
        return data
    except Exception:
        return None

def _get_snapshot_latest() -> dict | None:
    if not SNAPSHOT_LATEST_URL:
        return None
    now = time.time()
    cached = _SNAP_MEM["latest"]
    if cached["payload"] is not None and (now - cached["ts"] <= SNAPSHOT_TTL):
        return cached["payload"]
    data = _fetch_snapshot_payload(SNAPSHOT_LATEST_URL)
    if data:
        cached["payload"] = data
        cached["ts"] = now
    return cached["payload"]

def _get_snapshot_feed(feed: str) -> dict | None:
    if not feed:
        return None
    url = _snapshot_url_for_feed(feed)
    if not url:
        return None

    bucket = _SNAP_MEM["feeds"].setdefault(feed, {"ts": 0.0, "payload": None})
    now = time.time()
    if bucket["payload"] is not None and (now - bucket["ts"] <= SNAPSHOT_TTL):
        return bucket["payload"]

    data = _fetch_snapshot_payload(url)
    if data:
        bucket["payload"] = data
        bucket["ts"] = now
    return bucket["payload"]

# ----------------- Tiny in-memory TTL cache for /articles results -----------------
_MEM = {}  # key -> {ts, payload}

def _mem_key(feed: str | None, q: str | None) -> str:
    f = (feed or "").strip().lower()
    qq = (q or "").strip().lower()
    return f"{f}||{qq}"

def _mem_get_articles(feed: str | None, q: str | None):
    k = _mem_key(feed, q)
    obj = _MEM.get(k)
    if not obj:
        return None
    if time.time() - obj["ts"] <= _MEM_TTL:
        return obj["payload"]
    return None

def _mem_set_articles(feed: str | None, q: str | None, payload):
    k = _mem_key(feed, q)
    _MEM[k] = {"ts": time.time(), "payload": payload}

# =========================================================
# Articles API (Snapshot-first → Firestore → disk cache)
# =========================================================
@app.route("/articles", methods=["GET", "OPTIONS"])
def list_articles():
    if request.method == "OPTIONS":
        return ("", 204)

    feed = (request.args.get("feed") or "").strip()
    q = (request.args.get("q") or "").strip().lower()
    cache_only = request.args.get("cache") == "1"

    is_search = bool(q)
    try:
        raw_limit = int(request.args.get("limit", 0))
    except Exception:
        raw_limit = 0

    # limit logic
    if is_search:
        limit = min(raw_limit or 50, 500)
        window = min(max(limit, 200), FETCH_WINDOW)
    else:
        limit = min(raw_limit or 150, 150)
        window = FETCH_WINDOW

    # 0) Disk cache only
    if cache_only:
        docs = _read_cache()
        resp = jsonify(docs[:limit])
        resp.headers["X-Source"] = "disk"
        return resp

    # 1) Memory cache (works for feed too now)
    mem = _mem_get_articles(feed, q)
    if mem is not None:
        resp = jsonify(mem[:limit])
        resp.headers["X-Source"] = "mem"
        return resp

    # 2) SNAPSHOT-first (FAST) for non-search (home + feeds)
    if not is_search:
        snap_payload = None
        if feed:
            snap_payload = _get_snapshot_feed(feed.lower())
        else:
            snap_payload = _get_snapshot_latest()

        if snap_payload and isinstance(snap_payload.get("items"), list) and snap_payload["items"]:
            items = snap_payload["items"]

            # Snapshot items are already public json
            # Ensure newest-first (use ingestedAt/publishedAt)
            def _k(d):
                return _parse_ts_maybe(d.get("ingestedAt") or d.get("publishedAt"))
            items.sort(key=_k, reverse=True)

            # Write memory cache
            _mem_set_articles(feed, q, items)

            resp = jsonify(items[:limit])
            resp.headers["X-Source"] = "snapshot"
            resp.headers["X-Snapshot-At"] = str(snap_payload.get("generatedAt") or "")
            return resp

    # 3) Firestore (fallback)
    docs = []
    from_cache = False

    try:
        qref = coll.order_by("ingestedAt", direction=firestore.Query.DESCENDING).limit(window)
        for _doc in qref.stream(retry=None, timeout=10):
            d = _doc.to_dict()
            d["id"] = _doc.id
            docs.append(d)

        public_rows = [doc_to_public(d) for d in docs]
        _write_cache(public_rows)

    except ResourceExhausted as e:
        log.warning("Firestore quota exceeded, serving disk cache: %s", e)
        docs = _read_cache()
        from_cache = True

    except Exception as e:
        log.warning("Firestore fetch failed, using disk cache: %s", e)
        docs = _read_cache()
        from_cache = True

    # filters
    if feed:
        docs = [d for d in docs if (d.get("feed") or "").lower() == feed.lower()]
    if q:
        tl = lambda s: (s or "").lower()
        docs = [
            d for d in docs
            if q in tl(d.get("title_lower") or d.get("title"))
            or q in tl(d.get("summary"))
        ]

    # sort newest-first
    docs.sort(key=lambda d: _parse_ts_maybe(d.get("ingestedAt") or d.get("publishedAt")), reverse=True)

    if not from_cache:
        docs = [doc_to_public(d) for d in docs]

    # write memory cache for next hit
    _mem_set_articles(feed, q, docs)

    resp = jsonify(docs[:limit])
    resp.headers["X-Source"] = "disk" if from_cache else "firestore"
    return resp

# ----------------- Backend Search (full Firestore or cache) -----------------
@app.get("/search_articles")
def search_articles():
    q = (request.args.get("q") or "").strip()
    if not q:
        return jsonify({"ok": False, "error": "missing q"}), 400

    q_lower = q.lower()
    limit = int(request.args.get("limit", "50"))

    docs = []
    from_cache = False

    try:
        qref = coll.order_by("ingestedAt", direction=firestore.Query.DESCENDING).limit(800)
        for _doc in qref.stream(retry=None, timeout=10):
            d = _doc.to_dict()
            d["id"] = _doc.id
            docs.append(d)
    except ResourceExhausted as e:
        log.warning("search_articles: quota exceeded, falling back to cache: %s", e)
        docs = _read_cache()
        from_cache = True
    except Exception as e:
        log.warning("search_articles: fetch failed, falling back to cache: %s", e)
        docs = _read_cache()
        from_cache = True

    def tl(s): return (s or "").lower()
    results = [
        d for d in docs
        if q_lower in tl(d.get("title_lower") or d.get("title"))
        or q_lower in tl(d.get("summary"))
        or q_lower in tl(d.get("feed"))
    ]

    results.sort(
        key=lambda d: _parse_ts_maybe(d.get("ingestedAt") or d.get("publishedAt")),
        reverse=True,
    )

    if not from_cache:
        results = [doc_to_public(d) for d in results]

    return jsonify(results[:limit])

# ----------------- Image proxy (streamed, memory-safe) -----------------
@app.route("/img", methods=["GET"])
def proxy_image():
    raw = (request.args.get("url") or "").strip()
    if not raw or not raw.startswith(("http://", "https://")):
        return ("Bad Request", 400)
    try:
        p = urlparse(raw)
        headers = {
            "User-Agent": FALLBACK_USER_AGENT,
            "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
            "Referer": f"{p.scheme}://{p.netloc}/",
        }
        r = requests.get(raw, headers=headers, timeout=(5, 10), allow_redirects=True, stream=True)
        if r.status_code >= 400:
            return ("Image fetch failed", 502)

        ct = r.headers.get("Content-Type", "image/jpeg")
        max_bytes = 5 * 1024 * 1024
        sent = 0

        def generate():
            nonlocal sent
            for chunk in r.iter_content(chunk_size=64 * 1024):
                if not chunk:
                    break
                sent += len(chunk)
                if sent > max_bytes:
                    break
                yield chunk

        return Response(generate(), content_type=ct)
    except Exception:
        return ("Image proxy error", 502)

# ----------------- Image picker (with cache) -----------------
_LOGOISH = re.compile(r"(logo|favicon|sprite|placeholder|default|brand|og[-_]?default)", re.I)
_GOOD_EXT = (".jpg", ".jpeg", ".png", ".webp", ".bmp")
_BAD_HOST_BITS = (
    "scorecardresearch.com",
    "doubleclick.net",
    "googletagmanager.com",
    "google-analytics.com",
    "analytics.google.com",
    "adservice.google.com",
    "quantserve.com",
    "pixel.wp.com",
    "stats.wp.com",
    "facebook.com/tr",
)

# Cache: url -> {ts, img}
_PICK_CACHE = {}

def _pick_cache_get(url: str):
    obj = _PICK_CACHE.get(url)
    if not obj:
        return None
    if time.time() - obj["ts"] <= _PICK_TTL:
        return obj["img"]
    return None

def _pick_cache_set(url: str, img: str):
    _PICK_CACHE[url] = {"ts": time.time(), "img": img or ""}

def _looks_like_logo(u):
    s = (u or "").lower()
    if any(x in s for x in ("1x1", "pixel", "spacer")):
        return True
    return bool(_LOGOISH.search(s)) or s.endswith(".svg")

def _pick_from_srcset(srcset):
    if not srcset:
        return ""
    best = ""
    best_w = -1
    for part in srcset.split(","):
        seg = part.strip().split()
        if not seg:
            continue
        url = seg[0]
        w = 0
        if len(seg) > 1 and seg[1].endswith("w"):
            try:
                w = int(seg[1][:-1])
            except Exception:
                w = 0
        if w > best_w:
            best_w, best = w, url
    return best or srcset.split(",")[0].strip().split()[0]

def _extract_from_jsonld(html):
    urls = []
    if not html:
        return urls
    for m in re.finditer(r'<script[^>]+application/ld\+json[^>]*>(.*?)</script>', html, re.I | re.S):
        try:
            data = json.loads(m.group(1))
        except Exception:
            continue

        def walk(node):
            if isinstance(node, dict):
                img = node.get("image") or node.get("thumbnailUrl")
                if isinstance(img, str):
                    urls.append(img)
                elif isinstance(img, dict) and img.get("url"):
                    urls.append(img["url"])
                elif isinstance(img, list):
                    for x in img:
                        if isinstance(x, str):
                            urls.append(x)
                        elif isinstance(x, dict) and x.get("url"):
                            urls.append(x["url"])
                for v in node.values():
                    walk(v)
            elif isinstance(node, list):
                for v in node:
                    walk(v)

        walk(data)
    return urls

def _extract_from_meta_and_dom(html, page_url):
    urls = []
    amp_url = None

    for m in re.finditer(
        r'<meta[^>]+(?:property|name|itemprop)=["\'](?:og:image(?::(?:secure_url|url))?|twitter:image(?::src)?|image)["\'][^>]+content=["\']([^"\']+)["\']',
        html, re.I
    ):
        urls.append(m.group(1))

    m = re.search(r'<link[^>]+rel=["\']image_src["\'][^>]+href=["\']([^"\']+)["\']', html, re.I)
    if m:
        urls.append(m.group(1))

    for m in re.finditer(r'<(?:source|img)[^>]+srcset=["\']([^"\']+)["\']', html, re.I):
        cand = _pick_from_srcset(m.group(1))
        if cand:
            urls.append(cand)

    for m in re.finditer(r'<(?:source|img)[^>]+data-srcset=["\']([^"\']+)["\']', html, re.I):
        cand = _pick_from_srcset(m.group(1))
        if cand:
            urls.append(cand)

    for m in re.finditer(r'<figure[^>]*>.*?<img[^>]+src=["\']([^"\']+)["\']', html, re.I | re.S):
        urls.append(m.group(1))

    for m in re.finditer(r'<img[^>]+src=["\']([^"\']+)["\']', html, re.I):
        urls.append(m.group(1))

    for m in re.finditer(r'<img[^>]+data-(?:src|original|lazy|lazy-src)=["\']([^"\']+)["\']', html, re.I):
        urls.append(m.group(1))

    amp = re.search(r'<link[^>]+rel=["\']amphtml["\'][^>]+href=["\']([^"\']+)["\']', html, re.I)
    if amp:
        amp_url = (amp.group(1) or "").strip()

    abs_urls = []
    for u in urls:
        if not u:
            continue
        u = u.strip()
        if u.startswith("//"):
            u = "https:" + u
        if not u.startswith(("http://", "https://")):
            u = urljoin(page_url, u)
        abs_urls.append(u)

    return abs_urls, amp_url

def _is_good_image_candidate(u):
    try:
        p = urlparse(u)
        host = (p.netloc or "").lower()
        path = (p.path or "").lower()
        if any(b in host for b in _BAD_HOST_BITS):
            return False
        if path.endswith(".svg"):
            return False
        base = path.rsplit("/", 1)[-1]
        if not any(base.endswith(ext) for ext in _GOOD_EXT):
            if not any(x in path for x in ("/images/", "/image/", "/img/", "/media/", "/uploads/", "/wp-content/")):
                return False
        return True
    except Exception:
        return False

def _score_candidate(u):
    score = 0
    s = u.lower()
    if any(ext in s for ext in _GOOD_EXT):
        score += 4
    if any(x in s for x in ("/images/", "/image/", "/img/", "/media/", "/uploads/", "/wp-content/")):
        score += 3
    if any(x in s for x in ("hero", "cover", "article", "story", "photo")):
        score += 2
    if "sprite" in s or "logo" in s or "placeholder" in s:
        score -= 5
    if "pixel" in s or "tracker" in s or "beacon" in s:
        score -= 5
    return score

def _head_big_enough(url):
    try:
        r = requests.head(url, headers={"User-Agent": FALLBACK_USER_AGENT}, timeout=6, allow_redirects=True)
        ct = (r.headers.get("Content-Type") or "").lower()
        clen = int(r.headers.get("Content-Length") or "0")
        if not ct.startswith("image/"):
            return False
        return clen >= 1500
    except Exception:
        return False

def _pick_image_from_page(page_url, timeout=15):
    if not page_url:
        return None

    cached = _pick_cache_get(page_url)
    if cached is not None:
        return cached or None

    try:
        r = requests.get(
            page_url,
            timeout=timeout,
            headers={"User-Agent": FALLBACK_USER_AGENT, "Accept": "text/html,*/*;q=0.8"},
            allow_redirects=True,
        )
    except Exception:
        _pick_cache_set(page_url, "")
        return None

    if r.status_code != 200 or not r.text:
        _pick_cache_set(page_url, "")
        return None

    html = r.text

    cands = []
    cands += _extract_from_jsonld(html)
    meta_urls, amp_url = _extract_from_meta_and_dom(html, page_url)
    cands += meta_urls

    if amp_url:
        try:
            if amp_url.startswith("//"):
                amp_url = "https:" + amp_url
            if not amp_url.startswith(("http://", "https://")):
                amp_url = urljoin(page_url, amp_url)
            rr = requests.get(
                amp_url,
                timeout=timeout,
                headers={"User-Agent": FALLBACK_USER_AGENT, "Accept": "text/html,*/*;q=0.8"},
                allow_redirects=True,
            )
            if rr.status_code == 200 and rr.text:
                more_urls, _ = _extract_from_meta_and_dom(rr.text, amp_url)
                cands += more_urls
        except Exception:
            pass

    cleaned = []
    seen = set()
    for u in cands:
        if not u or u.startswith("data:"):
            continue
        if u.startswith("//"):
            u = "https:" + u
        if not u.startswith(("http://", "https://")):
            continue
        key = u.split("?", 1)[0].lower()
        if key in seen:
            continue
        seen.add(key)
        if _looks_like_logo(u):
            continue
        if not _is_good_image_candidate(u):
            continue
        cleaned.append(u)

    cleaned.sort(key=_score_candidate, reverse=True)

    for u in cleaned[:12]:
        if _head_big_enough(u):
            _pick_cache_set(page_url, u)
            return u

    _pick_cache_set(page_url, "")
    return None

@app.get("/pick_image")
def pick_image():
    page_url = (request.args.get("url") or "").strip()
    if not page_url:
        return jsonify({"version": PICKER_VERSION, "imageUrl": ""}), 400

    u = _pick_image_from_page(page_url) or ""
    try:
        host = (urlparse(u).netloc or "").lower()
        if any(b in host for b in _BAD_HOST_BITS):
            u = ""
    except Exception:
        u = ""

    return jsonify({"version": PICKER_VERSION, "imageUrl": u}), 200

# ----------------- Diag / Health -----------------
@app.get("/diag")
def diag():
    info = {
        "ok": True,
        "projectId": PROJECT_ID or "(default)",
        "cachePath": CACHE_PATH,
        "cacheExists": os.path.exists(CACHE_PATH),
        "cacheBytes": 0,
        "cacheMtime": None,
        "hasDoc": False,
        "sampleCount": 0,
        "snapshotLatest": SNAPSHOT_LATEST_URL or "",
        "snapshotFeedBase": SNAPSHOT_FEED_BASE or "",
    }
    try:
        if os.path.exists(CACHE_PATH):
            st = os.stat(CACHE_PATH)
            info["cacheBytes"] = st.st_size
            info["cacheMtime"] = datetime.fromtimestamp(st.st_mtime, tz=timezone.utc).isoformat()
    except Exception:
        pass
    try:
        sample = list(coll.limit(3).stream(retry=None, timeout=10))
        info["sampleCount"] = len(sample)
        info["hasDoc"] = bool(sample)
    except ResourceExhausted as e:
        info["ok"] = True
        info["quota"] = "exhausted"
        info["note"] = "serving cache"
    except Exception as e:
        info["ok"] = False
        info["error"] = str(e)
        return jsonify(info), 500
    return jsonify(info)

@app.get("/health")
def health():
    return "ok"

# ----------------- Latest (for Zapier) -----------------
@app.route("/latest", methods=["GET"])
def latest():
    try:
        qref = coll.order_by("ingestedAt", direction=firestore.Query.DESCENDING).limit(1)
        out = []
        for _doc in qref.stream(retry=None, timeout=10):
            d = _doc.to_dict()
            d["id"] = _doc.id
            d = ensure_image_fields(d)
            d = ensure_slug(d)
            out.append(doc_to_public(d))
        if not out:
            return jsonify({"ok": False, "error": "no_articles"}), 404
        return jsonify({"ok": True, "article": out[0]}), 200
    except ResourceExhausted:
        docs = _read_cache()
        if docs:
            return jsonify({"ok": True, "article": docs[0]}), 200
        return jsonify({"ok": False, "error": "quota_exceeded_and_no_cache"}), 503
    except Exception as e:
        log.exception("latest failed")
        return jsonify({"ok": False, "error": str(e)}), 500

# ----------------- SSR: /read/<slug> -----------------
@app.get("/read/<slug>")
def read(slug):
    snap = _get_doc_by_slug(slug)
    doc = None
    if snap:
        doc = snap.to_dict()
        doc["id"] = snap.id

    if not doc:
        doc_id = request.args.get("id", "").strip()
        if doc_id:
            s = _get_doc_by_id(doc_id)
            if s and s.exists:
                d = s.to_dict()
                d["id"] = s.id
                want = slugify(d.get("cleanTitle") or d.get("title"))
                if want and want != slug:
                    return redirect(url_for("read", slug=want, id=s.id), code=301)
                doc = d

    if not doc:
        abort(404)

    doc = ensure_slug(doc)
    og = {
        "og_title": doc.get("cleanTitle") or doc.get("title"),
        "og_desc": doc.get("cleanSummary") or doc.get("excerpt") or doc.get("description") or "Radiant Waves",
        "og_image": doc.get("imageUrl") or doc.get("image"),
        "og_url": request.url
    }
    return render_template("read.html", article=doc, canonical=request.url, **og)

# ----------------- Redirect → canonical /read/<slug> -----------------
@app.get("/r/<doc_id>")
def r_redirect(doc_id):
    s = _get_doc_by_id(doc_id)
    if not s or not s.exists:
        abort(404)
    d = s.to_dict()
    d["id"] = s.id
    slug = d.get("slug") or slugify(d.get("cleanTitle") or d.get("title"))
    return redirect(url_for("read", slug=slug, id=s.id), code=301)

# ----------------- Simple sitemap (last 100) -----------------
@app.get("/sitemap.xml")
def sitemap():
    items = coll.order_by("publishedAt", direction=firestore.Query.DESCENDING).limit(100).stream()
    rows = []
    for s in items:
        d = s.to_dict()
        d["id"] = s.id
        slug = d.get("slug") or slugify(d.get("cleanTitle") or d.get("title"))
        url = url_for("read", slug=slug, id=s.id, _external=True)
        lastmod = (d.get("publishedAt") or datetime.utcnow()).strftime("%Y-%m-%d")
        rows.append(f"<url><loc>{url}</loc><lastmod>{lastmod}</lastmod></url>")
    xml = "<?xml version='1.0' encoding='UTF-8'?><urlset xmlns='http://www.sitemaps.org/schemas/sitemap/0.9'>" + "".join(rows) + "</urlset>"
    return xml, 200, {"Content-Type": "application/xml"}

# ================= FOOTBALL NEWS =================
FOOTBALL_FEEDS = [
    "https://www.skysports.com/rss/12040",
    "https://www.skysports.com/rss/11095",
    "https://www.espn.com/espn/rss/soccer/news",
    "https://www.footballtransfers.com/en/rss",
    "https://www.newsnow.co.uk/h/Sport/Football/Transfer+News?type=rss",
]

def fetch_football_news(limit_per_feed=6, max_total=30):
    items = []
    for url in FOOTBALL_FEEDS:
        try:
            feed = feedparser.parse(url)
            for e in feed.entries[:limit_per_feed]:
                if getattr(e, "published_parsed", None):
                    ts = time.mktime(e.published_parsed)
                else:
                    ts = time.time()
                items.append({
                    "id": e.get("id") or e.get("link"),
                    "title": e.get("title"),
                    "summary": (e.get("summary") or "")[:260],
                    "url": e.get("link"),
                    "imageUrl": None,
                    "category": "football",
                    "source": url,
                    "ts": ts,
                })
        except Exception as ex:
            log.error("football feed failed for %s: %s", url, ex)
            continue
    items.sort(key=lambda x: x["ts"], reverse=True)
    return items[:max_total]

@app.get("/football")
def football():
    items = fetch_football_news()
    return jsonify({"ok": True, "items": items, "count": len(items)}), 200

# ================= LIVESCORE =================
@app.get("/livescore")
def livescore():
    api_base = os.getenv("FOOTBALL_API_BASE", "https://v3.football.api-sports.io")
    api_key = os.getenv("FOOTBALL_API_KEY")
    if not api_key:
        return jsonify({"ok": False, "reason": "NO_API_KEY", "items": []}), 200

    try:
        r = requests.get(
            f"{api_base}/fixtures",
            params={"live": "all"},
            headers={"x-apisports-key": api_key},
            timeout=8,
        )
        data = r.json()
        return jsonify({
            "ok": True,
            "items": data.get("response", []),
            "ts": int(time.time())
        }), 200
    except Exception as e:
        log.error("livescore fetch failed: %s", e)
        return jsonify({"ok": False, "reason": "FETCH_FAILED", "items": []}), 200

# ----------------- Scheduler (runs under gunicorn) -----------------
import subprocess
from apscheduler.schedulers.background import BackgroundScheduler
from atexit import register

def run_ingest_job():
    log.info("🚀 Ingest job starting…")
    subprocess.run(["python", "scripts/ingest.py"], check=False)
    log.info("✅ Ingest job finished")

if RUN_JOBS:
    try:
        _sched = BackgroundScheduler(daemon=True, timezone="UTC")
        _sched.add_job(run_ingest_job, "cron", minute="0,30")
        _sched.start()
        log.info("🕒 Scheduler started (cron at :00/:30 UTC)")
        register(lambda: _sched.shutdown(wait=False))
    except Exception:
        log.exception("Failed to start APScheduler")

# ----------------- Local dev runner -----------------
if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "8080")))
