'use strict';
/* Four write-ups named in one message, and "separately" after them, means
   four sets — not one set of twelve. */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT = path.resolve(__dirname, '..');
const STUBS = path.join(__dirname, 'stubs');
const HERE = path.join(os.tmpdir(), 'cftool-tests', path.basename(__filename, '.js'));
fs.mkdirSync(HERE, { recursive: true });
const PORT = 4433;
const BASE = `http://127.0.0.1:${PORT}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const checks = [];
const record = (n, ok, d) => checks.push({ n, ok, d });

const WRITE_UPS = [
  'Egnyte - Content Sprawl Scope',
  'Google Gmail - Email Sprawl Scope',
  'Slack Message Sprawl-Limitation',
  'Slack Message Sprawl-InScope',
  'Box for Business - Content Sprawl Scope',
];

const body = (name) => [
  `# ${name}`,
  '',
  `This write-up specifies how ${name} is scanned and reported.`,
  'The scan counts every folder and file in the tenant and reports the total.',
  'Items shared with anyone-with-the-link are listed with their owner and age.',
  'Stale items are those untouched for 180 days; duplicates are matched by hash.',
  'A scan started without admin consent is refused with "Permissions required".',
  'The report can be exported as CSV. Counts above 100,000 items are paged.',
].join('\n');

async function upload(name) {
  const fd = new FormData();
  fd.append('name', name);
  fd.append('product', 'datasprawl');
  fd.append('file', new Blob([body(name)], { type: 'text/markdown' }), `${name}.md`);
  const res = await fetch(`${BASE}/api/documents`, { method: 'POST', body: fd });
  return res.json();
}

async function ask(question) {
  const fd = new FormData();
  fd.append('question', question);
  fd.append('history', '[]');
  fd.append('currentProduct', 'datasprawl');
  const res = await fetch(`${BASE}/api/assistant`, { method: 'POST', body: fd });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

(async () => {
  fs.rmSync(path.join(HERE, 'psdata'), { recursive: true, force: true });
  fs.rmSync(path.join(HERE, 'psuploads'), { recursive: true, force: true });

  const env = {
    ...process.env,
    CF_DATA_DIR: path.join(HERE, 'psdata'),
    CF_UPLOAD_DIR: path.join(HERE, 'psuploads'),
    PORT: String(PORT),
    AI_PROVIDER: 'openai',
    OPENAI_API_KEY: 'sk-test-not-a-real-key',
    NODE_OPTIONS: `--require "${path.join(STUBS, 'stubdraft.js').split(path.sep).join('/')}"`,
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
    for (const name of WRITE_UPS) await upload(name);
    const { documents } = await (await fetch(`${BASE}/api/documents`)).json();
    record('the write-ups are on the shelf', documents.length === 5, `${documents.length} filed`);

    /* ---- the message that came back as one set ---- */
    const said = 'write test scenarios for data sprawl for this all Egnyte - Content Sprawl Scope,'
      + 'Google Gmail - Email Sprawl Scope,Slack Message Sprawl-Limitation,Slack Message Sprawl-InScope '
      + 'for all these write test scenarios seperate separtely';

    const out = await ask(said);
    record('the request is answered', out.status === 200, out.body.error || '');

    const drafts = out.body.drafts || [];
    record('one set per write-up, not one set', drafts.length === 4,
      drafts.length ? `${drafts.length} sets` : (out.body.draft ? 'came back as ONE set' : 'no drafts at all'));

    const names = drafts.map((d) => d.name);
    record('each set carries its write-up\'s name',
      WRITE_UPS.slice(0, 4).every((n) => names.includes(n)), names.join(' | '));

    record('the write-up nobody named is left out',
      !names.includes('Box for Business - Content Sprawl Scope'),
      names.includes('Box for Business - Content Sprawl Scope') ? 'Box crept in' : 'Box left out');

    record('no set holds another\'s scenarios',
      drafts.every((d) => d.scenarios.every((s) => s.scenario.includes(d.name))),
      `${drafts.reduce((n, d) => n + d.scenarios.length, 0)} scenarios in all`);

    record('each lands under the right product',
      drafts.every((d) => d.product === 'datasprawl'), drafts.map((d) => d.product).join(','));

    record('the reply names them and their counts',
      WRITE_UPS.slice(0, 4).every((n) => String(out.body.answer).includes(n)),
      String(out.body.answer).split('\n')[0]);

    /* ---- "separately" alone, no names ---- */
    const apart = await ask('for all the data sprawl documents write test scenarios separately');
    record('"separately" alone still splits them', (apart.body.drafts || []).length >= 4,
      `${(apart.body.drafts || []).length} sets`);

    /* ---- one write-up named is still one set ---- */
    const one = await ask('write test scenarios for Egnyte - Content Sprawl Scope');
    record('naming one write-up gives one set',
      Boolean(one.body.draft) && !(one.body.drafts || []).length,
      one.body.draft ? `one set: ${one.body.draft.name}` : `${(one.body.drafts || []).length} sets`);

    record('and names it after that write-up',
      Boolean(one.body.draft) && one.body.draft.name === 'Egnyte - Content Sprawl Scope',
      one.body.draft ? one.body.draft.name : 'no draft');

    /* ---- asked for them together, they stay together ---- */
    const together = await ask(
      'write test scenarios for Egnyte - Content Sprawl Scope and Slack Message Sprawl-InScope in one set'
    );
    record('asked for one set, they stay in one',
      Boolean(together.body.draft) && !(together.body.drafts || []).length,
      together.body.draft ? 'one set' : `${(together.body.drafts || []).length} sets`);
  } catch (err) {
    record('threw', false, err.message);
  }

  console.log('\n--- a set each, when a set each is asked for ---');
  checks.forEach((c) => console.log((c.ok ? '  PASS  ' : '  FAIL  ') + c.n.padEnd(40) + ' ' + (c.d || '')));
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n${failed} FAILED` : '\nall checks passed');
  if (failed) console.log('\nserver log:\n' + log.slice(-900));

  server.kill();
  process.exit(failed ? 1 : 0);
})();
