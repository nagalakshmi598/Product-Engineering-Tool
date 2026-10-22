'use strict';
/* The write-up you attached is the one the scenarios come from. */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT = path.resolve(__dirname, '..');
const STUBS = path.join(__dirname, 'stubs');
const HERE = path.join(os.tmpdir(), 'cftool-tests', path.basename(__filename, '.js'));
fs.mkdirSync(HERE, { recursive: true });
const PORT = 4449;
const BASE = `http://127.0.0.1:${PORT}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const checks = [];
const record = (n, ok, d) => checks.push({ n, ok, d });

/* Each write-up carries one phrase that appears in no other. */
const ATTACHED = [
  '# Email Attributes Scope', '',
  'This write-up specifies which mailbox attributes move during a migration.',
  'The retention cutover window is honoured for every mailbox in the wave.',
  'Display names, aliases and forwarding addresses are carried across.',
].join('\n');

const OPEN_ONE = [
  '# Slack Message Sprawl- InScope', '',
  'This write-up specifies which Slack messages are in scope for the scan.',
  'Messages in archived channels older than 180 days are counted as stale.',
].join('\n');

const ON_THE_SHELF = [
  '# Dropbox - Content Sprawl Scope', '',
  'This write-up specifies how a Dropbox tenant is scanned for sprawl.',
  'Items shared with anyone-with-the-link are listed with their owner and age.',
].join('\n');

async function upload(name, text, product) {
  const fd = new FormData();
  fd.append('name', name);
  fd.append('product', product);
  fd.append('file', new Blob([text], { type: 'text/markdown' }), `${name}.md`);
  return (await fetch(`${BASE}/api/documents`, { method: 'POST', body: fd })).json();
}

async function ask(question, { attach, extra = {} } = {}) {
  const fd = new FormData();
  fd.append('question', question);
  fd.append('history', '[]');
  Object.entries(extra).forEach(([k, v]) => fd.append(k, v));
  if (attach) fd.append('files', new Blob([attach.text], { type: 'text/markdown' }), `${attach.name}.md`);
  const res = await fetch(`${BASE}/api/assistant`, { method: 'POST', body: fd });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const rowsOf = (body) => (body.draft && body.draft.scenarios)
  || (body.drafts || []).flatMap((d) => d.scenarios)
  || [];

const mentions = (rows, re) => rows.some((s) => re.test(s.scenario));

(async () => {
  fs.rmSync(path.join(HERE, 'sdata2'), { recursive: true, force: true });
  fs.rmSync(path.join(HERE, 'suploads2'), { recursive: true, force: true });

  const env = {
    ...process.env,
    CF_DATA_DIR: path.join(HERE, 'sdata2'),
    CF_UPLOAD_DIR: path.join(HERE, 'suploads2'),
    PORT: String(PORT),
    AI_PROVIDER: 'openai',
    OPENAI_API_KEY: 'sk-test-not-a-real-key',
    NODE_OPTIONS: `--require "${path.join(STUBS, 'stubsource.js').split(path.sep).join('/')}"`,
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
    const open = await upload('Slack Message Sprawl- InScope', OPEN_ONE, 'content');
    await upload('Dropbox - Content Sprawl Scope', ON_THE_SHELF, 'content');
    const openId = open.document.id;

    /* ---- the report: attach a write-up while another one is open ---- */
    const sent = await ask('write test scenarios for this document', {
      attach: { name: 'Email Attributes Scope', text: ATTACHED },
      extra: { currentProduct: 'content', currentDocument: openId },
    });

    const rows = rowsOf(sent.body);
    record('it drafts something', rows.length > 0,
      rows.length ? `${rows.length} scenarios` : String(sent.body.answer).slice(0, 50));
    record('from the write-up that was attached',
      mentions(rows, /retention cutover window/i),
      rows.length ? rows[0].scenario.slice(0, 60) : '');
    record('not from the one left open behind it',
      !mentions(rows, /archived channels/i),
      mentions(rows, /archived channels/i) ? 'drafted from the open one' : 'the open one was not used');
    record('nor from another on the shelf',
      !mentions(rows, /anyone-with-the-link/i), '');
    record('and not about uploading documents',
      !mentions(rows, /upload|Documents page/i), '');
    record('the attachment is still filed',
      (sent.body.documents || []).some((d) => d.name === 'Email Attributes Scope'),
      (sent.body.documents || []).map((d) => d.name).join(', '));

    /* ---- attach it with nothing open ---- */
    const alone = await ask('write test scenarios for this document', {
      attach: { name: 'Email Attributes Scope 2', text: ATTACHED },
      extra: { currentProduct: 'content' },
    });
    record('attaching one with nothing open works too',
      mentions(rowsOf(alone.body), /retention cutover window/i),
      `${rowsOf(alone.body).length} scenarios`);

    /* ---- attach one while naming another: the attachment still wins ---- */
    const confused = await ask('write test scenarios for this Dropbox - Content Sprawl Scope document', {
      attach: { name: 'Email Attributes Scope 3', text: ATTACHED },
      extra: { currentProduct: 'content' },
    });
    record('a name in the sentence does not beat the attachment',
      mentions(rowsOf(confused.body), /retention cutover window/i),
      rowsOf(confused.body).length ? rowsOf(confused.body)[0].scenario.slice(0, 54) : 'nothing');

    /* ---- nothing attached: pointing at the open one still works ---- */
    const pointed = await ask('write test scenarios for this document', {
      extra: { currentProduct: 'content', currentDocument: openId },
    });
    record('with nothing attached, "this document" is the open one',
      mentions(rowsOf(pointed.body), /archived channels/i),
      pointed.body.draft ? pointed.body.draft.name : String(pointed.body.answer).slice(0, 40));

    /* ---- nothing attached: naming one beats the open one ---- */
    const byName = await ask('write test scenarios for Dropbox - Content Sprawl Scope', {
      extra: { currentProduct: 'content', currentDocument: openId },
    });
    record('naming one beats whichever is open',
      mentions(rowsOf(byName.body), /anyone-with-the-link/i)
        && !mentions(rowsOf(byName.body), /archived channels/i),
      byName.body.draft ? byName.body.draft.name : 'no draft');
  } catch (err) {
    record('threw', false, err.message);
  }

  console.log('\n--- the write-up you attached is the source ---');
  checks.forEach((c) => console.log((c.ok ? '  PASS  ' : '  FAIL  ') + c.n.padEnd(50) + ' ' + (c.d || '')));
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n${failed} FAILED` : '\nall checks passed');
  if (failed) console.log('\nserver log:\n' + log.slice(-900));

  server.kill();
  process.exit(failed ? 1 : 0);
})();
