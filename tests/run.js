'use strict';

/**
 * Everything this tool is supposed to do, checked in one go.
 *
 * Run it with `npm test` before committing anything. Each suite starts the
 * tool on a port of its own, against an empty data folder in the system temp
 * directory, so none of this touches the enhancements, scenarios or write-ups
 * on the machine it runs on.
 *
 * The suites exist because each of these was got wrong once. A new change
 * that breaks one of them is a regression, and the point of running this is
 * to find that out here rather than in the chat panel a day later.
 */

const { spawn } = require('child_process');
const path = require('path');

const SUITES = [
  ['commands', 'commandtest.js', 'an instruction means the same thing every time'],
  ['typos', 'typotest.js', 'typed in a hurry, still understood'],
  ['documents', 'deltest.js', 'say document and a document goes'],
  ['pointing', 'pointtest.js', '"this one", said while pointing at a screenshot'],
  ['filing', 'filetest.js', 'asked to keep a write-up, it keeps the write-up'],
  ['source', 'sourcetest.js', 'the write-up you attached is what it drafts from'],
  ['contents', 'insidetest.js', 'scenarios for what the write-up says'],
  ['per write-up', 'persetest.js', 'a set each, when a set each is asked for'],
  ['agent', 'agenttest.js', 'everything the tool does, asked for in the chat'],
  ['recordings', 'guidetest.js', 'a recording, written up as a guide'],
  ['chat ui', 'toolstest.js', 'copy and edit, under a message'],
];

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const quiet = process.argv.includes('--quiet');

function runOne(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, file)], {
      cwd: path.resolve(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

(async () => {
  const wanted = only.length
    ? SUITES.filter(([name, file]) => only.some((a) => name.includes(a) || file.includes(a)))
    : SUITES;

  if (!wanted.length) {
    console.error(`Nothing matches "${only.join(' ')}". Suites: ${SUITES.map((s) => s[0]).join(', ')}`);
    process.exit(1);
  }

  console.log(`Running ${wanted.length} ${wanted.length === 1 ? 'suite' : 'suites'}.\n`);

  const results = [];
  const started = Date.now();

  for (const [name, file, what] of wanted) {
    process.stdout.write(`  ${name.padEnd(14)} ${what} … `);
    // one at a time: each starts a server, and they would fight over Chrome
    // eslint-disable-next-line no-await-in-loop
    const { code, out } = await runOne(file);

    const counted = (out.match(/^ {2}PASS/gm) || []).length;
    const broke = (out.match(/^ {2}FAIL/gm) || []).length;
    const skipped = /skipped/.test(out) && !counted;

    if (skipped) console.log('skipped');
    else if (code === 0) console.log(`${counted} ok`);
    else console.log(`${broke || '?'} FAILED`);

    results.push({ name, file, code, out, counted, broke, skipped });
    if (code !== 0 && !quiet) console.log(out.split('\n').filter((l) => /FAIL|FAILED|Error/.test(l)).join('\n'));
  }

  const failed = results.filter((r) => r.code !== 0 && !r.skipped);
  const checks = results.reduce((n, r) => n + r.counted, 0);
  const seconds = Math.round((Date.now() - started) / 1000);

  console.log('');
  if (!failed.length) {
    console.log(`${checks} checks passed in ${seconds}s. Nothing was broken.`);
    process.exit(0);
  }

  console.log(`${failed.length} of ${results.length} suites failed — ${checks} checks passed.\n`);
  failed.forEach((r) => {
    console.log(`=== ${r.name} (${r.file}) ===`);
    console.log(r.out.trim());
    console.log('');
  });

  process.exit(1);
})();
