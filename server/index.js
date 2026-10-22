'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');

const store = require('./store');
const { extractScenarios } = require('./parse');

/*
 * DIY's sheets label their rows: "Module Name : Workspaces (Negative)" above a
 * run of negative checks. Reading those labels is turned on for DIY alone,
 * because the other products' sheets are flat lists and a stray short line in
 * one of those should stay the scenario it is.
 */
const LABELLED_SHEETS = new Set(['diy']);
const { askAssistant, guessProduct, justFileIt } = require('./assistant');
const attachments = require('./attachments');
const { writeWalkthrough, wantsAGuide } = require('./walkthrough');
const { whichOneIsShown, picturesIn } = require('./pointing');
const { MAX_GUIDE_FRAMES } = require('./video');
const { parseCommand, describeCommand, readsAsAnInstruction } = require('./commands');
const { tidyName } = require('./names');
const { generateTestCases, hasApiKey, activeProvider, keyProblem } = require('./testcases');
const testCaseJobs = require('./testcasejobs');
const {
  ALLOWED_EXT: DOC_EXT,
  ingestDocument,
  documentFilePath,
  removeDocumentFiles,
  sanitizeHtml,
  escapeHtml,
} = require('./documents');

const PORT = process.env.PORT || 4310;
const { UPLOAD_DIR } = require('./paths');
const SCENARIO_EXT = new Set(['.csv', '.txt', '.xlsx', '.xls', '.xlsm']);
const DOCUMENT_EXT = new Set(DOC_EXT);

fs.mkdirSync(UPLOAD_DIR, { recursive: true });


/* Two kinds of upload: the scenario sheet, and the enhancement document.
   The "file" field is always the sheet, "document" is always the write-up. */
function extensionFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  const wantsDocument = file.fieldname === 'document';
  const allowed = wantsDocument ? DOCUMENT_EXT : SCENARIO_EXT;

  if (!allowed.has(ext)) {
    cb(new Error(
      wantsDocument
        ? `Documents must be one of: ${[...DOCUMENT_EXT].join(', ')}.`
        : 'Only .csv, .xlsx, .xls or .txt files can be uploaded as test scenarios.'
    ));
    return;
  }
  cb(null, true);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: extensionFilter,
});

// documents carry screenshots, and a screen recording carries rather more
const uploadDocument = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: attachments.MAX_BYTES },
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!DOCUMENT_EXT.has(ext)) {
      cb(new Error(`Documents must be one of: ${[...DOCUMENT_EXT].join(', ')}.`));
      return;
    }
    cb(null, true);
  },
});

const enhancementUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 40 * 1024 * 1024 },
  fileFilter: extensionFilter,
}).fields([
  { name: 'file', maxCount: 1 },
  { name: 'document', maxCount: 1 },
]);

const app = express();
app.use(express.json());

/* What build of the page this server is serving.
 *
 * The tool is left open for hours and talked to rather than reloaded, so a
 * fix can be deployed, running and answering while the browser is still
 * executing the script it loaded this morning — the server's new wording
 * arriving in the old page's handling of it. Every API reply carries this,
 * and the page says so when it stops matching what the page loaded with. */
const BUILD = (() => {
  const sum = crypto.createHash('sha1');
  const root = path.join(__dirname, '..', 'public');

  ['app.js', 'styles.css', 'index.html'].forEach((file) => {
    try { sum.update(fs.readFileSync(path.join(root, file))); } catch (err) { sum.update(file); }
  });

  return sum.digest('hex').slice(0, 12);
})();

app.use('/api', (req, res, next) => {
  res.setHeader('X-Tool-Build', BUILD);
  next();
});
// no-cache so a UI change shows up on a plain refresh, without a hard reload
app.use(express.static(path.join(__dirname, '..', 'public'), {
  etag: true,
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-cache');
  },
}));

const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const truthy = (value) => value === undefined || value === 'true' || value === true || value === 'on';

/**
 * Multipart field values arrive latin1-decoded, so a file name with an en dash
 * or an accent shows up as mojibake ("Slack â€“ chat.docx"). Re-read those bytes
 * as UTF-8 when that produces a clean string.
 */
function decodeFileName(name) {
  const raw = String(name || '');
  if (!/[À-ÿ]/.test(raw)) return raw;

  const utf8 = Buffer.from(raw, 'latin1').toString('utf8');
  return utf8.includes('�') ? raw : utf8;
}

