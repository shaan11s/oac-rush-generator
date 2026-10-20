const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');

const app = express();
const PORT = 3000;

app.use(express.json());

// Lets the page call the API even when it's opened from somewhere other than
// this server (VS Code Live Server, or index.html opened directly, whose
// origin is "null"). Only local origins are allowed.
app.use('/api', (req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (origin === 'null' || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
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

// ── Polite fetching ──────────────────────────────────────────────────────────
// Sites throttle clients that ask for lots of pages at once, answering
// "429 Too Many Requests" — e.g. Culture Calendar's "Fetch All Images" asks
// for every show's page together, often all on one site. So pages from the
// same site are fetched at most PER_HOST_CONCURRENCY at a time and
// PER_HOST_GAP_MS apart; a 429 (or 503) pauses that site for as long as it
// asks (its Retry-After header, else a growing wait) and is retried; and
// fetched pages are remembered for CACHE_MS, so loading a show's details and
// then its images doesn't fetch the page twice.

const PER_HOST_CONCURRENCY = 2;
const PER_HOST_GAP_MS = 400;
const MAX_RETRIES = 3;
const MAX_RETRY_WAIT_MS = 20000;
const CACHE_MS = 10 * 60 * 1000;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const hosts = new Map(); // hostname -> { active, queue, nextStart, timer }

function hostState(url) {
  const name = new URL(url).hostname.toLowerCase();
  if (!hosts.has(name)) hosts.set(name, { active: 0, queue: [], nextStart: 0, timer: null });
  return hosts.get(name);
}

// Runs task() when the site has a free slot.
function withHostLimit(url, task) {
  const h = hostState(url);
  return new Promise((resolve, reject) => {
    h.queue.push({ task, resolve, reject });
    pumpHost(h);
  });
}

function pumpHost(h) {
  while (h.active < PER_HOST_CONCURRENCY && h.queue.length && !h.timer) {
    const wait = h.nextStart - Date.now();
    if (wait > 0) {
      h.timer = setTimeout(() => { h.timer = null; pumpHost(h); }, wait);
      return;
    }
    const { task, resolve, reject } = h.queue.shift();
    h.active++;
    h.nextStart = Date.now() + PER_HOST_GAP_MS;
    task().then(resolve, reject).finally(() => { h.active--; pumpHost(h); });
  }
}

function pauseHost(url, ms) {
  const h = hostState(url);
  h.nextStart = Math.max(h.nextStart, Date.now() + ms);
}

// Retry-After is either seconds or an HTTP date.
function retryAfterMs(response) {
  const v = response.headers.get('retry-after');
  if (!v) return null;
  const ms = /^\d+$/.test(v.trim()) ? +v * 1000 : Date.parse(v) - Date.now();
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, MAX_RETRY_WAIT_MS) : null;
}

class HttpError extends Error {
  constructor(status, challenge) {
    super(challenge
      ? 'That site blocks automated page loading (a bot-protection checkpoint), and it couldn\'t be passed. Fill this one in by hand.'
      : status === 429
        ? 'That site is limiting how fast pages can be loaded (429 Too Many Requests). Wait a minute and try again.'
        : `Page returned ${status}.`);
    this.status = status;
    this.challenge = !!challenge;
  }
}

// Bot protection (Vercel's "Security Checkpoint", Cloudflare's "Just a
// moment…") answers anything that isn't a real browser with a 429/403/503
// and a challenge page, and says so in a header. Waiting and retrying never
// gets past it, so such a site is remembered for CHALLENGE_MS and its pages
// go straight to Chrome (renderPage), which can pass the challenge.
const CHALLENGE_MS = 15 * 60 * 1000;
const CHALLENGE_TITLES = 'security checkpoint|just a moment|checking your browser|attention required';
function isChallenge(response) {
  return response.headers.has('x-vercel-mitigated') || response.headers.get('cf-mitigated') === 'challenge';
}
function hostChallenged(url) {
  return Date.now() - (hostState(url).challengedAt || 0) < CHALLENGE_MS;
}
// ...and Chrome couldn't get past it either: give up on the site's links.
function hostUnreachable(url) {
  return hostChallenged(url) && Date.now() - (hostState(url).renderFailedAt || 0) < CHALLENGE_MS;
}

const pageCache = new Map(); // url + accept -> { time, text }

async function fetchText(url, accept = FETCH_HEADERS.Accept) {
  const key = accept + ' ' + url;
  const hit = pageCache.get(key);
  if (hit && Date.now() - hit.time < CACHE_MS) return hit.text;
  const text = await withHostLimit(url, async () => {
    if (hostChallenged(url)) throw new HttpError(429, true); // found a wall while waiting
    for (let attempt = 0; ; attempt++) {
      const response = await safeFetch(url, { headers: { ...FETCH_HEADERS, Accept: accept }, timeout: 8000 });
      if (!response.ok && isChallenge(response)) {
        hostState(url).challengedAt = Date.now();
        throw new HttpError(response.status, true);
      }
      if ((response.status === 429 || response.status === 503) && attempt < MAX_RETRIES) {
        const wait = retryAfterMs(response) ?? 2000 * 2 ** attempt; // 2s, 4s, 8s
        pauseHost(url, wait);
        await sleep(wait);
        continue;
      }
      if (!response.ok) {
        // Still refused after every retry: treat it like a bot wall too.
        if (response.status === 429 || response.status === 503) hostState(url).challengedAt = Date.now();
        throw new HttpError(response.status);
      }
      return response.text();
    }
  });
  pageCache.set(key, { time: Date.now(), text });
  return text;
}

async function fetchPageHtml(url) {
  return fetchText(url);
}

// ── Pages built by JavaScript ────────────────────────────────────────────────
// Some sites (dma.org is one) send every page as an empty shell and fill it in
// with JavaScript, so reading the HTML finds nothing. When a page looks like
// that — or the site refuses a plain request — it's opened in a hidden Chrome
// window instead, the way a browser would, and the finished page is read.
// This needs Google Chrome (or Edge/Chromium) installed and the
// puppeteer-core package; without them, pages are just read as before.

function looksEmpty(html) {
  const text = html
    .replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length < 400;
}

function findChrome() {
  const fs = require('fs');
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ];
  return candidates.find(p => p && fs.existsSync(p)) || null;
}

// No single page may hold up the queue for longer than this.
const RENDER_TIMEOUT_MS = 40000;
function withTimeout(ms, task) {
  return Promise.race([task(), sleep(ms).then(() => { console.error(`  Chrome couldn't finish loading the page in ${ms / 1000}s`); return null; })]);
}

let browserPromise = null;
let browserIdleTimer = null;

async function getBrowser() {
  if (!browserPromise) {
    let puppeteer;
    try { puppeteer = require('puppeteer-core'); } catch (e) { return null; }
    const executablePath = findChrome();
    if (!executablePath) return null;
    browserPromise = puppeteer.launch({ executablePath, headless: 'new', args: ['--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled'] })
      .catch(e => { console.error('Could not start Chrome:', e.message); browserPromise = null; return null; });
  }
  return browserPromise;
}

// Closes Chrome after a minute without use so it isn't left running.
function releaseBrowserSoon() {
  clearTimeout(browserIdleTimer);
  browserIdleTimer = setTimeout(async () => {
    const b = await browserPromise;
    browserPromise = null;
    if (b) b.close().catch(() => {});
  }, 60000);
}

// Runs inside the rendered page and reads it the way a person would, for
// sites that don't label their event info: the title is the largest text
// that isn't part of a menu, the description the nearest sentence-length text
// below it, the image the biggest picture near the top, and the dates whatever
// short lines look like "Oct 16th 2026".
function readRenderedPage() {
  const inMenu = el => el.closest('nav, header, footer, [role="navigation"], [role="banner"], [role="contentinfo"], button');
  const blocks = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const text = node.textContent.replace(/\s+/g, ' ').trim();
    const el = node.parentElement;
    if (text.length < 3 || !el) continue;
    const cs = getComputedStyle(el), r = el.getBoundingClientRect();
    if (cs.visibility === 'hidden' || cs.display === 'none' || r.width === 0 || r.height === 0) continue;
    blocks.push({ text, el, tag: el.tagName, y: r.top + scrollY, size: parseFloat(cs.fontSize) });
  }
  // Menus: three or more same-size items on one line.
  const rowCount = {};
  blocks.forEach(b => { const k = Math.round(b.y / 8) + ':' + b.size; rowCount[k] = (rowCount[k] || 0) + 1; });
  const content = blocks.filter(b => !inMenu(b.el) && rowCount[Math.round(b.y / 8) + ':' + b.size] < 3);

  const titleBlock = content.filter(b => b.text.length <= 150)
    .sort((a, b) => b.size - a.size || a.y - b.y)[0];
  // The nearest sentence-length text below the title.
  const description = titleBlock
    ? (content.filter(b => b.y > titleBlock.y && b.text.length >= 40).sort((a, b) => a.y - b.y)[0] || {}).text || ''
    : '';

  const imgs = [...document.images]
    .map(i => ({ src: i.currentSrc || i.src, r: i.getBoundingClientRect() }))
    .filter(i => i.src && !i.src.startsWith('data:') && i.r.width >= 200 && i.r.top + scrollY < 1500)
    .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height);

  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const dates = [];
  // Dates are looked for everywhere: they often share a line with the times,
  // which the menu filter would drop.
  blocks.filter(b => b.text.length <= 60 && !inMenu(b.el)).forEach(b => {
    const m = b.text.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i);
    if (m) dates.push(`${m[3]}-${String(MONTHS.indexOf(m[1].toLowerCase()) + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`);
  });

  return { title: titleBlock ? titleBlock.text : '', description, imageUrl: imgs.length ? imgs[0].src : null, dates };
}

