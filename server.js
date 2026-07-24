const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── SSRF guard ───────────────────────────────────────────────────────────────
// Event links can now point at any 3rd-party site, so the server fetches
// arbitrary user-supplied URLs. Block requests aimed at internal/private
// network addresses (including via redirect) before they go out.
function isPrivateIP(ip) {
  if (net.isIP(ip) === 4) {
    const p = ip.split('.').map(Number);
    if (p[0] === 10) return true;
    if (p[0] === 127) return true;
    if (p[0] === 0) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    return false;
  }
  if (net.isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1') return true;
    if (lower.startsWith('fe80:')) return true;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
    if (lower.startsWith('::ffff:')) {
      const v4 = lower.split(':').pop();
      if (v4 && v4.includes('.')) return isPrivateIP(v4);
    }
    return false;
  }
  return true; // unrecognized -> block
}

async function assertSafeUrl(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch (e) { throw new Error('Invalid URL.'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http/https URLs are allowed.');
  const hostname = u.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.local')) throw new Error('That host is not allowed.');
  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch (e) {
    throw new Error('Could not resolve that host.');
  }
  if (!addresses.length || addresses.some(a => isPrivateIP(a.address))) {
    throw new Error('That host resolves to a private/internal address and is not allowed.');
  }
  return u;
}

// Fetches a URL, validating every redirect hop against the SSRF guard
// before following it (so a public URL can't redirect to an internal one).
async function safeFetch(rawUrl, options = {}, maxRedirects = 5) {
  let current = await assertSafeUrl(rawUrl);
  for (let i = 0; i <= maxRedirects; i++) {
    const response = await fetch(current.toString(), { ...options, redirect: 'manual' });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const loc = response.headers.get('location');
      if (!loc) throw new Error('Redirect with no location header.');
      current = await assertSafeUrl(new URL(loc, current).toString());
      continue;
    }
    return response;
  }
  throw new Error('Too many redirects.');
}

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
};

// ── Image extraction ────────────────────────────────────────────────────────

function decodeHtmlEntities(str) {
  return str.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
}

// Pulls the high-res carousel image from an AT&T PAC event page's data-original
// attribute. That's the untouched imgix URL — src/data-src hold a pre-cropped
// 115x65 thumbnail, and og:image is often a generic/unrelated graphic.
function extractCarouselImage(html, pageUrl) {
  const m1 = html.match(/data-original=["'](https:\/\/attpac-media\.imgix\.net\/[^"']+)["']/i);
  if (m1) return decodeHtmlEntities(m1[1]);

  const m3 = html.match(/data-src=["'](https:\/\/attpac-media\.imgix\.net\/[^"']+)["']/i);
  if (m3) return decodeHtmlEntities(m3[1]);

  const m2 = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
           || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  if (m2) {
    const raw = decodeHtmlEntities(m2[1]);
    try { return new URL(raw, pageUrl).toString(); } catch (e) { return raw; }
  }

  return null;
}

