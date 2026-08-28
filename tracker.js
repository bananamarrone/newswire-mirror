/**
 * Rockstar Newswire → RSS tracker
 * ---------------------------------
 * Rockstar's public newswire.rss feed is gone. The live site now pulls
 * articles from an internal GraphQL API (graph.rockstargames.com) that
 * requires a "persisted query hash" which isn't publicly documented.
 *
 * This script:
 *   1. Tries the last known-good GraphQL URL from state.json first (fast path).
 *   2. If that fails or returns no articles, opens the real newswire page in
 *      headless Chromium, watches network traffic, grabs the persisted-query
 *      hash, and re-issues the query directly.
 *   3. Uses a deep recursive scan on the JSON response so it survives Rockstar
 *      renaming their GraphQL fields (the previous fixed-path approach broke
 *      whenever the shape changed).
 *   4. Writes results out as a standard RSS 2.0 feed.xml.
 */

const fs      = require('fs');
const path    = require('path');
const puppeteer = require('puppeteer');

const NEWSWIRE_URL = 'https://www.rockstargames.com/newswire';
const OUTPUT_PATH  = path.join(__dirname, 'public', 'feed.xml');
const STATE_PATH   = path.join(__dirname, 'state.json');

// ─── state ────────────────────────────────────────────────────────────────────

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); }
  catch { return { lastHash: null, lastArticles: [], cache: {} }; }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// ─── xml helpers ──────────────────────────────────────────────────────────────

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
      ${a.tag ? `<category>${escapeXml(a.tag)}</category>` : ''}
      <description>${escapeXml((a.content || '').slice(0, 500))}</description>
      <content:encoded><![CDATA[${a.content || ''}]]></content:encoded>
      ${a.image ? `<enclosure url="${escapeXml(a.image)}" type="image/jpeg" />` : ''}
    </item>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Rockstar Games Newswire (unofficial mirror)</title>
    <link>${NEWSWIRE_URL}</link>
    <description>Auto-generated mirror of the Rockstar Newswire, rebuilt because Rockstar retired their public RSS feed. Full article text included.</description>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>`;
}

// ─── article extraction ───────────────────────────────────────────────────────

/**
 * Deep-scan an arbitrary JSON object for any array whose elements look like
 * Rockstar newswire articles (have a title + some kind of url/link field).
 * Returns the best candidate array, or [].
 *
 * This replaces the old fixed-path approach which broke whenever Rockstar
 * renamed their GraphQL response fields.
 */
function deepFindArticles(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 10) return null;

  // Check if this node itself is a promising array
  if (Array.isArray(obj) && obj.length >= 3) {
    const sample = obj[0];
    if (
      sample &&
      typeof sample === 'object' &&
      typeof sample.title === 'string' &&
      sample.title.length > 5 &&
      (sample.url || sample.link || sample.slug || sample.uri)
    ) {
      return obj;
    }
  }

  // Recurse into object values, prefer keys that sound article-related
  const keys = Object.keys(obj);
  const priority = keys.filter(k => /newswire|article|post|item|feed|result|node|content/i.test(k));
  const rest     = keys.filter(k => !/newswire|article|post|item|feed|result|node|content/i.test(k));

  for (const k of [...priority, ...rest]) {
    const found = deepFindArticles(obj[k], depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * Map a raw article node (whatever shape Rockstar returns) into our
 * normalised article object.
 */
function normaliseArticle(a) {
  const rawUrl = a.url || a.link || a.uri || a.slug || '';
  const image =
    a.preview_images_parsed?.newswire_block?.d16x9 ||
    a.preview_images_parsed?.newswire_block?.square ||
    a.image?.social?.url ||
    a.image?.default?.url ||
    a.thumbnail?.url ||
    a.heroImage?.url ||
    null;

  return {
    id:    a.id || rawUrl,
    title: a.title || a.headline || '',
    link:  rawUrl.startsWith('http') ? rawUrl : `https://www.rockstargames.com${rawUrl}`,
    date:  a.created || a.publishTime || a.publishedAt || a.date || Date.now(),
    tag:   a.primary_tags?.[0]?.name || a.tags?.[0]?.name || a.category || null,
    image
  };
}

