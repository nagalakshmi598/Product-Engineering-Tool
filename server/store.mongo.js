'use strict';

/**
 * The tool's data, in MongoDB.
 *
 * Two collections:
 *   enhancements — one per enhancement, with its scenarios embedded. Scenarios
 *                  are only ever read and written together with their
 *                  enhancement, so embedding keeps that a single round trip.
 *   documents    — one per uploaded write-up, with its rendered HTML embedded.
 *
 * The uuid the app uses as `id` is stored as Mongo's `_id`, so it is unique and
 * indexed for free; db.fromDoc maps it back on the way out.
 *
 * Every function here is async. The products list is static configuration, not
 * data, so it stays in the file.
 */

const crypto = require('crypto');
const { getDb, fromDoc } = require('./db');
const { defaultStatus } = require('./scenarios');

const PRODUCTS = [
  { key: 'message', label: 'Message', blurb: 'Chat, threads and message migration' },
  { key: 'email', label: 'Email', blurb: 'Mailbox, folders and email delivery' },
  { key: 'content', label: 'Content', blurb: 'Files, folders and permissions' },
  { key: 'datasprawl', label: 'Data Sprawl', blurb: 'Duplicate and stale data across clouds' },
  { key: 'diy', label: 'DIY', blurb: 'Do-it-yourself migrations' },
];

const SCENARIO_STATUS = ['pass', 'fail', 'pending'];

async function enhancements() {
  return (await getDb()).collection('enhancements');
}

async function documents() {
  return (await getDb()).collection('documents');
}

function isProduct(key) {
  return PRODUCTS.some((p) => p.key === key);
}

/** The card view of an enhancement: everything but the scenario rows. */
function summary(enhancement) {
  const { scenarios, ...rest } = enhancement;
  return { ...rest, scenarioCount: (scenarios || []).length };
}

/* ---------------- products ---------------- */

async function listProducts() {
  const [byProduct, docCounts] = await Promise.all([
    (await enhancements()).aggregate([
      {
        $group: {
          _id: '$product',
          enhancementCount: { $sum: 1 },
          scenarioCount: { $sum: { $size: { $ifNull: ['$scenarios', []] } } },
          testCaseCount: {
            $sum: {
              $size: {
                $filter: {
                  input: { $ifNull: ['$scenarios', []] },
                  as: 's',
                  cond: { $gt: [{ $size: { $ifNull: ['$$s.testCases', []] } }, 0] },
                },
              },
            },
          },
        },
      },
    ]).toArray(),
    (await documents()).aggregate([{ $group: { _id: '$product', count: { $sum: 1 } } }]).toArray(),
  ]);

  const stats = new Map(byProduct.map((row) => [row._id, row]));
  const docs = new Map(docCounts.map((row) => [row._id, row.count]));

  return PRODUCTS.map((product) => {
    const row = stats.get(product.key) || {};
    return {
      ...product,
      enhancementCount: row.enhancementCount || 0,
      scenarioCount: row.scenarioCount || 0,
      testCaseCount: row.testCaseCount || 0,
      documentCount: docs.get(product.key) || 0,
    };
  });
}

/* ---------------- enhancements ---------------- */

async function listEnhancements(productKey) {
  const rows = await (await enhancements())
    .find({ product: productKey })
    .sort({ createdAt: -1 })
    .toArray();
  return rows.map((row) => summary(fromDoc(row)));
}

async function getEnhancement(id) {
  const row = await (await enhancements()).findOne({ _id: id });
  return fromDoc(row);
}

async function findByName(productKey, name) {
  const row = await (await enhancements()).findOne({
    product: productKey,
    nameLower: String(name).trim().toLowerCase(),
  });
  return fromDoc(row);
}

async function createEnhancement({ product, name, description, sourceFile, scenarios, extraColumns }) {
  const now = new Date().toISOString();
  const clean = name.trim();
  const record = {
    _id: crypto.randomUUID(),
    product,
    name: clean,
    nameLower: clean.toLowerCase(),
    description: (description || '').trim(),
    sourceFile: sourceFile || '',
    extraColumns: extraColumns || [],
    scenarios: renumber(scenarios || []),
    createdAt: now,
    updatedAt: now,
  };

  await (await enhancements()).insertOne(record);
  return fromDoc(record);
}