// The page after its JavaScript has run — { html, info } with info from
// readRenderedPage — or null if Chrome isn't available or the page wouldn't
// load. Every request the page makes goes through the same private-network
// guard as ordinary fetches; fonts and video are skipped.
async function renderPage(url) {
  const key = 'rendered ' + url;
  const hit = pageCache.get(key);
  if (hit && Date.now() - hit.time < CACHE_MS) return hit.text;
  await assertSafeUrl(url);
  const browser = await getBrowser();
  if (!browser) return null;
  const result = await withHostLimit(url, () => withTimeout(RENDER_TIMEOUT_MS, async () => {
    if (hostUnreachable(url)) return null; // gave up on this site while waiting
    const page = await browser.newPage();
    try {
      await page.setUserAgent(FETCH_HEADERS['User-Agent']);
      await page.setViewport({ width: 1280, height: 900 });
      await page.setRequestInterception(true);
      page.on('request', req => {
        if (['font', 'media'].includes(req.resourceType())) return req.abort().catch(() => {});
        assertSafeUrl(req.url()).then(() => req.continue(), () => req.abort()).catch(() => {});
      });
      page.on('dialog', d => d.dismiss().catch(() => {}));
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
      // A bot-protection checkpoint solves itself in a real browser and then
      // reloads the page; give it a moment.
      const onChallenge = () => page.evaluate(re => new RegExp(re, 'i').test(document.title), CHALLENGE_TITLES);
      if (await onChallenge()) {
        await page.waitForFunction(re => !new RegExp(re, 'i').test(document.title), { timeout: 15000 }, CHALLENGE_TITLES).catch(() => {});
        await page.waitForNetworkIdle({ idleTime: 500, timeout: 8000 }).catch(() => {});
      }
      const challenge = await onChallenge();
      return { html: await page.content(), info: await page.evaluate(readRenderedPage), challenge };
    } catch (e) {
      console.error('Render error:', e.message);
      return null;
    } finally {
      page.close().catch(() => {});
      releaseBrowserSoon();
    }
  }));
  if (result && !result.challenge) pageCache.set(key, { time: Date.now(), text: result });
  return result;
}

