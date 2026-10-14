'use strict';

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

/* ---------------- the instructions ---------------- */

const PATTERNS = [
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
const NEEDS_CONFIRMING = new Set(['delete-set', 'delete-scenarios']);

/**
 * Read a message as an instruction to change something.
 *
 * @returns {null|{kind: string, confirm: boolean, ...}}
 */
function parseCommand(question) {
  const text = String(question || '').trim();
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

    return { kind: pattern.kind, confirm: NEEDS_CONFIRMING.has(pattern.kind), ...read };
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
    case 'rename-set':
      return `Rename "${command.name || context.enhancementName}" to "${command.to}".`;
    case 'delete-set':
      return `Delete "${command.name || context.enhancementName}" and every scenario in it. This cannot be undone.`;
    default:
      return 'Make that change.';
  }
}

module.exports = { parseCommand, describeCommand, readNumbers, STATUS_WORDS };