function keepOriginal(id, file) {
  const ext = path.extname(file.originalname).toLowerCase();
  const stored = `${id}-${Date.now()}${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, stored), file.buffer);
  return stored;
}

app.get('/api/products', wrap(async (req, res) => {
  res.json({ products: (await store.listProducts()), documentCount: (await store.countDocuments()) });
}));

app.get('/api/products/:product/enhancements', wrap(async (req, res) => {
  const { product } = req.params;
  if (!store.isProduct(product)) return res.status(404).json({ error: 'Unknown product.' });
  res.json({ product, enhancements: (await store.listEnhancements(product)) });
}));

// New enhancement: test scenario sheet, and optionally the enhancement document.
app.post('/api/enhancements', enhancementUpload, wrap(async (req, res) => {
  const { product, name, description } = req.body;
  const sheet = req.files && req.files.file && req.files.file[0];
  const docFile = req.files && req.files.document && req.files.document[0];

  if (!store.isProduct(product)) {
    return res.status(400).json({ error: 'Select a product before creating the enhancement.' });
  }
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Enhancement / feature name is required.' });
  }
  if ((await store.findByName(product, name))) {
    return res.status(409).json({ error: `"${name.trim()}" already exists for this product.` });
  }
  if (!sheet && !docFile) {
    return res.status(400).json({
      error: 'Attach a test scenario file, a document, or both. At least one is required.',
    });
  }

  // Both files are optional: scenarios can come later, and a document-only
  // enhancement is a valid starting point.
  let scenarios = [];
  let extraColumns = [];
  let skipped = 0;
  let labelled = 0;
  if (sheet) {
    ({ scenarios, extraColumns, skipped, labelled = 0 } = extractScenarios(sheet.buffer, sheet.originalname, {
      splitLines: truthy(req.body.splitLines),
      headings: LABELLED_SHEETS.has(product),
    }));
  }

  const created = (await store.createEnhancement({
    product,
    name: tidyName(name),
    description,
    sourceFile: sheet ? decodeFileName(sheet.originalname) : '',
    scenarios,
    extraColumns,
  }));
  if (sheet) keepOriginal(created.id, sheet);

  let document = null;
  if (docFile) {
    const saved = await storeDocument({
      name: name.trim(),
      description,
      product,
      enhancementId: created.id,
      file: docFile,
    });
    document = store.documentSummary(saved);
  }

  res.status(201).json({
    enhancement: store.summary(created),
    imported: scenarios.length,
    skipped,
    document,
  });
}));

app.get('/api/enhancements/:id', wrap(async (req, res) => {
  const enhancement = (await store.getEnhancement(req.params.id));
  if (!enhancement) return res.status(404).json({ error: 'Enhancement not found.' });
  res.json({ enhancement, documents: (await store.documentsForEnhancement(enhancement.id)) });
}));

// Re-upload scenarios for an existing enhancement (replace or append).
app.post('/api/enhancements/:id/scenarios', upload.single('file'), wrap(async (req, res) => {
  const enhancement = (await store.getEnhancement(req.params.id));
  if (!enhancement) return res.status(404).json({ error: 'Enhancement not found.' });
  if (!req.file) return res.status(400).json({ error: 'Attach a .csv or .xlsx file of test scenarios.' });

  const mode = req.body.mode === 'append' ? 'append' : 'replace';
  const { scenarios, extraColumns, skipped, labelled = 0 } = extractScenarios(
    req.file.buffer,
    req.file.originalname,
    {
      splitLines: truthy(req.body.splitLines),
      headings: LABELLED_SHEETS.has(enhancement.product),
    }
  );

  const updated = (await store.setScenarios(enhancement.id, {
    scenarios,
    extraColumns,
    sourceFile: decodeFileName(req.file.originalname),
    mode,
  }));
  keepOriginal(enhancement.id, req.file);

  res.json({ enhancement: updated, imported: scenarios.length, skipped, labelled, mode });
}));

// Add a single scenario typed in the tool (no CSV) — appended after the last row.
app.post('/api/enhancements/:id/scenario', wrap(async (req, res) => {
  const enhancement = (await store.getEnhancement(req.params.id));
  if (!enhancement) return res.status(404).json({ error: 'Enhancement not found.' });

  const { scenario, extra } = req.body || {};
  if (typeof scenario !== 'string' || !scenario.trim()) {
    return res.status(400).json({ error: 'Enter the test scenario before adding it.' });
  }
  if (scenario.trim().length > 2000) {
    return res.status(400).json({ error: 'The test scenario is too long (2,000 characters maximum).' });
  }

  const updated = (await store.addScenario(enhancement.id, { scenario, extra }));
  res.status(201).json({ enhancement: updated, sno: updated.scenarios.length });
}));

// Generate (or re-generate) detailed test cases for one scenario, via Claude.
app.post('/api/enhancements/:id/scenarios/:sno/testcases', wrap(async (req, res) => {
  const enhancement = (await store.getEnhancement(req.params.id));
  if (!enhancement) return res.status(404).json({ error: 'Enhancement not found.' });

  const sno = Number(req.params.sno);
  const scenario = enhancement.scenarios.find((s) => Number(s.sno) === sno);
  if (!scenario) return res.status(404).json({ error: `Test scenario ${req.params.sno} not found.` });

  // Serve the cached set unless the caller explicitly asked for a fresh one.
  if (scenario.testCases && scenario.testCases.length && req.body && req.body.regenerate !== true) {
    return res.json({ sno, testCases: scenario.testCases, meta: scenario.testCasesMeta, cached: true });
  }

  const product = store.PRODUCTS.find((p) => p.key === enhancement.product);
  const generated = await generateTestCases({
    productLabel: product ? product.label : enhancement.product,
    enhancementName: enhancement.name,
    scenarioText: scenario.scenario,
    sno,
  });

  (await store.setTestCases(enhancement.id, sno, generated));
  res.status(201).json({
    sno,
    testCases: generated.testCases,
    meta: { model: generated.model, provider: generated.provider, generatedAt: generated.generatedAt },
    cached: false,
  });
}));

/* ---------------- test cases for a whole enhancement ----------------
   The same work as the button on each row, done for every scenario that is
   still empty, so a set of two hundred is one request rather than two
   hundred clicks. */

app.post('/api/enhancements/:id/testcases', wrap(async (req, res) => {
  const regenerate = Boolean(req.body && req.body.regenerate);
  const job = await testCaseJobs.start(req.params.id, { regenerate });
  res.status(202).json({ job });
}));

app.get('/api/enhancements/:id/testcases', wrap(async (req, res) => {
  const job = testCaseJobs.get(req.params.id);
  if (!job) return res.json({ job: null });
  res.json({ job });
}));

app.delete('/api/enhancements/:id/testcases', wrap(async (req, res) => {
  res.json({ job: testCaseJobs.cancel(req.params.id) });
}));

/** Everything in the tool still missing test cases. */
app.get('/api/testcases/outstanding', wrap(async (req, res) => {
  res.json({ enhancements: await testCaseJobs.outstanding() });
}));

/* ---------------- enhancement documents ---------------- */

async function storeDocument({ name, description, product, enhancementId, file }) {
  const id = crypto.randomUUID();
  const fileName = decodeFileName(file.originalname);
  const ingested = await ingestDocument({ id, buffer: file.buffer, originalName: fileName });

  return (await store.createDocument({
    id,
    name: name.trim(),
    description: (description || '').trim(),
    product: product || '',
    enhancementId: enhancementId || '',
    fileName,
    ...ingested,
  }));
}

app.get('/api/documents', wrap(async (req, res) => {
  res.json({ documents: (await store.listDocuments()) });
}));

app.post('/api/documents', uploadDocument.single('file'), wrap(async (req, res) => {
  const { description, product, enhancementId } = req.body;
  if (!req.file) return res.status(400).json({ error: 'Attach the document file.' });

  // No name typed? Use the file name — the document is the point, not the label.
  const readable = decodeFileName(req.file.originalname);
  const name = (req.body.name || '').trim() || path.basename(readable, path.extname(readable));

  const doc = await storeDocument({ name: tidyName(name), description, product, enhancementId, file: req.file });
  res.status(201).json({ document: store.documentSummary(doc) });
}));

app.get('/api/documents/:id', wrap(async (req, res) => {
  const doc = (await store.getDocument(req.params.id));
  if (!doc) return res.status(404).json({ error: 'Document not found.' });
  res.json({ document: doc });
}));

// The stored file itself: PDFs render in the browser viewer, images as <img>.
app.get('/api/documents/:id/file', wrap(async (req, res) => {
  const doc = (await store.getDocument(req.params.id));
  if (!doc) return res.status(404).json({ error: 'Document not found.' });

  const file = documentFilePath(doc.id, doc.storedFile);
  if (!file) return res.status(404).json({ error: 'The stored file is missing.' });

  res.setHeader('Content-Type', doc.mime || 'application/octet-stream');
  if (req.query.download === '1') {
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(doc.fileName)}"`);
  }
  res.sendFile(file);
}));

