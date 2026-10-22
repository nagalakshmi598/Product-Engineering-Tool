'use strict';

/**
 * Asked to keep a write-up, it keeps the write-up.
 *
 * "Upload this document in content", said while standing on the Message page,
 * filed it under Message and then wrote nine test scenarios off it and saved
 * those under Message too. Two things were wrong at once: the product that
 * was said lost to the product that was on screen, and an instruction to file
 * something was read as a feature being described.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT = path.resolve(__dirname, '..');
const HERE = path.join(os.tmpdir(), 'cftool-tests', path.basename(__filename, '.js'));
fs.mkdirSync(HERE, { recursive: true });
const PORT = 4451;
const BASE = `http://127.0.0.1:${PORT}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const checks = [];
const record = (n, ok, d) => checks.push({ n, ok, d });

const WRITE_UP = [
  '# Confluence to SharePoint Migration Walkthrough', '',
  'This write-up specifies how a Confluence space is migrated to SharePoint.',
  'Page trees are recreated as document libraries with their folder structure.',
  'Attachments larger than 250 MB are reported and skipped.',
].join('\n');

async function send(question, { attach, extra = {} } = {}) {
  const fd = new FormData();
  fd.append('question', question);
  fd.append('history', '[]');
  Object.entries(extra).forEach(([k, v]) => fd.append(k, v));
  if (attach) {
    fd.append('files', new Blob([attach.text], { type: 'text/markdown' }), `${attach.name}.docx.md`);
  }
  const res = await fetch(`${BASE}/api/assistant`, { method: 'POST', body: fd });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const docs = async () => (await (await fetch(`${BASE}/api/documents`)).json()).documents;

async function setsIn(product) {
  const r = await (await fetch(`${BASE}/api/products/${product}/enhancements`)).json();
  return r.enhancements || [];
}

(async () => {
  fs.rmSync(path.join(HERE, 'data'), { recursive: true, force: true });
  fs.rmSync(path.join(HERE, 'uploads'), { recursive: true, force: true });

  const env = {
    ...process.env,
    CF_DATA_DIR: path.join(HERE, 'data'),
    CF_UPLOAD_DIR: path.join(HERE, 'uploads'),
    PORT: String(PORT),
    OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '',   // filing must need no model at all
  };

  const server = spawn(process.execPath, ['server/index.js'], { cwd: PROJECT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', (c) => { log += c; });
  server.stderr.on('data', (c) => { log += c; });

  let up = false;
  for (let i = 0; i < 90; i += 1) {
    try { if ((await fetch(`${BASE}/api/products`)).ok) { up = true; break; } } catch (_) {}
    await wait(500);
  }
  if (!up) { console.error('never came up:\n' + log); server.kill(); process.exit(1); }

  try {
    /* ---- the message, said from the Message page ---- */
    const sent = await send('upload this document in content', {
      attach: { name: 'Confluence-to-SharePoint-Migration-Walkthrough', text: WRITE_UP },
      extra: { currentProduct: 'message' },
    });

    record('it is answered without a model', sent.status === 200,
      sent.body.error || `${sent.body.provider}`);

    const filed = (sent.body.documents || [])[0];
    record('the write-up is filed', Boolean(filed), filed ? filed.name : 'nothing filed');
    record('under the product that was said',
      filed && filed.product === 'content',
      filed ? `filed under ${filed.product || '(none)'}` : '');
    record('not the product that was on screen',
      !filed || filed.product !== 'message',
      filed && filed.product === 'message' ? 'went to Message' : 'Message was not used');
    record('and it says where it went',
      /filed under Content/i.test(String(sent.body.answer)),
      String(sent.body.answer).split('\n')[0]);

    record('no scenarios were written', !sent.body.draft && !sent.body.drafts,
      sent.body.draft ? `drafted ${sent.body.draft.scenarios.length} anyway` : 'none drafted');
    record('and no set was created anywhere',
      (await setsIn('message')).length === 0 && (await setsIn('content')).length === 0,
      `${(await setsIn('message')).length} in Message, ${(await setsIn('content')).length} in Content`);
    record('it offers to write them', /write test scenarios/i.test(String(sent.body.answer)), '');

    /* ---- the other ways of saying where ---- */
    const places = [
      ['file this under Email', 'email'],
      ['put this one in data sprawl', 'datasprawl'],
      ['save this in the DIY product', 'diy'],
      ['upload this document', 'message'],          // nothing said; the page decides
    ];

    for (const [said, product] of places) {
      const out = await send(said, {
        attach: { name: `Spec for ${product}`, text: WRITE_UP },
        extra: { currentProduct: 'message' },
      });
      const got = (out.body.documents || [])[0];
      record(`"${said}"`, got && got.product === product,
        got ? `filed under ${got.product || '(none)'}` : 'nothing filed');
    }

    record('everything asked for is on the shelf', (await docs()).length === 5,
      `${(await docs()).length} write-ups`);

    /* ---- asking for both still does both ---- */
    const both = await send('upload this document in content and write test scenarios for it', {
      attach: { name: 'Spec with scenarios', text: WRITE_UP },
      extra: { currentProduct: 'message' },
    });
    record('asking for both is not read as filing only',
      !/is filed under .*\.\n\nSay the word/.test(String(both.body.answer)),
      String(both.body.answer).slice(0, 56));
  } catch (err) {
    record('threw', false, err.message);
  }

  console.log('\n--- asked to keep it, it keeps it ---');
  const width = Math.max(...checks.map((c) => c.n.length));
  checks.forEach((c) => console.log((c.ok ? '  PASS  ' : '  FAIL  ') + c.n.padEnd(width) + '  ' + (c.d || '')));
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n${failed} FAILED` : '\nall checks passed');
  if (failed) console.log('\nserver log:\n' + log.slice(-900));

  server.kill();
  process.exit(failed ? 1 : 0);
})();
