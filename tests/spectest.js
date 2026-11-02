'use strict';
/* Describe a functionality in the chat; the write-up of it is on the shelf.
 *
 * The bot writes the document itself and files it — no file is picked, no
 * upload is made, nobody opens Word. What matters as much is what this must
 * not do: asking for test scenarios must still draft scenarios, an attached
 * file must still be filed as a file, and an instruction must still be an
 * instruction. Those are checked here too, because this path sits in front
 * of all three. */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT = path.resolve(__dirname, '..');
const STUBS = path.join(__dirname, 'stubs');
const HERE = path.join(os.tmpdir(), 'cftool-tests', path.basename(__filename, '.js'));
fs.mkdirSync(HERE, { recursive: true });
const PORT = 4452;
const BASE = `http://127.0.0.1:${PORT}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const checks = [];
const record = (n, ok, d) => checks.push({ n, ok, d });

/* ---------------- what is read as a request for a write-up ---------------- */

const { wantsAWriteUp, whatToWriteAbout, describedIn, cleanTitle } = require('../server/specs');

const RETENTION = 'When a canvas has not been opened for 90 days it is marked expired '
  + 'and becomes read-only until someone restores it from the workspace settings.';

[
  ['create a document for this functionality: ' + RETENTION, true],
  ['write a document for the canvas retention window and upload it', true],
  ['prepare a write-up for group dm name migration', true],
  ['make a doc on how delta migration works', true],
  ['write this up', true],
  ['document this functionality', true],
  ['create a specification for the export feature', true],

  /* The ones it must keep its hands off. */
  ['write test scenarios for this document', false],
  ['write test scenarios for slack message sprawl inscope', false],
  ['draft scenarios for the export feature', false],
  ['generate test cases for scenario 4', false],
  ['what does the Egnyte write-up say about stale items?', false],
  ['how many documents are in the tool?', false],
].forEach(([said, want]) => {
  record(`${want ? 'wants a write-up' : 'leaves alone'}: "${said.slice(0, 44)}"`,
    wantsAWriteUp(said) === want, wantsAWriteUp(said) ? 'write-up' : 'not a write-up');
});

record('the asking is taken off the front',
  describedIn('create a document for this functionality: ' + RETENTION) === RETENTION,
  describedIn('create a document for this functionality: ' + RETENTION).slice(0, 40));

record('and "and upload it" off the back',
  describedIn(`write a document for this: ${RETENTION} and upload it to the tool`) === RETENTION,
  describedIn(`write a document for this: ${RETENTION} and upload it to the tool`).slice(-34));

record('a message that is only an ask has nothing in it',
  whatToWriteAbout('create a document and upload it', []) === '',
  JSON.stringify(whatToWriteAbout('create a document and upload it', [])).slice(0, 36));

record('said a message ago, it is still the subject',
  whatToWriteAbout('create a document and upload it',
    [{ role: 'user', content: RETENTION }, { role: 'assistant', content: 'Noted.' }]) === RETENTION,
  '');

record('an earlier ask is not mistaken for the description',
  whatToWriteAbout('create a document', [{ role: 'user', content: 'create a document for me please' }]) === '',
  '');

record('a title naming nobody is turned down', cleanTitle('The user uploads a document') === '', '');
record('a title naming the feature is kept',
  cleanTitle('Canvas Retention Window') === 'Canvas Retention Window', '');

/* ---------------- and the same through the tool ---------------- */

async function ask(question, extra = {}) {
  const fd = new FormData();
  fd.append('question', question);
  fd.append('history', JSON.stringify(extra.history || []));
  Object.entries(extra).forEach(([k, v]) => { if (k !== 'history') fd.append(k, v); });
  const res = await fetch(`${BASE}/api/assistant`, { method: 'POST', body: fd });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const docs = async () => (await (await fetch(`${BASE}/api/documents`)).json()).documents;

async function contentsOf(id) {
  const { document: doc } = await (await fetch(`${BASE}/api/documents/${id}`)).json();
  return String(doc.html || doc.text || '');
}

(async () => {
  fs.rmSync(path.join(HERE, 'sdata'), { recursive: true, force: true });
  fs.rmSync(path.join(HERE, 'suploads'), { recursive: true, force: true });

  const env = {
    ...process.env,
    CF_DATA_DIR: path.join(HERE, 'sdata'),
    CF_UPLOAD_DIR: path.join(HERE, 'suploads'),
    PORT: String(PORT),
    AI_PROVIDER: 'openai',
    OPENAI_API_KEY: 'sk-test-not-a-real-key',
    NODE_OPTIONS: `--require "${path.join(STUBS, 'stubspec.js').split(path.sep).join('/')}"`,
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
    /* ---- the thing asked for ---- */
    const made = await ask(`create a document for this functionality: ${RETENTION}`,
      { currentProduct: 'message' });

    record('a document comes back', Boolean(made.body.document),
      made.body.document ? made.body.document.name : String(made.body.answer).slice(0, 56));
    record('it is named after the feature',
      made.body.document && made.body.document.name === 'Canvas Retention Window',
      made.body.document ? made.body.document.name : '');
    record('it is on the shelf', (await docs()).some((d) => d.name === 'Canvas Retention Window'),
      `${(await docs()).length} write-ups`);
    record('filed under the page it was asked from',
      made.body.document && made.body.document.product === 'message',
      made.body.document ? made.body.document.product : '');
    record('nothing was uploaded to make it',
      !(made.body.documents || []).length && !(made.body.attachments || []).length, '');

    const html = await contentsOf(made.body.document.id);
    record('it says what was described', /Expired/.test(html) && /read-only/i.test(html),
      html.replace(/<[^>]+>/g, ' ').slice(0, 70));
    record('the on-screen label is set in bold', /<strong>Expired<\/strong>/.test(html), '');
    record('it is not a write-up about uploading documents',
      !/upload/i.test(html), /upload/i.test(html) ? 'wrote about uploading' : 'about the feature');
    record('it reads as a write-up, not as numbered steps',
      /<h3>/.test(html) && !/<h3>Step 1/.test(html), '');

    /* What the description did not settle is the half of the write-up that
       makes it honest — and a model told in prose to add it decides it was
       told enough, so it is asked for as a list of its own. */
    record('what was left open is asked at the end',
      /<h3>Open Points<\/h3>/.test(html) && /Who may restore one\?/.test(html),
      /Open Points/.test(html) ? 'asked' : 'nothing asked');
    record('the questions come after the behaviour, not before',
      html.indexOf('Open Points') > html.indexOf('read-only'), '');
    record('and the same question is not asked twice',
      (html.match(/restored after it has expired/g) || []).length === 1,
      `${(html.match(/restored after it has expired/g) || []).length} time(s)`);

    record('and it offers scenarios rather than writing them',
      !made.body.draft && !made.body.drafts && /test scenarios/i.test(String(made.body.answer)),
      made.body.draft ? 'drafted scenarios nobody asked for' : 'offered');

    /* ---- described first, asked for after ---- */
    const after = await ask('create document and upload it', {
      currentProduct: 'datasprawl',
      history: [
        { role: 'user', content: 'Clicking Export downloads the sprawl report as a CSV of every row shown.' },
        { role: 'assistant', content: 'Understood.' },
      ],
    });

    record('a description a message back is written up',
      Boolean(after.body.document) && after.body.document.name === 'Sprawl Report CSV Export',
      after.body.document ? after.body.document.name : String(after.body.answer).slice(0, 50));

    const second = after.body.document ? await contentsOf(after.body.document.id) : '';
    record('from what was said, not from "create document"',
      /CSV/.test(second) && !/upload/i.test(second), second.replace(/<[^>]+>/g, ' ').slice(0, 60));

    /* ---- the model wrote its own Open Points section ---- */
    const its_own = await ask('prepare a write-up for this functionality: Group DM names are migrated '
      + 'as Group DM names in the destination and the original name is preserved.',
    { currentProduct: 'message' });

    const dm = its_own.body.document ? await contentsOf(its_own.body.document.id) : '';
    record('a model that asked its own questions is left to it',
      (dm.match(/<h3>Open Points<\/h3>/g) || []).length === 1,
      `${(dm.match(/<h3>Open Points<\/h3>/g) || []).length} Open Points section(s)`);
    record('and its questions are the ones kept',
      /Which character limit applies/.test(dm), '');

    /* ---- nothing to write about ---- */
    const empty = await ask('create a document and upload it', { currentProduct: 'message' });
    const before = (await docs()).length;
    record('an ask with nothing in it asks back',
      !empty.body.document && /tell me the functionality/i.test(String(empty.body.answer)),
      String(empty.body.answer).slice(0, 46));
    record('and writes nothing', (await docs()).length === before, `${before} write-ups`);

    /* ---- what must not have changed ---- */
    const drafted = await ask('write test scenarios for exporting the sprawl report as CSV',
      { currentProduct: 'datasprawl' });
    record('asking for scenarios still drafts scenarios',
      Boolean(drafted.body.draft) && drafted.body.draft.scenarios.length > 0,
      drafted.body.draft ? `${drafted.body.draft.scenarios.length} scenarios` : String(drafted.body.answer).slice(0, 44));
    record('and writes no document for them',
      !drafted.body.document, drafted.body.document ? 'wrote a document' : 'no document');

    const instruction = await ask('delete the Canvas Retention Window document');
    record('an instruction is still an instruction',
      instruction.body.command && instruction.body.command.kind === 'delete-document',
      instruction.body.command ? instruction.body.command.kind : String(instruction.body.answer).slice(0, 40));

    /* An attached file is the document. Asking for one while handing one
       over is filing, which is what it was before this path existed. */
    const withFile = await (async () => {
      const fd = new FormData();
      fd.append('question', 'upload this document and write test scenarios');
      fd.append('history', '[]');
      fd.append('currentProduct', 'message');
      fd.append('files', new Blob([
        '# Slack Canvas Retention\n\nA canvas untouched for 90 days is marked expired.',
      ], { type: 'text/markdown' }), 'Slack Canvas Retention.md');
      const res = await fetch(`${BASE}/api/assistant`, { method: 'POST', body: fd });
      return res.json();
    })();

    record('a file attached is filed, not written up',
      (withFile.documents || []).length === 1 && !withFile.document,
      withFile.document ? 'wrote a second one' : `${(withFile.documents || []).length} filed`);
  } catch (err) {
    record('threw', false, err.message);
  }

  console.log('\n--- describe it, and it is written up ---');
  checks.forEach((c) => console.log((c.ok ? '  PASS  ' : '  FAIL  ') + c.n.padEnd(52) + ' ' + (c.d || '')));
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n${failed} FAILED` : '\nall checks passed');
  if (failed) console.log('\nserver log:\n' + log.slice(-900));

  server.kill();
  process.exit(failed ? 1 : 0);
})();