// Screenshots pulled out of a .docx.
app.get('/api/documents/:id/assets/:asset', wrap(async (req, res) => {
  const doc = (await store.getDocument(req.params.id));
  if (!doc) return res.status(404).json({ error: 'Document not found.' });

  const file = documentFilePath(doc.id, req.params.asset);
  if (!file) return res.status(404).json({ error: 'Image not found.' });
  res.sendFile(file);
}));

// Rename a document, move it to another product tab, or correct its matter.
app.patch('/api/documents/:id', wrap(async (req, res) => {
  const doc = (await store.getDocument(req.params.id));
  if (!doc) return res.status(404).json({ error: 'Document not found.' });

  const { name, description, product, html } = req.body || {};
  if (product !== undefined && product !== '' && !store.isProduct(product)) {
    return res.status(400).json({ error: 'Unknown product.' });
  }
  if (name !== undefined && !String(name).trim()) {
    return res.status(400).json({ error: 'Enter a document name.' });
  }

  // Only the kinds the tool renders as text can be edited in it. A PDF or a
  // screenshot has no editable matter, and the stored file is never rewritten.
  let matter;
  if (html !== undefined) {
    if (doc.kind !== 'docx' && doc.kind !== 'text') {
      return res.status(400).json({ error: 'This document type cannot be edited in the tool.' });
    }
    if (typeof html !== 'string' || !html.trim()) {
      return res.status(400).json({ error: 'The document cannot be saved empty.' });
    }
    if (html.length > 2000000) {
      return res.status(413).json({ error: 'The document is too large to save.' });
    }
    matter = sanitizeHtml(html);
  }

  const updated = (await store.updateDocument(doc.id, { name, description, product, html: matter }));
  res.json({ document: store.documentSummary(updated) });
}));

app.delete('/api/documents/:id', wrap(async (req, res) => {
  const doc = (await store.getDocument(req.params.id));
  if (!doc) return res.status(404).json({ error: 'Document not found.' });

  (await store.deleteDocument(doc.id));
  removeDocumentFiles(doc.id);
  res.status(204).end();
}));

// Is a Claude key configured? Lets the UI explain itself before you click.
app.get('/api/ai-status', wrap(async (req, res) => {
  const { provider, model } = activeProvider();
  res.json({ ready: hasApiKey(), provider, model, problem: keyProblem() });
}));

// Delete a single scenario row by its serial number.
// Mark one scenario passed, failed, or not yet run.
app.patch('/api/enhancements/:id/scenarios/:sno/status', wrap(async (req, res) => {
  const { status } = req.body || {};
  if (!store.SCENARIO_STATUS.includes(status)) {
    return res.status(400).json({ error: 'Status must be pass, fail or pending.' });
  }

  const sno = Number(req.params.sno);
  if (!Number.isInteger(sno) || sno < 1) {
    return res.status(400).json({ error: 'Invalid scenario number.' });
  }

  const result = (await store.setScenarioStatus(req.params.id, sno, status));
  if (result.status === 'no-enhancement') return res.status(404).json({ error: 'Enhancement not found.' });
  if (result.status === 'no-scenario') return res.status(404).json({ error: `Test scenario ${sno} no longer exists.` });

  res.json({ enhancement: result.enhancement });
}));

app.delete('/api/enhancements/:id/scenarios/:sno', wrap(async (req, res) => {
  const sno = Number(req.params.sno);
  if (!Number.isInteger(sno) || sno < 1) {
    return res.status(400).json({ error: 'Invalid scenario number.' });
  }

  const result = (await store.deleteScenario(req.params.id, sno));
  if (result.status === 'no-enhancement') return res.status(404).json({ error: 'Enhancement not found.' });
  if (result.status === 'no-scenario') return res.status(404).json({ error: `Test scenario ${sno} no longer exists.` });

  res.json({ enhancement: result.enhancement, removed: result.removed });
}));

app.patch('/api/enhancements/:id', wrap(async (req, res) => {
  const { name, description } = req.body || {};
  const enhancement = (await store.getEnhancement(req.params.id));
  if (!enhancement) return res.status(404).json({ error: 'Enhancement not found.' });

  if (name && name.trim()) {
    const clash = (await store.findByName(enhancement.product, name));
    if (clash && clash.id !== enhancement.id) {
      return res.status(409).json({ error: `"${name.trim()}" already exists for this product.` });
    }
  }
  res.json({ enhancement: store.summary((await store.updateEnhancement(enhancement.id, { name, description }))) });
}));

