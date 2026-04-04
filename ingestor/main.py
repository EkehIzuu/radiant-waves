import os
import re
import json
import gzip
import logging
from datetime import datetime, timezone
from urllib.parse import (
    urljoin, urlparse, parse_qs, unquote,
    urlunparse, urlencode, parse_qsl
)

import sys

import feedparser
import requests
from google.cloud import firestore
from google.oauth2 import service_account

_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
from article_filters import (
    filter_home_articles_with_fallback,
    filter_snapshot_by_ingest_age,
    HOME_ARTICLE_MAX_AGE_DAYS,
    SNAPSHOT_HOME_SAMPLE_SIZE,
    SNAPSHOT_MAX_AGE_DAYS,
)

# Optional modern Firestore filter (silences positional-arg warning if available)
try:
    from google.cloud.firestore_v1 import FieldFilter
except Exception:
    FieldFilter = None

# ----------------- Config -----------------
PROJECT_ID = (os.getenv("GOOGLE_CLOUD_PROJECT") or "").strip()

# Snapshot settings (written to repo snapshots/ only — GitHub raw URLs)
SNAPSHOT_LIMIT_HOME = int(os.getenv("SNAPSHOT_LIMIT_HOME", "150"))         # latest combined
SNAPSHOT_LIMIT_PER_FEED = int(os.getenv("SNAPSHOT_LIMIT_PER_FEED", "200")) # per feed

FALLBACK_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0 Safari/537.36"
)

FEEDS = {
    "politics": [
        "https://www.google.com/alerts/feeds/09855239715608489155/1350228738014628326",
    ],
    "football": [
        "https://www.google.com/alerts/feeds/09855239715608489155/12203863912173460582",
        "https://www.google.com/alerts/feeds/09855239715608489155/6577141511429490555",
        "https://www.google.com/alerts/feeds/09855239715608489155/16275881333359002773",
        "https://www.google.com/alerts/feeds/09855239715608489155/15069529153221936917",
        "https://www.google.com/alerts/feeds/09855239715608489155/6960387846797858001",
        "https://www.google.com/alerts/feeds/09855239715608489155/16275881333359005065",
        "https://www.google.com/alerts/feeds/09855239715608489155/16275881333359005444",
    ],
    "celebrity": [
        "https://www.google.com/alerts/feeds/09855239715608489155/16695839084782454682",
        "https://www.google.com/alerts/feeds/09855239715608489155/759794245045875009",
        "https://www.google.com/alerts/feeds/09855239715608489155/3146722371147045714",
    ],
}

# Allow deep-scrape for all feeds
ALLOW_DEEP_SCRAPE_FEEDS = {"football", "politics", "celebrity"}
# ------------------------------------------

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("ingestor")

# ---- Firestore auth (GitHub Actions / Render friendly) ----
CREDS_JSON = (os.getenv("GOOGLE_APPLICATION_CREDENTIALS_JSON") or "").strip().strip('"').strip("'")
CREDS_PATH = (os.getenv("GOOGLE_APPLICATION_CREDENTIALS") or "").strip()

def _load_credentials():
    """
    Returns google-auth credentials or None if ADC is expected.
    """
    # 1) service account JSON in env
    if CREDS_JSON:
        info = json.loads(CREDS_JSON)
        return service_account.Credentials.from_service_account_info(info), info.get("project_id")

    # 2) service account file path
    if CREDS_PATH and os.path.exists(CREDS_PATH):
        creds = service_account.Credentials.from_service_account_file(CREDS_PATH)
        # creds.project_id exists on some versions; be defensive
        pid = getattr(creds, "project_id", None)
        return creds, pid

    # 3) ADC
    return None, None

def get_firestore_client():
    creds, pid = _load_credentials()
    if creds:
        return firestore.Client(project=PROJECT_ID or pid, credentials=creds)
    return firestore.Client(project=PROJECT_ID) if PROJECT_ID else firestore.Client()

db = get_firestore_client()
coll = db.collection("articles")
# -----------------------------------------------------------

