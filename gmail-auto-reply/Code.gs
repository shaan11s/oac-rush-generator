// Ticket DFW auto-reply — a Google Apps Script that runs inside Gmail.
//
// Every few minutes it looks for new emails from SENDER whose subject
// contains one of SUBJECT_MATCHES, pulls the ticketdfw.com event links out of them
// (the first link is the featured show, the rest are "More Upcoming Events"),
// reads each event page, builds the email body with Builder.gs (a copy of
// public/tools/ticket-dfw/builder.js) and emails the HTML back as an .html
// attachment, with a preview in the message itself.
//
// Setup is in README.txt ("Ticket DFW — Gmail auto-reply").

const SENDER = 'shaan.sekhon@attpac.org';
const SUBJECT_MATCHES = ['TICKET DFW', 'TDFW']; // any one of these; case doesn't matter
const REPLY_SUBJECT = 'Ticket DFW HTML';
const EVENTS_HEADING = 'More Upcoming Events';
const CHECK_EVERY_MINUTES = 5;
const DONE_LABEL = 'Ticket DFW HTML sent';

// ── Setup ────────────────────────────────────────────────────────────────────

// Run once by hand (select "setup" and click Run). Starts the timer and marks
// the matching emails already in the inbox as done, so only emails that
// arrive from now on get a reply.
function setup() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'checkInbox')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('checkInbox').timeBased().everyMinutes(CHECK_EVERY_MINUTES).create();

  const done = loadDoneIds();
  matchingMessages().forEach(m => done.add(m.getId()));
  saveDoneIds(done);
  Logger.log(`Checking every ${CHECK_EVERY_MINUTES} minutes. ${done.size} existing email(s) skipped.`);
}

// Run by hand to stop the auto-replies.
function stop() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'checkInbox')
    .forEach(t => ScriptApp.deleteTrigger(t));
  Logger.log('Stopped.');
}

// ── The timer ────────────────────────────────────────────────────────────────

function checkInbox() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return; // the previous run is still going
  try {
    const done = loadDoneIds();
    matchingMessages().forEach(message => {
      if (done.has(message.getId())) return;
      handleMessage(message);
      // Marked done even when it failed: the error was emailed, and retrying
      // every few minutes would only send the same error again.
      done.add(message.getId());
      saveDoneIds(done);
    });
  } finally {
    lock.releaseLock();
  }
}

// Messages are checked one by one, not by thread: Gmail can group several
// forwards with the same subject into one conversation.
function matchingMessages() {
  const query = `from:${SENDER} subject:(${SUBJECT_MATCHES.map(s => `"${s}"`).join(' OR ')}) newer_than:3d`;
  const out = [];
  GmailApp.search(query, 0, 20).forEach(thread => {
    thread.getMessages().forEach(m => {
      const subject = m.getSubject().toUpperCase();
      if (!m.getFrom().toLowerCase().includes(SENDER.toLowerCase())) return;
      if (!SUBJECT_MATCHES.some(s => subject.includes(s.toUpperCase()))) return;
      if (subject.includes(REPLY_SUBJECT.toUpperCase())) return; // our own reply, forwarded back
      out.push(m);
    });
  });
  return out;
}

function handleMessage(message) {
  const to = message.getFrom();
  try {
    const links = extractEventLinks(message.getBody(), message.getPlainBody());
    if (!links.length) {
      GmailApp.sendEmail(to, REPLY_SUBJECT, '', {
        htmlBody: `<p>I couldn't find any ticketdfw.com event links in "${escHtml(message.getSubject())}", so there's no HTML this time.</p>`,
      });
      return;
    }

    const { shows, problems } = loadShows(links);
    const [feature, ...events] = shows;
    const body = buildTicketDfwBody(feature, events, EVENTS_HEADING);
    const date = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
    const file = Utilities.newBlob(body, 'text/html', `ticket-dfw-${date}.html`);

    const notes = problems.concat(checkShows(feature, events));
    const summary = `<p style="font-family:arial;font-size:14px;">The Ticket DFW HTML is attached (<b>${escHtml(file.getName())}</b>) — featured show: <b>${escHtml(feature.title || feature.url)}</b>, plus ${events.length} more event${events.length === 1 ? '' : 's'}. A preview is below.</p>`
      + (notes.length ? `<p style="font-family:arial;font-size:14px;"><b>Check before sending:</b></p><ul style="font-family:arial;font-size:14px;">${notes.map(n => `<li>${escHtml(n)}</li>`).join('')}</ul>` : '')
      + '<hr style="margin:24px 0;">';

    GmailApp.sendEmail(to, REPLY_SUBJECT, 'The Ticket DFW HTML is attached.', {
      htmlBody: summary + body,
      attachments: [file],
    });
    message.getThread().addLabel(GmailApp.getUserLabelByName(DONE_LABEL) || GmailApp.createLabel(DONE_LABEL));
  } catch (e) {
    GmailApp.sendEmail(to, REPLY_SUBJECT + ' — failed', '', {
      htmlBody: `<p>Something went wrong building the HTML for "${escHtml(message.getSubject())}":</p><pre>${escHtml(String(e && e.stack || e))}</pre>`,
    });
  }
}

