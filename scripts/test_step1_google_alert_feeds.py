#!/usr/bin/env python3
"""
Step 1 — verify Google Alert RSS URLs return entries (no Firestore needed).

Keep FEEDS in sync with ingestor/main.py and main.py.
"""
from __future__ import annotations

import sys

import feedparser

# Sync with ingestor/main.py FEEDS
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


def main() -> int:
    ok = True
    for name, urls in FEEDS.items():
        urls = urls if isinstance(urls, (list, tuple)) else [urls]
        total = 0
        for u in urls:
            parsed = feedparser.parse(u)
            n = len(getattr(parsed, "entries", []) or [])
            total += n
            status = getattr(parsed, "status", None)
            bozo = getattr(parsed, "bozo", None)
            print(f"[{name}] {u}")
            print(f"  entries={n}  http_status={status!r}  feedparser_bozo={bozo!r}")
            if n and parsed.entries:
                t0 = (parsed.entries[0].get("title") or "")[:100]
                print(f"  sample_title: {t0!r}")
            if n == 0:
                print("  WARNING: no entries — check Alert in Google Alerts UI (paused / wrong account).")
                ok = False
        print(f"  TOTAL for {name}: {total}\n")

    if ok:
        print("Step 1 RSS check: OK (all feeds returned at least one entry).")
    else:
        print("Step 1 RSS check: some feeds are empty — fix Alerts before relying on ingest.")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
