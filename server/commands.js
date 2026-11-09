'use strict';

const { correctInstruction } = require('./words');

/**
 * Asking the tool to change something, in the words people use.
 *
 * The scenarios, their results and the sets they live in are all edited from
 * the chat. The reading is done here rather than by the model: an instruction
 * to delete two hundred scenarios has to mean exactly what it says, every
 * time, and has to be the same instruction tomorrow. A model asked to decide
 * is a model that can decide differently.
 *
 * Nothing here touches the store. Reading an instruction and carrying it out
 * are kept apart, so that what was understood can be put to the person before
 * anything happens to their data.
 */

const STATUS_WORDS = {
  pass: 'pass', passed: 'pass', passing: 'pass', ok: 'pass',
  fail: 'fail', failed: 'fail', failing: 'fail', broken: 'fail',
  pending: 'pending', 'not run': 'pending', 'not tested': 'pending', untested: 'pending',
};

/* What a row is called when it is pointed at by its number: "scenario 4",
   "row 4", "s.no 4", "no. 4", "#4", or nothing at all. */
const A_ROW_WORD = '(?:scenarios?|sceanrios?|rows?|cases?|items?|lines?'
  + '|points?|sl\\.?\\s*nos?|s\\.?\\s*nos?|nos?\\.?|numbers?|#)';
/* Said twice as often as not — "scenario no 4", "row number 4". */
const A_ROW = `(?:test\\s+)?${A_ROW_WORD}(?:\\s*${A_ROW_WORD})?`;

/* "42", "42 and 43", "42, 43 and 44", "42-45", "42 43 44" — a space is how
   most people separate them, and it used to end the list at the first one. */
const NUMBER_LIST = '(\\d+(?:\\s*(?:,|and|&|\\+|#|to|thru|through|till|until|-|–|—)\\s*\\d+|\\s+\\d+)*)';

/**
 * Pull the scenario numbers out of "12, 14 and 16", "12-15", or "12 14 16".
 *
 * Numbers separated by nothing but a space used to come back as the first
 * one alone: "delete scenario 1 2 3" deleted scenario 1 and said so, and the
 * other two stayed. The split was on commas and the word "and", and whatever
 * fell in one piece was read for a single number.
 */
function readNumbers(text) {
  const out = new Set();
  const add = (n) => { if (Number.isInteger(n) && n > 0) out.add(n); };

  String(text).split(/\s*(?:,|&|\+|\band\b|\bplus\b)\s*/i).forEach((span) => {
    /* "12-15", "35 to 58": every number between the two ends, and the ends
       themselves. Taken out of the span so they are not counted again. */
    const rest = span.replace(
      /(\d+)\s*(?:-|–|—|\bto\b|\bthru\b|\bthrough\b|\btill\b|\buntil\b)\s*(\d+)/gi,
      (whole, a, b) => {
        const from = Number(a);
        const to = Number(b);
        if (Math.abs(to - from) > 500) return ' ';   // a typo, not a request
        for (let n = Math.min(from, to); n <= Math.max(from, to); n += 1) add(n);
        return ' ';
      }
    );

    /* and everything still standing is a number on its own: "1 2 3", "7". */
    (rest.match(/\d+/g) || []).forEach((d) => add(Number(d)));
  });

  return Array.from(out).sort((a, b) => a - b);
}

/* The set being looked at, rather than one called "this". */
const THE_OPEN_ONE = /^(?:this|it|that|these|the\s+(?:open|current)\s+one)$/i;

