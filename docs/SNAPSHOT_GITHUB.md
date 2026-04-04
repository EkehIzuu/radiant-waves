# Snapshots on GitHub (no Firebase Storage)

1. **Ingest workflow** writes `snapshots/*.json.gz` under the repo and **commits** them.
2. **Public URLs** (use in `index.html` → `window.RW_SNAPSHOT_*`):

   `https://raw.githubusercontent.com/OWNER/REPO/BRANCH/snapshots/latest.json.gz`  
   `https://raw.githubusercontent.com/OWNER/REPO/BRANCH/snapshots/feeds/`

3. **`SNAPSHOT_MAX_AGE_DAYS`** (default **5**): snapshot files only include rows with **`ingestedAt`** (else `publishedAt`) in that window; older docs remain in Firestore (e.g. search). Workflow runs **every 30 minutes** (`*/30 * * * *`).