/** Rows keep a clean 1..N numbering, and default to passed. */
function renumber(scenarios) {
  return scenarios.map((s, idx) => ({ ...s, status: s.status || defaultStatus(s), sno: idx + 1 }));
}

/** Write the scenarios back and hand the whole enhancement to the caller. */
async function saveScenarios(id, scenarios, extra = {}) {
  const row = await (await enhancements()).findOneAndUpdate(
    { _id: id },
    { $set: { scenarios, updatedAt: new Date().toISOString(), ...extra } },
    { returnDocument: 'after' }
  );
  return fromDoc(row);
}

async function setScenarios(id, { scenarios, extraColumns, sourceFile, mode = 'replace' }) {
  const enhancement = await getEnhancement(id);
  if (!enhancement) return null;

  const rows = mode === 'append'
    ? renumber([...enhancement.scenarios, ...scenarios])
    : renumber(scenarios);

  const columns = mode === 'append'
    ? Array.from(new Set([...enhancement.extraColumns, ...(extraColumns || [])]))
    : extraColumns || [];

  return saveScenarios(id, rows, {
    extraColumns: columns,
    sourceFile: sourceFile || enhancement.sourceFile,
  });
}

/** Append one scenario typed straight into the tool (no file involved). */
async function addScenario(id, { scenario, extra }) {
  const enhancement = await getEnhancement(id);
  if (!enhancement) return null;

  const cleanExtra = {};
  enhancement.extraColumns.forEach((col) => {
    cleanExtra[col] = String((extra || {})[col] || '').trim();
  });

  const rows = [...enhancement.scenarios, {
    sno: enhancement.scenarios.length + 1,
    status: defaultStatus({ extra: cleanExtra }),
    scenario: scenario.trim(),
    sourceSno: '',
    extra: cleanExtra,
    addedInTool: true,
  }];

  return saveScenarios(id, rows);
}

/** Cache the generated test cases on the scenario row so they survive a restart. */
/**
 * Write the test cases onto one scenario, and only that scenario.
 *
 * Reading the whole array, changing one entry and writing it all back loses
 * writes the moment two of these overlap — and filling in a set of scenarios
 * runs several at once, so they always overlap. The positional update touches
 * the one row, leaving the rest of the array exactly as it is on the server.
 */
/** Reword one scenario, leaving its number, result and test cases alone. */
async function updateScenario(id, sno, { scenario }) {
  const current = await getEnhancement(id);
  if (!current) return { status: 'no-enhancement' };

  const row = (current.scenarios || []).find((s) => Number(s.sno) === Number(sno));
  if (!row) return { status: 'no-scenario' };

  const after = String(scenario).trim().slice(0, 2000);
  const saved = await (await enhancements()).findOneAndUpdate(
    { _id: id, 'scenarios.sno': Number(sno) },
    { $set: { 'scenarios.$.scenario': after, updatedAt: new Date().toISOString() } },
    { returnDocument: 'after' }
  );

  if (!saved) return { status: 'no-scenario' };
  return { status: 'ok', enhancement: fromDoc(saved), before: row.scenario, after };
}

async function setTestCases(id, sno, { testCases, model, provider, generatedAt }) {
  const row = await (await enhancements()).findOneAndUpdate(
    { _id: id, 'scenarios.sno': Number(sno) },
    {
      $set: {
        'scenarios.$.testCases': testCases,
        'scenarios.$.testCasesMeta': { model, provider, generatedAt },
        updatedAt: new Date().toISOString(),
      },
    },
    { returnDocument: 'after' }
  );

  if (!row) return null;
  return (fromDoc(row).scenarios || []).find((s) => Number(s.sno) === Number(sno)) || null;
}