// The page's HTML, rendered in Chrome if the plain HTML is an empty shell or
// the site turned the plain request away (403/429). Falls back to whatever
// the plain request got.
// { html, info }: the page's HTML, rendered in Chrome if the plain HTML is
// an empty shell or the site turned the plain request away (403/429/503) —
// then info holds what readRenderedPage found. Falls back to whatever the
// plain request got.
async function fetchUsableHtml(url) {
  let html = null, error = null;
  // Chrome already failed to get past this site's wall: don't make every
  // other link from it wait the full RENDER_TIMEOUT_MS too.
  if (hostUnreachable(url)) throw new HttpError(429, true);
  if (hostChallenged(url)) error = new HttpError(429, true); // known wall: don't knock
  else {
    try { html = await fetchPageHtml(url); } catch (e) { error = e; }
    if (html && !looksEmpty(html)) return { html, info: null };
    if (error && ![403, 429, 503].includes(error.status)) throw error;
  }
  const rendered = await renderPage(url);
  if (rendered && !looksEmpty(rendered.html) && !rendered.challenge) return rendered;
  if (hostChallenged(url)) hostState(url).renderFailedAt = Date.now();
  if (html) return { html, info: null };
  if (rendered && rendered.challenge) throw new HttpError(429, true);
  throw error;
}