function extractArticles(data) {
  const raw = deepFindArticles(data);
  if (!raw) return [];
  return raw.map(normaliseArticle).filter(a => a.title && a.link);
}

// ─── fast-path: re-use the last known good URL ────────────────────────────────

async function tryLastHashFetch(lastHash) {
  if (!lastHash) return null;
  try {
    const res = await fetch(lastHash, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; newswire-mirror/1.0)' }
    });
    if (!res.ok) {
      console.log(`Fast-path fetch returned ${res.status} — will re-discover via browser`);
      return null;
    }
    const data = await res.json();
    const articles = extractArticles(data);
    if (articles.length) {
      console.log(`Fast-path: got ${articles.length} articles from cached hash`);
      return { hash: lastHash, articles };
    }
    console.log('Fast-path: URL returned data but extractArticles found nothing — will re-discover');
    console.log('DEBUG fast-path sample:', JSON.stringify(data).slice(0, 600));
  } catch (e) {
    console.log('Fast-path fetch error:', e.message);
  }
  return null;
}

// ─── slow-path: puppeteer discovery ───────────────────────────────────────────

async function discoverAndFetch(browser) {
  const page = await browser.newPage();
  try {
    const capturedRequests = new Map(); // url → postData (for POST bodies)

    page.on('request', req => {
      const url = req.url();
      if (url.includes('graph.rockstargames.com')) {
        capturedRequests.set(url, req.postData() || null);
      }
    });

    await page.goto(NEWSWIRE_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    // Give lazy-loaded requests a moment to fire
    await new Promise(r => setTimeout(r, 6000));

    if (!capturedRequests.size) {
      throw new Error('No graph.rockstargames.com requests captured — Rockstar may have changed how the newswire loads data.');
    }

    // Prioritise URLs whose operationName sounds newswire/article related
    const urls = [...capturedRequests.keys()];
    const prioritized = [
      ...urls.filter(u => /newswire|article|tag|post/i.test(u)),
      ...urls.filter(u => !/newswire|article|tag|post/i.test(u))
    ];

    console.log(`Captured ${capturedRequests.size} GraphQL URLs, trying ${prioritized.length} candidates`);

    let articles = [];
    let winningUrl = null;
    const debugSamples = [];

    for (const candidateUrl of prioritized) {
      // Try GET first; if that fails, try POST with the captured body
      let body = null;
      let status = 0;

      // GET attempt (re-issue from page context to inherit cookies/headers)
      const getResult = await page.evaluate(async (u) => {
        try {
          const r = await fetch(u, { credentials: 'omit' });
          return { status: r.status, body: await r.text() };
        } catch (e) { return { status: 0, body: '' }; }
      }, candidateUrl);

      status = getResult.status;
      body   = getResult.body;

      // If GET returned nothing useful and we have a POST body, try that
      if ((status !== 200 || !body) && capturedRequests.get(candidateUrl)) {
        const postBody = capturedRequests.get(candidateUrl);
        const postResult = await page.evaluate(async (u, pb) => {
          try {
            const r = await fetch(u, {
              method: 'POST',
              credentials: 'omit',
              headers: { 'Content-Type': 'application/json' },
              body: pb
            });
            return { status: r.status, body: await r.text() };
          } catch (e) { return { status: 0, body: '' }; }
        }, candidateUrl, postBody);
        status = postResult.status;
        body   = postResult.body;
      }

      if (status !== 200 || !body) continue;

      let data;
      try { data = JSON.parse(body); } catch { continue; }

      const found = extractArticles(data);
      if (found.length) {
        articles   = found;
        winningUrl = candidateUrl;
        console.log(`Winning URL: ${candidateUrl} → ${found.length} articles`);
        break;
      }

      debugSamples.push({
        url: candidateUrl,
        dataKeys: Object.keys(data?.data || {}),
        sample: JSON.stringify(data).slice(0, 800)
      });
    }

    if (!articles.length) {
      console.error('--- DEBUG: no article-shaped response found ---');
      for (const s of debugSamples) {
        console.error('URL:', s.url);
        console.error('data keys:', JSON.stringify(s.dataKeys));
        console.error('sample:', s.sample);
        console.error('---');
      }
      throw new Error(`None of the ${prioritized.length} captured GraphQL responses contained article-shaped data. See DEBUG output above.`);
    }

    return { hash: winningUrl, articles };
  } finally {
    await page.close();
  }
}

// ─── article body fetching ────────────────────────────────────────────────────

async function fetchArticleBody(page, url) {
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
  await new Promise(r => setTimeout(r, 1500));

  const text = await page.evaluate(() => {
    const selectors = [
      'article',
      '[class*="ArticleContent"]',
      '[class*="article-content"]',
      '[class*="PostContent"]',
      '[class*="post-content"]',
      'main'
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.innerText && el.innerText.trim().length > 200) {
        return el.innerText.trim();
      }
    }
    return document.body ? document.body.innerText.trim() : '';
  });

  return cleanArticleText(text);
}

