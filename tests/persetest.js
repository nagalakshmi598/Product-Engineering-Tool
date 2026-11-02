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

/** The same ask, with the write-ups handed over rather than named. */
async function attach(question, names) {
  const fd = new FormData();
  fd.append('question', question);
  fd.append('history', '[]');
  fd.append('currentProduct', 'datasprawl');
  names.forEach((name) => {
    fd.append('files', new Blob([body(name)], { type: 'text/markdown' }), `${name}.md`);
  });
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

    /* ---- handed over rather than named ----
       In-Scope and Out-of-Scope attached to one message: both were filed and
       only one was drafted from, with nothing saying the other was dropped. */
    const PAIR = ['Mail_Gmail-to-Gmail_In-Scope', 'Mail_Gmail-to-Gmail_Out-of-Scope'];
    const two = await attach('write test scenarios for these documents', PAIR);

    record('two write-ups attached make two sets', (two.body.drafts || []).length === 2,
      two.body.drafts ? `${two.body.drafts.length} sets`
        : (two.body.draft ? `ONE set: ${two.body.draft.name}` : 'no drafts at all'));
    record('both of them were filed', (two.body.documents || []).length === 2,
      `${(two.body.documents || []).length} filed`);
    record('each set is named after its own write-up',
      PAIR.every((n) => (two.body.drafts || []).some((d) => d.name === n)),
      (two.body.drafts || []).map((d) => d.name).join(' | '));
    record('and carries only its own scenarios',
      (two.body.drafts || []).length === 2
        && two.body.drafts.every((d) => d.scenarios.length
          && d.scenarios.every((s) => s.scenario.includes(d.name))),
      (two.body.drafts || []).map((d) => d.scenarios.length).join(' + '));
    record('the reply names both and their counts',
      PAIR.every((n) => String(two.body.answer).includes(n)),
      String(two.body.answer).split('\n')[0]);

    /* ---- more than two, because two is not the number ---- */
    const THREE = ['Box Sprawl - InScope', 'Box Sprawl - Out of Scope', 'Box Sprawl - Limitations'];
    const three = await attach('for all these documents write test scenarios', THREE);
    record('three attached make three sets', (three.body.drafts || []).length === 3,
      `${(three.body.drafts || []).length} sets`);
    record('each under the product it was filed in',
      (three.body.drafts || []).every((d) => d.product === 'datasprawl'),
      (three.body.drafts || []).map((d) => d.product).join(','));

    /* ---- what must not have changed ---- */
    const oneFile = await attach('write test scenarios for this document', ['Dropbox Sprawl - InScope']);
    record('one write-up attached is still one set',
      Boolean(oneFile.body.draft) && !(oneFile.body.drafts || []).length,
      oneFile.body.draft ? `one set: ${oneFile.body.draft.name}` : `${(oneFile.body.drafts || []).length} sets`);
    record('and it is named after the write-up, not the file',
      Boolean(oneFile.body.draft) && oneFile.body.draft.name === 'Dropbox Sprawl - InScope',
      oneFile.body.draft ? oneFile.body.draft.name : '');

    const asOne = await attach('write test scenarios for these documents in one set',
      ['OneDrive Sprawl - InScope', 'OneDrive Sprawl - Out of Scope']);
    record('asked for them in one set, attached, they stay in one',
      !(asOne.body.drafts || []).length,
      (asOne.body.drafts || []).length ? `${asOne.body.drafts.length} sets` : 'one set');

    const justFile = await attach('keep these documents', ['Egnyte Sprawl - Limitations']);
    record('attaching without asking for scenarios still only files',
      !justFile.body.draft && !(justFile.body.drafts || []).length
        && (justFile.body.documents || []).length === 1,
      justFile.body.draft ? 'drafted anyway' : 'filed and stopped');
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
