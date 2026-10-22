'use strict';

/**
 * An instruction means the same thing every time it is given.
 *
 * This is the one part of the assistant that is not a model: a delete has to
 * mean a delete today and tomorrow, and the same words have to reach the same
 * branch. Nothing here starts a server — it reads sentences and checks what
 * they were understood to be.
 *
 * Every line below is something that was once read as something else.
 */

const { parseCommand, describeCommand, readsAsAnInstruction } = require('../server/commands');
const { correctInstruction } = require('../server/words');

const checks = [];
const record = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });

/* what was said, what it is, and anything that has to be true of the reading */
const SENTENCES = [
  /* ---- write-ups ---- */
  ['delete the Egnyte - Content Sprawl Scope document', 'delete-document',
    (c) => c.name === 'Egnyte - Content Sprawl Scope'],
  ['delete the document called Dropbox - Content Sprawl Scope', 'delete-document'],
  ['delete this document', 'delete-document', (c) => c.name === null],
  ['delete this document in data sprawl not scenarios', 'delete-document'],
  ['delete this write-up', 'delete-document'],
  ['get rid of that write-up', 'delete-document'],
  ['delete the DIY Tool Test Scenarios document', 'delete-document',
    (c) => c.name === 'DIY Tool Test Scenarios'],
  ['rename the Dropbox - Content Sprawl Scope document to Dropbox sprawl', 'rename-document',
    (c) => c.to === 'Dropbox sprawl' && c.name === 'Dropbox - Content Sprawl Scope'],
  /* the words people actually use for renaming, none of which is "rename" */
  ['edit that name as Confluence-to-SharePoint-Migration-Walkthrough', 'rename-document',
    (c) => c.name === null && c.to === 'Confluence-to-SharePoint-Migration-Walkthrough'],
  ['change the name to Egnyte sprawl', 'rename-document', (c) => c.name === null && c.to === 'Egnyte sprawl'],
  ['edit the document name to Egnyte sprawl', 'rename-document', (c) => c.name === null],
  ['set the title as Dropbox sprawl', 'rename-document', (c) => c.to === 'Dropbox sprawl'],
  ['rename this document to Egnyte sprawl', 'rename-document', (c) => c.name === null],
  ['rename that write-up as Egnyte v2', 'rename-document', (c) => c.to === 'Egnyte v2'],
  ['change the title of the Egnyte - Content Sprawl Scope document to Egnyte v2', 'rename-document',
    (c) => c.name === 'Egnyte - Content Sprawl Scope'],
  ['change the Egnyte - Content Sprawl Scope document to Egnyte v2', 'rename-document',
    (c) => c.name === 'Egnyte - Content Sprawl Scope'],
  ['move the Egnyte - Content Sprawl Scope document to Content', 'move-document',
    (c) => c.to === 'Content'],
  ['add to the Egnyte - Content Sprawl Scope document: the scan reports shared links',
    'append-document', (c) => /shared links$/.test(c.text)],
  ['in the Egnyte - Content Sprawl Scope document, change "180 days" to "90 days"',
    'replace-in-document', (c) => c.from === '180 days' && c.to === '90 days'],

  /* ---- sets and scenarios ---- */
  ['delete the Box for Business - Content Sprawl Scope set', 'delete-set'],
  ['delete Box for Business - Content Sprawl Scope', 'delete-set'],
  ['delete the scenarios in the Egnyte document', 'delete-set'],
  ['delete scenarios 4, 5 and 6', 'delete-scenarios', (c) => c.snos.join() === '4,5,6'],
  ['delete scenarios 10-13', 'delete-scenarios', (c) => c.snos.join() === '10,11,12,13'],
  ['mark 12 and 14 as failed', 'set-status', (c) => c.status === 'fail' && c.snos.join() === '12,14'],
  ['mark 3 as not run', 'set-status', (c) => c.status === 'pending'],
  ['change scenario 12 to: Verify that the banner is shown', 'edit-scenario',
    (c) => c.sno === 12 && /banner/.test(c.text)],
  ['rename this to Workspace checks', 'rename-set', (c) => c.to === 'Workspace checks'],
  ['remove that section', 'clear-column', (c) => /section/i.test(c.column)],
  ['remove the type column', 'clear-column'],

  /* ---- test cases ---- */
  ['generate test cases', 'make-test-cases', (c) => c.again === false],
  ['generate test cases for the Private Channels set', 'make-test-cases'],
  ['write test cases for all scenarios in Egnyte - Content Sprawl Scope', 'make-test-cases'],
  ['regenerate test cases for Egnyte', 'make-test-cases', (c) => c.again === true],
  ['fill in the missing test cases', 'make-test-cases'],

  /* ---- typed in a hurry ---- */
  ['delte this document', 'delete-document'],
  ['Delte this document', 'delete-document'],
  ['delet the Egnyte - Content Sprawl Scope document', 'delete-document'],
  ['remve that section', 'clear-column'],
  ['renmae this to Workspace checks', 'rename-set'],
  ['genrate test cases', 'make-test-cases'],
  ['delete scenarious 4 and 5', 'delete-scenarios'],

  /* ---- not instructions ---- */
  ['how do I delete a document?', null],
  ['what documents do we have?', null],
  ['how many scenarios have failed?', null],
  ['write test scenarios for data sprawl', null],
  ['write scenarios from the Egnyte document', null],
  ['which enhancements have no test cases yet?', null],
];

