'use strict';
/* Everything the tool does, asked for in the chat. */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT = path.resolve(__dirname, '..');
const STUBS = path.join(__dirname, 'stubs');
const HERE = path.join(os.tmpdir(), 'cftool-tests', path.basename(__filename, '.js'));
fs.mkdirSync(HERE, { recursive: true });
const PORT = 4443;
const BASE = `http://127.0.0.1:${PORT}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const checks = [];
const record = (n, ok, d) => checks.push({ n, ok, d });

const SPEC = [
  '# Egnyte - Content Sprawl Scope', '',
  'This write-up specifies how the Egnyte tenant is scanned and reported.',
  'Stale items are those untouched for 180 days; duplicates are matched by hash.',
  'A scan without admin consent is refused with "Permissions required".',
].join('\n');

async function ask(question, extra = {}) {
  const fd = new FormData();
  fd.append('question', question);
  fd.append('history', '[]');
  Object.entries(extra).forEach(([k, v]) => fd.append(k, v));
  const res = await fetch(`${BASE}/api/assistant`, { method: 'POST', body: fd });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function run(command, target) {
  const res = await fetch(`${BASE}/api/assistant/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      command,
      enhancementId: target ? target.id : null,
      documentId: target ? target.id : null,
    }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/** Say it, then do what it said — the two steps the chat takes. */
async function instruct(question, extra) {
  const said = await ask(question, extra);
  if (!said.body.command || !said.body.target) return { said, done: null };
  return { said, done: await run(said.body.command, said.body.target) };
}

const docs = async () => (await (await fetch(`${BASE}/api/documents`)).json()).documents;
const doc = async (id) => (await (await fetch(`${BASE}/api/documents/${id}`)).json()).document;

