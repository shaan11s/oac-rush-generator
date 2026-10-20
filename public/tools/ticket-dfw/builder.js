// Builds the Ticket DFW email body. Shared by the Ticket DFW web tool
// (index.html) and the Gmail auto-reply script (gmail-auto-reply/Code.gs),
// so it must stay plain JavaScript with no browser-only APIs (no document,
// URL or URLSearchParams). After changing it, paste it again into the Apps
// Script project's Builder.gs file.
//
// A show is { presenter, title, dates, venue, blurb, cta, url, rawImgUrl,
// imgAlt }; any field can be empty.

// Some pages put a time in the date line ("October 11, 2026 - 2pm Matinee
// Performance"). Keep only the date: drop whatever follows the year unless
// it's the end of a date range ("Dec 27, 2026 - Jan 3, 2027"), and drop a
// trailing time when there's no year ("Oct 7 at 7:30 pm").
const MONTH_START = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;
function dateOnly(dates) {
  dates = (dates || '').trim();
  const m = dates.match(/^(.*\b(?:19|20)\d{2})\s*[-–—,]?\s*(.+)$/);
  if (m && !MONTH_START.test(m[2]) && !/\b(19|20)\d{2}\b/.test(m[2])) return m[1];
  return dates.replace(/,?\s*(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)(?=\W|$).*$/i, '').trim();
}