SENTENCES.forEach(([said, kind, alsoTrue]) => {
  const command = parseCommand(said);
  const got = command ? command.kind : null;

  let ok = got === kind;
  let why = got === null ? 'not an instruction' : got;

  if (ok && command && alsoTrue && !alsoTrue(command)) {
    ok = false;
    why = `${got}, but read wrongly: ${JSON.stringify(command)}`;
  }

  record(`"${said}"`, ok, ok ? why : `${why}  (wanted ${kind || 'not an instruction'})`);
});

/* ---- what it says it is about to do ---- */
const SAYS = [
  ['delete the Egnyte document', /Delete the write-up "Egnyte"\. This cannot be undone\./],
  ['delete scenarios 4 and 5', /Delete scenarios 4, 5 in "Open Set"\. This cannot be undone\./],
  ['remove that section', /Empty the section column in "Open Set", on every row\./],
  ['regenerate test cases', /Write the test cases again for every scenario in "Open Set", replacing/],
  ['generate test cases', /Write test cases for the scenarios in "Open Set" that have none yet\./],
];

SAYS.forEach(([said, shape]) => {
  const command = parseCommand(said);
  const sentence = command ? describeCommand(command, { enhancementName: 'Open Set' }) : '(nothing)';
  record(`it says what it will do: "${said}"`, shape.test(sentence), sentence);
});

/* ---- what it asks about first ---- */
const ASKS_FIRST = [
  ['delete this document', true],
  ['delete scenarios 4 and 5', true],
  ['remove that section', true],
  ['regenerate test cases', true],
  ['in the Egnyte document, change "a" to "b"', true],
  ['generate test cases', false],
  ['mark 4 as failed', false],
  ['rename this to Workspace checks', false],
  ['add to the Egnyte document: one more line', false],
];

ASKS_FIRST.forEach(([said, shouldAsk]) => {
  const command = parseCommand(said);
  const asks = Boolean(command && command.confirm);
  record(`${shouldAsk ? 'asks' : 'just does'}: "${said}"`, command && asks === shouldAsk,
    command ? (asks ? 'asks first' : 'done straight away') : 'not an instruction');
});

/* ---- an instruction it cannot read is still an instruction ---- */
const BACKSTOP = [
  ['remove all of the documents from the data sprawl tab', true],
  ['clear out the old scenarios somehow', true],
  ['write test scenarios for data sprawl', false],
  ['how many scenarios are there?', false],
  ['what is the Egnyte document about?', false],
];

BACKSTOP.forEach(([said, caught]) => {
  record(`backstop ${caught ? 'catches' : 'lets through'}: "${said}"`,
    readsAsAnInstruction(said) === caught, '');
});

/* ---- names are never corrected, only the words of the instruction ---- */
const LEAVES_ALONE = [
  'delete the Box for Business - Content Sprawl Scope',
  'delete the Slack Message Sprawl-InScope set',
  'rename the Dropbox - Content Sprawl Scope document to Dropbox sprawl',
  'write test scenarios for data sprawl',
];

LEAVES_ALONE.forEach((said) => {
  const { text } = correctInstruction(said);
  record(`left exactly as typed: "${said.slice(0, 44)}"`, text === said, text === said ? '' : text);
});

const width = Math.max(...checks.map((c) => c.name.length));
console.log('\n--- an instruction means the same thing every time ---');
checks.forEach((c) => {
  console.log((c.ok ? '  PASS  ' : '  FAIL  ') + c.name.padEnd(width) + '  ' + (c.detail || ''));
});

const failed = checks.filter((c) => !c.ok).length;
console.log(failed ? `\n${failed} FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
