'use strict';

/**
 * The tool's data, in a JSON file.
 *
 * Used when no MONGODB_URI is configured, which is the zero-setup default: the
 * tool runs with nothing to install. Every exported function is async so it is
 * interchangeable with store.mongo.js — see store.js, which picks between them.
 *
 * Reads and writes are synchronous underneath; the file is small and this is a
 * single-process tool. Two servers pointed at the same file will overwrite each
 * other, which is one of the reasons to move to MongoDB when sharing it.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { defaultStatus } = require('./scenarios');

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'db.json');

const PRODUCTS = [
  { key: 'message', label: 'Message', blurb: 'Chat, threads and message migration' },
  { key: 'email', label: 'Email', blurb: 'Mailbox, folders and email delivery' },
  { key: 'content', label: 'Content', blurb: 'Files, folders and permissions' },
  { key: 'datasprawl', label: 'Data Sprawl', blurb: 'Duplicate and stale data across clouds' },
  { key: 'diy', label: 'DIY', blurb: 'Do-it-yourself migrations' },
];

let db = { enhancements: [], documents: [] };

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DATA_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      db = {
        enhancements: Array.isArray(parsed.enhancements) ? parsed.enhancements : [],
        documents: Array.isArray(parsed.documents) ? parsed.documents : [],
      };
    } catch (err) {
      // Keep a copy of the unreadable file instead of silently dropping data.
      const backup = `${DATA_FILE}.corrupt-${Date.now()}`;
      fs.copyFileSync(DATA_FILE, backup);
      console.error(`db.json could not be parsed; moved a copy to ${backup}`);
      db = { enhancements: [], documents: [] };
    }
  }
  repairNumbering();

  try { lastWriteMtimeMs = fs.existsSync(DATA_FILE) ? fs.statSync(DATA_FILE).mtimeMs : 0; } catch (err) { lastWriteMtimeMs = 0; }
  return db;
}

/**
 * Give every scenario an S.No.
 *
 * Rows written by a path that forgot to number them arrive with the column
 * blank, and stay that way for as long as the file lives. Numbering them here,
 * once, on load, repairs what is already stored and means no future gap in a
 * write path can leave the table looking broken.
 */
function repairNumbering() {
  let repaired = 0;

  db.enhancements.forEach((enhancement) => {
    const rows = enhancement.scenarios || [];
    const unnumbered = rows.some((row, idx) => Number(row.sno) !== idx + 1);
    if (!unnumbered) return;

    enhancement.scenarios = renumber(rows);
    repaired += 1;
  });

  if (!repaired) return;
  persist();
  console.log(`numbered the scenarios in ${repaired} enhancement${repaired === 1 ? '' : 's'}`);
}

let lastWriteMtimeMs = 0;

function persist() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_FILE); // atomic-ish: never leaves a half-written db.json
  lastWriteMtimeMs = fs.statSync(DATA_FILE).mtimeMs;
}

/**
 * Re-read db.json when someone else changed it — another server instance, or a
 * script editing the file while this process is running. Without this, our
 * in-memory snapshot would overwrite their changes on the next write.
 */
function syncFromDisk() {
  if (!fs.existsSync(DATA_FILE)) return;
  try {
    if (fs.statSync(DATA_FILE).mtimeMs !== lastWriteMtimeMs) load();
  } catch (err) {
    // a transient stat failure must not take a request down
  }
}

function isProduct(key) {
  return PRODUCTS.some((p) => p.key === key);
}

function summary(enhancement) {
  const { scenarios, ...rest } = enhancement;
  return { ...rest, scenarioCount: scenarios.length };
}

function listProducts() {
  syncFromDisk();
  return PRODUCTS.map((product) => {
    const items = db.enhancements.filter((e) => e.product === product.key);
    return {
      ...product,
      enhancementCount: items.length,
      scenarioCount: items.reduce((sum, e) => sum + e.scenarios.length, 0),
      // what the dashboard tiles summarise
      testCaseCount: items.reduce(
        (sum, e) => sum + e.scenarios.filter((s) => s.testCases && s.testCases.length).length,
        0
      ),
      documentCount: db.documents.filter((d) => d.product === product.key).length,
    };
  });
}