function cleanArticleText(text) {
  if (!text) return text;
  const cutMarkers = ['(Opens in a new window)', 'Related Stories'];
  let cutIndex = text.length;
  for (const marker of cutMarkers) {
    const idx = text.indexOf(marker);
    if (idx !== -1 && idx < cutIndex) cutIndex = idx;
  }
  return text.slice(0, cutIndex).trim();
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  const state = loadState();
  const cache = state.cache || {};

  // Fast path: re-use the last known good URL without spinning up a browser
  let result = await tryLastHashFetch(state.lastHash);

  let browser;
  if (!result) {
    // Slow path: headless browser discovery
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    try {
      result = await discoverAndFetch(browser);
    } catch (err) {
      console.error('Browser discovery failed:', err.message);

      // Emergency fallback: serve whatever was last successfully cached
      if (state.lastArticles?.length && Object.keys(cache).length) {
        console.log('Serving stale cache as emergency fallback');
        const staleArticles = state.lastArticles
          .map(link => {
            const id = link.split('/').filter(Boolean).pop();
            const cached = cache[id] || cache[link];
            if (!cached) return null;
            return { id, title: cached.title, link, date: cached.cachedAt, content: cached.content, tag: null, image: null };
          })
          .filter(Boolean);
        if (staleArticles.length) {
          fs.writeFileSync(OUTPUT_PATH, buildRss(staleArticles));
          console.log(`Wrote ${staleArticles.length} stale articles as fallback`);
        } else if (!fs.existsSync(OUTPUT_PATH)) {
          fs.writeFileSync(OUTPUT_PATH, buildRss([]));
        }
      } else if (!fs.existsSync(OUTPUT_PATH)) {
        fs.writeFileSync(OUTPUT_PATH, buildRss([]));
      }
      process.exitCode = 1;
      if (browser) await browser.close();
      return;
    }
  }

  const { hash, articles } = result;

  // Fetch full article body for any article not yet in cache
  if (articles.some(a => !cache[a.id]?.content)) {
    if (!browser) {
      browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
    }
    const bodyPage = await browser.newPage();
    for (const a of articles) {
      if (cache[a.id]?.content) {
        a.content = cache[a.id].content;
        continue;
      }
      try {
        const body = await fetchArticleBody(bodyPage, a.link);
        if (body && body.length > 100) {
          a.content = body;
          cache[a.id] = { content: body, cachedAt: new Date().toISOString(), title: a.title, link: a.link };
        } else {
          a.content = '(Could not extract full article text — view the article at the link above.)';
        }
      } catch (e) {
        console.error(`Failed to fetch body for ${a.link}:`, e.message);
        a.content = '(Could not extract full article text — view the article at the link above.)';
      }
    }
    await bodyPage.close();
  } else {
    // All from cache
    for (const a of articles) {
      a.content = cache[a.id].content;
    }
  }

  if (browser) await browser.close();

  // Trim cache to current articles (with a little headroom)
  const currentIds = new Set(articles.map(a => a.id));
  const trimmedCache = {};
  for (const [id, val] of Object.entries(cache)) {
    if (currentIds.has(id)) trimmedCache[id] = val;
  }

  const rss = buildRss(articles);
  fs.writeFileSync(OUTPUT_PATH, rss);
  saveState({
    lastHash: hash,
    lastArticles: articles.map(a => a.link),
    lastSuccess: new Date().toISOString(),
    cache: trimmedCache
  });
  console.log(`OK: wrote ${articles.length} articles (with full body text) to ${OUTPUT_PATH}`);
}

main();
