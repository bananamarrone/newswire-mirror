# Rockstar Newswire Tracker (free, no PC/server needed)

Rockstar killed their public RSS feed. This folder rebuilds one using a
headless browser that runs **inside GitHub Actions** (free) and publishes
the result via **GitHub Pages** (free) — nothing runs on your PC and no
Railway/Render account is needed for this part.

## One-time setup (~5 minutes)

1. **Create a new GitHub repo** (public is easiest — gives you unlimited
   free Actions minutes). Name it anything, e.g. `newswire-mirror`.

2. **Copy this whole `rockstar-newswire-tracker` folder** into the root of
   that new repo (so `tracker.js`, `package.json`, and
   `.github/workflows/update-feed.yml` are all at the repo root — NOT
   nested inside a subfolder, or the workflow path needs updating).

3. **Push it to GitHub.**

4. In the repo, go to **Settings → Pages** and set:
   - Source: **GitHub Actions**

5. Go to the **Actions** tab and manually run the "Update Rockstar
   Newswire feed" workflow once (`Run workflow` button). After it
   finishes, GitHub Pages will give you a URL that looks like:

   ```
   https://<your-username>.github.io/<repo-name>/feed.xml
   ```

6. Copy that URL into your bot's `config.json`:

   ```json
   "gtaNewsRssUrl": "https://<your-username>.github.io/<repo-name>/feed.xml"
   ```

7. Restart the bot / run your GTA news check command. It should now read
   from this feed like any normal RSS URL.

From here, the workflow re-runs every 30 minutes on its own, forever,
for free — no trial account, no card, nothing on your machine.

## If it stops working later

Rockstar can rotate the internal GraphQL hash the newswire page uses at
any time. If that happens, the tracker run will fail and the Action tab
will show a red X — but it will leave the **last successfully fetched
feed.xml in place** rather than breaking your bot's feed outright. Check
the failed run's logs; if the page's structure changed significantly,
the article-parsing logic in `tracker.js` (`discoverAndFetch`) may need
a small update. This is the exact same fragility the original AI
flagged — it comes with any approach that isn't an official feed.

## Local test (optional)

You can also test this on your own machine before deploying:

```
cd rockstar-newswire-tracker
npm install
npm start
```

This downloads a full Chromium the first time (a few hundred MB) —
that's why it's better suited to Actions than your bot's own hosting.
