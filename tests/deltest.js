'use strict';
/* Say document, a document goes. Say scenarios, scenarios go. */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT = path.resolve(__dirname, '..');
const STUBS = path.join(__dirname, 'stubs');
const HERE = path.join(os.tmpdir(), 'cftool-tests', path.basename(__filename, '.js'));
fs.mkdirSync(HERE, { recursive: true });
const PORT = 4435;
const BASE = `http://127.0.0.1:${PORT}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const checks = [];
const record = (n, ok, d) => checks.push({ n, ok, d });

const body = (name) => [
  `# ${name}`, '',
  `This write-up specifies how ${name} is scanned and reported in full detail.`,
  'The scan counts every folder and file in the tenant and reports the total count.',
  'Stale items are those untouched for 180 days; duplicates are matched by hash.',
].join('\n');

async function upload(name) {
  const fd = new FormData();
  fd.append('name', name);
  fd.append('product', 'datasprawl');
  fd.append('file', new Blob([body(name)], { type: 'text/markdown' }), `${name}.md`);
  return (await fetch(`${BASE}/api/documents`, { method: 'POST', body: fd })).json();
}

async function ask(question, { documentId, enhancementId } = {}) {
  const fd = new FormData();
  fd.append('question', question);
  fd.append('history', '[]');
  fd.append('currentProduct', 'datasprawl');
  if (documentId) fd.append('currentDocument', documentId);
  if (enhancementId) fd.append('currentEnhancement', enhancementId);
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

const docs = async () => (await (await fetch(`${BASE}/api/documents`)).json()).documents;
const sets = async () => (await (await fetch(`${BASE}/api/products/datasprawl/enhancements`)).json()).enhancements;

(async () => {
  fs.rmSync(path.join(HERE, 'ddata'), { recursive: true, force: true });
  fs.rmSync(path.join(HERE, 'duploads'), { recursive: true, force: true });

  const env = {
    ...process.env,
    CF_DATA_DIR: path.join(HERE, 'ddata'),
    CF_UPLOAD_DIR: path.join(HERE, 'duploads'),
    PORT: String(PORT),
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
    const made = await upload('Egnyte - Content Sprawl Scope');
    await upload('Dropbox - Content Sprawl Scope');
    const openDoc = made.document.id;

    /* a set of scenarios named almost the same, which is what got deleted */
    const set = await (await fetch(`${BASE}/api/assistant/scenarios`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        product: 'datasprawl', name: 'Egnyte - Content Sprawl Scope',
        scenarios: Array.from({ length: 20 }, (_, i) => ({
          scenario: `Verify that the Egnyte scan reports item ${i + 1} correctly.`,
          type: 'Positive',
        })),
      }),
    })).json();

    record('a write-up and a set share a name', (await docs()).length === 2 && (await sets()).length === 1,
      `${(await docs()).length} write-ups, ${(await sets()).length} set`);

    /* ---- the instruction that deleted the wrong thing ---- */
    const said = await ask('delete this document in data sprawl not scenarios', { documentId: openDoc });

    record('it is read as being about a write-up',
      said.body.command && said.body.command.kind === 'delete-document',
      said.body.command ? said.body.command.kind : 'not a command');
    record('it is not read as deleting a set',
      !said.body.command || said.body.command.kind !== 'delete-set',
      String(said.body.answer).slice(0, 60));
    record('it finds the write-up being read',
      Boolean(said.body.target) && said.body.target.id === openDoc,
      said.body.target ? said.body.target.name : 'nothing found');
    record('and asks first', said.body.command && said.body.command.confirm === true, '');

    const done = await run(said.body.command, said.body.target);
    record('the write-up goes', (await docs()).length === 1, done.body.done || done.body.error);
    record('the scenarios stay',
      (await sets()).length === 1 && (await sets())[0].scenarioCount === 20,
      `${(await sets())[0].scenarioCount} scenarios untouched`);

    /* ---- the same with nothing open: write-ups are offered, not sets ---- */
    const blind = await ask('delete this document');
    record('with nothing open it asks which write-up',
      /write-up/i.test(String(blind.body.answer)), String(blind.body.answer).slice(0, 48));
    record('and offers write-ups, not sets',
      (blind.body.choices || []).length > 0 && blind.body.choices.every((c) => c.kind === 'document'),
      (blind.body.choices || []).map((c) => c.name).join(', ') || 'nothing offered');

    /* ---- renaming, said the way people say it ----
       "Edit that name as X" reached the model, which answered that it could
       not help with renaming files. Nobody had asked it to. */
    const renamed = await ask('edit that name as Dropbox sprawl scope',
      { documentId: (await docs())[0].id });

    record('"edit that name as X" is an instruction',
      renamed.body.command && renamed.body.command.kind === 'rename-document',
      renamed.body.command ? renamed.body.command.kind : String(renamed.body.answer).slice(0, 56));
    record('it finds the write-up being read',
      Boolean(renamed.body.target), renamed.body.target ? renamed.body.target.name : 'nothing found');
    record('and says what it will be called',
      /to "Dropbox sprawl scope"/.test(String(renamed.body.answer)),
      String(renamed.body.answer).slice(0, 62));

    const didRename = await run(renamed.body.command, renamed.body.target);
    record('the write-up is renamed',
      (await docs()).some((d) => d.name === 'Dropbox sprawl scope'),
      didRename.body.done || didRename.body.error);

    /* ---- saying scenarios still means scenarios ---- */
    const other = await ask('delete the Egnyte - Content Sprawl Scope set', { enhancementId: set.enhancement.id });
    record('naming a set still deletes the set',
      other.body.command && other.body.command.kind === 'delete-set',
      other.body.command ? other.body.command.kind : 'not a command');

    const gone = await run(other.body.command, other.body.target);
    record('and it is the set that goes', (await sets()).length === 0 && (await docs()).length === 1,
      gone.body.done || gone.body.error);
  } catch (err) {
    record('threw', false, err.message);
  }

  console.log('\n--- document means document ---');
  checks.forEach((c) => console.log((c.ok ? '  PASS  ' : '  FAIL  ') + c.n.padEnd(38) + ' ' + (c.d || '')));
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n${failed} FAILED` : '\nall checks passed');
  if (failed) console.log('\nserver log:\n' + log.slice(-900));

  server.kill();
  process.exit(failed ? 1 : 0);
})();
