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

  /* ---- the whole recording is looked at, not the front of it ----
     Twelve screens over twenty-four seconds, and only four wanted. Stopping
     ffmpeg at the fourth stops it six seconds in, which on a real migration
     is a guide that ends before the migration starts; the four have to be
     spread across the recording instead. */
  const { framesFrom } = require('../server/video');
  const few = await framesFrom(clip, 'clip.mp4', { max: 4 });
  const last = few.frames.length ? few.frames[few.frames.length - 1].at : 0;

  record('only as many screens as were asked for', few.frames.length === 4,
    `${few.frames.length} screens`);
  record('the first of them is the opening screen', few.frames[0] && few.frames[0].at <= 1,
    few.frames[0] ? `at ${few.frames[0].at}s` : '');
  record('and the last is near the end of the recording', last >= 18,
    `last screen at ${last}s of 24`);
  record('spread across it rather than taken off the front',
    few.frames.every((f, i) => i === 0 || f.at > few.frames[i - 1].at)
      && new Set(few.frames.map((f) => f.at)).size === few.frames.length,
    few.frames.map((f) => `${f.at}s`).join(' '));

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

    /* ---- the shape the house guides are written in ---- */
    record('a page that reports is a section, not a step',
      /<h3>Migration Progress 1<\/h3>/.test(html), '');
    record('and takes no step number',
      !/<h3>Step \d+: Migration Progress/.test(html), '');
    record('the numbering skips it and runs straight',
      ['Step 1:', 'Step 2:', 'Step 3:', 'Step 4:'].every((n) => html.includes(`<h3>${n} `))
        && !html.includes('<h3>Step 0:'),
      (html.match(/<h3>Step \d+:/g) || []).join(' '));

    /* ---- every screen is kept, because that is the point of it ---- */
    record('every screen of the recording is in the guide',
      guide.screenshots >= guide.screens,
      `${guide.screenshots} screenshots for ${guide.screens} screens`);
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

    /* ---- the guide is readable where it was asked for ----
       Including its screenshots: they are the use of a walkthrough, and
       having to open the Documents page to see whether any were taken is
       the thing being fixed. */
    const page = made.body.writeUp;
    record('the guide comes back with the reply', Boolean(page && page.title), page ? page.title : 'nothing to render');
    record('a section per step, in the order written',
      Boolean(page) && page.sections.length === guide.steps
        && /^Step 1: /.test(page.sections[0].heading),
      page ? `${page.sections.length} sections, first "${page.sections[0].heading}"` : '');
    record('each carrying the screens it was taken from',
      Boolean(page) && page.sections.some((s) => (s.images || []).length)
        && page.sections.reduce((n, s) => n + (s.images || []).length, 0) === guide.screenshots,
      page ? `${page.sections.reduce((n, s) => n + (s.images || []).length, 0)} screenshots` : '');
    record('addressed where the page serves them',
      Boolean(page) && page.sections.every((s) => (s.images || [])
        .every((src) => src.startsWith(`/api/documents/${id}/assets/image-`))),
      page ? ((page.sections.find((s) => (s.images || []).length) || {}).images || [''])[0] : '');

    /* ---- asked for in the words people use when there is no video ----
       "Write this up" means the recording when a recording came with it. */
    const asWriteUp = await send('write this up', clip);
    record('"write this up" with a recording writes the recording up',
      Boolean(asWriteUp.body.guide && asWriteUp.body.document),
      asWriteUp.body.guide ? `${asWriteUp.body.guide.steps} steps` : String(asWriteUp.body.answer).slice(0, 50));

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
