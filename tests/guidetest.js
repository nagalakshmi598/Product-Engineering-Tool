'use strict';
/* A recording goes in; the guide comes out, in the shape of the PDF. */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ffmpeg = require('ffmpeg-static');

const PROJECT = path.resolve(__dirname, '..');
const STUBS = path.join(__dirname, 'stubs');
const HERE = path.join(os.tmpdir(), 'cftool-tests', path.basename(__filename, '.js'));
fs.mkdirSync(HERE, { recursive: true });
const PORT = 4431;
const BASE = `http://127.0.0.1:${PORT}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const checks = [];
const record = (n, ok, d) => checks.push({ n, ok, d });

/** Four solid screens, two seconds each: four scene changes to find. */
function makeRecording(file) {
  const colours = ['red', 'blue', 'green', 'yellow', 'white', 'black', 'cyan', 'magenta', 'gray', 'orange', 'purple', 'brown'];
  const inputs = colours.flatMap((c) => ['-f', 'lavfi', '-i', `color=${c}:s=640x360:d=2`]);
  execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    ...inputs,
    '-filter_complex', `${colours.map((_, i) => `[${i}:v]`).join('')}concat=n=${colours.length}:v=1[v]`,
    '-map', '[v]', '-r', '10', '-pix_fmt', 'yuv420p',
    file,
  ]);
  return fs.readFileSync(file);
}

async function send(question, video, name = 'migration.mp4') {
  const fd = new FormData();
  fd.append('question', question);
  fd.append('history', '[]');
  if (video) fd.append('files', new Blob([video], { type: 'video/mp4' }), name);
  const res = await fetch(`${BASE}/api/assistant`, { method: 'POST', body: fd });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

(async () => {
  fs.rmSync(path.join(HERE,'data'),{recursive:true,force:true});
  fs.rmSync(path.join(HERE,'uploads'),{recursive:true,force:true});
  const clip = makeRecording(path.join(HERE, 'clip.mp4'));
  record('a test recording was made', clip.length > 1000, `${Math.round(clip.length / 1024)} KB`);

  const env = {
    ...process.env,
    CF_DATA_DIR: path.join(HERE, 'data'),
    CF_UPLOAD_DIR: path.join(HERE, 'uploads'),
    PORT: String(PORT),
    AI_PROVIDER: 'openai',
    OPENAI_API_KEY: 'sk-test-not-a-real-key',
    // NODE_OPTIONS eats backslashes, so the preload path goes in with slashes
    NODE_OPTIONS: `--require "${path.join(STUBS, 'stubmodel.js').split(path.sep).join('/')}"`,
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
    /* ---- the ask the user actually makes ---- */
    const made = await send('see entire video and make document in that format with screenshots', clip);

    record('the request is answered', made.status === 200, made.body.error || '');
    record('a guide came back', Boolean(made.body.guide && made.body.document),
      made.body.answer ? String(made.body.answer).slice(0, 70) : JSON.stringify(made.body).slice(0, 70));

    const guide = made.body.guide || {};
    record('every screen was read', guide.screens >= 10, `${guide.screens} screens from the recording`);
    record('read in batches, each carrying on', guide.steps >= 4, `${guide.steps} steps across ${Math.ceil(guide.screens / 8)} batches`);
    record('the steps carry screenshots', guide.screenshots >= guide.steps,
      `${guide.screenshots} screenshots`);

    const id = made.body.document && made.body.document.id;
    const doc = id ? (await (await fetch(`${BASE}/api/documents/${id}`)).json()).document : null;
    const html = (doc && doc.html) || '';

    record('it is filed as a write-up', Boolean(doc), doc ? doc.name : 'no document');
    record('it is named for the journey', /Migration Guide/i.test((doc && doc.name) || ''), (doc && doc.name) || '');
    record('it opens with a title', /<h1>.*Migration Guide/i.test(html), '');
    record('and a sentence saying what it covers', /<p>This guide covers/.test(html), '');
    record('the steps are numbered as in the PDF',
      /<h3>Step 1: /.test(html) && /<h3>Step 2: /.test(html), '');
    record('what you click is in bold', /<strong>Sign In<\/strong>/.test(html),
      (/<strong>[^<]*<\/strong>/.exec(html) || [''])[0]);
    record('an arrow reads as an arrow', /→/.test(html), '');
    record('a screen of settings becomes a list', /<ul>\s*<li>/.test(html), '');
    record('each step shows its screen',
      (html.match(/<img src="\/api\/documents\/[^"]+\/assets\/image-\d+\.jpg"/g) || []).length >= 4,
      `${(html.match(/<img /g) || []).length} images`);
    record('a step spanning two screens keeps both',
      /image-2\.jpg/.test(html) && /image-3\.jpg/.test(html), '');
    record('a step with no words is left out', !/<h3>Step \d+: <\/h3>/.test(html), '');
    record('an invented frame number is ignored', !/image-999/.test(html), '');

    /* ---- the screenshots are actually served ---- */
    const first = /\/api\/documents\/[^"]+\/assets\/(image-1\.jpg)/.exec(html);
    if (first) {
      const shot = await fetch(`${BASE}/api/documents/${id}/assets/${first[1]}`);
      const bytes = Buffer.from(await shot.arrayBuffer());
      record('a screenshot is served', shot.ok && bytes.length > 500, `${bytes.length} bytes`);
      record('and it is a real picture', bytes.subarray(0, 3).toString('hex') === 'ffd8ff', 'JPEG');
    } else {
      record('a screenshot is served', false, 'no image in the guide');
    }

    /* ---- the recording is kept too ---- */
    const kept = (made.body.documents || []).find((d) => d.kind === 'video');
    record('the recording itself is kept', Boolean(kept), kept ? kept.name : 'not filed');

    /* ---- a video without that ask is not written up ---- */
    const other = await send('write test scenarios for what this video shows', clip);
    record('a video alone does not make a document', !other.body.guide,
      other.body.guide ? 'wrote one anyway' : 'answered in the chat instead');
  } catch (err) {
    record('threw', false, err.message);
  }

  console.log('\n--- a recording, written up as a guide ---');
  checks.forEach((c) => console.log((c.ok ? '  PASS  ' : '  FAIL  ') + c.n.padEnd(38) + ' ' + (c.d || '')));
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n${failed} FAILED` : '\nall checks passed');
  if (failed) console.log('\nserver log:\n' + log.slice(-1200));

  server.kill();
  process.exit(failed ? 1 : 0);
})();
