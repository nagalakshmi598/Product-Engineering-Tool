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

/* ---------------- a number of scenarios, read off the sentence ---------------- */

const { howManyAsked } = require('../server/assistant');

[
  ['write test scenarios for this document inscopes write upto 50+ scenarios '
    + 'both positive,negative and edge cases', 50],
  ['write 50 scenarios', 50],
  ['write at least 30 test scenarios for this', 30],
  ['give me 60 test cases', 60],
  ['minimum of 25 scenarios please', 25],
  ['write around 40 detailed scenarios', 40],

  /* A number that is not a count of what to write. */
  ['write test scenarios for this document', 0],
  ['generate test cases for scenario 4', 0],
  ['attachments up to 25 MB are migrated with the email', 0],
  ['write test scenarios for Mail_Gmail-to-Gmail_(02-11-2026)_In-Scope', 0],
  ['write 2 scenarios', 0],
  ['write 5000 scenarios', 0],
].forEach(([said, want]) => {
  record(`${want ? `${want} asked for` : 'no count'}: "${said.slice(0, 40)}"`,
    howManyAsked(said) === want, String(howManyAsked(said)));
});

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

async function ask(question, openSet) {
  const fd = new FormData();
  fd.append('question', question);
  fd.append('history', '[]');
  fd.append('currentProduct', 'datasprawl');
  if (openSet) fd.append('currentEnhancement', openSet);
  const res = await fetch(`${BASE}/api/assistant`, { method: 'POST', body: fd });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/** The same ask, with the write-ups handed over rather than named. */
async function attach(question, names, openSet) {
  const fd = new FormData();
  fd.append('question', question);
  fd.append('history', '[]');
  fd.append('currentProduct', 'datasprawl');
  if (openSet) fd.append('currentEnhancement', openSet);
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
    /* Scenarios were asked for, so scenarios are what happens. The two
       write-ups are read to draft from and left off the Documents page. */
    record('neither of them is filed, because that was not asked for',
      !(two.body.documents || []).length,
      `${(two.body.documents || []).length} filed`);
    record('and the reply says the attachment was only read',
      /read, not filed/i.test(String(two.body.answer)),
      String(two.body.answer).split('\n').slice(-1)[0].slice(0, 54));
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

    /* ---- what each set is asked for ----
       A set is drafted from one write-up on its own, and the turn that does
       it has to ask for the whole of that write-up and for nothing else. The
       stub reports the briefing back as scenarios, so a brief that quietly
       stops asking shows up here rather than as a thinner set nobody counts. */
    const brief = (two.body.drafts || [])[0] || { scenarios: [] };
    const briefed = brief.scenarios.map((s) => s.scenario).join(' | ');

    record('each write-up is asked for statement by statement',
      /read statement by statement/.test(briefed), briefed.slice(-120));
    record('and from nothing but itself',
      /drafted from nothing else/.test(briefed), '');
    record('what it rules out is asked for too',
      /rules out is tested too/.test(briefed), '');
    record('and no scenario count decides the length first',
      /briefed without a scenario count/.test(briefed), '');

    /* ---- a number asked for is a number written ----
       "Write up to 50+ scenarios" and thirty-six came back. A model told to
       write a long list stops when it has had enough of writing it, so the
       count is held here: counted, and asked for again until it is reached. */
    const counted = await attach('write test scenarios for this document, upto 20+ scenarios',
      ['Sharepoint Sprawl - InScope']);
    const got = counted.body.draft ? counted.body.draft.scenarios : [];

    record('asked for twenty, twenty come back', got.length >= 20, `${got.length} scenarios`);
    record('and none of them is written twice',
      new Set(got.map((s) => s.scenario.toLowerCase())).size === got.length,
      `${new Set(got.map((s) => s.scenario.toLowerCase())).size} distinct`);
    record('the later rounds carry on rather than start again',
      got.some((s) => /handles case 2[0-9]|handles case 1[0-9]/.test(s.scenario)),
      got.slice(-1).map((s) => s.scenario).join(''));
    record('all three kinds are still there',
      ['Positive', 'Negative', 'Edge'].every((k) => got.some((s) => s.type === k)),
      [...new Set(got.map((s) => s.type))].join(','));

    /* Each of several write-ups is held to the number, not the lot of them. */
    const bothCounted = await attach('write 20 scenarios for each of these documents',
      ['Teams Sprawl - InScope', 'Teams Sprawl - Out of Scope']);
    record('a number asked for applies to every set',
      (bothCounted.body.drafts || []).length === 2
        && bothCounted.body.drafts.every((d) => d.scenarios.length >= 20),
      (bothCounted.body.drafts || []).map((d) => d.scenarios.length).join(' + '));

    /* ---- and no number means no padding ---- */
    const unasked = await attach('write test scenarios for this document', ['Jira Sprawl - InScope']);
    record('with no number named, the set is the draft as it came',
      Boolean(unasked.body.draft) && unasked.body.draft.scenarios.length < 20,
      unasked.body.draft ? `${unasked.body.draft.scenarios.length} scenarios` : 'no draft');

    const justFile = await attach('keep these documents', ['Egnyte Sprawl - Limitations']);
    record('attaching without asking for scenarios still only files',
      !justFile.body.draft && !(justFile.body.drafts || []).length
        && (justFile.body.documents || []).length === 1,
      justFile.body.draft ? 'drafted anyway' : 'filed and stopped');

    /* ---- a functionality described in the chat, with no document at all ----
       It used to get the house dozen off a paragraph naming six behaviours
       and three messages: most of it untested, and nothing saying so. */
    const described = await ask('write test scenarios for this: when a Slack workspace is '
      + 'connected, every private channel the admin is not a member of is listed under Needs '
      + 'Access. The admin joins the channel or marks it skipped. The migration refuses to '
      + 'start while any channel is unresolved and shows Resolve access to continue.');

    const saw = (described.body.draft ? described.body.draft.scenarios : [])
      .map((s) => s.scenario).join(' | ');

    record('a described functionality is covered statement by statement',
      /covered statement by statement/.test(saw),
      saw ? saw.slice(-70) : String(described.body.answer).slice(0, 60));
    record('and nothing is filed for it either',
      !(described.body.documents || []).length,
      `${(described.body.documents || []).length} filed`);

    /* ---- and asking for both in one breath still does both ---- */
    const bothJobs = await attach('upload this document and write test scenarios for it',
      ['Notion Sprawl - InScope']);
    record('asking for both still files and drafts',
      Boolean(bothJobs.body.draft) && (bothJobs.body.documents || []).length === 1,
      `${(bothJobs.body.documents || []).length} filed, `
        + `${bothJobs.body.draft ? bothJobs.body.draft.scenarios.length : 0} scenarios`);
    record('and that set is named after the write-up as filed',
      Boolean(bothJobs.body.draft) && bothJobs.body.draft.name === 'Notion Sprawl - InScope',
      bothJobs.body.draft ? bothJobs.body.draft.name : '');

    /* ---- a set open behind the chat is not where another write-up lands ----
       Twelve scenarios about private channels went onto the end of a Gmail
       in-scope set, numbered 51-62, because that set was on the screen. */
    const open = await (await fetch(`${BASE}/api/assistant/scenarios`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        product: 'datasprawl',
        name: 'Mail_Gmail-to-Gmail_In-Scope_Scenarios',
        scenarios: [{ scenario: 'Verify that mapped events are migrated.', type: 'Positive', section: 'Scan' }],
      }),
    })).json();
    const here = open.enhancement.id;

    const elsewhere = await attach('write test scenarios for this document separately',
      ['Confluence Sprawl - InScope'], here);
    record('a document attached with a set open gets its own set',
      Boolean(elsewhere.body.draft) && !elsewhere.body.draft.enhancementId,
      elsewhere.body.draft
        ? (elsewhere.body.draft.enhancementId ? 'added to the open set' : elsewhere.body.draft.name)
        : 'no draft');
    record('named after the write-up, not the set on the screen',
      Boolean(elsewhere.body.draft) && elsewhere.body.draft.name === 'Confluence Sprawl - InScope',
      elsewhere.body.draft ? elsewhere.body.draft.name : '');
    record('and the reply says which set they go in',
      /own set/.test(String(elsewhere.body.answer))
        && /Mail_Gmail-to-Gmail_In-Scope_Scenarios/.test(String(elsewhere.body.answer)),
      String(elsewhere.body.answer).split('\n').slice(-1)[0].slice(0, 60));

    /* ---- asked for on the end of it, they go on the end of it ---- */
    const onto = await attach('write test scenarios for this document and add them to this set',
      ['Asana Sprawl - InScope'], here);
    record('"add them to this set" still adds them to it',
      Boolean(onto.body.draft) && onto.body.draft.enhancementId === here,
      onto.body.draft ? (onto.body.draft.enhancementId || 'own set') : 'no draft');

    /* ---- a file too thin to read as a write-up still is not the open set ----
       A scan that extracts to a line of text, a spreadsheet, a screenshot:
       those fell past the per-write-up path to the general one, which put
       their scenarios on the end of whatever was open. Same complaint, other
       route. */
    const thin = new FormData();
    thin.append('question', 'write test scenarios for this');
    thin.append('history', '[]');
    thin.append('currentProduct', 'datasprawl');
    thin.append('currentEnhancement', here);
    thin.append('files', new Blob(['Private channels need the admin to join.'],
      { type: 'text/markdown' }), 'thin-note.md');
    const sparse = await (await fetch(`${BASE}/api/assistant`, { method: 'POST', body: thin })).json();

    record('a file too thin to read as a write-up still gets its own set',
      Boolean(sparse.draft) && !sparse.draft.enhancementId,
      sparse.draft ? (sparse.draft.enhancementId ? 'added to the open set' : sparse.draft.name) : 'no draft');
    record('and is named after the file that carried it',
      Boolean(sparse.draft) && /thin.note/i.test(String(sparse.draft.name)),
      sparse.draft ? sparse.draft.name : 'no draft');
    record('and the reply says they are not going on the end of it',
      /set of their own/.test(String(sparse.answer)),
      String(sparse.answer).trim().split('\n').slice(-1)[0].slice(0, 58));

    /* ---- asked for in a new set, in so many words ---- */
    const freshly = await attach('write test scenarios for this document in a new set',
      ['Trello Sprawl - InScope'], here);
    record('"in a new set" is heard',
      Boolean(freshly.body.draft) && !freshly.body.draft.enhancementId,
      freshly.body.draft ? (freshly.body.draft.enhancementId || freshly.body.draft.name) : 'no draft');

    /* ---- and more for the set on the screen, with nothing attached ---- */
    const carryOn = await ask('write 3 more scenarios about archived channels', here);
    record('more scenarios with nothing attached still go on the open set',
      Boolean(carryOn.body.draft) && carryOn.body.draft.enhancementId === here,
      carryOn.body.draft ? (carryOn.body.draft.enhancementId || 'own set') : 'no draft');

    /* ---- several named write-ups do not pile into the open set either ---- */
    const several = await ask('write test scenarios for Egnyte - Content Sprawl Scope and '
      + 'Box for Business - Content Sprawl Scope', here);
    record('two named write-ups make two sets with one open',
      (several.body.drafts || []).length === 2
        && (several.body.drafts || []).every((d) => !d.enhancementId),
      `${(several.body.drafts || []).length} sets`);
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
