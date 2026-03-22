# Snapshot + Firestore (short)

1. **Ingest** → writes articles to **Firestore**.
2. **Export job** (optional) → builds `snapshots/latest.json.gz` for CDN/offline fallback.
3. **API (default):** `SERVE_BROWSE_FROM_SNAPSHOT=0` → browse hits **Firestore** each request (`MEM_TTL_SECONDS=0` = no RAM cache). Set `SERVE_BROWSE_FROM_SNAPSHOT=1` on Render only if you need to save quota (then snapshot can feel stale until rebuilt).
4. **Site (default):** loads **live `/articles` first**; snapshot only if API fails/offline.
5. **Hide from feed:** `archived` / `hiddenFromFeed` on docs (browse filters these; search can still find in Firestore).

6. **Home snapshot:** `latest.json.gz` pulls a wide sample, filters **good `imageUrl` only** (no logos/icons), optional **`HOME_ARTICLE_MAX_AGE_DAYS`>0** for a day window (default **0** = no cutoff; order is **latest ingest first**). Site uses **`/articles?...&home=1`** and sorts by **`ingestedAt`** like a wire.
