'use strict';

/**
 * Tidying the name a set of scenarios is filed under.
 *
 * Names arrive from three places — a sheet's filename, a model's section
 * heading, something typed in a hurry — and they drift apart: "Slack to teams"
 * beside "Chat to Teams", a comma with no space after it, "canva" for Canva,
 * and the word "scenarios" on a card that already sits under "Message
 * Migration Scenarios" next to a count of them.
 *
 * Only those are touched. An earlier version imposed sentence case on
 * everything, which lower-cased "Box for Business" and turned a shelf of
 * write-ups titled "Email Sprawl Scope" into "email sprawl scope" — names
 * their author had already written consistently. Whatever case someone chose
 * is theirs; what is fixed here is what is wrong, not what is different.
 */

/* Written the way the product writes them. Longest first, so "Google Chat"
   is matched before "Chat" and "Microsoft Teams" before "Teams". */
const PROPER = [
  'Google Workspace', 'Google Drive', 'Google Chat', 'Microsoft Teams', 'Microsoft 365',
  'Microsoft Outlook', 'Box for Business', 'SharePoint', 'OneDrive', 'CloudFuze',
  'Dropbox', 'Egnyte', 'Confluence', 'Outlook', 'Gmail', 'Slack', 'Teams', 'Canva',
  'Webex', 'Zoom', 'Jira', 'Exchange', 'M365',
];

/* Initialisms, upper case wherever they appear. */
const INITIALS = ['DM', 'DMs', 'DIY', 'CSV', 'API', 'SSO', 'URL', 'PDF', 'UI', 'QA'];

/* The page is already titled "<Product> Migration Scenarios" and every row
   carries a count of them, so the word on the card says nothing. */
const TRAILING_NOISE = /\s*\b(?:test\s+)?scenarios?\b\s*$/i;

/* Below this, dropping the word leaves a label rather than a name: "Group DM
   Name Scenarios" is worth more than "Group DM Name". */
const KEEP_AT_LEAST = 4;

function spacing(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ', ')     // "channels,Private" — a comma wants a space after it
    .replace(/\s+([.!?;:])/g, '$1')
    .trim();
}

/**
 * @param {string} raw the name as it was given
 * @returns {string} the same name, with what is wrong put right
 */
function tidyName(raw) {
  let name = spacing(raw);
  if (!name) return '';

  const withoutNoise = spacing(name.replace(TRAILING_NOISE, ''));
  if (withoutNoise.split(' ').filter(Boolean).length >= KEEP_AT_LEAST) name = withoutNoise;

  /* Product names, whatever case they were typed in. Word boundaries on both
     sides, so "Teams" in "Teamwork" is left alone. */
  PROPER.forEach((proper) => {
    const pattern = new RegExp(`(^|[^A-Za-z0-9])${proper.replace(/\s+/g, '\\s+')}(?![A-Za-z0-9])`, 'ig');
    name = name.replace(pattern, (whole, before) => `${before}${proper}`);
  });

  INITIALS.forEach((initial) => {
    const pattern = new RegExp(`(^|[^A-Za-z0-9])${initial}(?![A-Za-z0-9])`, 'ig');
    name = name.replace(pattern, (whole, before) => `${before}${initial}`);
  });

  /* A name starts with a capital, whatever was typed. */
  const first = name.search(/[A-Za-z]/);
  if (first >= 0) name = name.slice(0, first) + name[first].toUpperCase() + name.slice(first + 1);

  return name.slice(0, 120);
}

module.exports = { tidyName, PROPER, INITIALS };
