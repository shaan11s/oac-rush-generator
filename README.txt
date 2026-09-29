# Email Tools
AT&T Performing Arts Center — Internal Tools

A set of email-building tools. The main page (http://localhost:3000) lists
every tool; pick one to open it. Each tool lives in its own folder:

   public/index.html                  main page (tool picker)
   public/tools/culture-calendar/     Culture Calendar HTML Generator
   public/tools/wide-blocks/          Wide Blocks
   public/tools/square-blocks/        Square Blocks
   public/tools/main-feature/         Main Feature
   public/tools/main-features/        2 Main Features
   public/vendor/                     shared libraries

To add a tool: create public/tools/<name>/index.html and add a card for it
in public/index.html.

---

## Requirements
- Node.js 16 or later (https://nodejs.org)

---

## Setup (first time only)

1. Unzip this folder somewhere on your computer.
2. Open a terminal / command prompt and navigate to the folder:
   cd oac-rush-generator
3. Install dependencies:
   npm install

---

## Running the tool

Every time you need to use the tools:

   npm start

Then open your browser and go to:

   http://localhost:3000

To stop the server, press Ctrl+C in the terminal.

---

## Culture Calendar HTML Generator

Paste the Culture Calendar email (or upload an Excel/CSV sheet), auto-fetch
show images from each event page — including 3rd-party ticketing sites —
and generate copy-ready HTML blocks for ActiveCampaign.

## How to use

### Option A — Paste the email
1. Paste the email into the text area (tab defaults to this).
2. Click "Parse Shows" — the tool extracts all shows automatically.

### Option B — Upload an Excel/CSV sheet
1. Click the "Upload Excel" tab.
2. Choose a .xlsx/.xls/.csv file with one show per row, columns in this
   order: Presenter, Title, Subtitle, Date Text, Venue, CTA, Link.
   A header row is fine — it's detected and skipped automatically.
   A leading apostrophe in a cell (e.g. 'Tis the Season) is kept.

### Option C — Edit existing HTML
1. Click the "Import HTML" tab.
2. Paste HTML this tool generated before (or a whole email containing those
   show blocks), or click "Open .html file…".
3. Click "Load Shows" — every show fills back into the cards, images and
   crops included. Edit what you need and generate fresh HTML.

### Then, any way:
3. Click "Fetch All Images" to auto-pull a photo for every show at once, or
   use a show's own buttons:
   - the fetch icon auto-picks the best photo from that show's page, or
   - the gallery icon opens every image found on the page so you can pick
     one and drag/zoom to crop it manually.
   All images are normalized to AT&T's standard 622×350 size, whichever
   method you use. A green "✓" badge appears on each show when successful;
   if nothing is found, paste an image URL manually, or pick one from the
   "Preset image…" dropdown (hard-coded links in public/tools/culture-calendar/preset-images.js;
   presets are used as-is, not cropped).
4. Review/edit any field if something was misread.
5. Click "Generate HTML", then "Copy HTML" or "Download .html".
6. Paste the HTML blocks into your ActiveCampaign template.

---

## Notes

- Images are fetched server-side to avoid browser CORS restrictions.
- Event links can point at attpac.org, ticketdfw.com, or any 3rd-party
  ticketing/event page — the server blocks requests aimed at internal/
  private network addresses for safety, but otherwise fetches any public
  http/https page you give it.
- AT&T's own imgix-hosted photos are cropped via imgix directly (matches
  the original finalized templates exactly). Everything else is cropped/
  resized to 622×350 via images.weserv.nl (wsrv.nl), a free public image
  proxy — the final image URL in the HTML points there, not at your
  computer, so no image hosting/storage is needed on your end.
- If an image can't be auto-fetched, the HTML still outputs with
  INSERT_IMAGE_URL_HERE as a placeholder you can swap manually.

---

## Wide Blocks

1. Paste one or more attpac.org event links (one per line) and click
   "Load Shows". The presenter, title, dates, venue and photo are read from
   each event page; the year is dropped from the dates.
2. Check each show. Price defaults to $25; "Second Bold Line" is optional
   (e.g. a subtitle). Use the arrows to reorder shows.
3. Copy or download the HTML and paste the rows into the email's main
   675px table.

---

## Square Blocks

The "Upcoming Shows" squares: three per row, each with an image, the show
details and a red Buy Tickets button.

1. Paste attpac.org event links (one per line) and click "Load Shows". The
   presenter, title, dates (with year) and venue come from each page.
2. Paste an image link into each show — images start blank. Use "Extra Line"
   for things like "2pm Matinee Performance". Use the arrows to reorder.
3. Copy or download the HTML and paste the rows into the email's main 675px
   table. Shows fill rows of three in order; if the last row is short, the
   leftover spots are left empty.

---

## 2 Main Features

The two side-by-side featured shows at the top of an email, with an optional
28px heading above them ("Two New Shows Are On Sale Now!").

1. Paste two attpac.org event links and click "Load Shows" — the first goes
   on the left, the second on the right (use the arrows to swap).
2. Each show's photo is filled in from its event page and cropped to 16:9
   (paste a different image link to replace it). Use "Extra Line" for a time
   like "8:00 p.m.". Edit or clear the heading as needed.
3. Copy or download the HTML and paste the rows into the email's main 675px
   table. With only one show loaded, the right side is left empty.

---

## Main Feature

The single big feature right under the email header: a full-width image, a
28px headline, "Dates | Venue", a blurb, a button and an optional note.

1. Paste one attpac.org event link and click "Load Show". The image (cropped
   to 16:9), dates, venue and a starting blurb come from the event page.
   Loading another link replaces the current show.
2. Type a tagline over the headline (it starts as the show title), trim the
   blurb, and set the button text and link (e.g. a presale login link). The
   note below the button is optional — a bold part and a regular part.
3. Copy or download the HTML and paste the rows into the email's main 675px
   table, under the header.

