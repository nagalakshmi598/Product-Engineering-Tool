'use strict';

/**
 * Writing a walkthrough guide into the tool.
 *
 * A guide is a write-up of a different shape: a numbered run of steps, each
 * with a sentence saying what was done and a screenshot of the screen it was
 * done on — the shape of "DIY Email Migration Guide For Outlook to Gmails".
 *
 * It is stored exactly as an uploaded write-up is, so it reads on the
 * Documents page like any other, its screenshots are served from the same
 * place, and the assistant can draft scenarios from it without knowing it was
 * not a Word file.
 *
 * Nothing here captures anything. A step arrives with its screenshot already
 * taken; where that image came from — a browser being driven, a frame lifted
 * from a recording, a file someone picked — is the caller's business.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const store = require('./store');
const { documentFilePath } = require('./documents');

const { DOC_DIR: DOC_ROOT } = require('./paths');

function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * A sentence with the things you click in it set in bold.
 *
 * A walkthrough is read with one eye while the other is on the screen being
 * worked, and what the eye is looking for is the name of the button. Marking
 * those is the one piece of formatting the text needs, so **Next: Migration
 * Progress** survives into the page as bold and everything else is escaped.
 */
function richText(text) {
  return escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(?:--|—)>|-&gt;/g, '→');
}

/** png, jpeg or webp, from the opening bytes rather than from a claim. */
function imageExtension(buffer) {
  if (!buffer || buffer.length < 12) return null;
  const hex = buffer.subarray(0, 12).toString('hex');

  if (hex.startsWith('89504e470d0a1a0a')) return '.png';
  if (hex.startsWith('ffd8ff')) return '.jpg';
  if (hex.startsWith('52494646') && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return '.webp';

  return null;
}

/**
 * Write a guide into the tool.
 *
 * @param {object} guide
 * @param {string} guide.title        what the guide is called
 * @param {string} [guide.product]    the product it belongs under
 * @param {string} [guide.intro]      a sentence before the first step
 * @param {Array<{title: string, text: string, bullets?: string[],
 *                screenshot?: Buffer, screenshots?: Buffer[]}>} guide.steps
 * @returns {Promise<object>} the stored document
 */
async function writeGuide({ title, product = '', intro = '', steps = [] }) {
  const name = String(title || '').trim();
  if (!name) {
    const err = new Error('A guide needs a title.');
    err.status = 400;
    throw err;
  }
  if (!steps.length) {
    const err = new Error('A guide needs at least one step.');
    err.status = 400;
    throw err;
  }

  const id = crypto.randomUUID();
  const folder = path.join(DOC_ROOT, id);
  fs.mkdirSync(folder, { recursive: true });

  const lines = [`<h1>${escapeHtml(name)}</h1>`];
  if (intro) lines.push(`<p>${escapeHtml(intro)}</p>`);

  let shots = 0;

  /* Numbered steps are the things the reader does. A page reporting back —
     a migration running, a set of checks that passed, a completion summary —
     is a section with a heading of its own, which is how the guides this
     follows are written. It does not take a number, because nobody does it. */
  let number = 0;

  steps.forEach((step, i) => {
    const heading = richText(step.title || 'Step');
    if (step.section) {
      lines.push(`<h3>${heading}</h3>`);
    } else {
      number += 1;
      lines.push(`<h3>Step ${number}: ${heading}</h3>`);
    }

    if (step.text) lines.push(`<p>${richText(step.text)}</p>`);

    /* Some steps are a screen of switches rather than a single click, and
       reading those back as one long sentence loses which is which. */
    const bullets = (step.bullets || []).filter((b) => String(b || '').trim());
    if (bullets.length) {
      lines.push('<ul>');
      bullets.forEach((b) => lines.push(`<li>${richText(b)}</li>`));
      lines.push('</ul>');
    }

    /* One step often spans two screens — the dialog open, then the result —
       and a guide that keeps only the first leaves the reader at the dialog. */
    const shotsHere = step.screenshots && step.screenshots.length
      ? step.screenshots
      : [step.screenshot];

    shotsHere.forEach((picture) => {
      /* A step without a picture is still a step: the sentence carries it,
         and saying so is better than leaving a gap where an image failed. */
      const ext = imageExtension(picture);
      if (!ext) {
        if (picture) lines.push('<p><em>(the screenshot for this step could not be read)</em></p>');
        return;
      }

      shots += 1;
      const file = `image-${shots}${ext}`;
      fs.writeFileSync(path.join(folder, file), picture);
      lines.push(
        `<p><img src="/api/documents/${id}/assets/${file}" `
          + `alt="${escapeHtml(step.title || `Step ${i + 1}`)}" /></p>`
      );
    });
  });

  return store.createDocument({
    id,
    name,
    description: '',
    product,
    enhancementId: '',
    fileName: `${name}.html`,
    kind: 'text',
    html: lines.join('\n'),
    imageCount: shots,
    storedFile: '',
    mime: 'text/html; charset=utf-8',
    sizeBytes: Buffer.byteLength(lines.join('\n'), 'utf8'),
  });
}

module.exports = { writeGuide, imageExtension, DOC_ROOT, documentFilePath };