// Crops the photo to 16:9 (the shape of every image in the example email) at
// 2× its display width so it stays sharp: 675px for the feature, and 600px
// for the event photos — they're 200px on desktop but full width on phones. attpac-media imgix photos are cropped by imgix
// directly; anything else goes through the wsrv.nl image proxy.
function buildImageUrl(rawUrl, displayWidth) {
  if (!rawUrl) return '';
  const w = displayWidth * 2, h = Math.round(displayWidth * 2 * 9 / 16);
  // No URL/URLSearchParams here: Apps Script doesn't have them.
  const host = (rawUrl.match(/^https?:\/\/([^\/?#]+)/i) || [])[1] || '';
  if (host.includes('imgix.net')) {
    return rawUrl.split(/[?#]/)[0] + `?fit=crop&crop=faces%2Centropy%2Ccenter&w=${w}&h=${h}&q=75&fm=jpg`;
  }
  if (!host) return rawUrl;
  return `https://wsrv.nl/?url=${encodeURIComponent(rawUrl.replace(/^https?:\/\//, ''))}&w=${w}&h=${h}&fit=cover&a=attention&output=jpg&q=75`;
}

// ── HTML generation ──────────────────────────────────────────────────────────
// Copies the Ticket DFW email body (here-nor-there): a 675px white table
// holding the feature — full-width image, 30px bold centred title, 18px bold
// "Dates | Venue" line, 18px justified description, orange "Get Tickets"
// button — then a 30px spacer, a 24px "More Upcoming Events" heading and a
// list of events (200px image on the left; presenter, title, venue, dates
// and a "Get Tickets" link on the right) separated by 1px black rules. Empty
// text rows are left out.

const DEFAULT_CTA = 'Get Tickets';
const BASE_ID = 960000;
const TABLE_STYLE = '-ms-text-size-adjust: auto; -webkit-text-size-adjust: 100%; border-collapse: collapse; font-size: 14px; min-width: 100%; mso-table-lspace: 0pt; mso-table-rspace: 0pt;';
const TABLE_STYLE_INITIAL = '-ms-text-size-adjust: auto; -webkit-text-size-adjust: 100%; border-collapse: initial !important; font-size: 14px; min-width: 100%; mso-table-lspace: 0pt; mso-table-rspace: 0pt;';
const ORANGE = '#e3460f';

// Outlook draws the button from the VML shape, which needs a fixed width.
// The example's "Get Tickets" (18px text, 16px padding) is 144px.
function buttonWidth(text) {
  return Math.max(144, Math.round(144 + (text.length - 11) * 8.5));
}

function imgSrc(s, width) { return buildImageUrl(s.rawImgUrl, width) || 'INSERT_IMAGE_URL_HERE'; }

function featureImageRow(id, feature) {
  return `<tr style="mso-line-height-rule: exactly;">
<td id="layout-row-margin${id}" valign="top" style="mso-line-height-rule: exactly; padding: 0px;">
<table width="100%" border="0" cellpadding="0" cellspacing="0" style="${TABLE_STYLE_INITIAL}">
<tr id="layout-row${id}" class="layout layout-row widget _widget_picture style${id}" align="center" style="mso-line-height-rule: exactly;">
<td id="layout-row-padding${id}" valign="top" style="mso-line-height-rule: exactly; padding: 0px;">
<table width="100%" border="0" cellpadding="0" cellspacing="0" style="${TABLE_STYLE}">
<tr style="mso-line-height-rule: exactly;">
<td class="image-td tdfw-hero" align="center" valign="top" width="100%" style="mso-line-height-rule: exactly;"><a href="${escAttr(feature.url || '#')}" style="margin: 0; outline: none; padding: 0; color: #000000; display: block; min-width: 100%;"><img src="${escAttr(imgSrc(feature, 675))}" alt="${escAttr(feature.imgAlt || feature.title)}" width="675" style="border: none; display: block; outline: none; width: 675px; opacity: 1; max-width: 100%;"></a></td>
</tr>
</table></td>
</tr>
</table></td>
</tr>`;
}

// The title, date/venue and description rows share one wrapper; only the
// padding, width and inner <div> differ.
function textRow(id, inner, wide) {
  const pad = wide ? '5px' : '5px 10px 5px 10px';
  const width = wide ? 665 : 655;
  return `<tr style="mso-line-height-rule: exactly;">
<td id="layout-row-margin${id}" valign="top" style="mso-line-height-rule: exactly; padding: 0px;">
<table width="100%" border="0" cellpadding="0" cellspacing="0" style="${TABLE_STYLE_INITIAL}">
<tr id="layout-row${id}" class="layout layout-row widget _widget_text style${id}" style="mso-line-height-rule: exactly; margin: 0; padding: 0;">
<td id="layout-row-padding${id}" valign="top" style="mso-line-height-rule: exactly; padding: ${pad};">
<table width="100%" border="0" cellpadding="0" cellspacing="0" style="${TABLE_STYLE}">
<tr style="mso-line-height-rule: exactly;">
<td id="text_div${id + 5}" class="td_text td_block" valign="top" align="left" width="${width}" style="line-height: 140%; mso-line-height-rule: exactly; margin: 0; outline: none; padding: 0; color: inherit; font-size: 12px; font-weight: inherit; line-height: 1.4; text-decoration: inherit; font-family: arial;">
${inner}<!--[if (gte mso 12)&(lte mso 15) ]>
<style data-ac-keep="true" data-ac-inline="false"> #text_div${id + 5}, #text_div${id + 5} div { line-height: 140% !important; };
</style>
<![endif]--></td>
</tr>
</table></td>
</tr>
</table></td>
</tr>`;
}

function boldCentredInner(text, size) {
  return `<div style="line-height: 140%; margin: 0; outline: none; padding: 0; color: inherit; font-size: ${size}px; font-weight: inherit; line-height: 1.4; text-decoration: inherit; mso-line-height-rule: exactly; text-align: center;" data-line-height="1.4">
<span style="color: inherit; font-size: inherit; font-weight: bold; line-height: inherit; text-decoration: inherit;">${escHtml(text)}</span>
</div>`;
}

// *Words in asterisks* become italics, the way the example sets show titles
// (<em>Here Nor There</em>).
function formatBlurb(text) {
  return escHtml(text)
    .replace(/\*([^*\n]+)\*/g, '<em style="font-style: italic;">$1</em>')
    .replace(/\n/g, '<br>');
}

function blurbInner(feature) {
  return `<div class="tdfw-blurb" style="line-height: 140%; margin: 0; outline: none; padding: 0; color: #000000; font-size: 18px; font-weight: 400; line-height: 1.4; text-decoration: inherit; mso-line-height-rule: exactly; text-align: justify; font-family: arial;" data-line-height="1.4">
${formatBlurb(feature.blurb)}
</div>`;
}

function buttonRow(id, feature) {
  const url = escAttr(feature.url || '#');
  const cta = feature.cta || DEFAULT_CTA;
  return `<tr style="mso-line-height-rule: exactly;">
<td id="layout-row-margin${id}" valign="top" style="mso-line-height-rule: exactly; padding: 5px;">
<table width="100%" border="0" cellpadding="0" cellspacing="0" style="${TABLE_STYLE_INITIAL}">
<tr id="layout-row${id}" class="layout layout-row widget _widget_button style${id}" style="mso-line-height-rule: exactly;">
<td id="layout-row-padding${id}" valign="top" style="mso-line-height-rule: exactly; padding: 5px;">
<table width="100%" border="0" cellpadding="0" cellspacing="0" style="${TABLE_STYLE}">
<tr style="mso-line-height-rule: exactly;">
<td class="td_button td_block customizable" valign="top" align="left" width="655" style="mso-line-height-rule: exactly;">
<div class="button-wrapper" style="margin: 0; outline: none; padding: 0; text-align: center;">
<!--[if mso]> <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${url}" style="v-text-anchor:middle; width:${buttonWidth(cta)}px; height:72px; " arcsize="0%" strokecolor="#030303" strokeweight="1pt" fillcolor="${ORANGE}" o:button="true" o:allowincell="true" o:allowoverlap="false" > <v:textbox inset="2px,2px,2px,2px"> <center style="color:#ffffff;font-family:Arial; font-size:18px; line-height: 1.1;">${escHtml(cta)}</center> </v:textbox> </v:roundrect>
<![endif]--> <a href="${url}" style="margin: 0; outline: none; padding: 16px; color: #ffffff; background: ${ORANGE}; background-color: ${ORANGE}; border: 1px solid #030303; font-family: Arial; font-size: 18px; display: inline-block; line-height: 1.1; text-align: center; text-decoration: none; mso-hide: all;"> <span style="color:#ffffff;font-family:Arial;font-size:18px;"> ${escHtml(cta)} </span> </a>
</div></td>
</tr>
</table></td>
</tr>
</table></td>
</tr>`;
}

function spacerRow(id) {
  return `<tr style="mso-line-height-rule: exactly;">
<td id="layout-row-margin${id}" valign="top" style="mso-line-height-rule: exactly;">
<div class="spacer" style="margin: 0; outline: none; padding: 0; height: 30px; line-height: 30px; font-size: 30px;">&nbsp;</div>
</td>
</tr>`;
}

function headingRow(id, text) {
  return `<tr style="mso-line-height-rule: exactly;">
<td id="layout-row-margin${id}" valign="top" style="mso-line-height-rule: exactly; padding: 5px;">
<table width="100%" border="0" cellpadding="0" cellspacing="0" style="${TABLE_STYLE}">
<tr id="layout-row${id}" class="layout layout-row widget _widget_text style${id}">
<td id="text_div${id + 5}" class="td_text td_block" valign="top" align="center" width="655" style="mso-line-height-rule: exactly; margin: 0; outline: none; padding: 5px; color: inherit; font-size: 24px; font-weight: inherit; line-height: 1; text-decoration: inherit; font-family: arial; text-align: center;">
${escHtml(text)}
</td>
</tr>
</table></td>
</tr>`;
}

function dividerRow(id, gap) {
  return `<tr style="mso-line-height-rule: exactly;">
<td id="layout-row-margin${id}" valign="top" style="mso-line-height-rule: exactly;">
<table width="100%" border="0" cellpadding="0" cellspacing="0" style="border-collapse: collapse; line-height: 0; mso-line-height-rule: exactly;">
<tr><td height="${gap}" style="font-size: ${gap}px; height: ${gap}px; line-height: 0;"></td></tr>
<tr><td class="break-line" bgcolor="#000000" height="1" width="100%" style="line-height: 1px; height: 1px; width: 100%; background-color: #000000;"></td></tr>
<tr><td height="${gap}" style="font-size: ${gap}px; height: ${gap}px; line-height: 0;"></td></tr>
</table></td>
</tr>`;
}

// Each event is two columns — a 200px photo and the text — that stack on a
// phone into a full-width photo with the text underneath. See
// stackingColumn for how that works without help from a <style> block.
function eventRow(id, s) {
  const url = escAttr(s.url || '#');
  const lines = [];
  if (s.presenter) lines.push(`<span class="tdfw-small" style="font-size: 12px; font-weight: 400;">${escHtml(s.presenter)}</span><br>`);
  if (s.title) lines.push(`<span class="tdfw-title" style="font-size: 18px; font-weight: bold;">${escHtml(s.title)}</span><br>`);
  const where = [s.venue, s.dates].filter(Boolean).map(t => escHtml(t) + '<br>').join('');
  if (where) lines.push(`<span class="tdfw-small" style="font-size: 12px; font-weight: 400;">${where}</span>`);
  lines.push(`<a href="${url}" target="_blank" style="color: #000000; text-decoration: underline; font-family: arial; font-weight: bold; font-size: 14px;">${escHtml(s.cta || DEFAULT_CTA)}</a>`);
  return `<tr id="layout-row${id}" class="layout layout-row clear-this " style="mso-line-height-rule: exactly;">
<td id="layout-row-padding${id}" valign="top" style="mso-line-height-rule: exactly; font-size: 0; text-align: left;">
<!--[if mso]><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td valign="top" width="200"><![endif]-->
<div id="layout-row${id + 1}" class="tdfw-event-img" style="${stackingColumn(EVENT_IMG_WIDTH, 'top')}"><a href="${url}" style="margin: 0; outline: none; padding: 0; color: #000000; display: block;"><img src="${escAttr(imgSrc(s, 600))}" alt="${escAttr(s.imgAlt || s.title)}" width="200" style="border: none; display: block; outline: none; width: 100%; height: auto; opacity: 1;"></a></div><!--[if mso]></td><td valign="top" width="475"><![endif]--><div class="tdfw-event-text" style="${stackingColumn(EVENT_TEXT_WIDTH, 'top')}">
<div class="tdfw-event-pad" style="padding: 5px 10px 5px 10px; font-family: arial; color: #000000; font-size: 12px; line-height: 1.4; text-align: left;">
${lines.join('\n')}
</div>
</div><!--[if mso]></td></tr></table><![endif]-->
</td>
</tr>`;
}

// feature: one show or null; events: a list of shows; heading: the text above
// the events ("More Upcoming Events"), or '' to leave it out.
function buildTicketDfwRows(feature, events, heading) {
  const rows = [];
  let id = BASE_ID;
  const next = () => (id += 10);

  if (feature) {
    rows.push(featureImageRow(next(), feature));
    if (feature.title) rows.push(textRow(next(), boldCentredInner(feature.title, 30), true));
    const when = [feature.dates, feature.venue].filter(Boolean).join(' | ');
    if (when) rows.push(textRow(next(), boldCentredInner(when, 18), true));
    if (feature.blurb) rows.push(textRow(next(), blurbInner(feature), false));
    rows.push(buttonRow(next(), feature));
    if (events.length) rows.push(spacerRow(next()));
  }
  if (events.length) {
    if (heading) rows.push(headingRow(next(), heading));
    rows.push(dividerRow(next(), 12));
    events.forEach(s => {
      rows.push(eventRow(next(), s));
      rows.push(dividerRow(next(), 12));
    });
  }
  return rows.join('\n\n');
}

// The outer wrapper copied from the example: a full-width white table around
// the email column. The column is 100% wide up to 675px rather than a fixed
// 675px, so pasted into a slightly narrower spot in a template it shrinks to
// fit instead of sticking out. Outlook for Windows ignores max-width, so it
// gets a fixed 675px table inside <!--[if mso]> comments.
// Two columns that sit side by side on desktop and stack, each full width, on
// a phone. Every mail app needs a different route to that:
// - Gmail ignores <style> in the email body, so the column's own style does
//   it (the "Fab Four" technique): calc() is hugely negative in a container
//   wider than STACK_BELOW, so min-width (the desktop width) wins, and hugely
//   positive in a narrower one, so max-width (100%) wins. No nested brackets
//   in the calc — Gmail drops those.
// - Outlook (every version) has no calc(), but outside Windows it reads the
//   <style> in MOBILE_STYLE, which sets the same widths with !important.
// - Outlook for Windows uses neither; it gets a plain table inside
//   <!--[if mso]> comments.
// The parent cell has font-size: 0 and there's no space between the two
// <div>s, so nothing but the columns takes up room on the line; the widths
// also add up to a bit under 100% as a safety margin.
const STACK_BELOW = 600;
const EVENT_IMG_WIDTH = '29.6%';   // 200px of 675
const EVENT_TEXT_WIDTH = '69.6%';
function stackingColumn(width, valign) {
  return `display: inline-block; vertical-align: ${valign}; width: ${width}; min-width: ${width}; max-width: 100%; width: calc(${STACK_BELOW * STACK_BELOW}px - ${STACK_BELOW}00%);`;
}

// Read by every mail app except Gmail (which ignores <style> in the body —
// it gets the layout from stackingColumn instead): the desktop column widths
// for Outlook, which has no calc(), and on phones (600px and narrower, the
// same cut-off as ActiveCampaign's template) a full-width feature photo and
// events stacked as a full-width photo with slightly larger text underneath.
// On phones every table and image in the email — the template's header banner
// too — is also capped at the screen width: one fixed-width one is enough to make
// iPhone Mail zoom the whole email out, leaving our blocks a strip of it.
// The feature description is left-aligned on phones rather than justified,
// which leaves big gaps between words on a narrow screen. data-ac-keep stops
// ActiveCampaign from removing the <style>.
const MOBILE_STYLE = `<style data-ac-keep="true">
.tdfw-event-img { width: ${EVENT_IMG_WIDTH} !important; }
.tdfw-event-text { width: ${EVENT_TEXT_WIDTH} !important; }
@media only screen and (max-width: ${STACK_BELOW}px) {
table, td, img { max-width: 100% !important; } img { height: auto !important; }
.tdfw-event-img, .tdfw-event-text { width: 100% !important; }
.tdfw-hero img { width: 100% !important; max-width: 100% !important; height: auto !important; }
.tdfw-event-pad { padding: 12px 10px 4px 10px !important; }
.tdfw-blurb { text-align: left !important; }
.tdfw-small { font-size: 15px !important; }
.tdfw-title { font-size: 22px !important; }
}</style>`;

function wrapTicketDfwBody(rows) {
  return `<table class="template-table" border="0" cellpadding="0" cellspacing="0" width="100%" align="left" style="-ms-text-size-adjust: auto; -webkit-text-size-adjust: 100%; border-collapse: collapse; font-size: 14px; min-width: auto; mso-table-lspace: 0pt; mso-table-rspace: 0pt; background-color: #ffffff; background: #ffffff;">
<tr style="mso-line-height-rule: exactly;">
<td align="center" valign="top" width="100%" style="mso-line-height-rule: exactly;">
${MOBILE_STYLE}
<!--[if mso]><table role="presentation" width="675" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table class="template-table" border="0" cellpadding="0" cellspacing="0" width="100%" bgcolor="#ffffff" style="-ms-text-size-adjust: auto; -webkit-text-size-adjust: 100%; border-collapse: collapse; font-size: 14px; min-width: auto; mso-table-lspace: 0pt; mso-table-rspace: 0pt; max-width: 675px;">
<tr style="mso-line-height-rule: exactly;">
<td valign="top" align="center" width="100%" style="mso-line-height-rule: exactly;">
<table cellpadding="0" cellspacing="0" border="0" class="layout layout-table root-table" width="100%" style="-ms-text-size-adjust: auto; -webkit-text-size-adjust: 100%; border-collapse: collapse; font-size: 14px; min-width: 100%; mso-table-lspace: 0pt; mso-table-rspace: 0pt;">

${rows}

</table></td>
</tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td>
</tr>
</table>`;
}

// The whole email body, ready to paste.
function buildTicketDfwBody(feature, events, heading) {
  return wrapTicketDfwBody(buildTicketDfwRows(feature, events, heading));
}

function escHtml(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escAttr(s) { return escHtml(s).replace(/"/g, '&quot;'); }