function listEnhancements(productKey) {
  syncFromDisk();
  return db.enhancements
    .filter((e) => e.product === productKey)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(summary);
}

function getEnhancement(id) {
  syncFromDisk();
  return db.enhancements.find((e) => e.id === id) || null;
}

function findByName(productKey, name) {
  syncFromDisk();
  const wanted = name.trim().toLowerCase();
  return db.enhancements.find((e) => e.product === productKey && e.name.toLowerCase() === wanted) || null;
}

function createEnhancement({ product, name, description, sourceFile, scenarios, extraColumns }) {
  syncFromDisk();
  const now = new Date().toISOString();
  const enhancement = {
    id: crypto.randomUUID(),
    product,
    name: name.trim(),
    description: (description || '').trim(),
    sourceFile: sourceFile || '',
    extraColumns: extraColumns || [],
    scenarios: renumber(scenarios || []),
    createdAt: now,
    updatedAt: now,
  };
  db.enhancements.push(enhancement);
  persist();
  return enhancement;
}

function renumber(scenarios) {
  return scenarios.map((s, idx) => ({ ...s, status: s.status || defaultStatus(s), sno: idx + 1 }));
}

function setScenarios(id, { scenarios, extraColumns, sourceFile, mode = 'replace' }) {
  const enhancement = getEnhancement(id);
  if (!enhancement) return null;

  enhancement.scenarios =
    mode === 'append' ? renumber([...enhancement.scenarios, ...scenarios]) : renumber(scenarios);
  enhancement.extraColumns =
    mode === 'append'
      ? Array.from(new Set([...enhancement.extraColumns, ...(extraColumns || [])]))
      : extraColumns || [];
  enhancement.sourceFile = sourceFile || enhancement.sourceFile;
  enhancement.updatedAt = new Date().toISOString();
  persist();
  return enhancement;
}

/** Append one scenario typed straight into the tool (no file involved). */
function addScenario(id, { scenario, extra }) {
  const enhancement = getEnhancement(id);
  if (!enhancement) return null;

  const cleanExtra = {};
  enhancement.extraColumns.forEach((col) => {
    cleanExtra[col] = String((extra || {})[col] || '').trim();
  });

  enhancement.scenarios.push({
    sno: enhancement.scenarios.length + 1,
    status: defaultStatus({ extra: cleanExtra }),
    scenario: scenario.trim(),
    sourceSno: '',
    extra: cleanExtra,
    addedInTool: true,
  });
  enhancement.updatedAt = new Date().toISOString();
  persist();
  return enhancement;
}

/** Cache the generated test cases on the scenario row so they survive a restart. */
function setTestCases(id, sno, { testCases, model, provider, generatedAt }) {
  const enhancement = getEnhancement(id);
  if (!enhancement) return null;

  const scenario = enhancement.scenarios.find((s) => Number(s.sno) === Number(sno));
  if (!scenario) return null;

  scenario.testCases = testCases;
  scenario.testCasesMeta = { model, provider, generatedAt };
  enhancement.updatedAt = new Date().toISOString();
  persist();
  return scenario;
}

const SCENARIO_STATUS = ['pass', 'fail', 'pending'];

/** Set or clear the run result on one scenario row. */
function setScenarioStatus(id, sno, status) {
  syncFromDisk();
  const enhancement = getEnhancement(id);
  if (!enhancement) return { status: 'no-enhancement' };

  const scenario = enhancement.scenarios.find((s) => Number(s.sno) === Number(sno));
  if (!scenario) return { status: 'no-scenario' };

  scenario.status = status;
  enhancement.updatedAt = new Date().toISOString();
  persist();
  return { status: 'ok', enhancement };
}