# Limit full-page scrapes per run (politeness + speed)
SCRAPE_BUDGET = 20
_MIN_BYTES = 1500  # allow real thumbnails; avoid 1x1 pixels etc.

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
    "facebook.com",
)

def dt_utc_now():
    return datetime.now(timezone.utc)

def iso(dt):
    try:
        if isinstance(dt, datetime):
            return dt.astimezone(timezone.utc).isoformat()
    except Exception:
        pass
    return ""

def parse_published(entry):
    """Turn feedparser's time_struct into datetime; fallback to now."""
    try:
        pp = entry.get("published_parsed") or entry.get("updated_parsed")
        if pp:
            return datetime(*pp[:6], tzinfo=timezone.utc)
    except Exception:
        pass
    return dt_utc_now()

def clean_text(s):
    return (s or "").strip()

def first_non_empty(*vals):
    for v in vals:
        if v:
            v = clean_text(v)
            if v:
                return v
    return ""

def unwrap_google_redirect(u: str) -> str:
    """
    Unwrap Google redirect URLs like:
      https://www.google.com/url?...&url=REAL_URL
    """
    try:
        if not u:
            return u
        p = urlparse(u)
        if p.netloc.endswith("google.com") and p.path == "/url":
            q = parse_qs(p.query)
            target = (q.get("url") or q.get("q") or [None])[0]
            if target:
                return unquote(target)
        return u
    except Exception:
        return u

def looks_like_logo(u: str) -> bool:
    """Heuristic to skip logos/placeholders/thin sprites."""
    lo = (u or "").lower()
    bad_bits = (
        "logo", "favicon", "sprite", "placeholder", "default",
        "brandmark", "opengraph-default", "apple-touch-icon",
        "mask-icon", "site-icon",
        "generic_image_missing", "generic-image-missing", "image_missing",
        "image-missing", "noimage", "no-image", "missingimage", "missing-image",
        "blank"
    )
    bad_exts = (".svg",)
    if any(x in lo for x in ("1x1", "pixel", "spacer")):
        return True
    return any(b in lo for b in bad_bits) or lo.endswith(bad_exts)

def _good_article_url(u: str) -> bool:
    try:
        p = urlparse(u)
        if p.scheme not in ("http", "https"):
            return False
        if not p.netloc:
            return False
        return bool(p.path and p.path != "/")
    except Exception:
        return False

def resolve_real_link(entry, link: str) -> str:
    link = unwrap_google_redirect(link)
    try:
        host = urlparse(link).netloc.lower()
    except Exception:
        host = ""

    if "news.google.com" in host:
        candidates = []

        try:
            q = parse_qs(urlparse(link).query)
            if "url" in q and q["url"]:
                candidates.append(unquote(q["url"][0]))
        except Exception:
            pass

        for l in (entry.get("links") or []):
            h = (l.get("href") if isinstance(l, dict) else None) or ""
            if not h:
                continue
            h = unwrap_google_redirect(h)
            try:
                lh = urlparse(h).netloc.lower()
            except Exception:
                lh = ""
            if "news.google.com" not in lh and h.startswith("http"):
                candidates.append(h)
            else:
                try:
                    q2 = parse_qs(urlparse(h).query)
                    if "url" in q2 and q2["url"]:
                        candidates.append(unquote(q2["url"][0]))
                except Exception:
                    pass

        for href in re.findall(r'href=["\'](https?://[^"\']+)["\']', entry.get("summary") or "", re.I):
            href = unwrap_google_redirect(href)
            try:
                hh = urlparse(href).netloc.lower()
            except Exception:
                hh = ""
            if "news.google.com" not in hh:
                candidates.append(href)
            else:
                try:
                    q3 = parse_qs(urlparse(href).query)
                    if "url" in q3 and q3["url"]:
                        candidates.append(unquote(q3["url"][0]))
                except Exception:
                    pass

        for c in candidates:
            if _good_article_url(c):
                return c
        if candidates:
            return candidates[0]

    return link

