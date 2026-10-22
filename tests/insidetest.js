'use strict';
/* "Write scenarios for this document" means what the document says, not what
   uploading one does. */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT = path.resolve(__dirname, '..');
const STUBS = path.join(__dirname, 'stubs');
const HERE = path.join(os.tmpdir(), 'cftool-tests', path.basename(__filename, '.js'));
fs.mkdirSync(HERE, { recursive: true });
const PORT = 4447;
const BASE = `http://127.0.0.1:${PORT}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const checks = [];
const record = (n, ok, d) => checks.push({ n, ok, d });

const SPEC = [
  '# Slack Message Sprawl- InScope', '',
  'This write-up specifies which Slack messages are in scope for the sprawl scan.',
  'Messages in archived channels older than 180 days are counted as stale.',
  'Direct messages are excluded unless the workspace owner opts in.',
  'A scan started without owner consent is refused with "Consent required".',
].join('\n');

const OTHER = [
  '# Dropbox - Content Sprawl Scope', '',
  'This write-up specifies how the Dropbox tenant is scanned for content sprawl.',
  'Every folder and file is counted, and the total is reported per team member.',
  'Items shared with anyone-with-the-link are listed with their owner and age.',
].join('\n');

async function upload(name, text) {
  const fd = new FormData();
  fd.append('name', name);
  fd.append('product', 'datasprawl');
  fd.append('file', new Blob([text], { type: 'text/markdown' }), `${name}.md`);
  return (await fetch(`${BASE}/api/documents`, { method: 'POST', body: fd })).json();
}

async function ask(question, extra = {}) {
  const fd = new FormData();
  fd.append('question', question);
  fd.append('history', '[]');
  Object.entries(extra).forEach(([k, v]) => fd.append(k, v));
  const res = await fetch(`${BASE}/api/assistant`, { method: 'POST', body: fd });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const aboutUploading = (rows) => rows.some((s) => /upload|Documents page|file type/i.test(s.scenario));
const aboutTheFeature = (rows) => rows.some((s) => /archived channels|direct messages|consent/i.test(s.scenario));

(async () => {
  fs.rmSync(path.join(HERE, 'idata'), { recursive: true, force: true });
  fs.rmSync(path.join(HERE, 'iuploads'), { recursive: true, force: true });

  const env = {
    ...process.env,
    CF_DATA_DIR: path.join(HERE, 'idata'),
    CF_UPLOAD_DIR: path.join(HERE, 'iuploads'),
    PORT: String(PORT),
    AI_PROVIDER: 'openai',
    OPENAI_API_KEY: 'sk-test-not-a-real-key',
    NODE_OPTIONS: `--require "${path.join(STUBS, 'stubfeature.js').split(path.sep).join('/')}"`,
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
    const made = await upload('Slack Message Sprawl- InScope', SPEC);
    await upload('Dropbox - Content Sprawl Scope', OTHER);
    const docId = made.document.id;

    /* ---- the ask, with that write-up open ---- */
    const pointed = await ask('write test scenarios for this document',
      { currentProduct: 'datasprawl', currentDocument: docId });

    const rows = (pointed.body.draft && pointed.body.draft.scenarios) || [];
    record('it drafts something', rows.length > 0,
      rows.length ? `${rows.length} scenarios` : String(pointed.body.answer).slice(0, 50));
    record('from what the write-up says', aboutTheFeature(rows),
      rows.length ? rows[0].scenario.slice(0, 62) : '');
    record('not about uploading a document', !aboutUploading(rows),
      aboutUploading(rows) ? 'wrote about the Documents page' : 'nothing about uploading');
    record('and the set takes the write-up\'s name',
      pointed.body.draft && pointed.body.draft.name === 'Slack Message Sprawl- InScope',
      pointed.body.draft ? pointed.body.draft.name : 'no draft');
    record('filed under the write-up\'s product',
      pointed.body.draft && pointed.body.draft.product === 'datasprawl',
      pointed.body.draft ? pointed.body.draft.product : '');
    record('the reply says where they came from',
      /from what "Slack Message Sprawl- InScope" specifies/.test(String(pointed.body.answer)),
      String(pointed.body.answer).split('\n')[0]);
    record('and the Section column is not the write-up\'s name',
      rows.every((s) => (s.section || '') !== 'Slack Message Sprawl- InScope'),
      rows[0] ? `section: ${rows[0].section || '(none)'}` : '');

    /* ---- the other ways of pointing at it ---- */
    for (const said of [
      'for that document inside data write test scenarios',
      'write scenarios from this write-up',
      'write test scenarios for the open document',
    ]) {
      const out = await ask(said, { currentProduct: 'datasprawl', currentDocument: docId });
      const got = (out.body.draft && out.body.draft.scenarios) || [];
      record(`"${said.slice(0, 44)}"`, aboutTheFeature(got) && !aboutUploading(got),
        got.length ? `${got.length} from the write-up` : String(out.body.answer).slice(0, 36));
    }

    /* ---- attached, with a sentence that would lead it astray ----
       "Upload this document in content and write test scenarios" produced
       scenarios about clicking Upload Document and picking a file off a
       device — the sentence won over the write-up it introduced. */
    const attached = await (async () => {
      const fd = new FormData();
      fd.append('question', 'upload this document in content and write test scenarios');
      fd.append('history', '[]');
      fd.append('currentProduct', 'message');
      // a name of its own: the same file again updates the one already filed
      fd.append('files', new Blob([SPEC], { type: 'text/markdown' }), 'Slack Sprawl Scope v2.md');
      const res = await fetch(`${BASE}/api/assistant`, { method: 'POST', body: fd });
      return res.json();
    })();

    const fromFile = (attached.draft && attached.draft.scenarios) || [];
    record('an attached write-up is what it drafts from',
      aboutTheFeature(fromFile),
      fromFile.length ? fromFile[0].scenario.slice(0, 58) : String(attached.answer).slice(0, 48));
    record('the sentence that carried it does not win',
      !aboutUploading(fromFile),
      aboutUploading(fromFile) ? 'wrote about uploading documents' : 'nothing about uploading');
    record('and it is filed where the sentence said',
      (attached.documents || [])[0] && attached.documents[0].product === 'content',
      (attached.documents || [])[0] ? attached.documents[0].product : 'nothing filed');

    /* ---- naming it works without anything open ---- */
    const byName = await ask('write test scenarios for Slack Message Sprawl- InScope',
      { currentProduct: 'datasprawl' });
    const named = (byName.body.draft && byName.body.draft.scenarios) || [];
    record('naming one write-up drafts from it', aboutTheFeature(named) && !aboutUploading(named),
      byName.body.draft ? byName.body.draft.name : String(byName.body.answer).slice(0, 40));

    /* ---- two write-ups still go to a set each ---- */
    const two = await ask(
      'write test scenarios for Slack Message Sprawl- InScope and Dropbox - Content Sprawl Scope separately',
      { currentProduct: 'datasprawl' }
    );
    record('two named still make a set each', (two.body.drafts || []).length === 2,
      `${(two.body.drafts || []).length} sets`);

    /* ---- a feature described in words still drafts from the words ---- */
    const plain = await ask('write test scenarios for exporting the sprawl report as CSV',
      { currentProduct: 'datasprawl' });
    record('describing a feature still works',
      Boolean(plain.body.draft) && plain.body.draft.scenarios.length > 0,
      plain.body.draft ? `${plain.body.draft.scenarios.length} scenarios` : 'nothing drafted');
  } catch (err) {
    record('threw', false, err.message);
  }

  console.log('\n--- scenarios for what the write-up says ---');
  checks.forEach((c) => console.log((c.ok ? '  PASS  ' : '  FAIL  ') + c.n.padEnd(48) + ' ' + (c.d || '')));
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n${failed} FAILED` : '\nall checks passed');
  if (failed) console.log('\nserver log:\n' + log.slice(-900));

  server.kill();
  process.exit(failed ? 1 : 0);
})();