function tidyName(text) {
  return String(text || '')
    .replace(/^["'‘“]|["'’”]$/g, '')
    .replace(/\s+(?:set|enhancement|scenarios?|list|table)\s*$/i, '')
    .replace(/^the\s+/i, '')
    .replace(/[.!?]+$/, '')
    .trim();
}

/**
 * A name, or null when the words point at whatever is open.
 *
 * "Delete the Private Channels scenarios" names a set and calls it scenarios,
 * so the word comes off the end. "Delete the DIY Tool Test Scenarios
 * document" has already had its noun taken by the pattern — what is left is
 * the whole name, and taking a word off it leaves a name nothing is called.
 */
function namedOrOpen(text, { whole = false } = {}) {
  const name = whole ? tidyLabel(text) : tidyName(text);
  return THE_OPEN_ONE.test(name) ? null : name;
}

/** A name given in an instruction, with the quoting taken off. */
function tidyLabel(text) {
  return String(text || '')
    .replace(/^["'‘“]|["'’”]$/g, '')
    .replace(/[.!?]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ---------------- the instructions ---------------- */

/* The write-ups are managed from here too, so a pattern has to know when an
   instruction is about one rather than about a set of scenarios. */
const A_DOCUMENT = '(?:documents?|docs?|write-?ups?|files?)';

/* Saying "document" settles what the instruction is about, whether or not a
   name follows it. "Delete this document, not the scenarios" is about a
   write-up; reading it as the name of a set — and then offering sets to
   delete — answers the opposite of what was asked. */
const MENTIONS_A_DOCUMENT = new RegExp(`\\b${A_DOCUMENT}\\b`, 'i');

/* And saying "scenarios" settles it the other way, so that the word for a
   write-up appearing later in the sentence does not pull it back. */
const MENTIONS_SCENARIOS = /\b(?:scenarios?|rows?|test\s+cases?)\b/i;

/* What is being renamed is said before "to" or "as"; what comes after is the
   new name, and a new name is often "… migration scenarios". Reading the
   whole sentence for the word meant "rename the name as Gmail to Gmail
   migration scenarios" was taken as an instruction about scenarios, fell
   past the pattern that fits it, and came back as a set called "name". */
function whatIsBeingChanged(instruction) {
  const at = /\s\b(?:to|as|into)\s/i.exec(String(instruction || ''));
  return at ? instruction.slice(0, at.index) : instruction;
}

/* "Delete the scenarios in the Egnyte document" has the shape of a write-up
   being named — "the <something> document" — but the something is not a name,
   it is the word for the other thing in the tool. A write-up's name may well
   end in "Scenarios"; none of them begins with it. */
const STARTS_AS_SCENARIOS = /^(?:the\s+|all\s+|these\s+|those\s+)*(?:scenarios?|rows?|test\s+cases?)\b/i;

/* The columns of the scenario table. These name a part of what is on screen,
   never a set of scenarios, so "remove that section" empties a column — it
   does not delete eighty-six rows. */
const A_COLUMN = 'section|type|status|s\\.?\\s*no|serial|source';

/* Giving something a different name. "Rename" is the word for it, and almost
   nobody uses it: "edit that name as …", "change the name to …", "call it …"
   are what gets typed. Reaching the model with any of those got back a
   refusal to help with renaming files, which is not a thing this tool was
   being asked to do. */
const A_RENAME = '(?:rename|re-?name|edit|change|update|correct|fix|set|call)';
const NAMED = '["\'“]?(.+?)["\'”]?';

/* The words for a set of scenarios, the way a write-up has its own. Saying
   one of them settles what is being renamed, exactly as saying "document"
   does: "rename the scenarios title as X" is the set on the screen, not a
   write-up that happens to be called something similar. */
const A_SET = '(?:test\\s+)?(?:scenarios?|sets?|enhancements?)';
const A_SET_TITLED = `(?:${A_SET}|test\\s*cases?|lists?)`;

/* And plural only where no word follows to say which thing is meant, so that
   "edit the scenario to read ..." stays an edit of a scenario. */
const SOME_SCENARIOS = '(?:test\\s+)?(?:scenarios|sets?|enhancements?)';

const PATTERNS = [
  /* rename the scenarios title to Outlook_Shared_Mailboxes_to_Google_Groups
     — before the write-up renames below, which would otherwise take it: a
     set of scenarios was being left alone while a write-up of a similar
     name was renamed in its place, and the reply said so in a sentence
     nobody reads twice. */
  {
    kind: 'rename-set',
    re: new RegExp(
      `\\b${A_RENAME}\\s+(?:the\\s+|that\\s+|this\\s+|its\\s+)?`
        + `(?:${A_SET_TITLED}\\s+){1,2}(?:name|title)\\s+(?:to|as|into)\\s+${NAMED}\\s*$`,
      'i'
    ),
    read: (m) => ({ name: null, to: tidyLabel(m[1]) }),
  },

  /* rename the scenarios to Outlook Shared Mailboxes */
  {
    kind: 'rename-set',
    re: new RegExp(
      `\\b${A_RENAME}\\s+(?:the\\s+|that\\s+|this\\s+|these\\s+)?`
        + `${SOME_SCENARIOS}\\s+(?:to|as|into)\\s+${NAMED}\\s*$`,
      'i'
    ),
    read: (m) => ({ name: null, to: tidyLabel(m[1]) }),
  },

  /* delete the Outlook Shared Mailboxes document */
  {
    kind: 'delete-document',
    re: new RegExp(
      '\\b(?:delete|remove|drop|get\\s+rid\\s+of)\\s+(?:the\\s+)?'
        + `(?:${A_DOCUMENT}\\s+(?:called\\s+|named\\s+)?${NAMED}`
        + `|${NAMED}\\s+${A_DOCUMENT})\\s*$`,
      'i'
    ),
    read: (m) => ({ name: namedOrOpen(m[1] || m[2], { whole: true }), object: 'document' }),
  },

  /* delete this document — no name on it, so which one has to be asked, and
     asked about write-ups rather than about sets of scenarios */
  {
    kind: 'delete-document',
    re: new RegExp(
      '\\b(?:delete|remove|drop|get\\s+rid\\s+of)\\s+'
        + `(?:this|that|the|these|those|it)?\\s*${A_DOCUMENT}\\b`,
      'i'
    ),
    read: () => ({ name: null, object: 'document' }),
  },

  /* rename the Group DM document to Group DM naming */
  {
    kind: 'rename-document',
    re: new RegExp(
      `\\b${A_RENAME}\\s+(?:the\\s+)?`
        + `(?:${A_DOCUMENT}\\s+(?:called\\s+|named\\s+)?${NAMED}`
        + `|${NAMED}\\s+${A_DOCUMENT})`
        + `\\s+(?:to|as)\\s+${NAMED}\\s*$`,
      'i'
    ),
    read: (m) => ({ name: namedOrOpen(m[1] || m[2], { whole: true }), to: tidyLabel(m[3]), object: 'document' }),
  },

  /* edit that name as Confluence-to-SharePoint-Migration-Walkthrough —
     nothing names which write-up, so it is the one open or the one in the
     screenshot, and failing both it asks which.

     With the word "document" in it, that is settled. Without it — "rename
     the name as ..." — the sentence says what to call the thing and never
     says what the thing is, so it is marked as unsettled here and decided
     from what is on the screen rather than always being a write-up. */
  {
    kind: 'rename-document',
    re: new RegExp(
      `\\b${A_RENAME}\\s+(?:the\\s+|that\\s+|this\\s+|its\\s+)?`
        + `(?:(${A_DOCUMENT})\\s+)?(?:name|title)\\s+(?:to|as|into)\\s+${NAMED}\\s*$`,
      'i'
    ),
    read: (m) => ({ name: null, to: tidyLabel(m[2]), object: 'document', nounless: !m[1] }),
  },

  /* rename this document to Egnyte sprawl */
  {
    kind: 'rename-document',
    re: new RegExp(
      `\\b${A_RENAME}\\s+(?:this|that|the)\\s+${A_DOCUMENT}\\s+(?:to|as|into)\\s+${NAMED}\\s*$`,
      'i'
    ),
    read: (m) => ({ name: null, to: tidyLabel(m[1]), object: 'document' }),
  },

  /* move the Gmail Sprawl document to Email */
  {
    kind: 'move-document',
    re: new RegExp(
      '\\b(?:move|file|put|reassign)\\s+(?:the\\s+)?'
        + `(?:${A_DOCUMENT}\\s+(?:called\\s+|named\\s+)?${NAMED}`
        + `|${NAMED}\\s+${A_DOCUMENT})`
        + `\\s+(?:to|under|into)\\s+${NAMED}\\s*$`,
      'i'
    ),
    read: (m) => ({ name: namedOrOpen(m[1] || m[2], { whole: true }), to: tidyLabel(m[3]), object: 'document' }),
  },

  /* generate test cases for the Private Channels set */
  {
    kind: 'make-test-cases',
    re: new RegExp(
      '\\b(?:(re)-?(?:generate|write|do|run)|generate|write|create|produce|make|add|fill\\s+in|prepare)\\s+'
        + '(?:the\\s+|all\\s+(?:the\\s+)?|detailed\\s+|missing\\s+)*test\\s*cases?'
        + '(?:\\s+(?:for|on|in|against|to)\\s+(?:all\\s+(?:the\\s+)?(?:scenarios?|rows?)\\s+(?:in|of|for)\\s+)?'
          + `(?:the\\s+)?${NAMED})?\\s*$`,
      'i'
    ),
    read: (m) => ({ name: m[2] ? namedOrOpen(m[2]) : null, again: Boolean(m[1]) }),
  },

  /* add to the Egnyte write-up: the scan also reports shared links */
  {
    kind: 'append-document',
    re: new RegExp(
      '\\b(?:add|append|put)\\s+(?:this\\s+|the\\s+following\\s+)?(?:to|into|onto|at\\s+the\\s+end\\s+of)\\s+'
        + `(?:the\\s+)?${NAMED}\\s+${A_DOCUMENT}\\s*[:\\-—]\\s*([\\s\\S]+)`,
      'i'
    ),
    read: (m) => ({ name: namedOrOpen(m[1], { whole: true }), text: String(m[2]).trim(), object: 'document' }),
  },

  /* in the Egnyte write-up change "180 days" to "90 days" */
  {
    kind: 'replace-in-document',
    re: new RegExp(
      `\\b(?:in|on)\\s+(?:the\\s+)?${NAMED}\\s+${A_DOCUMENT}[,\\s]+`
        + '(?:change|replace|correct|swap)\\s+["\'“](.+?)["\'”]\\s+(?:to|with|for)\\s+["\'“](.*?)["\'”]\\s*$',
      'i'
    ),
    read: (m) => ({
      name: namedOrOpen(m[1], { whole: true }), from: m[2], to: m[3], object: 'document',
    }),
  },

  /* mark 12 and 14 as failed */
  {
    kind: 'set-status',
    re: new RegExp(
      `\\b(?:mark|set|make|change)\\s+(?:test\\s+)?(?:scenarios?|rows?|cases?|numbers?|#)?\\s*${NUMBER_LIST}`
        + '\\s+(?:as|to)\\s+(pass(?:ed|ing)?|fail(?:ed|ing)?|pending|not\\s+run|not\\s+tested|untested|ok|broken)\\b',
      'i'
    ),
    read: (m) => ({ snos: readNumbers(m[1]), status: STATUS_WORDS[m[2].toLowerCase().replace(/\s+/g, ' ')] }),
  },

  /* change scenario 12 to: ... */
  {
    kind: 'edit-scenario',
    re: /\b(?:change|update|edit|reword|rewrite|correct|fix)\s+(?:test\s+)?(?:scenario|row|case|number|#)\s*(\d+)\s+to[:\s]+([\s\S]+)/i,
    read: (m) => ({ sno: Number(m[1]), text: String(m[2]).trim().replace(/^["'“]|["'”]$/g, '') }),
  },

  /* delete scenarios 12, 14 and 16 */
  {
    kind: 'delete-scenarios',
    re: new RegExp(
      `\\b(?:delete|remove|drop|get\\s+rid\\s+of)\\s+(?:the\\s+)?${A_ROW}\\s*${NUMBER_LIST}`,
      'i'
    ),
    read: (m) => ({ snos: readNumbers(m[1]) }),
  },

  /* delete 12, 14 and 16 — numbers and nothing else, so it cannot be read as
     the name of a set. "Delete 2024 report" is a name and stays one. */
  {
    kind: 'delete-scenarios',
    re: new RegExp(
      `^\\s*(?:please\\s+)?(?:delete|remove|drop|get\\s+rid\\s+of)\\s+(?:the\\s+)?${NUMBER_LIST}`
        + `(?:\\s+${A_ROW}s?)?\\s*\\.?\\s*$`,
      'i'
    ),
    read: (m) => ({ snos: readNumbers(m[1]) }),
  },

  /* rename this to Workspace checks */
  {
    kind: 'rename-set',
    re: /\brename\s+(?:this|it|the\s+set|the\s+enhancement|(?:the\s+)?["'“]?(.+?)["'”]?)\s+(?:to|as)\s+["'“]?(.+?)["'”]?\s*$/i,
    read: (m) => ({ name: m[1] ? namedOrOpen(m[1]) : null, to: tidyLabel(m[2]) }),
  },

  /* empty the Section column — before the catch-all below, which would read
     "remove that section" as the name of a set and delete it */
  {
    kind: 'clear-column',
    re: new RegExp(
      '\\b(?:remove|clear|delete|drop|empty)\\s+(?:the\\s+|that\\s+|this\\s+)?'
        + `(${A_COLUMN})\\s*(?:column|values?|field)?`
        + '(?:\\s+(?:from|on|in|for)\\s+(?:all\\s+)?(?:the\\s+)?(?:scenarios?|rows?|table|set))?\\s*$',
      'i'
    ),
    read: (m) => ({ column: tidyLabel(m[1]) }),
  },

  /* delete the DIY Tool Test Scenarios set — last, so it does not swallow the
     narrower deletes above */
  {
    kind: 'delete-set',
    re: /\b(?:delete|remove|drop|get\s+rid\s+of)\s+(?:the\s+)?(.+?)\s*$/i,
    read: (m) => ({ name: namedOrOpen(m[1]), open: THE_OPEN_ONE.test(tidyName(m[1])) }),
  },
];

/* Deleting is the one that cannot be taken back, so it is put to the person
   before it happens. The rest are a click to undo and are simply done. */
const NEEDS_CONFIRMING = new Set([
  'delete-set', 'delete-scenarios', 'delete-document', 'clear-column', 'replace-in-document',
]);

/**
 * Read a message as an instruction to change something.
 *
 * @returns {null|{kind: string, confirm: boolean, ...}}
 */
/**
 * An instruction to manage what the tool holds, whether or not it parsed.
 *
 * "Delete this document" typed as "delte this document" used to reach the
 * drafting path and come back as nineteen test scenarios about deleting a
 * document, filed under a set named after the typo. Spelling is fixed above,
 * but no list of corrections covers every way a sentence can be put, so this
 * is the backstop: an instruction that was not understood is said to be not
 * understood, rather than quietly turned into something else.
 *
 * Only the managing verbs. "Write scenarios for the Egnyte write-up" is a
 * drafting request that mentions a write-up, and it is not this.
 */
const MANAGING = new RegExp(
  '^(?:please\\s+)?(?:can\\s+you\\s+|could\\s+you\\s+)?'
    + '(?:delete|remove|drop|get\\s+rid\\s+of|rename|move|file|refile|clear|empty|archive)\\b',
  'i'
);

const A_THING_IN_THE_TOOL = new RegExp(
  `\\b(?:${A_DOCUMENT}|scenarios?|sets?|enhancements?|columns?|rows?|test\\s*cases?|section|status)\\b`,
  'i'
);

function readsAsAnInstruction(question) {
  const { text } = correctInstruction(String(question || '').trim());
  if (text.length > 160) return false;          // a paragraph is not an order

  const verb = MANAGING.exec(text);
  if (!verb) return false;

  /* The thing has to be named somewhere other than in the verb. "File this
     under Email" is a verb and a destination and no noun at all — reading its
     own "file" as the thing meant an upload was turned down as an instruction
     nobody could make out. */
  return A_THING_IN_THE_TOOL.test(text.slice(verb[0].length));
}

function parseCommand(question) {
  /* Read what was meant, not what was typed. */
  const text = correctInstruction(String(question || '').trim()).text;
  if (!text) return null;

  /* "Can you delete scenario 5?" is an instruction wearing a question mark;
     "how do I delete a scenario?" is a question about one. The difference is
     whether the asking is addressed to the tool or about it. */
  const asked = /^(?:can|could|would|will|please)\s+(?:you\s+)?(?:please\s+)?/i;
  const plain = text.replace(asked, '').replace(/^please\s+/i, '');

  if (/^(?:how|what|why|when|where|which|should|is|are|does|do|did)\b/i.test(plain)) return null;

  const instruction = plain.trim();

  for (const pattern of PATTERNS) {
    const m = pattern.re.exec(instruction);
    if (!m) continue;

    const read = pattern.read(m);
    if (!read) continue;
    if (read.snos && !read.snos.length) continue;
    if (pattern.kind === 'delete-set' && !read.open && (!read.name || read.name.length < 3)) continue;
    if (pattern.kind === 'rename-set' && !read.to) continue;

    /* "Set the scenarios to pass" is a status, not a new name for the set.
       A_RENAME covers "set", "change" and "update", which are the words for
       both, so what follows "to" decides. */
    if (pattern.kind === 'rename-set' && STATUS_WORDS[String(read.to).toLowerCase()]) continue;

    /* The word decides, the other way round as well: an instruction that
       says scenarios is not a write-up being renamed, whatever a write-up
       on the shelf happens to be called. */
    if (pattern.kind === 'rename-document'
      && MENTIONS_SCENARIOS.test(whatIsBeingChanged(instruction))
      && !MENTIONS_A_DOCUMENT.test(whatIsBeingChanged(instruction))) continue;

    if (pattern.kind === 'edit-scenario' && !read.text) continue;

    /* A write-up has to be named to be renamed or moved: there is no "the
       open one" on a page that lists fifteen of them. Deleting one may go
       unnamed — it is put to the person before it happens anyway, and that
       is the moment to ask which. */
    /* Deleting and renaming may go unnamed — both are put to the person
       before they happen, and that is the moment to ask which. Moving and
       editing the words inside one still have to say which. */
    const mayGoUnnamed = pattern.kind === 'delete-document' || pattern.kind === 'rename-document';

    if (read.object === 'document' && !mayGoUnnamed
      && (!read.name || read.name.length < 3)) continue;

    /* What was captured as a write-up's name is the word for scenarios, so
       scenarios are what was asked about. */
    if (read.object === 'document' && read.name && STARTS_AS_SCENARIOS.test(read.name)) continue;

    /* "Edit the document name to X" has no name in it — "name" is the word
       for the thing being changed, not what the write-up is called. In
       "change the title of the Egnyte document" it is both: the word, then
       the name after it. */
    if (read.object === 'document' && read.name) {
      read.name = read.name.replace(/^(?:the\s+)?(?:name|title)\s+of\s+(?:the\s+)?/i, '').trim();
      if (/^(?:name|title)$/i.test(read.name)) read.name = null;
    }

    /* The word decides. An instruction that says "document" is never read as
       the name of a set, even when no write-up matches what was typed. */
    if (pattern.kind === 'delete-set' && MENTIONS_A_DOCUMENT.test(instruction)
      && !MENTIONS_SCENARIOS.test(instruction)) continue;
    if (/^(?:rename|move)-document$/.test(pattern.kind) && !read.to) continue;
    if (pattern.kind === 'clear-column' && !read.column) continue;
    if (pattern.kind === 'append-document' && !read.text) continue;
    if (pattern.kind === 'replace-in-document' && !read.from) continue;

    /* Writing test cases where there are none costs time and nothing else.
       Writing them again throws away the ones that are there, so that one is
       asked about. */
    const confirm = NEEDS_CONFIRMING.has(pattern.kind)
      || (pattern.kind === 'make-test-cases' && Boolean(read.again));

    return { kind: pattern.kind, confirm, ...read };
  }

  return null;
}

/** What the tool is about to do, in a sentence the person can check. */
function describeCommand(command, context = {}) {
  const where = context.enhancementName ? ` in "${context.enhancementName}"` : '';
  /* A run of numbers is put back the way it was asked for: "scenarios 35-58"
     rather than twenty-four of them spelled out, which is what has to be
     read and agreed to before a delete happens. */
  const list = (ns) => {
    if (ns.length === 1) return `scenario ${ns[0]}`;

    const runs = [];
    ns.forEach((n) => {
      const last = runs[runs.length - 1];
      if (last && n === last[1] + 1) last[1] = n;
      else runs.push([n, n]);
    });

    return `scenarios ${runs.map(([a, b]) => {
      if (a === b) return String(a);
      return b === a + 1 ? `${a}, ${b}` : `${a}–${b}`;
    }).join(', ')}`;
  };

  switch (command.kind) {
    case 'set-status':
      return `Mark ${list(command.snos)}${where} as ${command.status === 'pending' ? 'not run' : command.status}.`;
    case 'edit-scenario':
      return `Reword scenario ${command.sno}${where}.`;
    case 'delete-scenarios':
      return `Delete ${list(command.snos)}${where}. This cannot be undone.`;
    case 'delete-document':
      return command.name || context.documentName
        ? `Delete the write-up "${command.name || context.documentName}". This cannot be undone.`
        : 'Delete that write-up. This cannot be undone.';
    case 'rename-document':
      return command.name || context.documentName
        ? `Rename the write-up "${command.name || context.documentName}" to "${command.to}".`
        : `Rename that write-up to "${command.to}".`;
    case 'move-document':
      return `File the write-up "${command.name}" under ${command.to}.`;
    case 'make-test-cases':
      return command.again
        ? `Write the test cases again for every scenario${where || ''}, replacing the ones there now. This cannot be undone.`
        : `Write test cases for the scenarios${where || ''} that have none yet.`;
    case 'append-document':
      return `Add that to the end of the write-up "${command.name}".`;
    case 'replace-in-document':
      return `In the write-up "${command.name}", change "${command.from}" to "${command.to}". This cannot be undone.`;
    case 'clear-column':
      return `Empty the ${command.column} column${where}, on every row. This cannot be undone.`;
    case 'rename-set':
      /* Named as a set, because a write-up of nearly the same name is often
         sitting beside it and this is the sentence that says which was
         understood. */
      return `Rename the set "${command.name || context.enhancementName}" to "${command.to}".`;
    case 'delete-set':
      return `Delete "${command.name || context.enhancementName}" and every scenario in it. This cannot be undone.`;
    default:
      return 'Make that change.';
  }
}

module.exports = {
  parseCommand, describeCommand, readsAsAnInstruction, readNumbers, STATUS_WORDS,
};