def _normalize_image_url(u: str) -> str:
    if not u:
        return u
    try:
        p = urlparse(u)
        q = dict(parse_qsl(p.query, keep_blank_values=True))
        for key in ("w", "width"):
            if key in q:
                try:
                    q[key] = str(max(int(q[key]), 1200))
                except Exception:
                    pass
        for key in ("h", "height"):
            if key in q:
                try:
                    q[key] = str(max(int(q[key]), 675))
                except Exception:
                    pass
        for k in ("utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"):
            q.pop(k, None)
        return urlunparse(p._replace(query=urlencode(q)))
    except Exception:
        return u

def _pick_from_srcset(srcset: str) -> str:
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

def _head_ok(url: str, session: requests.Session) -> bool:
    try:
        r = session.head(url, headers={"User-Agent": FALLBACK_USER_AGENT}, timeout=6, allow_redirects=True)
        ct = (r.headers.get("Content-Type") or "").lower()
        clen = int(r.headers.get("Content-Length", "0") or "0")
        if ct.startswith("image/") and clen >= _MIN_BYTES:
            return True
        rg = session.get(
            url,
            headers={"User-Agent": FALLBACK_USER_AGENT, "Range": "bytes=0-4096"},
            timeout=8,
            allow_redirects=True,
        )
        ctg = (rg.headers.get("Content-Type") or "").lower()
        return ctg.startswith("image/")
    except Exception:
        return True

def _fetch_html(url: str, session: requests.Session) -> str:
    headers = {
        "User-Agent": FALLBACK_USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Referer": f"{urlparse(url).scheme}://{urlparse(url).netloc}/",
    }
    r = session.get(url, headers=headers, timeout=10, allow_redirects=True)
    r.raise_for_status()
    return r.text

def _extract_from_jsonld(html: str):
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

