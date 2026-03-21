# Snapshot + Firestore (short)

1. **Ingest** → writes articles to **Firestore**.
2. **Export job** (your CI/cron) → builds `snapshots/latest.json.gz` (+ per-feed if used) → deploy to Pages / ship with API.
3. **API**: `SERVE_BROWSE_FROM_SNAPSHOT=1` (default) → `/articles` **without** `?q=` reads **disk snapshot/cache** only. **`?q=`** search → **Firestore** (unless `DISABLE_FIRESTORE_READS=1`).
4. **Hide from feed, keep in search**: set `archived: true` or `hiddenFromFeed: true` on a doc when you “retire” it from the snapshot export; search still finds it in Firestore.
