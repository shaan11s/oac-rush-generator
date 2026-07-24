# OAC Rush HTML Generator
AT&T Performing Arts Center — Internal Tool

Paste OAC Rush email (or upload an Excel/CSV sheet), auto-fetch
show images from each event page — including 3rd-party ticketing sites —
and generate copy-ready HTML blocks for ActiveCampaign.

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

Every time you need to generate a rush email:

   npm start

Then open your browser and go to:

   http://localhost:3000

To stop the server, press Ctrl+C in the terminal.

---

## How to use

### Option A — Paste Hector's email
1. Paste the email into the text area (tab defaults to this).
2. Click "Parse Shows" — the tool extracts all shows automatically.

### Option B — Upload an Excel/CSV sheet
1. Click the "Upload Excel" tab.
2. Choose a .xlsx/.xls/.csv file with one show per row, columns in this
   order: Presenter, Title, Subtitle, Date Text, Venue, CTA, Link.
   A header row is fine — it's detected and skipped automatically.

### Then, either way:
3. Click "Fetch All Images" to auto-pull a photo for every show at once, or
   use a show's own buttons:
   - the fetch icon auto-picks the best photo from that show's page, or
   - the gallery icon opens every image found on the page so you can pick
     one and drag/zoom to crop it manually.
   All images are normalized to AT&T's standard 622×350 size, whichever
   method you use. A green "✓" badge appears on each show when successful;
   if nothing is found, paste an image URL manually.
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
