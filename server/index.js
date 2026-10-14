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
const { askAssistant } = require('./assistant');
const attachments = require('./attachments');
const { generateTestCases, hasApiKey, activeProvider, keyProblem } = require('./testcases');
const testCaseJobs = require('./testcasejobs');
const {
  ALLOWED_EXT: DOC_EXT,
  ingestDocument,
  documentFilePath,
  removeDocumentFiles,
  sanitizeHtml,
} = require('./documents');

const PORT = process.env.PORT || 4310;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
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

// documents carry screenshots, so they get a bigger ceiling
const uploadDocument = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 40 * 1024 * 1024 },
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
    name,
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

  const doc = await storeDocument({ name, description, product, enhancementId, file: req.file });
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

  return bestScore >= 0.6 ? store.getEnhancement(best.id) : null;
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
  if (scenarios.length > 200) {
    return res.status(400).json({ error: 'That is more than 200 scenarios; split it up.' });
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
    name: String(name).trim(),
    description: (description || '').trim(),
    sourceFile: 'Assistant',
    scenarios: kept,
    extraColumns,
  });

  res.status(201).json({ enhancement: store.summary(created), added: kept.length, skipped, appended: false });
}));

const chatUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: attachments.MAX_BYTES, files: attachments.MAX_FILES },
}).array('files', attachments.MAX_FILES);

// The in-tool assistant: answers questions about what this tool holds, and
// reads whatever is attached to the message.
app.post('/api/assistant', chatUpload, wrap(async (req, res) => {
  const { question, currentProduct, currentEnhancement } = req.body || {};

  /* An open set of scenarios is the thread of the conversation: a screenshot
     dropped into the chat while reading it is almost always the next part of
     the same feature, so the draft carries on there. */
  const open = currentEnhancement ? await store.getEnhancement(currentEnhancement) : null;

  // multipart sends history as a JSON string; plain JSON sends it as an array
  let history = req.body && req.body.history;
  if (typeof history === 'string') {
    try { history = JSON.parse(history); } catch (err) { history = []; }
  }

  const read = await attachments.readAll(req.files);
  const result = await askAssistant({
    question,
    history,
    currentProduct,
    attachments: read,
    openEnhancement: open ? { id: open.id, name: open.name, product: open.product } : null,
  });

  res.json({
    ...result,
    attachments: read.map(({ name, kind, note }) => ({ name, kind, note })),
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