/** Set the run result on one scenario row. */
async function setScenarioStatus(id, sno, status) {
  const enhancement = await getEnhancement(id);
  if (!enhancement) return { status: 'no-enhancement' };

  const scenario = enhancement.scenarios.find((s) => Number(s.sno) === Number(sno));
  if (!scenario) return { status: 'no-scenario' };

  const rows = enhancement.scenarios.map((s) => (
    Number(s.sno) === Number(sno) ? { ...s, status } : s
  ));

  return { status: 'ok', enhancement: await saveScenarios(id, rows) };
}

/** Delete one scenario row; the rows left keep a clean 1..N numbering. */
async function deleteScenario(id, sno) {
  const enhancement = await getEnhancement(id);
  if (!enhancement) return { status: 'no-enhancement' };

  const idx = enhancement.scenarios.findIndex((s) => Number(s.sno) === Number(sno));
  if (idx === -1) return { status: 'no-scenario' };

  const remaining = enhancement.scenarios.slice();
  const [removed] = remaining.splice(idx, 1);

  return { status: 'ok', enhancement: await saveScenarios(id, renumber(remaining)), removed };
}

async function updateEnhancement(id, { name, description }) {
  const set = { updatedAt: new Date().toISOString() };
  if (typeof name === 'string' && name.trim()) {
    set.name = name.trim();
    set.nameLower = set.name.toLowerCase();
  }
  if (typeof description === 'string') set.description = description.trim();

  const row = await (await enhancements()).findOneAndUpdate(
    { _id: id },
    { $set: set },
    { returnDocument: 'after' }
  );
  return fromDoc(row);
}

async function deleteEnhancement(id) {
  const result = await (await enhancements()).deleteOne({ _id: id });
  return result.deletedCount > 0;
}

/** Every enhancement with its scenarios — one query, for the assistant. */
async function allEnhancements() {
  const rows = await (await enhancements()).find({}).sort({ createdAt: -1 }).toArray();
  return rows.map(fromDoc);
}

/* ---------------- enhancement documents ---------------- */

/** List view never carries the HTML body — only what the cards show. */
function documentSummary(doc) {
  const { html, ...rest } = doc;
  return { ...rest, hasBody: Boolean(html) };
}

async function listDocuments() {
  const rows = await (await documents())
    .find({}, { projection: { html: 0 } })
    .sort({ createdAt: -1 })
    .toArray();
  return rows.map((row) => ({ ...fromDoc(row), hasBody: true }));
}

async function countDocuments() {
  return (await documents()).countDocuments();
}

async function getDocument(id) {
  return fromDoc(await (await documents()).findOne({ _id: id }));
}

async function documentsForEnhancement(enhancementId) {
  const rows = await (await documents())
    .find({ enhancementId }, { projection: { html: 0 } })
    .toArray();
  return rows.map((row) => ({ ...fromDoc(row), hasBody: true }));
}

async function createDocument(doc) {
  const record = { ...doc, _id: doc.id || crypto.randomUUID() };
  delete record.id;
  await (await documents()).insertOne(record);
  return fromDoc(record);
}

async function updateDocument(id, { name, description, product, html }) {
  const set = { updatedAt: new Date().toISOString() };
  if (typeof name === 'string' && name.trim()) set.name = name.trim();
  if (typeof description === 'string') set.description = description.trim();
  if (typeof product === 'string') set.product = product;
  if (typeof html === 'string') {
    set.html = html;
    set.editedAt = new Date().toISOString();
  }

  const row = await (await documents()).findOneAndUpdate(
    { _id: id },
    { $set: set },
    { returnDocument: 'after' }
  );
  return fromDoc(row);
}

async function deleteDocument(id) {
  const result = await (await documents()).deleteOne({ _id: id });
  return result.deletedCount > 0;
}

/** Every document including its rendered body — one query, for the assistant. */
async function allDocuments() {
  const rows = await (await documents()).find({}).sort({ createdAt: -1 }).toArray();
  return rows.map(fromDoc);
}

module.exports = {
  PRODUCTS,
  SCENARIO_STATUS,
  isProduct,
  listProducts,
  listEnhancements,
  getEnhancement,
  findByName,
  createEnhancement,
  setScenarios,
  addScenario,
  setTestCases,
  setScenarioStatus,
  deleteScenario,
  updateScenario,
  updateEnhancement,
  deleteEnhancement,
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
  summary,
};