// ── Event info any site can provide ──────────────────────────────────────────
// Many event pages describe themselves for Google and social media: a
// schema.org Event in a <script type="application/ld+json"> block, and
// og:title / og:description / og:image tags. Used when the page isn't an
// attpac.org-style one.

function jsonLdEvent(html) {
  const blocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  const nodes = [];
  const collect = o => {
    if (Array.isArray(o)) return o.forEach(collect);
    if (!o || typeof o !== 'object') return;
    nodes.push(o);
    if (o['@graph']) collect(o['@graph']);
  };
  blocks.forEach(b => { try { collect(JSON.parse(b[1].trim())); } catch (e) { /* skip broken JSON */ } });
  return nodes.find(n => [].concat(n['@type'] || []).some(t => /Event$/i.test(String(t)))) || null;
}

function firstImage(img) {
  if (!img) return null;
  if (Array.isArray(img)) return firstImage(img[0]);
  if (typeof img === 'object') return img.url || img.contentUrl || null;
  return String(img);
}

function metaContent(html, name) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*>`, 'i');
  const tag = (html.match(re) || [])[0];
  const m = tag && tag.match(/content=["']([^"']*)["']/i);
  return m ? htmlToText(m[1]) : '';
}

// og:title is often "Show Name | Site Name" — drop the site name.
function stripSiteName(title, siteName) {
  if (!siteName) return title;
  const m = title.match(new RegExp(`^(.*?)\\s*[|–—-]\\s*${siteName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i'));
  return m && m[1] ? m[1] : title;
}

// The site-wide <meta name="description"> on a JavaScript app's shell
// describes the site, not the event.
function looksGeneric(description, html) {
  return !jsonLdEvent(html) && !metaContent(html, 'og:description') && description === metaContent(html, 'description');
}

function structuredDetails(html, pageUrl) {
  const ev = jsonLdEvent(html);
  const siteName = metaContent(html, 'og:site_name');
  const loc = ev && [].concat(ev.location || [])[0];
  const absolute = u => { try { return u ? new URL(decodeHtmlEntities(u), pageUrl).toString() : null; } catch (e) { return null; } };
  const h1 = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1];
  return {
    presenter: '',
    title: (ev && ev.name && htmlToText(String(ev.name)))
      || stripSiteName(metaContent(html, 'og:title'), siteName)
      || (h1 && htmlToText(h1)) || '',
    dates: ev ? formatDays([ev.startDate, ev.endDate].filter(Boolean)) : '',
    venue: loc ? htmlToText(String(typeof loc === 'object' ? loc.name || '' : loc)) : '',
    description: (ev && ev.description && htmlToText(String(ev.description)))
      || metaContent(html, 'og:description') || metaContent(html, 'description'),
    imageUrl: absolute(ev && firstImage(ev.image)) || absolute(metaContent(html, 'og:image')) || null,
  };
}

// ── dma.org pages ────────────────────────────────────────────────────────────
// dma.org is a JavaScript app: every page arrives as the same empty shell and
// fills itself in from a JSON file (Drupal JSON:API data) at
// files.dma.org/cms/production/content/en/<page path>.json. Reading that
// file gets the title, dates and images the HTML never contains.

function dmaContentUrl(pageUrl) {
  let u;
  try { u = new URL(pageUrl); } catch (e) { return null; }
  if (!/^(www\.)?dma\.org$/i.test(u.hostname)) return null;
  const path = u.pathname.replace(/\/+$/, '');
  if (!path) return null;
  return `https://files.dma.org/cms/production/content/en${path}.json`;
}

async function fetchDmaPage(pageUrl) {
  let json;
  try {
    json = JSON.parse(await fetchText(dmaContentUrl(pageUrl), 'application/json'));
  } catch (e) {
    if (e.status === 429) throw e;
    throw new Error(e.status ? `Could not find that page on dma.org (${e.status}).` : 'Could not read that dma.org page.');
  }
  if (!json || !json.data || !json.data.attributes) throw new Error('Could not read that dma.org page.');
  return json.data;
}

// The URL of a JSON:API media/file relationship, however deeply it's nested.
function dmaFileUrl(rel) {
  const d = rel && rel.data;
  if (!d) return null;
  if (d.attributes && d.attributes.uri && d.attributes.uri.url) return d.attributes.uri.url;
  return dmaFileUrl(d.relationships && d.relationships.field_media_image);
}