/** Delete one scenario row; the rows left keep a clean 1..N numbering. */
function deleteScenario(id, sno) {
  const enhancement = getEnhancement(id);
  if (!enhancement) return { status: 'no-enhancement' };

  const idx = enhancement.scenarios.findIndex((s) => Number(s.sno) === Number(sno));
  if (idx === -1) return { status: 'no-scenario' };

  const [removed] = enhancement.scenarios.splice(idx, 1);
  enhancement.scenarios = renumber(enhancement.scenarios);
  enhancement.updatedAt = new Date().toISOString();
  persist();
  return { status: 'ok', enhancement, removed };
}

function updateEnhancement(id, { name, description }) {
  const enhancement = getEnhancement(id);
  if (!enhancement) return null;
  if (typeof name === 'string' && name.trim()) enhancement.name = name.trim();
  if (typeof description === 'string') enhancement.description = description.trim();
  enhancement.updatedAt = new Date().toISOString();
  persist();
  return enhancement;
}

function deleteEnhancement(id) {
  syncFromDisk();
  const idx = db.enhancements.findIndex((e) => e.id === id);
  if (idx === -1) return false;
  db.enhancements.splice(idx, 1);
  persist();
  return true;
}

/* ---------------- enhancement documents ---------------- */

/** List view never carries the HTML body — only what the cards show. */
function documentSummary(doc) {
  const { html, ...rest } = doc;
  return { ...rest, hasBody: Boolean(html) };
}

function listDocuments() {
  syncFromDisk();
  return db.documents
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(documentSummary);
}

function countDocuments() {
  syncFromDisk();
  return db.documents.length;
}

function getDocument(id) {
  syncFromDisk();
  return db.documents.find((d) => d.id === id) || null;
}

function documentsForEnhancement(enhancementId) {
  syncFromDisk();
  return db.documents.filter((d) => d.enhancementId === enhancementId).map(documentSummary);
}

function createDocument(doc) {
  syncFromDisk();
  const now = new Date().toISOString();
  const record = { ...doc, createdAt: now, updatedAt: now };
  db.documents.push(record);
  persist();
  return record;
}

function updateDocument(id, { name, description, product, html }) {
  syncFromDisk();
  const doc = getDocument(id);
  if (!doc) return null;
  if (typeof name === 'string' && name.trim()) doc.name = name.trim();
  if (typeof description === 'string') doc.description = description.trim();
  if (typeof product === 'string') doc.product = product;
  if (typeof html === 'string') {
    doc.html = html;
    doc.editedAt = new Date().toISOString();
  }
  doc.updatedAt = new Date().toISOString();
  persist();
  return doc;
}

function deleteDocument(id) {
  syncFromDisk();
  const idx = db.documents.findIndex((d) => d.id === id);
  if (idx === -1) return false;
  db.documents.splice(idx, 1);
  persist();
  return true;
}


/** Every enhancement with its scenarios — matches the Mongo store's API. */
function allEnhancements() {
  syncFromDisk();
  return db.enhancements.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Every document including its rendered body. */
function allDocuments() {
  syncFromDisk();
  return db.documents.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

module.exports = {
  PRODUCTS,
  load,
  allEnhancements,
  allDocuments,
  listDocuments,
  countDocuments,
  getDocument,
  documentsForEnhancement,
  createDocument,
  updateDocument,
  deleteDocument,
  documentSummary,
  isProduct,
  listProducts,
  listEnhancements,
  getEnhancement,
  findByName,
  createEnhancement,
  setScenarios,
  addScenario,
  deleteScenario,
  setTestCases,
  setScenarioStatus,
  SCENARIO_STATUS,
  updateEnhancement,
  deleteEnhancement,
  summary,
};


/* Read the file once at startup, so the numbering repair runs before the
   first request rather than on whichever request happens to arrive first. */
load();

/* Every data function is exposed as async, so this module and store.mongo.js
   are drop-in replacements for one another. */
const SYNCHRONOUS = new Set(["PRODUCTS","SCENARIO_STATUS","isProduct","documentSummary","summary"]);
Object.keys(module.exports).forEach((key) => {
  const value = module.exports[key];
  if (typeof value !== 'function' || SYNCHRONOUS.has(key)) return;
  module.exports[key] = async (...args) => value(...args);
});