def _extract_from_meta_and_dom(html: str, page_url: str):
    urls = []
    if not html:
        return urls

    for m in re.finditer(
        r'<meta[^>]+(?:property|name)=["\'](?:og:image(?::secure_url|:url)?|twitter:image(?::src)?)["\'][^>]+content=["\']([^"\']+)["\']',
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

    for m in re.finditer(r'background-image\s*:\s*url\((["\']?)([^"\')]+)\1\)', html, re.I):
        urls.append(m.group(2))

    for nm in re.finditer(r'<noscript[^>]*>(.*?)</noscript>', html, re.I | re.S):
        part = nm.group(1) or ""
        for m in re.finditer(r'<img[^>]+src=["\']([^"\']+)["\']', part, re.I):
            urls.append(m.group(1))
        for m in re.finditer(r'<img[^>]+data-(?:src|original|lazy|lazy-src)=["\']([^"\']+)["\']', part, re.I):
            urls.append(m.group(1))
        for m in re.finditer(r'<(?:source|img)[^>]+srcset=["\']([^"\']+)["\']', part, re.I):
            cand = _pick_from_srcset(m.group(1))
            if cand:
                urls.append(cand)

    amp = re.search(r'<link[^>]+rel=["\']amphtml["\'][^>]+href=["\']([^"\']+)["\']', html, re.I)
    amp_url = (amp.group(1) or "").strip() if amp else None

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

    if amp_url:
        if amp_url.startswith("//"):
            amp_url = "https:" + amp_url
        if not amp_url.startswith(("http://", "https://")):
            amp_url = urljoin(page_url, amp_url)
        abs_urls.append(amp_url + "#__AMP_FETCH__")

    return abs_urls

def extract_football_specific_image(article_url, html):
    try:
        domain = (urlparse(article_url).netloc or "").lower()
        site_patterns = [
            (r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)["\']', ['espn.com']),
            (r'<img[^>]+class=["\'][^"\']*article-image[^"\']*["\'][^>]+src=["\']([^"\']+)["\']', ['espn.com']),
            (r'<meta[^>]+name=["\']twitter:image["\'][^>]+content=["\']([^"\']+)["\']', ['bbc.co.uk','bbc.com']),
            (r'<div[^>]+class=["\'][^"\']*sp-o-media-wrapper[^"\']*["\'][^>]*>.*?<img[^>]+src=["\']([^"\']+)["\']', ['bbc.co.uk','bbc.com']),
            (r'<figure[^>]+class=["\'][^"\']*sdc-site-image[^"\']*["\'][^>]*>.*?<img[^>]+src=["\']([^"\']+)["\']', ['skysports.com']),
            (r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)["\']', ['skysports.com']),
            (r'<div[^>]+class=["\'][^"\']*article-featured-image[^"\']*["\'][^>]*>.*?<img[^>]+src=["\']([^"\']+)["\']', []),
            (r'<img[^>]+class=["\'][^"\']*wp-post-image[^"\']*["\'][^>]+src=["\']([^"\']+)["\']', []),
            (r'<div[^>]+class=["\'][^"\']*hero-image[^"\']*["\'][^>]*>.*?<img[^>]+src=["\']([^"\']+)["\']', []),
        ]
        for pattern, domains in site_patterns:
            if not domains or any(d in domain for d in domains):
                matches = re.findall(pattern, html, re.IGNORECASE | re.DOTALL)
                for match in matches:
                    u = (match or "").strip()
                    if not u:
                        continue
                    if u.startswith("//"):
                        u = "https:" + u
                    if not u.startswith(("http://", "https://")):
                        u = urljoin(article_url, u)
                    if not looks_like_logo(u):
                        return u
    except Exception as e:
        log.info("Football-specific extraction error: %s", e)
    return None

def deep_pick_image(article_url: str, session=None):
    sess = session or requests.Session()
    try:
        html = _fetch_html(article_url, sess)
    except Exception as e:
        log.info("Deep scrape fetch error: %s -> %s", article_url, e)
        return None

    foot_img = extract_football_specific_image(article_url, html)
    if foot_img:
        return foot_img

    cands = []
    cands += _extract_from_jsonld(html)
    cands += _extract_from_meta_and_dom(html, article_url)

    amp_hrefs = [u for u in cands if u.endswith("#__AMP_FETCH__")]
    if amp_hrefs:
        try:
            amp_url = amp_hrefs[-1].replace("#__AMP_FETCH__", "")
            amp_html = _fetch_html(amp_url, sess)
            cands += _extract_from_meta_and_dom(amp_html, amp_url)
        except Exception as e:
            log.info("AMP fetch error: %s -> %s", article_url, e)

    cleaned = []
    seen = set()
    for u in cands:
        if not u or u.startswith("data:"):
            continue
        if u.startswith("//"):
            u = "https:" + u
        if not u.startswith(("http://", "https://")):
            continue
        u = _normalize_image_url(u)
        pr = urlparse(u)
        host = (pr.netloc or "").lower()
        key = (host + pr.path).lower()
        if key in seen:
            continue
        seen.add(key)
        if looks_like_logo(u):
            continue
        if any(b in host for b in _BAD_HOST_BITS):
            continue
        cleaned.append(u)

    for u in cleaned[:10]:
        if _head_ok(u, sess):
            return u
    return cleaned[0] if cleaned else None

def fetch_og_image(page_url: str, timeout=8):
    if not page_url:
        return None
    try:
        r = requests.get(
            page_url,
            timeout=timeout,
            headers={
                "User-Agent": FALLBACK_USER_AGENT,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
                "Referer": f"{urlparse(page_url).scheme}://{urlparse(page_url).netloc}/",
            },
            allow_redirects=True,
        )
    except Exception as e:
        log.info("OG fetch error: %s -> %s", page_url, e)
        return None

    if r.status_code != 200 or not r.text:
        log.info("OG fetch status: %s -> %s", page_url, r.status_code)
        return None

    html = r.text

    pat1 = re.compile(
        r'<meta[^>]+(?:property|name)=["\'](?:og:image(?::(?:secure_url|url))?|twitter:image(?::src)?)["\'][^>]+content=["\']([^"\']+)["\']',
        re.I,
    )
    pat2 = re.compile(
        r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+(?:property|name)=["\'](?:og:image(?::(?:secure_url|url))?|twitter:image(?::src)?)["\']',
        re.I,
    )
    candidates = pat1.findall(html) + pat2.findall(html)
    for u in candidates:
        u = u.strip()
        if u.startswith("//"):
            u = "https:" + u
        if not u.startswith(("http://", "https://")):
            u = urljoin(page_url, u)
        if u.startswith(("http://", "https://")) and not looks_like_logo(u):
            return u

    m = re.search(r'<link[^>]+rel=["\']image_src["\'][^>]+href=["\']([^"\']+)["\']', html, re.I)
    if m:
        u = m.group(1).strip()
        if u.startswith("//"):
            u = "https:" + u
        if not u.startswith(("http://", "https://")):
            u = urljoin(page_url, u)
        if u.startswith(("http://", "https://")) and not looks_like_logo(u):
            return u

    m = re.search(r'<img[^>]+src=["\']([^"\']+)["\']', html, re.I)
    if m:
        u = m.group(1).strip()
        if u.startswith("//"):
            u = "https:" + u
        if not u.startswith(("http://", "https://")):
            u = urljoin(page_url, u)
        if u.startswith(("http://", "https://")) and not looks_like_logo(u):
            return u

    log.info("OG none: %s", page_url)
    return None

def find_image_in_entry(entry, feed_name: str):
    for t in (entry.get("media_thumbnail") or []):
        u = (t.get("url") if isinstance(t, dict) else None)
        if u and str(u).startswith(("http://", "https://")) and not looks_like_logo(u):
            log.info("IMG via media_thumbnail: %s", u)
            return u
    for c in (entry.get("media_content") or []):
        u = (c.get("url") if isinstance(c, dict) else None)
        if u and str(u).startswith(("http://", "https://")) and not looks_like_logo(u):
            log.info("IMG via media_content: %s", u)
            return u

    for l in (entry.get("links") or []):
        if isinstance(l, dict) and l.get("rel") == "enclosure":
            ctype = str(l.get("type", "")).lower()
            if ctype.startswith("image/"):
                u = l.get("href")
                if u and str(u).startswith(("http://", "https://")) and not looks_like_logo(u):
                    log.info("IMG via enclosure: %s", u)
                    return u

    html_chunks = []
    if entry.get("summary"):
        html_chunks.append(entry["summary"])
    sd = entry.get("summary_detail") or {}
    if isinstance(sd, dict):
        html_chunks.append(sd.get("value") or "")
    for c in (entry.get("content") or []):
        if isinstance(c, dict):
            html_chunks.append(c.get("value") or "")

    link = entry.get("link") or ((entry.get("links") or [{}])[0].get("href"))

    def norm(u: str) -> str:
        if not u:
            return ""
        u = u.strip()
        if u.startswith("//"):
            u = "https:" + u
        if not u.startswith(("http://", "https://")) and link:
            u = urljoin(link, u)
        return u

    def ok(u: str) -> bool:
        if not u or not u.startswith(("http://", "https://")):
            return False
        if u.lower().startswith("data:"):
            return False
        if looks_like_logo(u):
            return False
        return True

    IMG_SRC_RE  = re.compile(r'<img[^>]+src=["\']([^"\']+)["\']', re.I)
    IMG_DATA_RE = re.compile(r'<img[^>]+data-(?:src|original|lazy-src)=["\']([^"\']+)["\']', re.I)
    SRCSET_RE   = re.compile(r'srcset=["\']([^"\']+)["\']', re.I)

    for html in html_chunks:
        if not html:
            continue
        candidates = []
        candidates += IMG_SRC_RE.findall(html)
        candidates += IMG_DATA_RE.findall(html)
        for srcset in SRCSET_RE.findall(html):
            best = _pick_from_srcset(srcset)
            if best:
                candidates.append(best)
        for raw in candidates:
            u = norm(raw)
            if ok(u):
                log.info("IMG via HTML parse: %s", u)
                return u

    if link:
        global SCRAPE_BUDGET
        if SCRAPE_BUDGET > 0:
            SCRAPE_BUDGET -= 1
            try:
                feed_key = (feed_name or "").lower()
                if feed_key in ALLOW_DEEP_SCRAPE_FEEDS:
                    with requests.Session() as s:
                        img = deep_pick_image(link, s)
                    if img and ok(img):
                        log.info("IMG via DEEP scrape: %s", img)
                        return img
                    img2 = fetch_og_image(link)
                    if img2 and ok(img2):
                        log.info("IMG via OG scrape: %s", img2)
                        return img2
                else:
                    img2 = fetch_og_image(link)
                    if img2 and ok(img2):
                        log.info("IMG via OG scrape: %s", img2)
                        return img2
                    with requests.Session() as s:
                        img = deep_pick_image(link, s)
                    if img and ok(img):
                        log.info("IMG via DEEP scrape: %s", img)
                        return img
            except Exception as e:
                log.info("Fallback image error: %s", e)

    return None

def upsert_article(doc):
    url = doc.get("url")
    if not url:
        return False

    if FieldFilter:
        existing = list(coll.where(filter=FieldFilter("url", "==", url)).limit(1).stream())
    else:
        existing = list(coll.where("url", "==", url).limit(1).stream())

    if existing:
        existing_doc = existing[0].to_dict() or {}
        if "ingestedAt" in existing_doc:
            doc["ingestedAt"] = existing_doc["ingestedAt"]
        else:
            doc["ingestedAt"] = dt_utc_now()
        coll.document(existing[0].id).set(doc, merge=True)
        return True
    else:
        doc["ingestedAt"] = dt_utc_now()
        coll.add(doc)
        return True


# =========================
# SNAPSHOT BUILD + UPLOAD
# =========================
def _serialize_article(d: dict) -> dict:
    """
    Keep snapshots small and stable.
    """
    return {
        "feed": d.get("feed", ""),
        "source": d.get("source", ""),
        "title": d.get("title", ""),
        "summary": d.get("summary", ""),
        "url": d.get("url", ""),
        "publishedAt": iso(d.get("publishedAt")),
        "ingestedAt": iso(d.get("ingestedAt")),
        "imageUrl": d.get("imageUrl", ""),
    }

def _query_latest(limit: int, feed: str | None = None):
    """Newest docs; per-feed uses composite index when available, else global scan + filter."""
    if not feed:
        q = coll.order_by("ingestedAt", direction=firestore.Query.DESCENDING).limit(limit)
        return [doc.to_dict() or {} for doc in q.stream()]

    try:
        if FieldFilter:
            q = (
                coll.where(filter=FieldFilter("feed", "==", feed))
                .order_by("ingestedAt", direction=firestore.Query.DESCENDING)
                .limit(limit)
            )
        else:
            q = (
                coll.where("feed", "==", feed)
                .order_by("ingestedAt", direction=firestore.Query.DESCENDING)
                .limit(limit)
            )
        return [doc.to_dict() or {} for doc in q.stream()]
    except Exception as e:
        log.warning(
            "Per-feed Firestore query failed (%s), using global scan + filter: %s",
            feed,
            e,
        )
        wide = min(max(limit * 8, 800), 8000)
        q = coll.order_by("ingestedAt", direction=firestore.Query.DESCENDING).limit(wide)
        rows = []
        f_lower = feed.lower()
        for doc in q.stream():
            d = doc.to_dict() or {}
            if (d.get("feed") or "").lower() == f_lower:
                rows.append(d)
            if len(rows) >= limit:
                break
        return rows

def _gzip_bytes(payload: dict) -> bytes:
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    out = gzip.compress(raw, compresslevel=9)
    return out

# Repo-root snapshots/ (committed by GitHub Actions)
SNAPSHOT_REPO_DIR = os.path.join(_ROOT, "snapshots")


def _write_snapshot_to_repo(relative_path: str, gz_bytes: bytes) -> None:
    """Write under repo snapshots/ for raw.githubusercontent.com hosting."""
    safe = relative_path.replace("..", "").lstrip("/")
    full = os.path.join(SNAPSHOT_REPO_DIR, *safe.split("/"))
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "wb") as f:
        f.write(gz_bytes)
    log.info("Wrote snapshot file: %s (%d bytes gz)", full, len(gz_bytes))


def build_and_upload_snapshots():
    log.info("Building snapshots (repo snapshots/ only)...")
    now = dt_utc_now()

    # 1) Home snapshot: wide sample → last SNAPSHOT_MAX_AGE_DAYS by ingest → image heuristics → cap
    home_raw = _query_latest(SNAPSHOT_HOME_SAMPLE_SIZE, feed=None)
    home_raw = filter_snapshot_by_ingest_age(home_raw, max_age_days=SNAPSHOT_MAX_AGE_DAYS)
    home_docs = filter_home_articles_with_fallback(
        home_raw, max_age_days=0, limit=SNAPSHOT_LIMIT_HOME
    )
    home_payload = {
        "generatedAt": iso(now),
        "count": len(home_docs),
        "homeFilter": {
            "maxAgeDays": HOME_ARTICLE_MAX_AGE_DAYS,
            "imageHeuristics": True,
            "snapshotMaxAgeDays": SNAPSHOT_MAX_AGE_DAYS,
        },
        "items": [_serialize_article(d) for d in home_docs],
    }
    home_gz = _gzip_bytes(home_payload)
    _write_snapshot_to_repo("latest.json.gz", home_gz)

    # 2) Per-feed snapshots (same ingest-age window, then cap)
    feed_query_window = min(800, max(SNAPSHOT_LIMIT_PER_FEED * 4, 200))
    for feed in FEEDS.keys():
        raw_feed = _query_latest(feed_query_window, feed=feed)
        docs = filter_snapshot_by_ingest_age(raw_feed, max_age_days=SNAPSHOT_MAX_AGE_DAYS)
        docs = docs[:SNAPSHOT_LIMIT_PER_FEED]
        payload = {
            "generatedAt": iso(now),
            "feed": feed,
            "count": len(docs),
            "snapshotMaxAgeDays": SNAPSHOT_MAX_AGE_DAYS,
            "items": [_serialize_article(d) for d in docs],
        }
        gz = _gzip_bytes(payload)
        _write_snapshot_to_repo(f"feeds/{feed}.json.gz", gz)

    log.info("Snapshots done.")


# =========================
# INGEST
# =========================
def ingest():
    logging.info("Starting ingestion run")
    written = skipped = 0

    for feed_name, urls in FEEDS.items():
        urls = urls if isinstance(urls, (list, tuple)) else [urls]
        for feed_url in urls:
            logging.info(f"Fetching feed: {feed_url} ({feed_name})")
            parsed = feedparser.parse(feed_url)

            for e in parsed.entries:
                title = first_non_empty(e.get("title"))
                orig_link = first_non_empty(e.get("link"))
                link = resolve_real_link(e, unwrap_google_redirect(orig_link))
                summary = first_non_empty(e.get("summary"))
                source = first_non_empty(parsed.feed.get("title"))

                if not link or not title:
                    skipped += 1
                    continue

                e2 = dict(e)
                e2["link"] = link

                image_url = find_image_in_entry(e2, feed_name)

                doc = {
                    "feed": feed_name,
                    "source": source,
                    "title": title,
                    "title_lower": (title or "").lower(),
                    "summary": summary,
                    "url": link,
                    "publishedAt": parse_published(e),
                    "imageUrl": image_url or "",
                }

                if upsert_article(doc):
                    written += 1
                else:
                    skipped += 1

    logging.info(f"Ingestion done. written={written} skipped={skipped}")

    # NEW: snapshots after ingestion
    try:
        build_and_upload_snapshots()
    except Exception as ex:
        log.exception("Snapshot build/upload failed: %s", ex)


if __name__ == "__main__":
    ingest()
