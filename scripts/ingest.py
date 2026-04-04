# scripts/ingest.py
import os, time, logging, json
from datetime import datetime, timezone
from google.cloud import firestore

def fetch_articles():
    """Dummy data for now — replace later with real feed fetching."""
    return [
        {"title": "Radiant Waves heartbeat", "url": "https://radiant-waves.com.ng", "ts": int(time.time())}
    ]

def main():
    logging.basicConfig(level=logging.INFO)
    db = firestore.Client(project=os.getenv("GOOGLE_CLOUD_PROJECT"))
    col = db.collection("articles")
    items = fetch_articles()
    now = datetime.now(timezone.utc)
    for it in items:
        doc_id = str(it.get("ts", int(time.time())))
        if "publishedAt" not in it and "ts" in it:
            it["publishedAt"] = now  # so build-seo and post-to-social can order by publishedAt
        col.document(doc_id).set(it, merge=True)
    print(json.dumps({"ingested": len(items)}))

if __name__ == "__main__":
    main()
