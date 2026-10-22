'use strict';
/* "Delete this document", said while pointing at a screenshot of one. */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ffmpeg = require('ffmpeg-static');

const PROJECT = path.resolve(__dirname, '..');
const STUBS = path.join(__dirname, 'stubs');
const HERE = path.join(os.tmpdir(), 'cftool-tests', path.basename(__filename, '.js'));
fs.mkdirSync(HERE, { recursive: true });
const PORT = 4437;
const BASE = `http://127.0.0.1:${PORT}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const checks = [];
const record = (n, ok, d) => checks.push({ n, ok, d });

const PRODUCT_DOCS = [
  'Google Workspace - Content Sprawl Scope',
  'OneDrive - Content Sprawl Scope',
  'Box for Business - Content Sprawl Scope',
  'Dropbox - Content Sprawl Scope',
  'Egnyte - Content Sprawl Scope',
  'Google Gmail - Email Sprawl Scope',
  'Microsoft Outlook - Email Sprawl Scope',
  'Slack Message Sprawl-Limitation',
  'Slack Message Sprawl-InScope',
];
const OTHER_DOCS = ['Outlook_Shared_Mailboxes_to_Google_Groups_Migration', 'DIY Email Migration Guide'];

const body = (name) => [
  `# ${name}`, '',
  `This write-up specifies how ${name} is scanned and reported, in detail.`,
  'The scan counts every folder and file in the tenant and reports the total.',
  'Stale items are those untouched for 180 days; duplicates are matched by hash.',
].join('\n');

function makeScreenshot(file) {
  execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=white:s=900x520:d=1',
    '-frames:v', '1', file,
  ]);
  return fs.readFileSync(file);
}

async function upload(name, product) {
  const fd = new FormData();
  fd.append('name', name);
  fd.append('product', product);
  fd.append('file', new Blob([body(name)], { type: 'text/markdown' }), `${name}.md`);
  return (await fetch(`${BASE}/api/documents`, { method: 'POST', body: fd })).json();
}

async function ask(question, { product, shot } = {}) {
  const fd = new FormData();
  fd.append('question', question);
  fd.append('history', '[]');
  if (product) fd.append('currentProduct', product);
  if (shot) fd.append('files', new Blob([shot], { type: 'image/png' }), 'image.png');
  const res = await fetch(`${BASE}/api/assistant`, { method: 'POST', body: fd });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const docs = async () => (await (await fetch(`${BASE}/api/documents`)).json()).documents;

(async () => {
  fs.rmSync(path.join(HERE, 'pdata'), { recursive: true, force: true });
  fs.rmSync(path.join(HERE, 'puploads'), { recursive: true, force: true });

  const shot = makeScreenshot(path.join(HERE, 'marked.png'));
  record('a screenshot was made', shot.subarray(0, 4).toString('hex') === '89504e47', `${shot.length} bytes, PNG`);

  const env = {
    ...process.env,
    CF_DATA_DIR: path.join(HERE, 'pdata'),
    CF_UPLOAD_DIR: path.join(HERE, 'puploads'),
    PORT: String(PORT),
    AI_PROVIDER: 'openai',
    OPENAI_API_KEY: 'sk-test-not-a-real-key',
    NODE_OPTIONS: `--require "${path.join(STUBS, 'stubpoint.js').split(path.sep).join('/')}"`,
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
    for (const name of PRODUCT_DOCS) await upload(name, 'datasprawl');
    for (const name of OTHER_DOCS) await upload(name, 'email');
    record('fifteen-ish write-ups, nine in the tab', (await docs()).length === 11, `${(await docs()).length} filed`);

    /* ---- the ask from the screenshot ---- */
    const said = await ask('delete this document in data sprawl not scenarios',
      { product: 'datasprawl', shot });

    record('the screenshot is read', Boolean(said.body.target),
      said.body.target ? said.body.target.name : String(said.body.answer).slice(0, 48));
    record('it picks the one that was marked',
      said.body.target && said.body.target.name === 'Dropbox - Content Sprawl Scope',
      said.body.target ? said.body.target.name : 'nothing');
    record('and says why, so it can be checked',
      /From the screenshot — boxed in red/.test(String(said.body.answer)),
      String(said.body.answer).split('\n')[0]);
    record('it still asks before deleting',
      said.body.command && said.body.command.confirm === true, '');

    /* ---- nothing marked: it asks, and asks about the right nine ---- */
    const blind = await ask('delete this document', { product: 'datasprawl' });
    const offered = (blind.body.choices || []).map((c) => c.name);

    record('with no screenshot it asks which', /Which write-up/i.test(String(blind.body.answer)),
      String(blind.body.answer).slice(0, 40));
    record('and offers the tab\'s write-ups, all of them',
      PRODUCT_DOCS.every((n) => offered.includes(n)), `${offered.length} offered`);
    record('not another product\'s',
      !offered.some((n) => OTHER_DOCS.includes(n)),
      offered.some((n) => OTHER_DOCS.includes(n)) ? 'other products crept in' : 'none from elsewhere');
    record('each marked as a write-up', offered.length > 0 && blind.body.choices.every((c) => c.kind === 'document'), '');

    /* ---- the build stamp, so the page knows it is behind ---- */
    const res = await fetch(`${BASE}/api/products`);
    record('every reply says which build served it',
      /^[0-9a-f]{12}$/.test(res.headers.get('X-Tool-Build') || ''),
      res.headers.get('X-Tool-Build') || 'no header');
  } catch (err) {
    record('threw', false, err.message);
  }

  console.log('\n--- "this one", said while pointing ---');
  checks.forEach((c) => console.log((c.ok ? '  PASS  ' : '  FAIL  ') + c.n.padEnd(40) + ' ' + (c.d || '')));
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n${failed} FAILED` : '\nall checks passed');
  if (failed) console.log('\nserver log:\n' + log.slice(-900));

  server.kill();
  process.exit(failed ? 1 : 0);
})();
