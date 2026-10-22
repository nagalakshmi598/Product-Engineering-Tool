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

/* "42", "42 and 43", "42, 43 and 44", "42-45" */
const NUMBER_LIST = '(\\d+(?:\\s*(?:,|and|&|to|-|–)\\s*\\d+)*)';

/** Pull the scenario numbers out of "12, 14 and 16" or "12-15". */
function readNumbers(text) {
  const out = new Set();
  const spans = String(text).split(/\s*(?:,|and|&)\s*/i);

  spans.forEach((span) => {
    const range = /^\s*(\d+)\s*(?:-|–|to)\s*(\d+)\s*$/.exec(span);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (to - from > 500) return;                   // a typo, not a request
      for (let n = Math.min(from, to); n <= Math.max(from, to); n += 1) out.add(n);
      return;
    }
    const one = /\d+/.exec(span);
    if (one) out.add(Number(one[0]));
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

/** A name, or null when the words point at whatever is open. */
function namedOrOpen(text) {
  const name = tidyName(text);
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

/* "Delete the scenarios in the Egnyte document" has the shape of a write-up
   being named — "the <something> document" — but the something is not a name,
   it is the word for the other thing in the tool. A write-up's name may well
   end in "Scenarios"; none of them begins with it. */
const STARTS_AS_SCENARIOS = /^(?:the\s+|all\s+|these\s+|those\s+)*(?:scenarios?|rows?|test\s+cases?)\b/i;

/* The columns of the scenario table. These name a part of what is on screen,
   never a set of scenarios, so "remove that section" empties a column — it
   does not delete eighty-six rows. */
const A_COLUMN = 'section|type|status|s\\.?\\s*no|serial|source';
const NAMED = '["\'“]?(.+?)["\'”]?';

const PATTERNS = [
  /* delete the Outlook Shared Mailboxes document */
  {
    kind: 'delete-document',
    re: new RegExp(
      '\\b(?:delete|remove|drop|get\\s+rid\\s+of)\\s+(?:the\\s+)?'
        + `(?:${A_DOCUMENT}\\s+(?:called\\s+|named\\s+)?${NAMED}`
        + `|${NAMED}\\s+${A_DOCUMENT})\\s*$`,
      'i'
    ),
    read: (m) => ({ name: namedOrOpen(m[1] || m[2]), object: 'document' }),
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
      '\\brename\\s+(?:the\\s+)?'
        + `(?:${A_DOCUMENT}\\s+(?:called\\s+|named\\s+)?${NAMED}`
        + `|${NAMED}\\s+${A_DOCUMENT})`
        + `\\s+(?:to|as)\\s+${NAMED}\\s*$`,
      'i'
    ),
    read: (m) => ({ name: namedOrOpen(m[1] || m[2]), to: tidyLabel(m[3]), object: 'document' }),
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
    read: (m) => ({ name: namedOrOpen(m[1] || m[2]), to: tidyLabel(m[3]), object: 'document' }),
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
    read: (m) => ({ name: namedOrOpen(m[1]), text: String(m[2]).trim(), object: 'document' }),
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
      name: namedOrOpen(m[1]), from: m[2], to: m[3], object: 'document',
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
      `\\b(?:delete|remove|drop|get\\s+rid\\s+of)\\s+(?:the\\s+)?(?:test\\s+)?(?:scenarios?|rows?|cases?|numbers?|#)\\s*${NUMBER_LIST}`,
      'i'
    ),
    read: (m) => ({ snos: readNumbers(m[1]) }),
  },

  /* rename this to Workspace checks */
  {
    kind: 'rename-set',
    re: /\brename\s+(?:this|it|the\s+set|the\s+enhancement|(?:the\s+)?["'“]?(.+?)["'”]?)\s+(?:to|as)\s+["'“]?(.+?)["'”]?\s*$/i,
    read: (m) => ({ name: m[1] ? namedOrOpen(m[1]) : null, to: tidyName(m[2]) }),
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
  return MANAGING.test(text) && A_THING_IN_THE_TOOL.test(text);
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
    if (pattern.kind === 'edit-scenario' && !read.text) continue;

    /* A write-up has to be named to be renamed or moved: there is no "the
       open one" on a page that lists fifteen of them. Deleting one may go
       unnamed — it is put to the person before it happens anyway, and that
       is the moment to ask which. */
    if (read.object === 'document' && pattern.kind !== 'delete-document'
      && (!read.name || read.name.length < 3)) continue;

    /* What was captured as a write-up's name is the word for scenarios, so
       scenarios are what was asked about. */
    if (read.object === 'document' && read.name && STARTS_AS_SCENARIOS.test(read.name)) continue;

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
  const list = (ns) => (ns.length === 1 ? `scenario ${ns[0]}` : `scenarios ${ns.join(', ')}`);

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
      return `Rename the write-up "${command.name}" to "${command.to}".`;
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
      return `Rename "${command.name || context.enhancementName}" to "${command.to}".`;
    case 'delete-set':
      return `Delete "${command.name || context.enhancementName}" and every scenario in it. This cannot be undone.`;
    default:
      return 'Make that change.';
  }
}

module.exports = {
  parseCommand, describeCommand, readsAsAnInstruction, readNumbers, STATUS_WORDS,
};