(async () => {
  fs.rmSync(path.join(HERE, 'adata'), { recursive: true, force: true });
  fs.rmSync(path.join(HERE, 'auploads'), { recursive: true, force: true });

  const env = {
    ...process.env,
    CF_DATA_DIR: path.join(HERE, 'adata'),
    CF_UPLOAD_DIR: path.join(HERE, 'auploads'),
    PORT: String(PORT),
    OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '',   // nothing here needs a model
  };

  const server = spawn(process.execPath, ['server/index.js'], { cwd: PROJECT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', (c) => (log += c));
  server.stderr.on('data', (c) => (log += c));

  let up = false;
  for (let i = 0; i < 90; i += 1) {
    try { if ((await fetch(`${BASE}/api/products`)).ok) { up = true; break; } } catch (_) {}
    await wait(500);
  }
  if (!up) { console.error('never came up:\n' + log); server.kill(); process.exit(1); }

  try {
    /* ---- 1. upload, by attaching it to a message ---- */
    const fd = new FormData();
    fd.append('question', 'here is the Egnyte scope write-up');
    fd.append('history', '[]');
    fd.append('currentProduct', 'datasprawl');
    fd.append('files', new Blob([SPEC], { type: 'text/markdown' }), 'Egnyte - Content Sprawl Scope.md');
    const uploaded = await (await fetch(`${BASE}/api/assistant`, { method: 'POST', body: fd })).json();

    const filed = (uploaded.documents || [])[0];
    record('a write-up attached to a message is filed', Boolean(filed), filed ? filed.name : 'nothing filed');
    const docId = filed && filed.id;

    /* ---- 2. add to it ---- */
    const added = await instruct(
      'add to the Egnyte - Content Sprawl Scope document: The scan also reports links shared with anyone.'
    );
    record('the bot adds to a write-up',
      added.done && /Added to/.test(added.done.body.done || ''),
      (added.done && (added.done.body.done || added.done.body.error)) || String(added.said.body.answer).slice(0, 50));
    record('and the words are really in it',
      /links shared with anyone/.test((await doc(docId)).html || ''), '');

    /* ---- 3. correct it ---- */
    const fixed = await instruct(
      'in the Egnyte - Content Sprawl Scope document, change "180 days" to "90 days"'
    );
    const body = (await doc(docId)).html || '';
    record('the bot corrects a write-up',
      fixed.done && /Changed/.test(fixed.done.body.done || ''),
      (fixed.done && (fixed.done.body.done || fixed.done.body.error)) || 'no change');
    record('the old wording is gone', !/180 days/.test(body) && /90 days/.test(body), '');
    record('it asks before changing stored words',
      fixed.said.body.command && fixed.said.body.command.confirm === true, '');

    const missing = await instruct('in the Egnyte - Content Sprawl Scope document, change "a year" to "a month"');
    record('and says so when the words are not there',
      missing.done && missing.done.status === 404 && /does not appear/.test(missing.done.body.error || ''),
      (missing.done && missing.done.body.error) || '');

    /* ---- 4. rename and refile it ---- */
    const renamed = await instruct('rename the Egnyte - Content Sprawl Scope document to Egnyte Sprawl Scope');
    record('the bot renames a write-up',
      renamed.done && /now called "Egnyte Sprawl Scope"/.test(renamed.done.body.done || ''),
      (renamed.done && (renamed.done.body.done || renamed.done.body.error)) || '');

    const moved = await instruct('move the Egnyte Sprawl Scope document to Content');
    record('the bot refiles a write-up',
      moved.done && /filed under Content/.test(moved.done.body.done || ''),
      (moved.done && (moved.done.body.done || moved.done.body.error)) || '');

    /* ---- 5. a set of scenarios, and test cases for it ---- */
    const set = await (await fetch(`${BASE}/api/assistant/scenarios`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        product: 'datasprawl', name: 'Egnyte sprawl checks',
        scenarios: Array.from({ length: 5 }, (_, i) => ({
          scenario: `Verify that the Egnyte scan reports item ${i + 1} correctly.`,
          type: i % 2 ? 'Negative' : 'Positive',
        })),
      }),
    })).json();
    const setId = set.enhancement.id;

    const cases = await ask('generate test cases for Egnyte sprawl checks');
    record('"generate test cases" is an instruction, not a question',
      cases.body.command && cases.body.command.kind === 'make-test-cases',
      cases.body.command ? cases.body.command.kind : String(cases.body.answer).slice(0, 44));
    record('it finds the set by name',
      Boolean(cases.body.target) && cases.body.target.id === setId,
      cases.body.target ? cases.body.target.name : 'not found');
    record('and does not ask, since it takes nothing away',
      cases.body.command && cases.body.command.confirm === false, '');

    const started = await run(cases.body.command, cases.body.target);
    record('the run starts and says how many',
      started.status === 200 && /5 scenarios/.test(started.body.done || ''),
      started.body.done || started.body.error);
    record('and hands back the set to watch',
      started.body.enhancementId === setId && Boolean(started.body.job), '');

    const again = await ask('regenerate test cases for Egnyte sprawl checks');
    record('regenerating asks first, since it replaces',
      again.body.command && again.body.command.again === true && again.body.command.confirm === true,
      String(again.body.answer).slice(0, 62));

    /* ---- 6. delete it ---- */
    const dropped = await instruct('delete the Egnyte Sprawl Scope document');
    record('the bot deletes a write-up',
      dropped.done && /Deleted the write-up/.test(dropped.done.body.done || ''),
      (dropped.done && (dropped.done.body.done || dropped.done.body.error)) || '');
    record('and the scenarios are untouched by it',
      (await (await fetch(`${BASE}/api/enhancements/${setId}`)).json()).enhancement.scenarios.length === 5,
      '5 scenarios still there');
    record('the shelf is empty again', (await docs()).length === 0, `${(await docs()).length} left`);

    /* ---- 7. it says what it can do ---- */
    const help = await ask('what can you do');
    const said = String(help.body.answer || '');
    record('it lists what it can be asked',
      /WRITE-UPS/.test(said) && /TEST CASES/.test(said) && /SCENARIOS/.test(said),
      said.split('\n')[0]);
    record('including the ones just built',
      /Generate test cases/.test(said) && /Add to the/.test(said) && /change "180 days"/.test(said), '');
  } catch (err) {
    record('threw', false, err.message);
  }

  console.log('\n--- everything the tool does, asked for in the chat ---');
  checks.forEach((c) => console.log((c.ok ? '  PASS  ' : '  FAIL  ') + c.n.padEnd(46) + ' ' + (c.d || '')));
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n${failed} FAILED` : '\nall checks passed');
  if (failed) console.log('\nserver log:\n' + log.slice(-900));

  server.kill();
  process.exit(failed ? 1 : 0);
})();
