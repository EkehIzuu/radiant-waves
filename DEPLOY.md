# Deploy auto-post to social (Telegram + optional Twitter)

This guide gets the **scheduled auto-poster** running so your latest article is shared to Telegram (and optionally Twitter) every 6 hours.

---

## 1. Telegram setup (required)

### Create a bot
1. Open Telegram and search for **@BotFather**.
2. Send `/newbot`, choose a name (e.g. "Radiant Waves News"), then a username (e.g. `RadiantWavesNews_bot`).
3. BotFather replies with a **token** like `123456789:ABCdefGHI...`. Copy it — this is `TELEGRAM_BOT_TOKEN`.

### Get your channel or chat ID
- **Option A — Post to a channel**  
  1. Create a channel (or use an existing one).  
  2. Add your bot as an **admin** (Channel → Manage → Administrators → Add).  
  3. To get the channel ID: forward any message from the channel to **@userinfobot**; it will show an id like `-1001234567890`. That’s `TELEGRAM_CHAT_ID` (include the minus if present).

- **Option B — Post to a group or yourself**  
  1. Add the bot to the group, or start a chat with it.  
  2. Send a message in that chat.  
  3. Open in browser: `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`.  
  4. Find `"chat":{"id": -123...}` — that number is `TELEGRAM_CHAT_ID`.

---

## 2. GitHub secrets (required for Telegram)

1. Open your repo on GitHub → **Settings** → **Secrets and variables** → **Actions**.
2. Add these **Repository secrets**:

| Name                           | Value                                      |
|--------------------------------|--------------------------------------------|
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Full JSON of your Firebase service account |
| `TELEGRAM_BOT_TOKEN`            | Token from BotFather                        |
| `TELEGRAM_CHAT_ID`             | Channel/chat ID from step 1                 |

**Firebase JSON:** In [Firebase Console](https://console.firebase.google.com) → Project → Project settings → Service accounts → Generate new private key. Paste the **entire** JSON (one line is fine).

---

## 3. Upload the code and run

1. **Commit and push** the new files to your repo:
   - `package.json`
   - `package-lock.json` (after you run `npm install` once locally)
   - `scripts/post-to-social.js`
   - `.github/workflows/post-to-social.yml`
   - `DEPLOY.md` (optional)

2. **Generate lockfile** (once on your machine):
   ```bash
   cd radiant-waves-main
   npm install
   ```
   Commit and push `package-lock.json` so the workflow can run `npm ci`.

3. The workflow runs **every 6 hours** automatically. To test immediately:
   - GitHub → **Actions** → **Post to social** → **Run workflow** → **Run workflow**.

4. Check the run log: it should say “Posted to Telegram” and “Marked article as posted.” If there’s “No unposted article found,” run your ingest/build so there’s at least one article without `postedToTelegramAt`.

---

## 4. Twitter (optional)

If you want to also post to **X (Twitter)**:

1. Go to [developer.twitter.com](https://developer.twitter.com) → sign in → **Developer portal** → **Projects & Apps** → create or use an app.
2. In the app, get:
   - **API Key and Secret** (Consumer Keys).
   - **Access Token and Secret** (User authentication).
3. In GitHub → **Settings** → **Secrets** → **Actions**, add:
   - `TWITTER_API_KEY`
   - `TWITTER_API_SECRET`
   - `TWITTER_ACCESS_TOKEN`
   - `TWITTER_ACCESS_SECRET`

After that, the same workflow will post to Telegram and Twitter when it runs.

---

## 5. Change schedule or collection

- **Schedule:** Edit `.github/workflows/post-to-social.yml` and change the `cron` line, e.g. `0 */6 * * *` = every 6 hours, `0 8,20 * * *` = 8:00 and 20:00 UTC daily.
- **Firestore collection:** Add a repo secret `FIRESTORE_COLLECTION` with your collection name. Default is `articles`.
- **Order field:** The script picks the “latest” article by a timestamp field. It uses `publishedAt` by default (same as your SEO build). If your ingest only writes `ts` or `createdAt`, add a secret or env `FIRESTORE_ORDER_FIELD` = `ts` (or `createdAt`).

---

## Troubleshooting

- **“No unposted article found”**  
  Your Firestore `articles` (or your collection) has no document without `postedToTelegramAt`. Ingest new articles or, for testing, remove that field from one doc.

- **Telegram “chat not found”**  
  For channels: bot must be **admin**. For groups: bot must be in the group and someone must have sent a message after adding it. Use the correct `TELEGRAM_CHAT_ID` (negative for channels/groups).

- **Firebase permission denied**  
  The service account must have read/write access to Firestore (e.g. “Cloud Datastore User” or “Editor”). Ensure the JSON secret is the full file, no extra spaces.

- **Twitter errors**  
  Check app permissions (read and write). Regenerate Access Token after changing permissions. Ensure all four secrets are set.