app.delete('/api/enhancements/:id', wrap(async (req, res) => {
  if (!(await store.deleteEnhancement(req.params.id))) {
    return res.status(404).json({ error: 'Enhancement not found.' });
  }
  res.status(204).end();
}));

// Download the stored scenarios back as a clean CSV.
app.get('/api/enhancements/:id/export.csv', wrap(async (req, res) => {
  const enhancement = (await store.getEnhancement(req.params.id));
  if (!enhancement) return res.status(404).json({ error: 'Enhancement not found.' });

  const cell = (value) => {
    const text = String(value == null ? '' : value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const header = ['S.No', 'Test Scenario', ...enhancement.extraColumns];
  const lines = [header.map(cell).join(',')];
  enhancement.scenarios.forEach((s) => {
    lines.push([s.sno, s.scenario, ...enhancement.extraColumns.map((c) => (s.extra || {})[c] || '')].map(cell).join(','));
  });

  const safeName = enhancement.name.replace(/[^a-z0-9._-]+/gi, '_').slice(0, 60) || 'scenarios';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}.csv"`);
  res.send(`\uFEFF${lines.join('\r\n')}\r\n`);
}));

// Keep scenarios the assistant drafted. This is the same thing a CSV upload
// does — the rows just arrive from the chat instead of a file. A name that
// already exists gets the rows appended rather than a second enhancement.
/* ---------------- keeping drafted scenarios tidy ----------------
   The same feature gets asked about more than once, and a model asked twice
   will phrase a check two slightly different ways. Neither should put a
   duplicate row in the table. */

/** Scenario text reduced to what it actually says, for comparison. */
function scenarioKey(text) {
  return String(text)
    .toLowerCase()
    .replace(/^verify that\s+/, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(the|a|an|is|are|be|to|of|in|on|for|and|or|that|its|their)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((w) => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
    .join(' ');
}

function words(s) {
  return new Set(String(s).split(' ').filter(Boolean));
}

function shared(left, right) {
  let n = 0;
  left.forEach((w) => { if (right.has(w)) n += 1; });
  return n;
}

/**
 * How much of the shorter sentence the longer one covers.
 *
 * Right for duplicate scenarios: a reworded check says the same thing with a
 * few extra words, and should still count as the one already held.
 */
function covers(a, b) {
  const left = words(a);
  const right = words(b);
  if (!left.size || !right.size) return 0;
  return shared(left, right) / Math.min(left.size, right.size);
}

/**
 * How alike two names are, counting what they do not share as well.
 *
 * Right for matching an enhancement: by the measure above, "shared channel
 * migration" scores a perfect 1 against "Teams to Teams standard channels,
 * Private channels and Shared channels Migration scenarios", because every
 * word of the short name appears in the long one. They are not the same
 * feature, and the rows would land in the wrong list.
 */
function alike(a, b) {
  const left = words(a);
  const right = words(b);
  if (!left.size || !right.size) return 0;

  const common = shared(left, right);
  return common / (left.size + right.size - common);
}

/**
 * Drop rows that repeat something already held, or each other.
 * @returns {{kept: Array, skipped: number}}
 */
function withoutDuplicates(rows, existingScenarios) {
  const seen = (existingScenarios || []).map((s) => scenarioKey(s.scenario));
  const kept = [];
  let skipped = 0;

  rows.forEach((row) => {
    const key = scenarioKey(row.scenario);
    if (!key) { skipped += 1; return; }

    const duplicate = seen.some((other) => other === key || covers(key, other) >= 0.85);
    if (duplicate) { skipped += 1; return; }

    seen.push(key);
    kept.push(row);
  });

  return { kept, skipped };
}

/**
 * The enhancement these scenarios belong to, if the tool already has one.
 *
 * An exact name match is the easy case. The harder one is the same feature
 * asked about in different words — "group DM names" then "group DM renaming"
 * — which should add to what is there rather than start a rival list.
 */
async function enhancementFor(product, name) {
  const exact = await store.findByName(product, name);
  if (exact) return exact;

  const wanted = scenarioKey(name);
  if (!wanted) return null;

  const candidates = await store.listEnhancements(product);
  let best = null;
  let bestScore = 0;

  candidates.forEach((candidate) => {
    const score = alike(wanted, scenarioKey(candidate.name));
    if (score > bestScore) { best = candidate; bestScore = score; }
  });

  /* Write-ups are named to a pattern — "Dropbox - Content Sprawl Scope",
     "Egnyte - Content Sprawl Scope" — and three words of five in common put
     every cloud's set at exactly 0.60, so they collapsed into one another.
     A genuine restatement of the same name scores 1.00. The bar sits above
     the pattern and below the restatement. */
  return bestScore >= 0.75 ? store.getEnhancement(best.id) : null;
}

app.post('/api/assistant/scenarios', wrap(async (req, res) => {
  const { product, name, scenarios, description, enhancementId } = req.body || {};

  /* Naming a set outright is how the assistant carries on one already open:
     the rows go on the end of it, whatever the drafted name turned out to be. */
  const continuing = enhancementId ? await store.getEnhancement(enhancementId) : null;
  if (enhancementId && !continuing) {
    return res.status(404).json({ error: 'That set of scenarios no longer exists.' });
  }

  if (!continuing && !store.isProduct(product)) {
    return res.status(400).json({ error: 'Pick a product for these scenarios.' });
  }
  if (!continuing && (!name || !String(name).trim())) {
    return res.status(400).json({ error: 'Give the enhancement a name.' });
  }
  if (!Array.isArray(scenarios) || !scenarios.length) {
    return res.status(400).json({ error: 'There are no scenarios to save.' });
  }
  /* A draft taken across a shelf of write-ups is legitimately long: thirteen
     specifications came back as two hundred and eighty-four scenarios, and
     two hundred was turning that away. What remains is a guard against a
     payload nobody meant to send, not a limit on how much can be tested. */
  if (scenarios.length > 2000) {
    return res.status(400).json({ error: `${scenarios.length} scenarios in one request is more than this is for.` });
  }

  const rows = scenarios
    .map((row) => (typeof row === 'string' ? { scenario: row } : row || {}))
    .filter((row) => typeof row.scenario === 'string' && row.scenario.trim())
    .map((row) => {
      const extra = {};
      if (row.type) extra.Type = String(row.type).slice(0, 20);
      if (row.section) extra.Section = String(row.section).slice(0, 120);
      return {
        scenario: row.scenario.trim().slice(0, 2000),
        sourceSno: '',
        extra,
        addedByAssistant: true,
      };
    });

  if (!rows.length) return res.status(400).json({ error: 'There are no scenarios to save.' });

  const extraColumns = [];
  if (rows.some((r) => r.extra.Type)) extraColumns.push('Type');
  if (rows.some((r) => r.extra.Section)) extraColumns.push('Section');

  const existing = continuing || (await enhancementFor(product, name));
  const { kept, skipped } = withoutDuplicates(rows, existing ? existing.scenarios : []);

  if (existing) {
    if (!kept.length) {
      return res.json({
        enhancement: store.summary(existing),
        added: 0,
        skipped,
        appended: true,
        continued: Boolean(continuing),
      });
    }

    const updated = await store.setScenarios(existing.id, {
      scenarios: kept,
      extraColumns: Array.from(new Set([...(existing.extraColumns || []), ...extraColumns])),
      sourceFile: existing.sourceFile || 'Assistant',
      mode: 'append',
    });
    return res.json({
      enhancement: store.summary(updated),
      added: kept.length,
      skipped,
      appended: true,
      continued: Boolean(continuing),
      firstSno: updated.scenarios.length - kept.length + 1,
      lastSno: updated.scenarios.length,
    });
  }

  const created = await store.createEnhancement({
    product,
    name: tidyName(name),
    description: (description || '').trim(),
    sourceFile: 'Assistant',
    scenarios: kept,
    extraColumns,
  });

  res.status(201).json({ enhancement: store.summary(created), added: kept.length, skipped, appended: false });
}));

/* ---------------- changes asked for in the chat ----------------
   Reading the instruction and carrying it out are separate on purpose: what
   was understood is put to the person first, and a delete is not done until
   they say so. */

/** One scenario, two scenarios. */
function plural(n, word) {
  return `${n} ${word}${Number(n) === 1 ? '' : 's'}`;
}

/** The set an instruction is about: the one named, or the one being read. */
/** A product named in an instruction — "Email", "data sprawl", "diy". */
function findProductKey(name) {
  const wanted = String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!wanted) return null;

  return store.PRODUCTS.find((p) => (
    p.key === wanted
    || p.label.toLowerCase().replace(/[^a-z0-9]/g, '') === wanted
  )) || null;
}

/** The closest name among a list, or nothing if none is close enough. */
function closestTo(name, rows) {
  const exact = rows.find((r) => r.name.toLowerCase() === String(name).toLowerCase());
  if (exact) return exact;

  const wanted = scenarioKey(name);
  let best = null;
  let bestScore = 0;

  rows.forEach((row) => {
    const score = alike(wanted, scenarioKey(row.name));
    if (score > bestScore) { best = row; bestScore = score; }
  });

  return bestScore >= 0.5 ? best : null;
}

async function targetOf(command, openId, openDocId) {
  /* An instruction about a write-up is answered from the write-ups, never
     from the sets of scenarios. Unnamed, it means the one being read — and
     failing that, nothing at all, so that the choices get offered rather
     than a set of scenarios deleted in a write-up's place. */
  if (command.object === 'document') {
    if (!command.name) return openDocId ? store.getDocument(openDocId) : null;

    const found = closestTo(command.name, await store.allDocuments());
    return found ? store.getDocument(found.id) : null;
  }

  if (command.name) {
    const found = closestTo(command.name, await store.allEnhancements());
    return found ? store.getEnhancement(found.id) : null;
  }

  return openId ? store.getEnhancement(openId) : null;
}

/**
 * The sets an instruction might have meant, best first.
 *
 * What is being looked at comes first, then anything whose name is close to
 * what was asked for, then the rest. Never more than six: a list longer than
 * that is not a choice, it is the same problem again.
 */
async function nearbySets(command, product) {
  const aboutDocument = command.object === 'document';
  const all = aboutDocument ? await store.allDocuments() : await store.allEnhancements();
  const wanted = command.name ? scenarioKey(command.name) : '';

  /* Looking at one product's write-ups, "this one" is one of those. Offering
     the other products' as well is offering things that are not on screen. */
  const inView = product ? all.filter((row) => row.product === product) : [];
  const pool = inView.length ? inView : all;

  const scored = pool.map((row) => ({
    row,
    score: wanted ? alike(wanted, scenarioKey(row.name)) : 0,
  }));

  /* Six when there is a name to rank by — past that the ranking is doing the
     work. Nothing to rank by and the order is arbitrary, so cutting it short
     just hides the one that was meant. */
  const room = wanted ? 6 : 12;

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, room)
    .map(({ row }) => (aboutDocument ? store.documentSummary(row) : store.summary(row)));
}

app.post('/api/assistant/command', wrap(async (req, res) => {
  const { command, enhancementId, documentId } = req.body || {};
  if (!command || !command.kind) return res.status(400).json({ error: 'No change was asked for.' });

  const target = await targetOf(command, enhancementId, documentId);
  if (!target) {
    /* Pointing at a screenshot and saying "this one" is how anyone asks, and
       nothing here can see where the arrow points. Rather than refuse, say
       what there is to choose from — one of them is almost always meant. */
    const near = await nearbySets(command, req.body.product);

    const thing = command.object === 'document' ? 'write-up' : 'set';

    return res.status(404).json({
      error: command.name
        ? `There is no ${thing} called "${command.name}".`
        : `Which ${thing} did you mean?`,
      choices: near.map((e) => ({
        id: e.id,
        name: e.name,
        product: e.product,
        scenarioCount: e.scenarioCount,
        kind: command.object === 'document' ? 'document' : 'set',
      })),
    });
  }

  /* ---- the write-ups ---- */

  if (command.kind === 'delete-document') {
    await store.deleteDocument(target.id);
    removeDocumentFiles(target.id);
    return res.json({
      done: `Deleted the write-up "${target.name}".`,
      gone: true,
      isDocument: true,
      product: target.product,
    });
  }

  /* A write-up is read as much as it is filed, and what it says goes out of
     date — a limit changes, a message is reworded. Correcting that from the
     chat beats downloading it, editing it and uploading it again. */
  if (command.kind === 'append-document') {
    const added = `<p>${escapeHtml(command.text)}</p>`;
    const updated = await store.updateDocument(target.id, {
      html: `${target.html || ''}\n${added}`,
    });

    return res.json({
      done: `Added to "${updated.name}".`,
      isDocument: true,
      document: store.documentSummary(updated),
    });
  }

  if (command.kind === 'replace-in-document') {
    const before = target.html || '';
    const hits = before.split(escapeHtml(command.from)).length - 1
      + (escapeHtml(command.from) === command.from ? 0 : before.split(command.from).length - 1);

    if (!hits) {
      return res.status(404).json({
        error: `"${command.from}" does not appear in "${target.name}".`,
      });
    }

    /* Escaped and plain both, because what is stored went through escaping
       and what was typed did not. */
    const after = before
      .split(escapeHtml(command.from)).join(escapeHtml(command.to))
      .split(command.from).join(command.to);

    const updated = await store.updateDocument(target.id, { html: after });

    return res.json({
      done: `Changed ${plural(hits, 'mention')} of "${command.from}" in "${updated.name}".`,
      isDocument: true,
      document: store.documentSummary(updated),
    });
  }

  if (command.kind === 'rename-document') {
    const updated = await store.updateDocument(target.id, { name: tidyName(command.to) });
    return res.json({
      done: `The write-up is now called "${updated.name}".`,
      isDocument: true,
      document: store.documentSummary(updated),
    });
  }

  if (command.kind === 'move-document') {
    const wanted = findProductKey(command.to);
    if (!wanted) {
      return res.status(400).json({
        error: `There is no product called "${command.to}". `
          + `Try one of: ${store.PRODUCTS.map((p) => p.label).join(', ')}.`,
      });
    }

    const updated = await store.updateDocument(target.id, { product: wanted.key });
    return res.json({
      done: `"${updated.name}" is now filed under ${wanted.label}.`,
      isDocument: true,
      document: store.documentSummary(updated),
    });
  }

  /* ---- the scenario sets ---- */

  if (command.kind === 'delete-set') {
    await store.deleteEnhancement(target.id);
    return res.json({
      done: `Deleted "${target.name}" and its ${plural(target.scenarios.length, 'scenario')}.`,
      gone: true,
      product: target.product,
    });
  }

  if (command.kind === 'rename-set') {
    const updated = await store.updateEnhancement(target.id, { name: tidyName(command.to) });
    return res.json({
      done: `Renamed to "${updated.name}".`,
      enhancement: store.summary(updated),
    });
  }

  if (command.kind === 'set-status') {
    const missing = [];
    let changed = 0;
    for (const sno of command.snos) {
      const result = await store.setScenarioStatus(target.id, sno, command.status);
      if (result.status === 'ok') changed += 1; else missing.push(sno);
    }
    const label = command.status === 'pending' ? 'not run' : command.status;
    return res.json({
      done: `${plural(changed, 'scenario')} marked ${label}.`
        + (missing.length ? ` No scenario numbered ${missing.join(', ')}.` : ''),
      enhancement: store.summary(await store.getEnhancement(target.id)),
    });
  }

  if (command.kind === 'edit-scenario') {
    const result = await store.updateScenario(target.id, command.sno, { scenario: command.text });
    if (result.status !== 'ok') {
      return res.status(404).json({ error: `"${target.name}" has no scenario ${command.sno}.` });
    }
    return res.json({
      done: `Scenario ${command.sno} now reads: ${result.after}`,
      enhancement: store.summary(result.enhancement),
    });
  }

  /* Writing the test cases is the long job in this tool — one model call per
     scenario, hundreds of them — so it is started and reported on rather than
     waited for. The page already knows how to follow one. */
  if (command.kind === 'make-test-cases') {
    const job = await testCaseJobs.start(target.id, { regenerate: Boolean(command.again) });

    if (!job.total) {
      return res.json({
        done: `Every scenario in "${target.name}" already has test cases. `
          + 'Say "regenerate test cases" to write them again.',
        enhancementId: target.id,
        job,
      });
    }

    return res.json({
      done: `Writing test cases for ${plural(job.total, 'scenario')} in "${target.name}" now — `
        + 'they will fill in on the page as they come back.',
      enhancementId: target.id,
      job,
    });
  }

  if (command.kind === 'clear-column') {
    /* The column is named the way it is spoken — "section" — and the table
       calls it "Section", so the match is made on the tool's own spelling. */
    const held = target.extraColumns || [];
    const column = held.find((c) => c.toLowerCase() === String(command.column).toLowerCase());

    if (!column) {
      return res.status(404).json({
        error: held.length
          ? `"${target.name}" has no ${command.column} column. It has: ${held.join(', ')}.`
          : `"${target.name}" has no extra columns.`,
      });
    }

    const rows = (target.scenarios || []).map((row) => {
      const extra = { ...(row.extra || {}) };
      delete extra[column];
      return { ...row, extra };
    });

    const updated = await store.setScenarios(target.id, {
      scenarios: rows,
      extraColumns: held.filter((c) => c !== column),
      sourceFile: target.sourceFile,
      mode: 'replace',
    });

    return res.json({
      done: `The ${column} column is gone from "${target.name}" — ${plural(rows.length, 'row')} cleared.`,
      enhancement: store.summary(updated),
    });
  }

  if (command.kind === 'delete-scenarios') {
    /* Taken from the highest number down: removing a row renumbers the ones
       after it, so working upwards would delete the wrong rows. */
    const order = [...command.snos].sort((a, b) => b - a);
    const missing = [];
    let removed = 0;

    for (const sno of order) {
      const result = await store.deleteScenario(target.id, sno);
      if (result.status === 'ok') removed += 1; else missing.push(sno);
    }

    return res.json({
      done: `${plural(removed, 'scenario')} deleted from "${target.name}".`
        + (missing.length ? ` No scenario numbered ${missing.join(', ')}.` : '')
        + (removed ? ' The rows after them have been renumbered.' : ''),
      enhancement: store.summary(await store.getEnhancement(target.id)),
    });
  }

  return res.status(400).json({ error: 'I do not know how to do that yet.' });
}));

/* ---------------- write-ups dropped into the chat ----------------
   A screenshot attached to a message is context for that message and nothing
   more. A write-up is not: it is the specification of a feature, worth
   keeping and worth asking about next week. One arriving in the chat is
   filed under Documents, exactly as the upload dialog would file it. */

/* A screenshot belongs to the message it came with. A write-up or a screen
   recording is the specification of a feature, and is kept. */
const WRITE_UP = new Set(['.docx', '.pdf', '.md', '.txt', '.mp4', '.mov', '.webm', '.m4v']);

/* Twenty-five files at sixty megabytes would be a gigabyte and a half held in
   memory at once. Nothing anyone attaches to a question comes near this. */
const TOTAL_UPLOAD_BYTES = 200 * 1024 * 1024;

/** Attached files worth keeping, in the order they arrived. */
function writeUpsAmong(files) {
  return (files || []).filter((f) => WRITE_UP.has(path.extname(decodeFileName(f.originalname) || '').toLowerCase()));
}

/**
 * File the write-ups attached to a message.
 *
 * A write-up sent again replaces the one already held rather than sitting
 * beside it: the second copy of a specification is how a team ends up testing
 * against the wrong one.
 */
async function keepWriteUps(files, { product }) {
  const kept = [];

  for (const file of writeUpsAmong(files)) {
    const fileName = decodeFileName(file.originalname);
    const name = path.basename(fileName, path.extname(fileName));

    const existing = (await store.allDocuments()).find((d) => d.fileName === fileName);
    if (existing) {
      const ingested = await ingestDocument({ id: existing.id, buffer: file.buffer, originalName: fileName });
      const updated = await store.updateDocument(existing.id, { html: ingested.html });
      kept.push({ ...store.documentSummary(updated), replaced: true });
      continue;
    }

    const doc = await storeDocument({ name: tidyName(name), description: '', product: product || '', file });
    kept.push({ ...store.documentSummary(doc), replaced: false });
  }

  return kept;
}

const chatUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: attachments.MAX_BYTES, files: attachments.MAX_FILES },
}).array('files', attachments.MAX_FILES);