// Every image on the page, best first: the 16:9 featured image, then the
// hero images, the square thumbnail and any images in the page text.
function dmaImages(data) {
  const r = data.relationships || {};
  const urls = ['field_featured_image', 'field_hero_image', 'field_hero_image_tablet', 'field_hero_image_mobile', 'field_thumbnail']
    .map(k => dmaFileUrl(r[k]));
  const paragraphs = (r.field_paragraph && r.field_paragraph.data) || [];
  paragraphs.forEach(p => {
    const html = (p.attributes && p.attributes.field_text && p.attributes.field_text.processed) || '';
    for (const m of html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) urls.push(decodeHtmlEntities(m[1]));
  });
  return [...new Set(urls.filter(Boolean))];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ISO dates ("2026-10-16T12:00:00-05:00") as "Oct 16, 2026", or a range from
// the earliest to the latest ("Oct 16 - Nov 6, 2026"). With upcomingOnly,
// past dates are left out unless they're all past.
function formatDays(isoDates, upcomingOnly) {
  const parse = v => { const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? { y: +m[1], mo: +m[2] - 1, d: +m[3], key: m[0] } : null; };
  let days = isoDates.map(parse).filter(Boolean);
  if (upcomingOnly) {
    const today = new Date().toISOString().slice(0, 10);
    const upcoming = days.filter(d => d.key >= today);
    if (upcoming.length) days = upcoming;
  }
  if (!days.length) return '';
  days.sort((x, y) => (x.key < y.key ? -1 : 1));
  const first = days[0], last = days[days.length - 1];
  const fmt = (d, year) => `${MONTHS[d.mo]} ${d.d}${year ? `, ${d.y}` : ''}`;
  if (first.key === last.key) return fmt(first, true);
  if (first.y !== last.y) return `${fmt(first, true)} - ${fmt(last, true)}`;
  if (first.mo === last.mo) return `${MONTHS[first.mo]} ${first.d} - ${last.d}, ${first.y}`;
  return `${fmt(first, false)} - ${fmt(last, true)}`;
}

// Repeating events list every date; past ones are left out.
function dmaDates(data) {
  const a = data.attributes;
  if (a.field_custom_date) return htmlToText(String(a.field_custom_date));
  return formatDays((a.field_date_rrule || []).map(o => o.value), true)
    || formatDays([a.field_start_date, a.field_end_date].filter(Boolean));
}

// The first paragraph of the page text, up to its first line break.
function dmaDescription(data) {
  if (data.attributes.field_hero_text) return htmlToText(String(data.attributes.field_hero_text));
  const paragraphs = (data.relationships && data.relationships.field_paragraph && data.relationships.field_paragraph.data) || [];
  for (const p of paragraphs) {
    const html = (p.attributes && p.attributes.field_text && p.attributes.field_text.processed) || '';
    const first = (html.match(/<p[^>]*>([\s\S]*?)<\/p>/i) || [, html])[1].split(/<br\s*\/?>/i)[0];
    const text = htmlToText(first);
    if (text) return text;
  }
  return '';
}

async function fetchEventImage(url) {
  if (dmaContentUrl(url)) return dmaImages(await fetchDmaPage(url))[0] || null;
  const { html, info } = await fetchUsableHtml(url);
  const primary = extractCarouselImage(html, url) || structuredDetails(html, url).imageUrl || (info && info.imageUrl);
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

  const started = Date.now();
  const took = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
  try {
    const imageUrl = await fetchEventImage(url);
    console.log(`  ${imageUrl ? '✓' : '–'} ${url} (${took()})`);
    if (imageUrl) return res.json({ imageUrl });
    return res.json({ imageUrl: null, message: 'No image found on this event page. Add one manually.' });
  } catch (err) {
    console.log(`  ✗ ${url} (${took()}): ${err.message}`);
    res.status(500).json({ error: err.message || 'Could not reach the event page. Check the URL and try again.' });
  }
});

