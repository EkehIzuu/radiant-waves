"""
Shared rules for home/browse: optional max-age window + non–low-quality image URLs.
Default: **no day cutoff** — order is by latest **ingest** (see API sort). Set
HOME_ARTICLE_MAX_AGE_DAYS>0 to add a calendar window.
Used by api.py (?home=1) and snapshot builders (latest.json.gz).
"""
from __future__ import annotations

import os
from datetime import datetime, timezone, timedelta
from typing import Any, List, Optional

# 0 = no age filter (broadcast-style: latest ingests first, no day cutoff)
HOME_ARTICLE_MAX_AGE_DAYS = int(os.getenv("HOME_ARTICLE_MAX_AGE_DAYS", "0"))

# When building home snapshot: pull this many newest docs then filter down
SNAPSHOT_HOME_SAMPLE_SIZE = int(
    os.getenv("SNAPSHOT_HOME_SAMPLE_SIZE", "600")
)


def _parse_ts(v: Any) -> Optional[datetime]:
    if v is None:
        return None
    if isinstance(v, datetime):
        return v if v.tzinfo else v.replace(tzinfo=timezone.utc)
    if isinstance(v, str):
        s = v.replace("Z", "+00:00")
        try:
            dt = datetime.fromisoformat(s)
            return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
        except Exception:
            return None
    # Firestore Timestamp-like
    if hasattr(v, "timestamp"):
        try:
            return datetime.fromtimestamp(float(v.timestamp()), tz=timezone.utc)
        except Exception:
            pass
    return None


def _article_ts_for_age(d: dict) -> datetime:
    """Calendar age checks prefer wall-clock published when set, else ingest."""
    for key in ("publishedAt", "ingestedAt"):
        t = _parse_ts(d.get(key))
        if t:
            return t.astimezone(timezone.utc)
    return datetime(1970, 1, 1, tzinfo=timezone.utc)


def is_low_quality_image_url(url: Optional[str]) -> bool:
    """
    Match app.js isLogoish + scripts/post-to-social-snapshot.js heuristics:
    no URL, data: URIs, logos, tiny icons, svg, etc.
    """
    s = (url or "").strip().lower()
    if not s:
        return True
    if s.startswith("data:"):
        return True
    bad = (
        "logo",
        "favicon",
        "sprite",
        "placeholder",
        "default",
        "brand",
        "avatar",
        "icon",
        "1x1",
        "spacer",
        "pixel",
        "tracking",
    )
    for b in bad:
        if b in s:
            return True
    if s.endswith(".svg"):
        return True
    return False


def article_image_url(d: dict) -> str:
    return str(
        d.get("imageUrl")
        or d.get("image_url")
        or d.get("image")
        or ""
    ).strip()


def article_passes_home_filters(
    d: dict,
    *,
    max_age_days: Optional[int] = None,
) -> bool:
    if not isinstance(d, dict):
        return False
    days = int(max_age_days if max_age_days is not None else HOME_ARTICLE_MAX_AGE_DAYS)
    if days > 0:
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)
        if _article_ts_for_age(d) < cutoff:
            return False
    if is_low_quality_image_url(article_image_url(d)):
        return False
    return True


def filter_home_articles(
    docs: List[dict],
    *,
    max_age_days: Optional[int] = None,
    limit: Optional[int] = None,
) -> List[dict]:
    """Keep input order (expect newest-first)."""
    out = [d for d in docs if article_passes_home_filters(d, max_age_days=max_age_days)]
    if limit is not None and limit > 0:
        out = out[:limit]
    return out


def filter_home_articles_with_fallback(
    docs: List[dict],
    *,
    max_age_days: Optional[int] = None,
    limit: Optional[int] = None,
) -> List[dict]:
    """
    Prefer good-image (+ optional age) rows; if that wipes the list (common when
    imageUrl is empty on many ingests), return the same docs unchanged so the site
    never goes blank — cards can use placeholders for missing images.
    """
    out = filter_home_articles(docs, max_age_days=max_age_days, limit=limit)
    if out:
        return out
    if not docs:
        return []
    if limit is not None and limit > 0:
        return docs[:limit]
    return list(docs)