// Things the email should not go out without, e.g. the Here Nor There page
// lists no venue.
function checkShows(feature, events) {
  const notes = [];
  [feature].concat(events).forEach((s, i) => {
    const name = s.title || s.url;
    const missing = [];
    if (!s.title) missing.push('title');
    if (!s.dates) missing.push('dates');
    if (!s.venue) missing.push('venue');
    if (!s.rawImgUrl) missing.push('image (search the file for INSERT_IMAGE_URL_HERE)');
    if (i === 0 && !s.blurb) missing.push('description');
    if (missing.length) notes.push(`${i === 0 ? 'Featured show' : 'Event'} "${name}" has no ${missing.join(', ')}.`);
  });
  return notes;
}

// ── Finding the links ────────────────────────────────────────────────────────

const EVENT_LINK = /^https?:\/\/(?:www\.)?(?:ticketdfw\.com|attpac\.org)\/events?\/[^\s"'<>]+/i;

// Event links in the order they appear. Handles links rewritten by Outlook
// Safe Links (the email is forwarded from an attpac.org Outlook account) and
// by Google's redirector.
function extractEventLinks(htmlBody, plainBody) {
  const candidates = [];
  const hrefRe = /href\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = hrefRe.exec(htmlBody || ''))) candidates.push(m[1]);
  const textRe = /https?:\/\/[^\s"'<>\]\)]+/gi;
  while ((m = textRe.exec(plainBody || ''))) candidates.push(m[0]);

  const seen = {};
  const links = [];
  candidates.forEach(raw => {
    const url = cleanLink(raw);
    if (!url) return;
    const key = url.toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
    if (seen[key]) return;
    seen[key] = true;
    links.push(url);
  });
  return links;
}

function cleanLink(raw) {
  let url = raw.replace(/&amp;/g, '&').trim();
  for (let i = 0; i < 3; i++) { // unwrap nested redirects
    const wrapped = url.match(/safelinks\.protection\.outlook\.com\/.*?[?&]url=([^&]+)/i)
                 || url.match(/google\.com\/url\?.*?[?&]q=([^&]+)/i);
    if (!wrapped) break;
    try { url = decodeURIComponent(wrapped[1]); } catch (e) { break; }
  }
  const match = url.match(EVENT_LINK);
  if (!match) return '';
  return match[0].replace(/[?#].*$/, '').replace(/[.,;:!]+$/, '');
}

// ── Reading the event pages ──────────────────────────────────────────────────
// A copy of the page reading in server.js (/api/event-details).

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
};

function loadShows(links) {
  const responses = UrlFetchApp.fetchAll(links.map(url => ({
    url, headers: FETCH_HEADERS, muteHttpExceptions: true, followRedirects: true,
  })));
  const problems = [];
  const shows = responses.map((res, i) => {
    const url = links[i];
    if (res.getResponseCode() !== 200) {
      problems.push(`Couldn't open ${url} (error ${res.getResponseCode()}) — fill that show in by hand.`);
      return { url, cta: DEFAULT_CTA };
    }
    const show = parseEventPage(res.getContentText(), url);
    if (!show.title) problems.push(`Couldn't read the show info on ${url} — fill it in by hand.`);
    return show;
  });
  return { shows, problems };
}

function parseEventPage(html, url) {
  const presenter = eventHeadingField(html, 'eventHeading__preheading');
  let title = eventHeadingField(html, 'eventHeading__title');
  // Some pages repeat the presenter at the start of the title.
  if (presenter && title.toLowerCase().startsWith(presenter.toLowerCase() + ' ')) {
    title = title.slice(presenter.length).trim();
  }
  return {
    url,
    presenter,
    title,
    dates: dateOnly(eventHeadingField(html, 'eventHeading__dates')),
    venue: eventHeadingField(html, 'eventHeading__venue-name'),
    blurb: eventHeadingField(html, 'eventHeading__short-description'),
    rawImgUrl: extractCarouselImage(html, url),
    imgAlt: title,
    cta: DEFAULT_CTA,
  };
}

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…',
};

function htmlToText(fragment) {
  return fragment
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] || m)
    .replace(/\s+/g, ' ')
    .trim();
}

function eventHeadingField(html, cls) {
  const m = html.match(new RegExp(`class="[^"]*\\b${cls}\\b[^"]*"[^>]*>([\\s\\S]*?)</(?:p|h1|h2|div)>`, 'i'));
  return m ? htmlToText(m[1]) : '';
}

function decodeHtmlEntities(str) {
  return str.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
}

// The untouched imgix photo from the page's carousel, else og:image.
function extractCarouselImage(html, pageUrl) {
  const m1 = html.match(/data-original=["'](https:\/\/attpac-media\.imgix\.net\/[^"']+)["']/i)
          || html.match(/data-src=["'](https:\/\/attpac-media\.imgix\.net\/[^"']+)["']/i);
  if (m1) return decodeHtmlEntities(m1[1]);
  const m2 = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
          || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  if (!m2) return '';
  const raw = decodeHtmlEntities(m2[1]);
  if (/^https?:\/\//i.test(raw)) return raw;
  const origin = (pageUrl.match(/^https?:\/\/[^\/]+/i) || [''])[0];
  return raw.startsWith('/') ? origin + raw : raw;
}

// ── Remembering what's been answered ─────────────────────────────────────────

function loadDoneIds() {
  const raw = PropertiesService.getScriptProperties().getProperty('doneIds');
  return new Set(raw ? JSON.parse(raw) : []);
}

function saveDoneIds(ids) {
  const list = Array.from(ids).slice(-300); // plenty for a 3-day search window
  PropertiesService.getScriptProperties().setProperty('doneIds', JSON.stringify(list));
}
