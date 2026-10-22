'use strict';
/* An instruction typed in a hurry is still an instruction, and one that
   cannot be read is never quietly turned into something else. */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT = path.resolve(__dirname, '..');
const STUBS = path.join(__dirname, 'stubs');
const HERE = path.join(os.tmpdir(), 'cftool-tests', path.basename(__filename, '.js'));
fs.mkdirSync(HERE, { recursive: true });
const PORT = 4445;
const BASE = `http://127.0.0.1:${PORT}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const checks = [];
const record = (n, ok, d) => checks.push({ n, ok, d });

const SPEC = [
  '# Slack Message Sprawl- InScope', '',
  'This write-up specifies which Slack messages are in scope for the sprawl scan.',
  'Messages older than 180 days in archived channels are counted as stale.',
  'Direct messages are excluded unless the workspace owner opts in.',
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

const docs = async () => (await (await fetch(`${BASE}/api/documents`)).json()).documents;
const sets = async () => (await (await fetch(`${BASE}/api/products/datasprawl/enhancements`)).json()).enhancements;

(async () => {
  fs.rmSync(path.join(HERE, 'ydata'), { recursive: true, force: true });
  fs.rmSync(path.join(HERE, 'yuploads'), { recursive: true, force: true });

  const env = {
    ...process.env,
    CF_DATA_DIR: path.join(HERE, 'ydata'),
    CF_UPLOAD_DIR: path.join(HERE, 'yuploads'),
    PORT: String(PORT),
    OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '',  // nothing here should reach a model
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
    const fd = new FormData();
    fd.append('question', 'here is the Slack in-scope write-up');
    fd.append('history', '[]');
    fd.append('currentProduct', 'datasprawl');
    fd.append('files', new Blob([SPEC], { type: 'text/markdown' }), 'Slack Message Sprawl- InScope.md');
    await fetch(`${BASE}/api/assistant`, { method: 'POST', body: fd });

    const docId = (await docs())[0].id;
    record('a write-up is on the shelf', (await docs()).length === 1, (await docs())[0].name);
    record('and no sets yet', (await sets()).length === 0, `${(await sets()).length} sets`);

    /* ---- the message from the screenshot, typo and all ---- */
    const typed = await ask('delte this document', { currentProduct: 'datasprawl', currentDocument: docId });

    record('the typo is still an instruction',
      typed.body.command && typed.body.command.kind === 'delete-document',
      typed.body.command ? typed.body.command.kind : String(typed.body.answer).slice(0, 48));
    record('it does not come back as a draft', !typed.body.draft && !typed.body.drafts,
      typed.body.draft ? 'drafted scenarios instead' : 'no draft');
    record('it finds the write-up', Boolean(typed.body.target) && typed.body.target.id === docId,
      typed.body.target ? typed.body.target.name : 'nothing');

    const done = await run(typed.body.command, typed.body.target);
    record('and deletes it when told to', (await docs()).length === 0,
      done.body.done || done.body.error);
    record('no set was invented along the way', (await sets()).length === 0,
      (await sets()).map((s) => s.name).join(', ') || 'none');

    /* ---- more hurried typing ---- */
    const more = [
      ['genrate test cases for Slack checks', 'make-test-cases'],
      ['delete scenarious 2 and 3', 'delete-scenarios'],
      ['remve that section', 'clear-column'],
      ['renmae this to Slack sprawl checks', 'rename-set'],
    ];

    const set = await (await fetch(`${BASE}/api/assistant/scenarios`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        product: 'datasprawl', name: 'Slack checks',
        scenarios: [{ scenario: 'Verify that archived channels are counted.', type: 'Positive', section: 'Scan' }],
      }),
    })).json();

    for (const [said, kind] of more) {
      const out = await ask(said, { currentProduct: 'datasprawl', currentEnhancement: set.enhancement.id });
      record(`"${said}"`, out.body.command && out.body.command.kind === kind,
        out.body.command ? out.body.command.kind : String(out.body.answer).slice(0, 40));
    }

    /* ---- an instruction it cannot read is not turned into something else ---- */
    const vague = await ask('remove all of the documents from the data sprawl tab',
      { currentProduct: 'datasprawl' });

    record('an unreadable instruction says so',
      /reads as an instruction/i.test(String(vague.body.answer)),
      String(vague.body.answer).split('\n')[0]);
    record('and never drafts scenarios instead', !vague.body.draft && !vague.body.drafts,
      vague.body.draft ? 'drafted anyway' : 'no draft');
    record('it says what to say instead', /delete the <name> document/.test(String(vague.body.answer)), '');

    /* ---- a real drafting request is untouched by any of this ---- */
    const drafting = await ask('write test scenarios for archived channel scanning',
      { currentProduct: 'datasprawl' });
    record('drafting requests still draft',
      !drafting.body.command && !/reads as an instruction/i.test(String(drafting.body.answer)),
      String(drafting.body.answer).split('\n')[0].slice(0, 54));
  } catch (err) {
    record('threw', false, err.message);
  }

  console.log('\n--- typed in a hurry, still understood ---');
  checks.forEach((c) => console.log((c.ok ? '  PASS  ' : '  FAIL  ') + c.n.padEnd(44) + ' ' + (c.d || '')));
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n${failed} FAILED` : '\nall checks passed');
  if (failed) console.log('\nserver log:\n' + log.slice(-900));

  server.kill();
  process.exit(failed ? 1 : 0);
})();
