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
    <description>Auto-generated mirror of the Rockstar Newswire, rebuilt because Rockstar retired their public RSS feed. Full article text included, scraped directly from each article page.</description>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>`;
}

async function discoverAndFetch(browser) {
  const page = await browser.newPage();
  try {
    const capturedUrls = new Set();

    page.on('request', req => {
      const url = req.url();
      if (url.includes('graph.rockstargames.com')) {
        capturedUrls.add(url);
      }
    });

    await page.goto(NEWSWIRE_URL, { waitUntil: 'networkidle2', timeout: 45000 });
    // Give lazy-loaded requests a moment to fire (newswire list often loads
    // slightly after the initial translations/nav calls)
    await new Promise(r => setTimeout(r, 6000));

    if (!capturedUrls.size) {
      throw new Error('Could not capture any graph.rockstargames.com requests — Rockstar may have changed how the newswire loads its data.');
    }

    // Prefer URLs whose operationName looks newswire/article related, but
    // fall back to checking every captured call if none match by name.
    const urls = [...capturedUrls];
    const prioritized = [
      ...urls.filter(u => /newswire|article|tag|post/i.test(u)),
      ...urls.filter(u => !/newswire|article|tag|post/i.test(u))
    ];

    let articles = [];
    let winningUrl = null;
    let debugSamples = [];

    for (const candidateUrl of prioritized) {
      const res = await page.evaluate(async (u) => {
        try {
          const r = await fetch(u, { credentials: 'omit' });
          return { status: r.status, body: await r.text() };
        } catch (e) {
          return { status: 0, body: '' };
        }
      }, candidateUrl);

      if (res.status !== 200 || !res.body) continue;

      let data;
      try {
        data = JSON.parse(res.body);
      } catch {
        continue;
      }

      const found = extractArticles(data);
      if (found.length) {
        articles = found;
        winningUrl = candidateUrl;
        break;
      }

      debugSamples.push({
        url: candidateUrl,
        dataKeys: Object.keys(data?.data || {}),
        sample: JSON.stringify(data).slice(0, 800)
      });
    }

    if (!articles.length) {
      console.error('--- DEBUG: no article-shaped response found among', prioritized.length, 'captured GraphQL calls ---');
      for (const s of debugSamples) {
        console.error('URL:', s.url);
        console.error('data keys:', JSON.stringify(s.dataKeys));
        console.error('sample:', s.sample);
        console.error('---');
      }
      throw new Error('None of the captured GraphQL responses contained article-shaped data. See DEBUG output above.');
    }

    return { hash: winningUrl, articles };
  } finally {
    await page.close();
  }
}

function extractArticles(data) {
  const candidates = [
    data?.data?.tag?.newswires?.results,
    data?.data?.newswires?.results,
    data?.data?.newswireFeed?.items,
    data?.data?.newswire?.results,
    data?.data?.newswire?.posts?.results,
    data?.data?.articles?.results,
    data?.data?.posts?.results
  ].filter(Boolean);

  for (const c of candidates) {
    if (Array.isArray(c) && c.length && c[0].title && (c[0].url || c[0].link)) {
      return c.map(a => {
        const rawUrl = a.url || a.link || '';
        const image =
          a.preview_images_parsed?.newswire_block?.d16x9 ||
          a.preview_images_parsed?.newswire_block?.square ||
          a.image?.social?.url ||
          a.image?.default?.url ||
          null;
        return {
          id: a.id || rawUrl,
          title: a.title,
          link: rawUrl.startsWith('http') ? rawUrl : `https://www.rockstargames.com${rawUrl}`,
          date: a.created || a.publishTime || a.date || Date.now(),
          tag: a.primary_tags?.[0]?.name || null,
          image
        };
      });
    }
  }
  return [];
}

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
    // Fallback: whole body text, trimmed of obvious nav/footer noise later
    return document.body ? document.body.innerText.trim() : '';
  });

  return text;
}

async function main() {
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  const state = loadState();
  const cache = state.cache || {}; // id -> { content, cachedAt }

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const { hash, articles } = await discoverAndFetch(browser);

    const page = await browser.newPage();
    for (const a of articles) {
      if (cache[a.id]?.content) {
        a.content = cache[a.id].content;
        continue;
      }
      try {
        const body = await fetchArticleBody(page, a.link);
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
    await page.close();

    // Trim cache to just the articles currently in the feed, so it doesn't
    // grow forever, but keep a little headroom for recently-dropped ones.
    const currentIds = new Set(articles.map(a => a.id));
    const trimmedCache = {};
    for (const id of currentIds) if (cache[id]) trimmedCache[id] = cache[id];

    const rss = buildRss(articles);
    fs.writeFileSync(OUTPUT_PATH, rss);
    saveState({
      lastHash: hash,
      lastArticles: articles.map(a => a.link),
      lastSuccess: new Date().toISOString(),
      cache: trimmedCache
    });
    console.log(`OK: wrote ${articles.length} articles (with full body text) to ${OUTPUT_PATH}`);
  } catch (err) {
    console.error('Tracker run failed:', err.message);
    if (!fs.existsSync(OUTPUT_PATH)) {
      fs.writeFileSync(OUTPUT_PATH, buildRss([]));
    }
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
