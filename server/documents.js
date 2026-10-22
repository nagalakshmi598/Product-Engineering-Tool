'use strict';

/**
 * Enhancement documents: the write-up QA/product keeps for every new enhancement
 * or customization — the matter plus screenshots.
 *
 *  .docx        -> converted to HTML, embedded screenshots extracted to files
 *  .pdf         -> stored and shown in the browser's own PDF viewer
 *  .png/.jpg/…  -> stored and shown as a single screenshot
 *  .md/.txt     -> stored and shown as formatted text
 */

const fs = require('fs');
const path = require('path');
const mammoth = require('mammoth');

const { DOC_DIR } = require('./paths');

const KIND_BY_EXT = {
  '.docx': 'docx',
  '.pdf': 'pdf',
  '.md': 'text',
  '.txt': 'text',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.bmp': 'image',
  '.mp4': 'video',
  '.mov': 'video',
  '.webm': 'video',
  '.m4v': 'video',
};

const MIME_BY_EXT = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.m4v': 'video/x-m4v',
};

const ALLOWED_EXT = Object.keys(KIND_BY_EXT);

function docKind(filename) {
  return KIND_BY_EXT[path.extname(filename || '').toLowerCase()] || null;
}

function mimeFor(filename) {
  return MIME_BY_EXT[path.extname(filename || '').toLowerCase()] || 'application/octet-stream';
}

function docFolder(id) {
  return path.join(DOC_DIR, id);
}

function extForContentType(contentType) {
  const map = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/bmp': '.bmp',
    'image/x-emf': '.emf',
    'image/emf': '.emf',
    'image/tiff': '.tif',
  };
  return map[contentType] || '.png';
}

/** Strip anything executable — the HTML is injected into the page. */
function sanitizeHtml(html) {
  return String(html)
    .replace(/<\s*script[\s\S]*?<\s*\/\s*script\s*>/gi, '')
    .replace(/<\s*style[\s\S]*?<\s*\/\s*style\s*>/gi, '')
    .replace(/<\s*iframe[\s\S]*?<\s*\/\s*iframe\s*>/gi, '')
    .replace(/ on[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/ on[a-z]+\s*=\s*'[^']*'/gi, '')
    .replace(/javascript:/gi, '');
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Minimal markdown-ish rendering for .md / .txt so the matter reads well. */
function textToHtml(raw) {
  const lines = String(raw).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let listOpen = false;
  let paragraph = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      out.push(`<p>${paragraph.join(' ')}</p>`);
      paragraph = [];
    }
  };
  const closeList = () => {
    if (listOpen) {
      out.push('</ul>');
      listOpen = false;
    }
  };
  const inline = (text) =>
    escapeHtml(text)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|\s)\*(?!\s)(.+?)\*/g, '$1<em>$2</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');

  lines.forEach((line) => {
    const trimmed = line.trim();

    if (!trimmed) {
      flushParagraph();
      closeList();
      return;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      closeList();
      const level = Math.min(heading[1].length + 1, 6);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      return;
    }

    const bullet = trimmed.match(/^[-*•]\s+(.*)$/);
    if (bullet) {
      flushParagraph();
      if (!listOpen) {
        out.push('<ul>');
        listOpen = true;
      }
      out.push(`<li>${inline(bullet[1])}</li>`);
      return;
    }

    closeList();
    paragraph.push(inline(trimmed));
  });

  flushParagraph();
  closeList();
  return out.join('\n');
}

/**
 * Save an uploaded document and produce what the UI needs to display it.
 * @returns {Promise<{kind, html, imageCount, storedFile, mime, sizeBytes}>}
 */
async function ingestDocument({ id, buffer, originalName }) {
  const kind = docKind(originalName);
  if (!kind) {
    const err = new Error(`Unsupported document type. Use ${ALLOWED_EXT.join(', ')}.`);
    err.status = 400;
    throw err;
  }

  const folder = docFolder(id);
  fs.mkdirSync(folder, { recursive: true });

  const ext = path.extname(originalName).toLowerCase();
  const storedFile = `source${ext}`;
  fs.writeFileSync(path.join(folder, storedFile), buffer);

  const base = { kind, storedFile, mime: mimeFor(originalName), sizeBytes: buffer.length, imageCount: 0, html: '' };

  if (kind === 'docx') {
    let imageIndex = 0;
    const result = await mammoth.convertToHtml(
      { buffer },
      {
        // keep the formatting Word carries that mammoth drops by default
        styleMap: [
          'u => u',
          'strike => s',
          "p[style-name='Title'] => h1:fresh",
          "p[style-name='Subtitle'] => p.doc-subtitle:fresh",
          "p[style-name='Quote'] => blockquote > p:fresh",
          "r[style-name='Code'] => code",
        ],
        // screenshots go to disk and are served back by URL, so db.json stays small
        convertImage: mammoth.images.imgElement(async (image) => {
          imageIndex += 1;
          const name = `image-${imageIndex}${extForContentType(image.contentType)}`;
          const data = await image.read();
          fs.writeFileSync(path.join(folder, name), data);
          return { src: `/api/documents/${id}/assets/${name}`, alt: `Screenshot ${imageIndex}` };
        }),
      }
    );
    base.html = sanitizeHtml(result.value);
    base.imageCount = imageIndex;
    base.warnings = (result.messages || []).slice(0, 5).map((m) => m.message);
    return base;
  }

  if (kind === 'text') {
    base.html = textToHtml(buffer.toString('utf8'));
    return base;
  }

  if (kind === 'image') {
    base.imageCount = 1;
    return base; // rendered straight from the stored file
  }

  return base; // pdf — shown in the browser's PDF viewer
}

function documentFilePath(id, name) {
  const safe = path.basename(String(name || ''));
  const file = path.join(docFolder(id), safe);
  // never escape the document's own folder
  if (!file.startsWith(docFolder(id))) return null;
  return fs.existsSync(file) ? file : null;
}

function removeDocumentFiles(id) {
  const folder = docFolder(id);
  if (fs.existsSync(folder)) fs.rmSync(folder, { recursive: true, force: true });
}

module.exports = {
  sanitizeHtml,
  escapeHtml,
  ALLOWED_EXT,
  DOC_DIR,
  docKind,
  mimeFor,
  ingestDocument,
  documentFilePath,
  removeDocumentFiles,
};