// Generic extraction — walks <img> tags (src/data-src/data-original/srcset),
// og:image / twitter:image meta tags, and CSS background-image references.
// Used as the source for the "browse all images on this page" gallery, and
// as a fallback for non-AT&T pages in the single/bulk auto-fetch path.
function extractAllImages(html, pageUrl) {
  const found = [];
  const seen = new Set();
  const push = (raw) => {
    if (!raw) return;
    raw = decodeHtmlEntities(raw.trim());
    if (!raw || raw.startsWith('data:')) return;
    if (/^(false|true|none|null|undefined)$/i.test(raw)) return; // lazy-load placeholder tokens
    try {
      const abs = new URL(raw, pageUrl).toString();
      if (/\.svg(\?|$)/i.test(abs)) return;
      if (seen.has(abs)) return;
      seen.add(abs);
      found.push(abs);
    } catch (e) { /* ignore malformed */ }
  };

  const imgTagRe = /<img[^>]+>/gi;
  let m;
  while ((m = imgTagRe.exec(html))) {
    const tag = m[0];
    ['data-original', 'data-src', 'src'].forEach(attr => {
      const am = tag.match(new RegExp(attr + '=["\']([^"\']+)["\']', 'i'));
      if (am) push(am[1]);
    });
    const srcsetM = tag.match(/srcset=["']([^"']+)["']/i);
    if (srcsetM) srcsetM[1].split(',').forEach(part => push(part.trim().split(/\s+/)[0]));
  }

  const metaTagRe = /<meta[^>]+>/gi;
  while ((m = metaTagRe.exec(html))) {
    const tag = m[0];
    if (/property=["'](og:image|og:image:secure_url)["']/i.test(tag) || /name=["']twitter:image["']/i.test(tag)) {
      const cm = tag.match(/content=["']([^"']+)["']/i);
      if (cm) push(cm[1]);
    }
  }

  const bgRe = /background(?:-image)?\s*:\s*url\(\s*['"]?([^'")]+)['"]?\s*\)/gi;
  while ((m = bgRe.exec(html))) push(m[1]);

  const bgAttrRe = /data-background(?:-image)?=["']([^"']+)["']/gi;
  while ((m = bgAttrRe.exec(html))) push(m[1]);

  return found;
}

async function fetchPageHtml(url) {
  const response = await safeFetch(url, { headers: FETCH_HEADERS, timeout: 8000 });
  if (!response.ok) throw new Error(`Page returned ${response.status}.`);
  return response.text();
}

async function fetchEventImage(url) {
  const html = await fetchPageHtml(url);
  const primary = extractCarouselImage(html, url);
  if (primary) return primary;
  const all = extractAllImages(html, url);
  return all.length ? all[0] : null;
}

app.post('/api/debug-image', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  try {
    const response = await safeFetch(url, { headers: FETCH_HEADERS, timeout: 8000 });
    const html = await response.text();
    const imgixMatches = [...html.matchAll(/data-(?:original|src|background)=["'](https?:\/\/[^"']*imgix[^"']+)["']/gi)].map(m => m[0].slice(0, 200));
    const ogMatch = html.match(/<meta[^>]+og:image[^>]+>/i);
    res.json({
      status: response.status,
      htmlLength: html.length,
      imgixAttributeMatches: imgixMatches.slice(0, 5),
      ogImageTag: ogMatch ? ogMatch[0] : null,
      snippet: html.slice(0, 500),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/fetch-image', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  try {
    const imageUrl = await fetchEventImage(url);
    if (imageUrl) return res.json({ imageUrl });
    return res.json({ imageUrl: null, message: 'No image found on this event page. Add one manually.' });
  } catch (err) {
    console.error('Fetch error:', err.message);
    res.status(500).json({ error: err.message || 'Could not reach the event page. Check the URL and try again.' });
  }
});

// ── /api/fetch-all-images ─────────────────────────────────────────────────────
// Batch version — receives an array of URLs and returns an array of results.
app.post('/api/fetch-all-images', async (req, res) => {
  const { urls } = req.body;
  if (!Array.isArray(urls)) return res.status(400).json({ error: 'urls must be an array.' });

  const results = await Promise.all(
    urls.map(async (url) => {
      if (!url) return { url, imageUrl: null, error: 'No URL provided.' };
      try {
        const imageUrl = await fetchEventImage(url);
        return { url, imageUrl };
      } catch (e) {
        return { url, imageUrl: null, error: e.message };
      }
    })
  );

  res.json({ results });
});

// ── /api/fetch-page-images ────────────────────────────────────────────────────
// Returns every candidate image URL found on a page, for the "browse &
// select" gallery. AT&T's carousel image (if present) is listed first since
// it's the known-good show photo; everything else follows in page order.
app.post('/api/fetch-page-images', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  try {
    const html = await fetchPageHtml(url);
    const primary = extractCarouselImage(html, url);
    const all = extractAllImages(html, url);
    const images = primary ? [primary, ...all.filter(i => i !== primary)] : all;

    if (!images.length) {
      return res.json({ images: [], message: 'No images found on this page.' });
    }
    res.json({ images: images.slice(0, 40) });
  } catch (err) {
    console.error('Page image fetch error:', err.message);
    res.status(500).json({ error: err.message || 'Could not reach that page. Check the URL and try again.' });
  }
});

app.listen(PORT, () => {
  console.log(`\n  OAC Rush Generator running at http://localhost:${PORT}\n`);
});