// ── /api/fetch-all-images ─────────────────────────────────────────────────────
// Batch version — receives an array of URLs and returns an array of results.
app.post('/api/fetch-all-images', async (req, res) => {
  const { urls } = req.body;
  if (!Array.isArray(urls)) return res.status(400).json({ error: 'urls must be an array.' });

  console.log(`Fetching images for ${urls.length} show${urls.length === 1 ? '' : 's'}…`);
  const results = await Promise.all(
    urls.map(async (url) => {
      if (!url) return { url, imageUrl: null, error: 'No URL provided.' };
      const started = Date.now();
      const took = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
      try {
        const imageUrl = await fetchEventImage(url);
        console.log(`  ${imageUrl ? '✓' : '–'} ${url} (${took()})`);
        return { url, imageUrl };
      } catch (e) {
        console.log(`  ✗ ${url} (${took()}): ${e.message}`);
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
    let images;
    if (dmaContentUrl(url)) {
      images = dmaImages(await fetchDmaPage(url));
    } else {
      const { html, info } = await fetchUsableHtml(url);
      const primary = extractCarouselImage(html, url) || structuredDetails(html, url).imageUrl || (info && info.imageUrl);
      const all = extractAllImages(html, url);
      images = primary ? [primary, ...all.filter(i => i !== primary)] : all;
    }

    if (!images.length) {
      return res.json({ images: [], message: 'No images found on this page.' });
    }
    res.json({ images: images.slice(0, 40) });
  } catch (err) {
    console.error('Page image fetch error:', err.message);
    res.status(500).json({ error: err.message || 'Could not reach that page. Check the URL and try again.' });
  }
});

// ── /api/event-details ───────────────────────────────────────────────────────
// Reads the show info from the heading of an attpac.org event page (used by
// the Wide Blocks, Square Blocks and feature tools). Every attpac.org event page marks these fields with the
// same eventHeading__* classes. ticketdfw.com pages share them; dma.org is
// read from its content JSON; any other site falls back to the event info it
// publishes for Google and social media (structuredDetails).

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…',
};

function htmlToText(fragment) {
  return fragment
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

function eventHeadingField(html, cls) {
  const m = html.match(new RegExp(`class="[^"]*\\b${cls}\\b[^"]*"[^>]*>([\\s\\S]*?)</(?:p|h1|h2|div)>`, 'i'));
  return m ? htmlToText(m[1]) : '';
}

app.post('/api/event-details', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  try {
    if (dmaContentUrl(url)) {
      const data = await fetchDmaPage(url);
      return res.json({
        presenter: '',
        title: htmlToText(String(data.attributes.title || '')),
        dates: dmaDates(data),
        venue: 'Dallas Museum of Art',
        description: dmaDescription(data),
        imageUrl: dmaImages(data)[0] || null,
      });
    }
    const { html, info } = await fetchUsableHtml(url);
    const presenter = eventHeadingField(html, 'eventHeading__preheading');
    let title = eventHeadingField(html, 'eventHeading__title');
    // Some pages repeat the presenter at the start of the title
    // ("TITAS/DANCE UNBOUND Presents Ballets Jazz…") — drop the repeat.
    if (presenter && title.toLowerCase().startsWith(presenter.toLowerCase() + ' ')) {
      title = title.slice(presenter.length).trim();
    }
    if (!title) {
      // Not an attpac.org-style page: use what the page says about itself.
      const details = structuredDetails(html, url);
      // A page built by JavaScript that labels nothing: go by how it looks.
      if (info && info.title && !jsonLdEvent(html) && !metaContent(html, 'og:title')) {
        Object.assign(details, {
          title: info.title,
          dates: details.dates || formatDays(info.dates, true),
          description: details.description && !looksGeneric(details.description, html) ? details.description : info.description,
          imageUrl: details.imageUrl || info.imageUrl,
        });
      }
      if (!details.title) {
        return res.status(422).json({ error: 'Could not find the show info on that page. Fill it in by hand.' });
      }
      if (!details.imageUrl) details.imageUrl = extractAllImages(html, url)[0] || null;
      return res.json(details);
    }
    res.json({
      presenter,
      title,
      dates: eventHeadingField(html, 'eventHeading__dates'),
      venue: eventHeadingField(html, 'eventHeading__venue-name'),
      description: eventHeadingField(html, 'eventHeading__short-description'),
      imageUrl: extractCarouselImage(html, url),
    });
  } catch (err) {
    console.error('Event details error:', err.message);
    res.status(500).json({ error: err.message || 'Could not reach that page. Check the URL and try again.' });
  }
});

// A page closing mid-load in the hidden Chrome can leave a stray rejected
// promise; log it rather than letting it stop the whole server.
process.on('unhandledRejection', err => console.error('Ignored error:', err && err.message ? err.message : err));

app.listen(PORT, () => {
  console.log(`\n  Email Tools running at http://localhost:${PORT}\n`);
});