// The in-tool assistant: answers questions about what this tool holds, and
// reads whatever is attached to the message.
app.post('/api/assistant', chatUpload, wrap(async (req, res) => {
  const { question, currentProduct, currentEnhancement, currentDocument } = req.body || {};

  const weight = (req.files || []).reduce((sum, f) => sum + (f.size || 0), 0);
  if (weight > TOTAL_UPLOAD_BYTES) {
    return res.status(413).json({
      error: `That is ${Math.round(weight / (1024 * 1024))} MB in one message. `
        + `Send up to ${Math.round(TOTAL_UPLOAD_BYTES / (1024 * 1024))} MB at a time.`,
    });
  }

  /* An open set of scenarios is the thread of the conversation: a screenshot
     dropped into the chat while reading it is almost always the next part of
     the same feature, so the draft carries on there. */
  const open = currentEnhancement ? await store.getEnhancement(currentEnhancement) : null;

  // multipart sends history as a JSON string; plain JSON sends it as an array
  let history = req.body && req.body.history;
  if (typeof history === 'string') {
    try { history = JSON.parse(history); } catch (err) { history = []; }
  }

  /* An instruction to change something is answered here rather than by the
     model: it has to mean the same thing every time it is given. */
  const command = parseCommand(question);
  if (command) {
    let target = await targetOf(command, open ? open.id : null, currentDocument);
    let becauseOfThePicture = '';

    /* Nothing was named and nothing is open — but a screenshot came with the
       message, and marking the thing on screen is how anyone says "this one".
       The picture is read against what it could be. It may come back with
       nothing, which is the same as before: it asks. */
    if (!target && (req.files || []).length) {
      const near = await nearbySets(command, currentProduct);
      const pictures = picturesIn(await attachments.readAll(req.files));
      const shown = await whichOneIsShown({
        pictures,
        candidates: near,
        question,
        noun: command.object === 'document' ? 'write-up' : 'set',
      });

      if (shown) {
        target = command.object === 'document'
          ? await store.getDocument(shown.id)
          : await store.getEnhancement(shown.id);
        if (target) {
          becauseOfThePicture = shown.why
            ? `From the screenshot — ${shown.why}.\n\n`
            : 'From the screenshot.\n\n';
        }
      }
    }

    if (!target) {
      const near = await nearbySets(command, currentProduct);

      /* Asked about a write-up, the choices offered are write-ups. Offering
         sets of scenarios instead is how "delete this document" ends up
         deleting forty-three scenarios. */
      const thing = command.object === 'document' ? 'write-up' : 'set';

      return res.json({
        answer: near.length
          ? (command.name
            ? `There is no ${thing} called "${command.name}". Did you mean one of these?`
            : `Which ${thing} did you mean?`)
          : `I cannot tell which ${thing} you mean. Open it, or give me its name.`,
        command,
        target: null,
        choices: near.map((e) => ({
          id: e.id,
          name: e.name,
          product: e.product,
          scenarioCount: e.scenarioCount,
          kind: command.object === 'document' ? 'document' : 'set',
        })),
        model: 'built-in',
        provider: 'local',
      });
    }

    return res.json({
      answer: becauseOfThePicture
        + describeCommand(command, { enhancementName: target.name, documentName: target.name }),
      command,
      target: { id: target.id, name: target.name, product: target.product },
      model: 'built-in',
      provider: 'local',
    });
  }

  /* An instruction that could not be read is said to be unreadable. It is
     never passed on to be answered some other way: "delete this document",
     not understood, used to come back as nineteen test scenarios about
     deleting documents, filed under a set named after the sentence. */
  /* A message carrying a file is an upload, whatever else it says. Only a
     message with nothing attached can be an instruction that went unread. */
  if (!(req.files || []).length && readsAsAnInstruction(question)) {
    const things = await store.allDocuments();
    const sets = await store.allEnhancements();
    const here = currentProduct
      ? things.filter((d) => d.product === currentProduct)
      : things;

    return res.json({
      answer: [
        'That reads as an instruction, but I could not tell which one.',
        '',
        'Say it one of these ways and I will do it:',
        '  • delete the <name> document',
        '  • delete the <name> set',
        '  • delete scenarios 4, 5 and 6',
        '  • remove the <name> column',
        '',
        `There ${things.length === 1 ? 'is' : 'are'} ${plural(things.length, 'write-up')} `
          + `and ${plural(sets.length, 'set')} in the tool`
          + (here.length !== things.length ? `, ${here.length} of them on this page` : '')
          + '. Name the one you mean, or open it and say "this one".',
      ].join('\n'),
      model: 'built-in',
      provider: 'local',
    });
  }

  /* Filed before the answer is composed, so the write-up is in the context
     the scenarios are drafted from. */
  const filed = await keepWriteUps(req.files, {
    product: guessProduct(String(question || ''), (open && open.product) || currentProduct),
  });

  /* Asked to keep it, and nothing else. Say where it went and stop — drafting
     scenarios nobody asked for, off a write-up that was only being filed, is
     a lot to happen to somebody who wanted a file kept. */
  if (filed.length && justFileIt(question)) {
    const labels = await store.listProducts();
    const where = (key) => {
      const found = labels.find((p) => p.key === key);
      return found ? found.label : 'no product';
    };

    return res.json({
      answer: [
        filed.map((d) => `"${d.name}" is filed under ${where(d.product)}.`).join('\n'),
        '',
        'Say the word and I will write test scenarios from what it specifies.',
      ].join('\n'),
      documents: filed,
      attachments: (await attachments.readAll(req.files)).map(({ name, kind, note }) => ({ name, kind, note })),
      model: 'built-in',
      provider: 'local',
    });
  }

  /* A recording of someone working through the product, together with a
     request to write it up, is a different job from a question about it:
     every screen is wanted rather than a sample of them, and what comes back
     is a document rather than an answer. The guide is read at full depth;
     everything else is read as it always was. */
  const guideWanted = attachments.hasVideo(req.files) && wantsAGuide(question);

  const read = await attachments.readAll(req.files, guideWanted ? { videoFrames: MAX_GUIDE_FRAMES } : {});

  const clips = guideWanted ? read.filter((f) => f.kind === 'video' && (f.frames || []).length) : [];
  if (clips.length) {
    const written = await writeWalkthrough({
      clips,
      question,
      product: guessProduct(String(question || ''), (open && open.product) || currentProduct),
    });

    const answer = `I watched ${plural(clips.length, 'recording')} and wrote it up as `
      + `"${written.document.name}" — ${plural(written.steps, 'step')} with `
      + `${plural(written.used, 'screenshot')}, read from ${plural(written.screens, 'screen')}. `
      + 'It is on the Documents page. Tell me what to change and I will change it.';

    return res.json({
      answer,
      document: store.documentSummary(written.document),
      guide: { steps: written.steps, screenshots: written.used, screens: written.screens },
      attachments: read.map(({ name, kind, note }) => ({ name, kind, note })),
      documents: filed,
      model: 'built-in',
      provider: 'local',
    });
  }

  const result = await askAssistant({
    question,
    history,
    currentProduct,
    attachments: read,
    openEnhancement: open ? { id: open.id, name: open.name, product: open.product } : null,
    /* The write-up being read, so that "write scenarios for this document"
       means the one on the screen rather than a feature of that name. */
    openDocument: currentDocument ? await store.getDocument(currentDocument) : null,
  });

  /* A write-up that arrived with the message already has a name, and it is
     a better one than the sentence that introduced it: "Canvas Retention
     Window" rather than "Here is the write-up for the Slack canvas retention
     window". A set already being carried on keeps its own name. */
  const written = filed.find((d) => d.kind !== 'video');
  if (result.draft && written && !result.draft.enhancementId) {
    result.draft.name = written.name;
    if (written.product) result.draft.product = written.product;
  }

  res.json({
    ...result,
    attachments: read.map(({ name, kind, note }) => ({ name, kind, note })),
    documents: filed,
  });
}));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'The file exceeds the 10 MB limit.' });
  }
  const status = err.status || 400;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'Something went wrong.' });
});

const server = app.listen(PORT, () => {
  console.log(`QA Test Scenario Tool running at http://localhost:${PORT}`);
});

/* Starting it twice is the ordinary way to meet this: the tool is already up
   in another window, or in one that was closed without stopping it. Node's
   own answer is a stack trace ending in EADDRINUSE, which buries the one
   thing worth knowing. */
server.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') throw err;

  console.error(
    `\nPort ${PORT} is already in use, so the tool did not start.\n\n`
      + `  • It may already be running — try http://localhost:${PORT}\n`
      + '  • To stop the one that holds the port:\n'
      + `      Windows      netstat -ano | findstr :${PORT}      then  taskkill /PID <pid> /F\n`
      + '      macOS/Linux  kill $(lsof -t -i:' + PORT + ')\n'
      + `  • Or run this one somewhere else:  PORT=4311 node server/index.js\n`
  );
  process.exit(1);
});
