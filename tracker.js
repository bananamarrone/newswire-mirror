/**
 * Rockstar Newswire → RSS tracker
 * ---------------------------------
 * Rockstar's public newswire.rss feed is gone. The live site now pulls
 * articles from an internal GraphQL API (graph.rockstargames.com) that
 * requires a "persisted query hash" which isn't publicly documented.
 *
 * This script:
 *   1. Opens the real newswire page in headless Chromium.
 *   2. Watches the network traffic the page itself generates.
 *   3. Grabs the persisted-query hash + variables off the real request.
 *   4. Re-issues that GraphQL query directly (fast, no browser needed
 *      for future runs — but we re-discover the hash every run anyway,
 *      since Rockstar can rotate it without warning).
 *   5. Writes the results out as a standard RSS 2.0 feed.xml.
 *
 * Meant to run on a schedule via GitHub Actions (see
 * .github/workflows/update-feed.yml) and publish feed.xml via GitHub Pages.
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const NEWSWIRE_URL = 'https://www.rockstargames.com/newswire';
const OUTPUT_PATH = path.join(__dirname, 'public', 'feed.xml');
const STATE_PATH = path.join(__dirname, 'state.json');

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { lastHash: null, lastArticles: [] };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function escapeXml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildRss(articles) {
  const items = articles.map(a => `
    <item>
      <title>${escapeXml(a.title)}</title>
      <link>${escapeXml(a.link)}</link>
      <guid isPermaLink="true">${escapeXml(a.link)}</guid>
      <pubDate>${new Date(a.date).toUTCString()}</pubDate>
      <description>${escapeXml(a.description || '')}</description>
      ${a.image ? `<enclosure url="${escapeXml(a.image)}" type="image/jpeg" />` : ''}
    </item>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Rockstar Games Newswire (unofficial mirror)</title>
    <link>${NEWSWIRE_URL}</link>
    <description>Auto-generated mirror of the Rockstar Newswire, rebuilt because Rockstar retired their public RSS feed.</description>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>`;
}

async function discoverAndFetch() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    let captured = null;

    page.on('request', req => {
      const url = req.url();
      if (url.includes('graph.rockstargames.com') && url.includes('persistedQuery')) {
        if (!captured) captured = url;
      }
    });

    // Also catch GraphQL calls made via POST body (some newswire builds do this)
    page.on('requestfinished', async req => {
      const url = req.url();
      if (url.includes('graph.rockstargames.com') && !captured) {
        captured = url;
      }
    });

    await page.goto(NEWSWIRE_URL, { waitUntil: 'networkidle2', timeout: 45000 });
    // Give lazy-loaded requests a moment to fire
    await new Promise(r => setTimeout(r, 4000));

    if (!captured) {
      throw new Error('Could not capture a graph.rockstargames.com request — Rockstar may have changed how the newswire loads its data.');
    }

    const res = await page.evaluate(async (capturedUrl) => {
      const r = await fetch(capturedUrl, { credentials: 'omit' });
      return { status: r.status, body: await r.text() };
    }, captured);

    if (res.status !== 200) {
      throw new Error(`Captured GraphQL URL returned HTTP ${res.status}`);
    }

    const data = JSON.parse(res.body);
    const rawArticles =
      data?.data?.tag?.newswires?.results ||
      data?.data?.newswires?.results ||
      data?.data?.newswireFeed?.items ||
      [];

    if (!rawArticles.length) {
      console.error('--- DEBUG: captured URL ---');
      console.error(captured);
      console.error('--- DEBUG: top-level response keys ---');
      console.error(JSON.stringify(Object.keys(data || {})));
      console.error('--- DEBUG: data.data keys (if present) ---');
      console.error(JSON.stringify(Object.keys(data?.data || {})));
      console.error('--- DEBUG: full response (truncated to 3000 chars) ---');
      console.error(JSON.stringify(data).slice(0, 3000));
      throw new Error('GraphQL response parsed but no articles were found — response shape may have changed. See DEBUG output above.');
    }

    const articles = rawArticles.map(a => ({
      title: a.title || a.subtitle || 'Untitled',
      link: a.url ? `https://www.rockstargames.com${a.url}` : NEWSWIRE_URL,
      date: a.publishTime || a.date || Date.now(),
      description: a.subtitle || a.description || '',
      image: a.image?.social?.url || a.image?.default?.url || null
    }));

    return { hash: captured, articles };
  } finally {
    await browser.close();
  }
}

async function main() {
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  const state = loadState();

  try {
    const { hash, articles } = await discoverAndFetch();
    const rss = buildRss(articles);
    fs.writeFileSync(OUTPUT_PATH, rss);
    saveState({ lastHash: hash, lastArticles: articles.map(a => a.link), lastSuccess: new Date().toISOString() });
    console.log(`OK: wrote ${articles.length} articles to ${OUTPUT_PATH}`);
  } catch (err) {
    console.error('Tracker run failed:', err.message);
    // Don't wipe out a previously-good feed.xml on a transient failure —
    // just leave the last successful build in place.
    if (!fs.existsSync(OUTPUT_PATH)) {
      fs.writeFileSync(OUTPUT_PATH, buildRss([]));
    }
    process.exitCode = 1;
  }
}

main();
