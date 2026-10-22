'use strict';

/**
 * The in-tool assistant.
 *
 * It answers questions about what is actually in this tool — products,
 * enhancements, test scenarios, their pass/fail state, and the uploaded
 * write-ups. The whole store is small enough to hand to the model as context
 * on every turn, so the answers are grounded in real rows rather than guessed.
 *
 * Provider selection, keys and error wording are shared with test-case
 * generation; see testcases.js.
 */

const store = require('./store');
const { activeProvider, friendlyApiError } = require('./testcases');

/* A turn is capped so one huge document cannot crowd out the question. */
const MAX_QUESTION = 1000;
const MAX_HISTORY = 8;
/*
 * How much of each write-up the model is given.
 *
 * These are the source material: a feature is specified in them, with the
 * field names, the limits and the behaviours that make a scenario worth
 * writing. At twelve hundred characters a twelve-thousand character write-up
 * arrived as its first paragraph, and scenarios drafted from it could only be
 * generic. The documents here come to forty thousand characters in total,
 * which is a fraction of what the model can hold, so they go in whole.
 *
 * The budget is for the day there are two hundred of them: a write-up the
 * question actually names is never cut, and the rest fill what is left.
 */
const DOC_EXCERPT = 14000;
const DOC_BUDGET = 90000;
const SCENARIO_CAP = 400;

/** Open-ended questions need the model; the rest of the assistant still works. */
const UNAVAILABLE = (reason) => `${reason}, so I cannot answer open-ended questions right now.

I can still answer these straight from the tool:
  • How many scenarios are there? How many passed or failed?
  • Which enhancement has the most scenarios?
  • Show the failed scenarios
  • Find scenarios about <term>
  • Which enhancements have no test cases yet?
  • What documents do we have? What is <document> about?`;

const SYSTEM = `You are the assistant built into a QA test scenario tool used by the
product engineering team at CloudFuze, a cloud data migration company.

You answer questions about the data held in this tool: its products, the
enhancements under test, their test scenarios and pass/fail results, and the
enhancement write-ups that have been uploaded.

Rules:
- Answer only from the CONTEXT below. It is the complete contents of the tool.
- If the answer is not in the context, say so plainly and suggest where the user
  might look instead. Never invent a scenario, a count, a document or a result.
- Be exact with numbers. Count the rows in the context rather than estimating.
- Answer the whole question. Where the context supports it, give the detail:
  what the write-up actually states, which scenarios cover it, which do not,
  and what follows from that. A question worth asking is worth more than a
  sentence — but every sentence must earn its place. Do not pad, do not
  restate the question, and do not close with an offer to help further.
- Where a write-up is the source, say which one, and quote the part that
  settles the matter rather than paraphrasing it away.
- When you refer to a scenario, give its number and the enhancement it sits in.
- If the context does not settle it, say so plainly and say what would —
  a write-up that has not been uploaded, a scenario nobody has written.
- Plain text only. No markdown headings, no code fences, no tables.`;

const SYSTEM_DRAFT = `You are a senior QA engineer on CloudFuze, a cloud data
migration product. Teams migrate chat, mail and content between Slack, Microsoft
Teams, Google Chat, Google Drive, SharePoint and similar clouds.

The user describes a feature and wants test scenarios for it. Draft them.

Shape of the answer:
- Label every scenario with what kind of check it is. Immediately after the
  number, write exactly one of these three words in square brackets —
  [Positive], [Negative] or [Edge]. Use those words, not synonyms, and not
  [Pass] or [Fail]. A line looks like this:

      7. [Negative] Verify that migration is refused when the destination
         Team mapping is missing, and the reason is shown.

    Positive — the feature behaving as intended.
    Negative — it is used wrongly, a limit is exceeded, a mapping is missing,
               input is invalid, permission is absent; the tool must refuse
               cleanly rather than half-work.
    Edge     — the boundary and the unusual but legal: exactly at a limit,
               empty, maximum length, a single item, duplicates, re-running,
               two at once, interrupted partway.
- All three kinds must appear. Roughly a third positive; the rest split
  between negative and edge.
- Group the scenarios into short sections, one per dimension of the feature.
  Put the section name on its own line, then its scenarios under it.
  A section name is a few words, optionally with the limit in brackets —
  for example "User limit (3 users)", "Name preservation", "Permissions".
- Number the scenarios continuously across the whole answer, 1, 2, 3 …
- One line each, starting "Verify that ", one check per line, concrete enough
  that a tester can carry it out and get a yes or no.

What to cover:
- The happy path first, then the negative and edge cases for each section —
  the negatives are the point, so give them at least half the lines.
- What moves and what must survive it: names, content, order, timestamps,
  formatting, attachments.
- Who sees it afterwards: mapped and unmapped users, membership, permissions,
  guests and external users.
- Awkward input: special characters, emojis, maximum lengths, empty, very
  large, duplicates, case differences and aliases.
- Limits and quotas the user mentions — test the boundary, one under and one
  over, and the ways someone might try to get around them.
- The edges: re-running a migration, running two at once, deleting and
  retrying, partial failure, and the source being left untouched.

Rules:
- If the user states a limit, a behaviour or a rule, test exactly that. Do not
  soften it or invent a different one.
- Where a write-up in the CONTEXT covers the feature — because the user named
  it, or because it describes the same thing — draft from what it actually
  states. Use its field names, its limits, its error messages, its screens,
  its order of steps. A scenario that could have been written without reading
  it is a wasted line: "Verify that the migration completes" says nothing that
  the write-up does not already promise. Name the write-up you drew on in one
  short line before the scenarios.
- Where the write-up is silent on something a tester would need to know, write
  the scenario anyway and mark it: put "(not stated in the write-up)" at the
  end of the line, so the gap is visible rather than guessed over.
- The write-up is what you read, never what you test. It is a Word file
  describing how a migration behaves; the migration is the subject. Do not
  write a scenario about opening it, viewing it, downloading it, uploading it,
  its title, or whether it displays without errors. "Verify that the system
  allows users to open the document titled X" tests this tool's document
  viewer, which is not what anyone asked about. Every line must be about the
  behaviour the write-up describes.
- The CONTEXT below is the team's existing scenarios and write-ups. Match their
  wording and level of detail, and do not repeat a scenario already there.
- 12 to 20 scenarios unless the feature is small.
- Plain text only. No markdown, no bold, no bullets, no code fences, and no
  commentary before or after the list.`;

/** Strip tags so a document's matter reads as plain text, one block per line. */
function toPlainText(html) {
  return String(html || '')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\/\s*(p|h[1-6]|li|div|tr|blockquote|section|article)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function statusOf(scenario) {
  const value = scenario && scenario.status;
  return value === 'fail' || value === 'pending' ? value : 'pass';
}

/**
 * Everything in the tool, flattened into text the model can read.
 * Built fresh per question so the answers track the current data.
 */
/**
 * Everything the tool holds, as text for the model.
 * @param {string} [focus] the question being answered, so the write-up it
 *   names can be put first and given in full.
 */
async function buildContext(focus = '') {
  const products = (await store.listProducts());
  const lines = [];

  lines.push('=== PRODUCTS ===');
  products.forEach((p) => {
    lines.push(
      `${p.label} (key: ${p.key}) — ${p.enhancementCount} enhancements, ` +
        `${p.scenarioCount} test scenarios, ${p.documentCount || 0} documents. ${p.blurb}`
    );
  });

  lines.push('', '=== ENHANCEMENTS AND THEIR TEST SCENARIOS ===');
  let shown = 0;
  let hidden = 0;

  const allEnhancements = await store.allEnhancements();

  products.forEach((product) => {
    allEnhancements.filter((e) => e.product === product.key).forEach((enhancement) => {
      const scenarios = enhancement.scenarios || [];
      const counts = { pass: 0, fail: 0, pending: 0 };
      scenarios.forEach((s) => { counts[statusOf(s)] += 1; });

      lines.push('');
      lines.push(
        `[${product.label}] "${enhancement.name}" — ${scenarios.length} scenarios ` +
          `(${counts.pass} pass, ${counts.fail} fail, ${counts.pending} not run)` +
          (enhancement.description ? ` — ${enhancement.description}` : '') +
          (enhancement.sourceFile ? ` — source: ${enhancement.sourceFile}` : '')
      );

      scenarios.forEach((s) => {
        if (shown >= SCENARIO_CAP) { hidden += 1; return; }
        shown += 1;
        const extra = Object.entries(s.extra || {})
          .filter(([, v]) => v)
          .map(([k, v]) => `${k}: ${v}`)
          .join('; ');
        const cases = (s.testCases || []).length;
        lines.push(
          `  ${s.sno}. [${statusOf(s).toUpperCase()}] ${s.scenario}` +
            (extra ? ` (${extra})` : '') +
            (cases ? ` (${cases} detailed test cases generated)` : '')
        );
      });
    });
  });

  if (hidden) lines.push('', `(${hidden} further scenarios not listed here.)`);

  lines.push('', '=== ENHANCEMENT DOCUMENTS ===');
  lines.push('The write-ups the team has uploaded. These specify how a feature is');
  lines.push('meant to behave, and are the source for scenarios written about it.');

  const documents = await store.allDocuments();
  if (!documents.length) lines.push('No documents uploaded.');

  /* The write-up the question names goes first, and is never cut. */
  const named = focus ? findDocument(String(focus).toLowerCase(), documents) : null;
  const ordered = named ? [named, ...documents.filter((d) => d.id !== named.id)] : documents;

  let spent = 0;
  ordered.forEach((doc) => {
    const product = products.find((p) => p.key === doc.product);
    const text = toPlainText(doc.html);
    lines.push('');
    lines.push(
      `"${doc.name}" — ${product ? product.label : 'unassigned'}, file ${doc.fileName}, ` +
        `${doc.imageCount || 0} screenshots, added ${doc.createdAt}`
    );
    if (!text) return;

    const room = doc === named
      ? DOC_EXCERPT
      : Math.min(DOC_EXCERPT, Math.max(0, DOC_BUDGET - spent));

    if (!room) {
      lines.push('  (not included here — ask about this write-up by name to read it)');
      return;
    }

    const shown = text.slice(0, room);
    spent += shown.length;
    lines.push(`  ${shown}${text.length > shown.length ? ' …(truncated)' : ''}`);
  });

  return lines.join('\n');
}

/** Whether a provider turned the request down over an attached picture. */
function rejectsImage(err) {
  if (!err) return false;
  if (err.status && err.status !== 400 && err.status !== 415 && err.status !== 422) return false;

  return /image|picture|media_type|unsupported file|could not process/i.test(String(err.message || ''));
}

/** Attached files, as a block for the model to read alongside the question. */
function attachmentContext(files) {
  if (!files.length) return '';
  return [
    '',
    '=== FILES THE USER ATTACHED TO THIS MESSAGE ===',
    ...files.map((f) => `\n--- ${f.name} ---\n${f.text}`),
  ].join('\n');
}

/** A user turn carrying pictures, in OpenAI's shape. */
function openAiTurn(question, images) {
  if (!images.length) return { role: 'user', content: question };
  return {
    role: 'user',
    content: [
      { type: 'text', text: question },
      ...images.map((img) => ({
        type: 'image_url',
        image_url: { url: `data:${img.mime};base64,${img.image}` },
      })),
    ],
  };
}

/** The same, in Anthropic's shape. */
function anthropicTurn(question, images) {
  if (!images.length) return { role: 'user', content: question };
  return {
    role: 'user',
    content: [
      ...images.map((img) => ({
        type: 'image',
        source: { type: 'base64', media_type: img.mime, data: img.image },
      })),
      { type: 'text', text: question },
    ],
  };
}

async function callOpenAi({ model, context, question, history, system = SYSTEM, images = [] }) {
  const OpenAIModule = require('openai');
  const OpenAI = OpenAIModule.default || OpenAIModule;
  const client = new OpenAI();

  const completion = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: `${system}\n\n=== CONTEXT ===\n${context}` },
      ...history,
      openAiTurn(question, images),
    ],
  });

  const choice = completion.choices && completion.choices[0];
  return (choice && choice.message && choice.message.content) || '';
}

async function callAnthropic({ model, context, question, history, system = SYSTEM, images = [] }) {
  const AnthropicModule = require('@anthropic-ai/sdk');
  const Anthropic = AnthropicModule.default || AnthropicModule;
  const client = new Anthropic();

  const message = await client.messages.create({
    model,
    max_tokens: 2400,
    system: `${system}\n\n=== CONTEXT ===\n${context}`,
    messages: [...history, anthropicTurn(question, images)],
  });

  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

/* ---------------- answering from the store itself ----------------
   Most questions asked of this tool are structured: counts, results, lookups.
   Those are answered here, straight from the data — exact, instant, free, and
   working whether or not an AI key is configured. A model is only needed for
   open-ended questions, and it counts less reliably than this does. */

/* ---------------- drafting test scenarios ----------------
   Ask for scenarios on a feature and the write-ups are mined for the behaviour
   they state, each statement turned into a scenario to verify. Every line comes
   from something the team actually documented, so nothing is invented. */

/* The recurring shape of a migration test in this tool: what gets moved,
   what must survive the move, who can see it afterwards, and what happens at
   the edges. Used when no write-up exists for the feature yet. */
const MIGRATION_CHECKS = [
  'is migrated successfully from the source to the destination',
  'keeps its original name in the destination after migration',
  'keeps its content unchanged after migration',
  'preserves the original order and timestamps of the migrated items',
  'is migrated for every mapped source user',
  'excludes unmapped source users from the destination',
  'preserves membership and access permissions after migration',
  'handles names containing capital letters, spaces, special characters and emojis',
  'handles a name at the maximum length the destination allows',
  'does not create duplicates when the migration is run a second time',
  'reports a clear error when the migration fails partway through',
  'leaves the source unchanged after migration',
];

/** Title-style the feature so it reads as the subject of a sentence. */
function featureSubject(feature) {
  const s = feature.trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Words that can be lowercased when a statement becomes "Verify that …". */
const OPENERS = new Set([
  'the', 'a', 'an', 'all', 'any', 'each', 'both', 'no', 'only', 'this', 'these',
  'those', 'it', 'there', 'when', 'where', 'after', 'before', 'during', 'once',
  'if', 'users', 'user', 'members', 'files', 'messages', 'migration', 'migrated',
  'in', 'on', 'at', 'for', 'with', 'by', 'from', 'to', 'as', 'not', 'we', 'you',
  'they', 'multiple', 'every', 'while', 'unless', 'however', 'additionally',
  'also', 'based', 'using', 'under', 'within', 'across', 'post', 'existing',
]);

function asScenario(sentence) {
  let s = sentence.replace(/\s+$/, '');
  if (/^verify\b/i.test(s)) return s;

  const first = s.split(/\s+/)[0] || '';
  const lead = OPENERS.has(first.toLowerCase()) ? first.toLowerCase() : first;
  const rest = s.slice(first.length);
  return `Verify that ${lead}${rest}`;
}

/* The ask can sit at either end: "write scenarios for X", or a paragraph
   describing X that finishes "…write scenarios for this". Removing the ask
   wherever it appears leaves the feature either way. */
const ASK_PHRASE = new RegExp(
  '\\b(?:please\\s+)?(?:can you\\s+|could you\\s+)?' +
  '(?:i\\s+)?(?:write|give|generate|create|draft|suggest|provide|prepare|make|compose|need|want)\\s*' +
  '(?:me\\s+)?(?:some\\s+|a\\s+|an\\s+|the\\s+|few\\s+|new\\s+)*(?:test\\s+)?' +
  '(?:sce\\w*rios?|test\\s*cases?)' +
  '\\s*(?:for|on|about|regarding)?\\s*(?:this|that|it|these|those)?',
  'gi'
);
const ASK_BARE = /\b(?:sce\w*rios?|test\s*cases?)\s+(?:for|on|about|regarding)\s+/gi;

/** The feature the message is about, with the asking words stripped off. */
function featureOf(q) {
  const tidy = (s) => s
    .replace(/^\s*(this|that|the|a|an|our|my)\s+(new\s+)?feature\b/i, '')
    .replace(/^\s*(new\s+)?feature\b/i, '')
    // qualifiers that describe the request rather than the feature
    .replace(/[,\s]*\b(?:with|including|include|plus|and|also|add)\b\s*(?:the\s+)?(?:some\s+)?negative\b.*$/i, '')
    .replace(/[,\s]*\b(?:with|including|include)\b\s*(?:the\s+)?(?:edge|boundary|corner)\s*cases?\b.*$/i, '')
    .replace(/[,\s]*\b(?:and|then)?\s*(?:add|save|upload|put|store)\s+(?:them|it|these|this)\b.*$/i, '')
    .replace(/[\s:,\-]*\b(?:with|and|including|for|to|of|in|on|about)\s*$/i, '')
    .replace(/^[\s:,\-\u2013\u2014]+/, '')
    .replace(/[\s:,\-]+$/, '')
    .replace(/[?.!]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();

  const stripped = tidy(q.replace(ASK_PHRASE, ' ').replace(ASK_BARE, ' '));
  if (keyTerms(stripped).length >= 2) return stripped;

  // nothing meaningful survived — fall back to the whole message
  return tidy(q);
}

/** Edit distance, capped — only used on single words. */
function editDistance(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  let prev = Array.from({ length: cols }, (_, j) => j);

  for (let i = 1; i < rows; i += 1) {
    const row = [i];
    for (let j = 1; j < cols; j += 1) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = row;
  }
  return prev[cols - 1];
}

/** Does the question say "scenario"? Typed in a hurry, it often nearly does. */
function mentionsScenario(q) {
  return q.split(/[^a-z0-9]+/).some((word) => {
    if (word.length < 5) return false;
    return ['scenario', 'scenarios', 'testcase', 'testcases']
      .some((key) => editDistance(word, key) <= 2);
  });
}

/* Asking to see the scenarios already held is a different job from asking for
   new ones to be written, and the two share most of their vocabulary. */
/**
 * Reading the tool, rather than adding to it.
 *
 * The word alone is not enough: "the attendee list", "a distribution list",
 * "members can view the channel" and "we see duplicates" are plain migration
 * vocabulary, and taking any of them for a lookup turns a request to write
 * scenarios into a search of the write-ups. So the word has to be doing the
 * asking — opening the message, or governing one of the tool's own nouns. */
const LOOKUP_WORD = '(?:find|show|search|display|list|see|view|which|how many|are there|do we have|exist)';
const TOOL_NOUN = '(?:scenarios?|sceanrios?|test ?cases?|documents?|write-?ups?|enhancements?|results?|screenshots?|products?)';
const LOOKUP_VERBS = new RegExp(
  `^\\s*${LOOKUP_WORD}\\b|\\b${LOOKUP_WORD}\\b(?:\\s+\\w+){0,3}\\s+${TOOL_NOUN}\\b`
);
const DRAFT_VERBS = /\b(write|generate|create|draft|prepare|suggest|compose|provide|give|need|want|make|come up)\b/;

/**
 * Asking for an explanation, not for the data.
 *
 * "Show the failed scenarios" and "why did those fail" both mention failing,
 * but only the first wants the list. Replaying it for the second is how the
 * assistant ends up answering two different questions the same way.
 */
const REASONING = /\b(why|reason|reasons|cause|caused|causing|explain|explanation|how come|what makes|root cause)\b/i;

/**
 * Leaning on the previous turn to say what it is about.
 *
 * The canned answers see one message at a time, so "those scenarios" means
 * nothing to them; the model is given the recent turns and can resolve it.
 */
const REFERS_BACK = /\b(those|these|them|they|that one|the ones|above|previous|last answer)\b/i;

/*
 * Asking what something says, covers or amounts to.
 *
 * The write-ups run to twelve thousand characters. A question about what one
 * of them says needs the part that settles it, not the paragraph it happens
 * to open with, so these go to the model with the write-ups in front of it.
 */
const ASKS_FOR_AN_ACCOUNT = new RegExp(
  [
    '\\b(?:describe|summaris\\w+|summariz\\w+|elaborate|in detail|walk me through|tell me about)\\b',
    '\\bwhat (?:does|do|did)\\b[\\s\\S]{0,60}\\b(?:say|says|state|states|cover|covers|mean|means|include)\\b',
    '\\bwhat(?:\\u2019s| is|\\`s)\\b[\\s\\S]{0,60}\\babout\\b',
    '\\bhow (?:does|do|is|are|should)\\b[\\s\\S]{0,80}\\b(?:work|works|handled|migrated|behave|behaves)\\b',
  ].join('|'),
  'i'
);

function needsContext(q, history) {
  // "why did these fail" is answered from the store: it knows whether a
  // reason was ever recorded, which a model can only guess at from silence
  if (REASONING.test(q) && /\bfail/.test(q)) return false;

  if (REASONING.test(q)) return true;
  if (ASKS_FOR_AN_ACCOUNT.test(q)) return true;

  return Boolean(history && history.length) && REFERS_BACK.test(q);
}

/** Does this read as a question, rather than a statement of a feature? */
function isQuestion(q) {
  const s = q.trim();
  if (s.endsWith('?')) return true;
  return /^(how|what|whats|which|why|when|where|who|whose|is|are|was|were|do|does|did|can|could|should|would|will|has|have|any|tell|explain|describe|count)\b/.test(s);
}

/** Did the user ask, in so many words, for scenarios? */
function wantsScenarios(q) {
  if (!mentionsScenario(q)) return false;
  if (LOOKUP_VERBS.test(q)) return false;
  return DRAFT_VERBS.test(q) || /\b(scenarios?|test cases?|sceanrios?)\s+(for|on|about)\b/.test(q);
}

/**
 * Asked to put a write-up in the tool, and nothing more.
 *
 * "Upload this document in content" is one instruction with one outcome: the
 * write-up is filed. It used to be read as a feature being described, and
 * came back as nine test scenarios saved under a product nobody mentioned —
 * which is a great deal to happen to somebody who asked for a file to be
 * kept.
 *
 * Asking for both in one breath — "upload this and write scenarios" — still
 * does both.
 */
const FILING = /^(?:please\s+)?(?:upload|save|keep|file|store|add|put|attach)\b/i;
/* "write-up" is the thing being filed, not a request to write anything. */
const WANTS_MORE_THAN_FILING = /\b(?:scenarios?|test\s*cases?|draft|write(?!-?ups?\b)|generate|describe|summar)/i;

function justFileIt(question) {
  const q = String(question || '').trim();
  return FILING.test(q) && !WANTS_MORE_THAN_FILING.test(q);
}

/** Naming a feature is a request for scenarios too — no keyword needed. */
function isDraftRequest(q) {
  if (wantsScenarios(q)) return true;
  if (LOOKUP_VERBS.test(q) || isQuestion(q)) return false;
  return keyTerms(q).length >= 2;
}

/** The checklist, for when a drafting request cannot reach a model. */
function scenarioFallback(question) {
  const q = String(question).toLowerCase().trim();
  if (!isDraftRequest(q)) return null;

  const feature = featureOf(q);
  return keyTerms(feature).length ? checklistFor(feature) : null;
}

/** A starting set for a feature with no write-up behind it yet. */
function checklistFor(feature) {
  const subject = featureSubject(feature);
  const lines = [
    `No write-up covers "${feature}" yet, so here is a starting set from the checks this team applies to every migration feature:`,
    '',
  ];
  MIGRATION_CHECKS.forEach((check, i) => lines.push(`${i + 1}. Verify that ${subject} ${check}.`));
  lines.push('');
  lines.push('Upload the enhancement write-up and ask again — I will then draft scenarios from what it actually states, which will be sharper than this.');
  return lines.join('\n');
}

/**
 * @returns {string|null} a numbered draft, or null when this is not that kind of question
 */
async function draftScenarios(q, data) {
  if (!isDraftRequest(q)) return null;

  const feature = featureOf(q);
  const terms = keyTerms(feature);

  /* A model groups the checks and adds the negative cases a write-up never
     states, so it drafts whenever one is reachable — the write-ups reach it
     in context either way. Mining them here is the offline fallback. */
  if (activeProvider().ready) return null;
  if (!terms.length) {
    return 'Tell me the feature and I will draft scenarios from the write-ups, for example: "scenarios for group DM name migration".';
  }

  /* Words like "slack", "teams" and "migration" appear in every write-up, so
     matching only those says nothing about the topic. Work out which of the
     question's words actually narrow things down, and insist on one of them. */
  const bodies = [];
  data.documents.forEach((doc) => {
    if (doc.html) bodies.push({ name: doc.name, text: toPlainText(doc.html) });
  });

  const docFreq = {};
  terms.forEach((term) => {
    docFreq[term] = bodies.filter((b) => b.text.toLowerCase().includes(term)).length;
  });

  /* If a real word from the feature appears in none of the write-ups, they are
     not describing this feature — "reactions sync" shares "slack" and "teams"
     with every document while its own vocabulary is nowhere. That is a new
     feature: hand it to the model, or fall back to the checklist. */
  const absent = terms.filter((term) => term.length >= 4 && docFreq[term] === 0);
  if (absent.length) {
    if (activeProvider().ready) return null;
    return checklistFor(feature);
  }

  // Among the words that are present, insist on the least common ones —
  // they are what separates this feature from the rest of the product.
  const rarest = Math.min(...terms.map((term) => docFreq[term]));
  const usable = rarest < bodies.length ? terms.filter((term) => docFreq[term] === rarest) : [];

  const statements = [];
  const required = Math.max(Math.min(2, terms.length), Math.ceil(terms.length * 0.6));

  bodies.forEach((body) => {
    splitSentences(body.text).forEach((raw) => {
      const clean = tidySentence(raw);
      if (!clean) return;
      const low = clean.toLowerCase();
      const score = terms.filter((term) => low.includes(term)).length;
      if (score < required) return;
      if (usable.length && !usable.some((term) => low.includes(term))) return;
      statements.push({ clean, score, doc: body.name });
    });
  });

  if (!statements.length) {
    // A model can do better than a checklist for something undocumented, so
    // hand over when one is configured and working.
    if (activeProvider().ready) return null;
    return checklistFor(feature);
  }

  statements.sort((a, b) => b.score - a.score);

  // do not re-draft what the tool already has
  const existing = [];
  data.enhancements.forEach((e) => e.scenarios.forEach((s) => existing.push(s.scenario.toLowerCase())));

  const drafted = [];
  const seen = [];
  statements.forEach(({ clean, doc }) => {
    if (drafted.length >= 8) return;
    const scenario = asScenario(clean);
    const norm = scenario.toLowerCase().replace(/[^a-z0-9 ]/g, '');
    if (seen.some((k) => k === norm || k.includes(norm) || norm.includes(k))) return;
    if (existing.some((x) => x.includes(clean.toLowerCase().slice(0, 40)))) return;
    seen.push(norm);
    drafted.push({ scenario, doc });
  });

  if (!drafted.length) {
    return `Every documented behaviour for "${feature}" is already covered by scenarios in the tool. Ask "find scenarios about ${feature}" to see them, or describe what is new about the feature and I will draft from that.`;
  }

  const source = [...new Set(drafted.map((d) => d.doc))];
  const lines = [`${plural(drafted.length, 'scenario')} drafted for "${feature}":`, ''];
  drafted.forEach((d, i) => lines.push(`${i + 1}. ${d.scenario}`));
  lines.push('');
  lines.push(`Drawn from: ${source.join(', ')}. Paste any of these into Add a Test Scenario on the enhancement.`);

  return lines.join('\n');
}

/* ---------------- reading the documents ----------------
   Feature questions ("how are group DM names migrated?") are answered from the
   write-ups themselves. The question is reduced to its meaningful words, every
   sentence in every document is scored against them, and the best passages come
   back with the document they came from. No model needed, and it cites a real
   source rather than paraphrasing one. */

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am',
  'how', 'what', 'which', 'who', 'whom', 'when', 'where', 'why', 'whose',
  'do', 'does', 'did', 'doing', 'done', 'can', 'could', 'will', 'would',
  'shall', 'should', 'may', 'might', 'must', 'we', 'you', 'i', 'he', 'she',
  'it', 'they', 'them', 'their', 'our', 'my', 'me', 'us', 'your', 'his', 'her',
  'in', 'on', 'of', 'to', 'for', 'and', 'or', 'but', 'with', 'from', 'about',
  'into', 'over', 'under', 'after', 'before', 'during', 'at', 'by', 'as',
  'that', 'this', 'these', 'those', 'there', 'here', 'any', 'all', 'some',
  'has', 'have', 'had', 'get', 'gets', 'got', 'use', 'used', 'using',
  'way', 'ways', 'tell', 'show', 'explain', 'describe', 'regarding', 'please',
  'know', 'want', 'need', 'does', 'happen', 'happens', 'work', 'works',
]);

/** The words in a question that actually carry meaning. */
function keyTerms(q) {
  const words = q.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const terms = [];
  words.forEach((w) => {
    if (w.length < 3 || STOPWORDS.has(w)) return;
    let stem = w;
    if (stem.length > 4 && stem.endsWith('s') && !stem.endsWith('ss')) stem = stem.slice(0, -1);
    // longer words keep only their root, so "authenticate" finds "authentication"
    if (stem.length > 6) stem = stem.slice(0, Math.max(5, stem.length - 3));
    if (stem.length >= 3 && !terms.includes(stem)) terms.push(stem);
  });
  return terms;
}

function splitSentences(text) {
  return text
    .split(/\n+/)
    .flatMap((block) => block.split(/(?<=[.!?])\s+(?=[A-Z0-9“"'\u2022])/))
    .map((s) => s.trim())
    .filter((s) => s.length > 24);
}

/**
 * Trim a sentence down to the part worth reading, or drop it.
 * @returns {string} the cleaned sentence, or '' if it carries no information
 */
function tidySentence(raw) {
  let s = raw.replace(/\s+/g, ' ').trim();

  // a numbered heading stub: "Private Channel Migration (API Approach) 1."
  if (/\s\d+\.?$/.test(s)) return '';
  // a bare section number opening the line: "2.During Migration ..."
  s = s.replace(/^\d+\s*[.)]\s*/, '');

  if (s.split(/\s+/).length < 7) return '';     // headings and labels
  if (!/[a-z]/.test(s)) return '';               // ALL CAPS banners
  if (!/[.!?]["')\u201d]?$/.test(s)) return '';   // a heading, not a statement
  return s;
}

/** Drop repeats and sentences already contained in one we are keeping. */
function dedupe(sentences) {
  const kept = [];
  sentences.forEach((s) => {
    const norm = s.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
    const clash = kept.some((k) => {
      const kn = k.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
      return kn === norm || kn.includes(norm) || norm.includes(kn);
    });
    if (!clash) kept.push(s);
  });
  return kept;
}

/**
 * Passages from the write-ups that answer the question.
 * @returns {string|null}
 */
async function searchDocuments(q, documents) {
  const terms = keyTerms(q);
  if (terms.length < 2) return null;

  const perDoc = [];

  documents.forEach((doc) => {
    if (!doc.html) return;

    const text = toPlainText(doc.html);
    if (!text) return;

    // A document whose own title matches the question starts ahead.
    const titleWords = doc.name.toLowerCase();
    const titleBonus = terms.filter((term) => titleWords.includes(term)).length;

    const scored = splitSentences(text)
      .map((sentence) => {
        const clean = tidySentence(sentence);
        const low = clean.toLowerCase();
        const hits = terms.filter((term) => low.includes(term));
        return { sentence: clean, score: hits.length };
      })
      .filter((s) => s.sentence && s.score >= Math.min(2, terms.length));

    if (!scored.length) return;

    scored.sort((a, b) => b.score - a.score);
    const best = scored[0].score;

    perDoc.push({
      doc,
      titleBonus,
      best,
      total: scored.reduce((sum, s) => sum + s.score, 0),
      passages: dedupe(scored.map((s) => s.sentence)),
    });
  });

  if (!perDoc.length) return null;

  // Rank on what the text actually says; the title only breaks a close call.
  const rank = (d) => d.best * 3 + d.total * 0.4 + d.titleBonus;
  perDoc.sort((a, b) => rank(b) - rank(a));

  const top = perDoc[0];
  // A single weak keyword hit is not an answer.
  if (top.best < 2 && !top.titleBonus) return null;

  const answer = top.passages.slice(0, 3).join(' ');
  if (!answer) return null;

  return `${answer}\n\nSource: ${top.doc.name}`;
}

/** Everything flattened once, so the matchers below can just read it. */
async function snapshot() {
  const products = (await store.listProducts());
  const enhancements = [];

  const all = await store.allEnhancements();

  products.forEach((product) => {
    all.filter((e) => e.product === product.key).forEach((full) => {
      const scenarios = full.scenarios || [];
      enhancements.push({
        id: full.id,
        name: full.name,
        product,
        scenarios,
        counts: scenarios.reduce(
          (acc, s) => { acc[statusOf(s)] += 1; return acc; },
          { pass: 0, fail: 0, pending: 0 }
        ),
        withCases: scenarios.filter((s) => (s.testCases || []).length).length,
      });
    });
  });

  return { products, enhancements, documents: await store.allDocuments() };
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** The product the question names, if any. */
function findProduct(q, products) {
  return products.find((p) => q.includes(p.label.toLowerCase()) || q.includes(p.key)) || null;
}

/** The enhancement the question names — longest title match wins. */
function findEnhancement(q, enhancements) {
  return enhancements
    .filter((e) => q.includes(e.name.toLowerCase()))
    .sort((a, b) => b.name.length - a.name.length)[0] || null;
}

function findDocument(q, documents) {
  const named = documents
    .filter((d) => q.includes(d.name.toLowerCase()))
    .sort((a, b) => b.name.length - a.name.length)[0];
  if (named) return named;

  // fall back to a document whose title shares a distinctive word with the question
  const words = q.split(/[^a-z0-9]+/).filter((w) => w.length > 4);
  return documents.find((d) => {
    const title = d.name.toLowerCase();
    const hits = words.filter((w) => title.includes(w)).length;
    return hits >= 2;
  }) || null;
}

/** Scenarios in scope once a product or enhancement has been named. */
/**
 * What "the most" is counted in, picked from how the question is worded.
 * Ordered: the narrower wordings are tested before the general ones.
 */
const MEASURES = [
  { when: /fail/, of: (e) => e.counts.fail, noun: 'failing scenario' },
  { when: /pass/, of: (e) => e.counts.pass, noun: 'passing scenario' },
  { when: /not run|pending|untested|not tested/, of: (e) => e.counts.pending, noun: 'scenario not yet run' },
  { when: /test ?case/, of: (e) => e.withCases, noun: 'scenario with test cases' },
  { when: /scenario|test/, of: (e) => e.scenarios.length, noun: 'scenario' },
];

function scopedScenarios({ enhancements }, product, enhancement) {
  if (enhancement) return [{ enhancement, scenarios: enhancement.scenarios }];
  const list = product ? enhancements.filter((e) => e.product.key === product.key) : enhancements;
  return list.map((e) => ({ enhancement: e, scenarios: e.scenarios }));
}

function listScenarioLines(groups, filter, limit = 12) {
  const lines = [];
  let total = 0;
  groups.forEach(({ enhancement, scenarios }) => {
    scenarios.filter(filter).forEach((s) => {
      total += 1;
      if (lines.length < limit) lines.push(`  ${s.sno}. ${s.scenario}  — ${enhancement.name}`);
    });
  });
  return { lines, total };
}

/**
 * @returns {string|null} an answer, or null to let the model handle it.
 */
async function answerLocally(question) {
  const q = String(question).toLowerCase().trim();
  if (!q) return null;

  const data = await snapshot();
  const { products, enhancements, documents } = data;
  const product = findProduct(q, products);
  const enhancement = findEnhancement(q, enhancements);

  const totals = enhancements.reduce(
    (acc, e) => {
      acc.scenarios += e.scenarios.length;
      acc.pass += e.counts.pass;
      acc.fail += e.counts.fail;
      acc.pending += e.counts.pending;
      acc.withCases += e.withCases;
      return acc;
    },
    { scenarios: 0, pass: 0, fail: 0, pending: 0, withCases: 0 }
  );

  /* ---- drafting scenarios for a named feature ---- */
  if (wantsScenarios(q)) return draftScenarios(q, data);

  /* ---- what can you do ----
     Asked often enough, and answered badly for long enough, that the list is
     worth keeping right: everything this tool does can be done from here, and
     people go on doing it by hand because nothing ever said so. */
  if (/^(help|what can you do|what do you do|hi|hello|hey)\b/.test(q)
      || /\bwhat can you (?:answer|help)/.test(q)
      || /\b(?:what|which)\b.*\b(?:can|could|able to)\b.*\b(?:you|bot|agent)\b.*\bdo\b/.test(q)) {
    return [
      'Everything this tool does, you can ask me to do. Nothing here needs the buttons.',
      '',
      'WRITE-UPS',
      '  • Attach one to a message and I file it under the right product',
      '  • Rename the <name> document to <new name>',
      '  • File the <name> document under Email',
      '  • Add to the <name> document: <the sentence to add>',
      '  • In the <name> document, change "180 days" to "90 days"',
      '  • Delete the <name> document',
      '',
      'SCENARIOS',
      '  • Write test scenarios for <feature>, or just describe the feature',
      '  • Write scenarios for <write-up>, <write-up> and <write-up> separately',
      '  • Mark 4 and 7 as failed',
      '  • Change scenario 12 to: Verify that …',
      '  • Delete scenarios 4, 5 and 6',
      '  • Rename this to <new name>, or delete the <name> set',
      '',
      'TEST CASES',
      '  • Generate test cases for <set> — or just "generate test cases" with one open',
      '  • Regenerate test cases for <set>, to replace the ones there',
      '',
      'RECORDINGS',
      '  • Attach a screen recording and say "make a document in that format"',
      '    and I write it up step by step, with the screenshots',
      '',
      'AND ASKING',
      '  • How many scenarios are there? How many passed or failed?',
      '  • Which enhancement has the most scenarios?',
      '  • Which enhancements have no test cases yet?',
      '  • What is <document> about?',
      '',
      'Anything that cannot be undone, I put to you before I do it.',
    ].join('\n');
  }

  /* ---- a document named in the question ----
     The word "document" need not appear: naming the write-up is enough. */
  const namedDoc = findDocument(q, documents);
  if (namedDoc && !mentionsScenario(q)
      && /about|summar|say|contain|explain|what is|what's|tell me|describe/.test(q)) {
    const text = toPlainText(namedDoc.html);
    if (!text) {
      return `"${namedDoc.name}" has no readable text in the tool — it is a ${namedDoc.kind}. Open it to view the file.`;
    }
    return `"${namedDoc.name}" (${namedDoc.imageCount || 0} screenshots):\n\n${text.slice(0, 600)}${text.length > 600 ? '…' : ''}`;
  }

  /* ---- documents ---- */
  if (/document|write-?up|screenshot/.test(q)) {
    const doc = findDocument(q, documents);

    if (doc && /about|summar|say|contain|explain|what is|what's|tell me/.test(q)) {
      const text = toPlainText(doc.html);
      if (!text) return `"${doc.name}" has no readable text in the tool — it is a ${doc.kind}. Open it to view the file.`;
      const excerpt = text.slice(0, 600);
      return `"${doc.name}" (${doc.imageCount || 0} screenshots):\n\n${excerpt}${text.length > 600 ? '…' : ''}`;
    }

    if (/how many|count|number of/.test(q)) {
      const scoped = product ? documents.filter((d) => d.product === product.key) : documents;
      return product
        ? `${product.label} has ${plural(scoped.length, 'document')}.`
        : `There ${documents.length === 1 ? 'is' : 'are'} ${plural(documents.length, 'document')} in the tool.`;
    }

    if (/what|which|list|show/.test(q)) {
      const scoped = product ? documents.filter((d) => d.product === product.key) : documents;
      if (!scoped.length) return product ? `${product.label} has no documents yet.` : 'No documents have been uploaded yet.';
      const lines = scoped.map((d) => {
        const owner = products.find((p) => p.key === d.product);
        return `  • ${d.name} — ${owner ? owner.label : 'unassigned'}, ${plural(d.imageCount || 0, 'screenshot')}`;
      });
      return `${plural(scoped.length, 'document')}${product ? ` for ${product.label}` : ''}:\n${lines.join('\n')}`;
    }
  }

  /* ---- enhancements with no generated test cases ---- */
  if (/no test case|without test case|missing test case|not.*(generated|have).*test case/.test(q)) {
    const none = enhancements.filter((e) => e.withCases === 0);
    if (!none.length) return 'Every enhancement has at least one scenario with generated test cases.';
    return `${plural(none.length, 'enhancement')} with no generated test cases:\n${
      none.map((e) => `  • ${e.name} (${e.product.label}, ${plural(e.scenarios.length, 'scenario')})`).join('\n')}`;
  }

  /* ---- most / fewest ----
     "Most scenarios", "most failures" and "most test cases" all rank the same
     enhancements, by different measures. Ranking only by scenario count sent
     the rest down to the failure list, which answered a different question. */
  const measure = MEASURES.find(({ when }) => when.test(q));
  if (measure && /most|highest|largest|biggest|worst/.test(q)) {
    const top = [...enhancements].sort((a, b) => measure.of(b) - measure.of(a))[0];
    if (!top) return 'There are no enhancements yet.';
    return `"${top.name}" (${top.product.label}) has the most, with ${plural(measure.of(top), measure.noun)}.`;
  }
  if (measure && /fewest|least|lowest|smallest/.test(q)) {
    const low = [...enhancements].sort((a, b) => measure.of(a) - measure.of(b))[0];
    if (!low) return 'There are no enhancements yet.';
    return `"${low.name}" (${low.product.label}) has the fewest, with ${plural(measure.of(low), measure.noun)}.`;
  }

  /* ---- failed / not run ---- */
  const wantsFail = /fail/.test(q);
  const wantsPending = /not run|pending|untested|not tested|yet to/.test(q);

  /* Asked why they failed, with nothing recorded to answer it. The sheets
     carry a status and no note, so there is nothing here to explain with. */
  if (wantsFail && REASONING.test(q)) {
    const groups = scopedScenarios(data, product, enhancement);
    const { total } = listScenarioLines(groups, (s) => statusOf(s) === 'fail');
    const where = enhancement ? ` in "${enhancement.name}"` : product ? ` for ${product.label}` : '';
    /* Whatever the sheet recorded beside the failing row — a remark, a
       defect id, a tester's note — is the only reason the tool holds. */
    const noted = [];
    groups.forEach(({ enhancement, scenarios }) => {
      scenarios.forEach((s) => {
        if (statusOf(s) !== 'fail') return;
        const note = Object.entries(s.extra || {})
          .filter(([key, value]) => value && !/^(type|section)$/i.test(key))
          .map(([key, value]) => `${key}: ${value}`)
          .join('; ');
        if (note) noted.push(`  ${s.sno}. ${s.scenario}  — ${note}  (${enhancement.name})`);
      });
    });

    if (!noted.length) {
      return `The tool records that ${plural(total, 'scenario')} failed${where}, but not why. `
        + 'The uploaded sheets carry a status and no failure note, so there is nothing stored to explain them.\n\n'
        + 'To keep the reasons: add a column such as "Remarks", "Comments" or "Defect" to the sheet and '
        + 'upload it again — I will then report what it says against each failing scenario.';
    }

    return `${plural(noted.length, 'failing scenario')}${where} ${noted.length === 1 ? 'has' : 'have'} a recorded reason:\n`
      + `${noted.slice(0, 12).join('\n')}`
      + (noted.length > 12 ? `\n  …and ${noted.length - 12} more.` : '')
      + (total > noted.length ? `\n\nThe other ${total - noted.length} record no reason.` : '');
  }

  if (wantsFail || wantsPending) {
    const want = wantsFail ? 'fail' : 'pending';
    const label = wantsFail ? 'failed' : 'not yet run';
    const groups = scopedScenarios(data, product, enhancement);
    const { lines, total } = listScenarioLines(groups, (s) => statusOf(s) === want);
    const where = enhancement ? ` in "${enhancement.name}"` : product ? ` for ${product.label}` : '';

    /* "How many failed" asks for the number; "show the failed ones" asks for
       the list. Both mention failing, and answering them the same way is the
       whole complaint. */
    if (/how many|count|number of/.test(q)) {
      const scoped = groups.reduce((n, g) => n + g.scenarios.length, 0);
      return wantsFail
        ? `${total} of ${plural(scoped, 'scenario')}${where} failed.`
        : `${total} of ${plural(scoped, 'scenario')}${where} ${total === 1 ? 'has' : 'have'} not been run yet.`;
    }
    if (!total) return `No scenarios are marked ${label}${where}. ${totals.pass} of ${totals.scenarios} are passing.`;
    return `${plural(total, 'scenario')} ${label}${where}:\n${lines.join('\n')}${
      total > lines.length ? `\n  …and ${total - lines.length} more.` : ''}`;
  }

  /* ---- counts ---- */
  if (/how many|count|number of|total/.test(q)) {
    if (/test case/.test(q)) {
      return `${plural(totals.withCases, 'scenario')} have detailed test cases generated, out of ${totals.scenarios}.`;
    }
    if (/enhancement/.test(q)) {
      const n = product ? enhancements.filter((e) => e.product.key === product.key).length : enhancements.length;
      return product ? `${product.label} has ${plural(n, 'enhancement')}.` : `There are ${plural(n, 'enhancement')} across all products.`;
    }
    if (/product/.test(q)) {
      return `There are ${plural(products.length, 'product')}: ${products.map((p) => p.label).join(', ')}.`;
    }
    if (/scenario|test/.test(q)) {
      if (enhancement) {
        const c = enhancement.counts;
        return `"${enhancement.name}" has ${plural(enhancement.scenarios.length, 'scenario')} — ${c.pass} pass, ${c.fail} fail, ${c.pending} not run.`;
      }
      if (product) {
        const scoped = enhancements.filter((e) => e.product.key === product.key);
        const n = scoped.reduce((sum, e) => sum + e.scenarios.length, 0);
        const pass = scoped.reduce((sum, e) => sum + e.counts.pass, 0);
        return n
          ? `${product.label} has ${plural(n, 'test scenario')}, ${pass} of them passing.`
          : `${product.label} has no test scenarios yet.`;
      }
      return `There are ${plural(totals.scenarios, 'test scenario')} in total — ${totals.pass} pass, ${totals.fail} fail, ${totals.pending} not run.`;
    }
  }

  /* ---- a named enhancement or product, asked about generally ---- */
  if (enhancement && /about|status|summar|tell me|how is|what is|what's/.test(q)) {
    const c = enhancement.counts;
    return `"${enhancement.name}" sits under ${enhancement.product.label}. ` +
      `${plural(enhancement.scenarios.length, 'scenario')}: ${c.pass} pass, ${c.fail} fail, ${c.pending} not run. ` +
      `${enhancement.withCases} of them have detailed test cases.`;
  }
  if (product && /about|status|summar|tell me|how is|what is|what's|anything|any /.test(q)) {
    const scoped = enhancements.filter((e) => e.product.key === product.key);
    const n = scoped.reduce((sum, e) => sum + e.scenarios.length, 0);
    const docs = documents.filter((d) => d.product === product.key).length;
    if (!scoped.length) return `${product.label} has nothing in the tool yet — no enhancements, scenarios or documents.`;
    return `${product.label}: ${plural(scoped.length, 'enhancement')}, ${plural(n, 'test scenario')}, ${plural(docs, 'document')}.\n${
      scoped.map((e) => `  • ${e.name} — ${plural(e.scenarios.length, 'scenario')}`).join('\n')}`;
  }

  /* ---- free-text search over the scenarios ---- */
  const searchMatch = q.match(/(?:scenarios?|tests?)\s+(?:about|for|on|mentioning|related to|covering|with)\s+(.+)/)
    || q.match(/(?:find|search|show me|list|any)\s+(?:scenarios?|tests?)?\s*(?:about|for|on|mentioning|related to|covering|with)?\s*(.+)/);
  if (searchMatch) {
    const term = searchMatch[1].replace(/[?.!]+$/, '').trim();
    if (term.length >= 3) {
      const groups = scopedScenarios(data, product, enhancement);
      const { lines, total } = listScenarioLines(groups, (s) => s.scenario.toLowerCase().includes(term));
      if (total) {
        return `${plural(total, 'scenario')} mention "${term}":\n${lines.join('\n')}${
          total > lines.length ? `\n  …and ${total - lines.length} more.` : ''}`;
      }
    }
  }

  /* ---- a bare feature description: "group DM rename in Teams" ---- */
  if (isDraftRequest(q)) return draftScenarios(q, data);

  /* ---- a feature question: read the write-ups ---- */
  const fromDocs = await searchDocuments(q, documents);
  if (fromDocs) return fromDocs;

  /* ---- last resort before the model: any scenario mentioning these words ---- */
  const terms = keyTerms(q);
  if (terms.length >= 2) {
    const groups = scopedScenarios(data, product, enhancement);
    const { lines, total } = listScenarioLines(
      groups,
      (s) => {
        const low = s.scenario.toLowerCase();
        return terms.filter((term) => low.includes(term)).length >= Math.min(2, terms.length);
      },
      8
    );
    if (total) {
      return `Nothing in the documents covers that directly, but ${plural(total, 'scenario')} mention it:\n${
        lines.join('\n')}${total > lines.length ? `\n  …and ${total - lines.length} more.` : ''}`;
    }
  }

  return null;   // nothing matched with confidence — let the model try
}

/**
 * @param {{question: string, history: Array<{role: string, content: string}>}} input
 * @returns {Promise<{answer: string, model: string, provider: string}>}
 */
/* ---------------- turning a draft into rows the tool can hold ----------------
   The answer is prose with numbered lines. Pulling the scenarios back out of it
   means the chat can hand them straight to the store, with the section headings
   kept as a column so the grouping survives. */

/* Models do not all reach for the same word. Read whichever they picked as
   one of the three kinds, and ignore a bracketed aside that is none of them. */
const LABELS = {
  Positive: ['positive', 'pos', 'pass', 'happy', 'happy path', 'valid', 'success'],
  Negative: ['negative', 'neg', 'fail', 'failure', 'invalid', 'error', 'unhappy'],
  Edge: ['edge', 'edge case', 'boundary', 'limit', 'corner', 'corner case'],
};

function labelOf(word) {
  const w = String(word).trim().toLowerCase();
  return Object.keys(LABELS).find((kind) => LABELS[kind].includes(w)) || '';
}

/** The numbered "Verify that …" lines, with the section each one sat under. */
/* A scenario says what to check, and says it in one of a few shapes: a
   numbered line, a bulleted one, or a bare sentence. Only numbered lines were
   read, so a draft that came back as a plain list was parsed as nothing at
   all and the scenarios were lost on their way to the table. */
const DRAFT_LINE = /^(?:(\d+)[.)]|[-*\u2022\u25cf])\s+(.*)$/;
const OPENS_A_SCENARIO = /^(?:verify|check|ensure|validate|confirm)\b/i;

/* Markers strong enough to say what kind of check a line is, for a draft that
   came back without its labels. Anything they do not catch is positive: a
   check with no refusal in it is the feature working. */
const READS_NEGATIVE = /\b(?:fails?|failure|cannot|can't|is not|are not|does not|do not|rejected?|refus\w+|invalid|without permission|unauthoris\w+|unauthoriz\w+|error message|is blocked|is denied|is skipped|is excluded)\b/i;
const READS_EDGE = /\b(?:exactly|boundary|maximum|minimum|at the limit|empty|duplicate|re-?run|simultaneous\w*|at once|interrupted|partial\w*|very large|special characters?|emoji)\b/i;

function kindOf(text) {
  if (READS_NEGATIVE.test(text)) return 'Negative';
  if (READS_EDGE.test(text)) return 'Edge';
  return 'Positive';
}

/*
 * A scenario about the write-up rather than about what it describes.
 *
 * Given a specification to draft from, a model will occasionally test the
 * specification: "Verify that the system allows users to open the document
 * titled Outlook_Shared_Mailboxes_to_Google_Groups_Migration without errors."
 * That tests this tool's document viewer. The write-up is what is read, never
 * what is tested, and a line like it is dropped rather than filed.
 *
 * Narrow on purpose. "Verify that a document migrates with its permissions"
 * is a real Content scenario and has to survive: the phrases below are about
 * a write-up sitting in a tool, not about documents being migrated.
 */
const ABOUT_THE_WRITE_UP = [
  /\b(?:the|this|a)\s+(?:document|write-?up|file)\s+(?:titled|named|called)\b/i,
  /\b(?:open|view|download|upload|display|render)(?:s|ed|ing)?\s+(?:the|this)\s+(?:document|write-?up)\b/i,
  /\bthis\s+write-?up\b/i,
  /\b(?:document|write-?up)\s+(?:is\s+)?(?:displayed|opens|loads)\s+without\s+errors?\b/i,
  /\b(?:uploaded|attached)\s+(?:document|write-?up|specification)\b/i,
];

function aboutTheWriteUp(text) {
  return ABOUT_THE_WRITE_UP.some((pattern) => pattern.test(text));
}

function parseDraft(answer) {
  const rows = [];
  let section = '';

  String(answer).split(/\r?\n/).forEach((raw) => {
    const line = raw.trim();
    if (!line) return;

    const listed = line.match(DRAFT_LINE);
    const bare = !listed && OPENS_A_SCENARIO.test(line);
    if (!listed && !bare) {
      /* A short line that is not a sentence is a heading for what follows \u2014
         unless it is one of the markers that divide the context given to the
         model. A draft that echoed "=== ENHANCEMENTS AND THEIR TEST SCENARIOS
         ===" back put that on eighty-six rows as their section. */
      if (line.length <= 60 && !/[.!?]$/.test(line) && !/^[-*\u2022]/.test(line)
          && !/^=+/.test(line) && !/=$/.test(line)) {
        section = line.replace(/^[\[(]?\s*(?:positive|negative|edge)\s*[\])]?\s*[:\-]?\s*/i, '').replace(/[:\s]+$/, '');
      }
      return;
    }

    let text = (listed ? listed[2] : line).trim();

    // "[Negative] Verify that …" — the label becomes its own column
    let type = '';
    const labelled = text.match(/^[\[(]\s*([a-z \-]{3,20})\s*[\])]\s*[:\-]?\s*(.*)$/i);
    if (labelled) {
      const kind = labelOf(labelled[1]);
      if (kind) {
        type = kind;
        text = labelled[2].trim();
      }
    }

    if (text.length <= 10) return;
    if (!listed && !OPENS_A_SCENARIO.test(text)) return;

    // the write-up is what was read, not what is under test
    if (aboutTheWriteUp(text)) return;

    /* Unlabelled, the wording says which kind it is — and it has to say
       something, or a negative check would sit in the table marked Pass. */
    rows.push({ scenario: text, section, type: type || kindOf(text) });
  });

  return rows;
}

/** Which product a feature belongs to, from the words it uses. */
const PRODUCT_HINTS = {
  message: ['chat', 'message', 'dm', 'channel', 'slack', 'teams', 'conversation', 'thread', 'reaction'],
  email: ['email', 'mail', 'mailbox', 'inbox', 'folder', 'outlook', 'gmail', 'exchange'],
  content: ['file', 'folder', 'drive', 'document', 'sharepoint', 'onedrive', 'permission', 'content'],
  datasprawl: ['sprawl', 'duplicate', 'stale', 'redundant', 'orphan'],
  diy: ['diy', 'self-serve', 'self serve', 'self-service', 'self service', 'do-it-yourself'],
};

/*
 * Words that name a product outright, rather than merely belonging to it.
 *
 * Every product moves files and channels about, so those words say nothing
 * about which one a feature is for. These do: "mailbox" is email's, wherever
 * it appears. Slack and Teams are deliberately absent — a DIY migration is
 * usually Slack to Teams, and naming the platforms says nothing about which
 * product runs it.
 */
const PRODUCT_NAMED = {
  diy: /\bdiy\b|\bdo[- ]it[- ]yourself\b|\bself[- ]serv(?:e|ice)\b/,
  datasprawl: /\bdata[- ]?sprawl\b/,
  email: /\bemail (?:migration|product)\b|\bmailbox\b|\binbox\b|\boutlook\b|\bgmail\b|\bexchange\b/,
  content: /\bcontent (?:migration|product)\b|\bsharepoint\b|\bonedrive\b/,
  message: /\bmessage (?:migration|product)\b/,
};

/*
 * Saying where something goes: "upload this document in content", "file it
 * under Email", "put this in data sprawl".
 *
 * This is said about the tool, not about the feature, so it beats everything
 * else — including the product whose page happens to be open, which is what
 * it used to lose to. Somebody standing on Message and saying "in content"
 * means content.
 *
 * Anchored at the end, because that is where the destination goes. "Write
 * scenarios for content sprawl" names no destination and must not be read as
 * naming one.
 */
const PUT_IT_IN = new RegExp(
  '\\b(?:in|into|under|to|on)\\s+(?:the\\s+)?'
    + '(message|email|content|data[\\s-]?sprawl|diy)'
    + '(?:\\s+(?:product|tab|page|section|migration))?'
    /* where a destination ends: the sentence, a comma, or the next clause.
       "In content" and "in content and write scenarios" both say content;
       "for content sprawl" says nothing about where anything goes. */
    + '(?=\\s*[.!,;]|\\s+(?:and|then|also)\\b|\\s*$)',
  'i'
);

/** The product an instruction says to put something in, or null. */
function productSaidOutright(text) {
  const found = PUT_IT_IN.exec(String(text || ''));
  if (!found) return null;

  const key = found[1].toLowerCase().replace(/[\s-]/g, '');
  return key === 'datasprawl' ? 'datasprawl' : key;
}

/**
 * The product a drafted feature belongs under.
 *
 * Naming a product wins. Otherwise the product being looked at wins, because
 * someone reading a product's scenarios is almost always asking about it —
 * and a DIY feature is described in the same words as every other product,
 * so counting those words would file it under whichever one owns them.
 */
function guessProduct(feature, fallback) {
  const q = String(feature).toLowerCase();

  /* Told where it goes, it goes there. */
  const told = productSaidOutright(q);
  if (told && PRODUCT_HINTS[told]) return told;

  const named = Object.keys(PRODUCT_NAMED).find((key) => PRODUCT_NAMED[key].test(q));
  if (named) return named;

  if (fallback && PRODUCT_HINTS[fallback]) return fallback;

  let best = null;
  let bestScore = 0;

  Object.entries(PRODUCT_HINTS).forEach(([key, words]) => {
    const score = words.filter((w) => q.includes(w)).length;
    if (score > bestScore) { best = key; bestScore = score; }
  });

  return best || 'message';
}

/**
 * A title for the enhancement the rows will live under.
 *
 * The feature as typed is the best source, but a terse or garbled message
 * leaves nothing usable — "two aslso" is not a feature. When that happens the
 * drafted scenarios themselves say what this is about, so name it from their
 * first section heading, or from the first scenario.
 */
/* How people introduce a feature before naming it. None of this belongs in
   the title: the set is called "Huddle recording migration", not "We are
   adding a feature where a huddle recording…". */
const FRAMING = [
  /^(?:so\s+)?(?:we|i|they|our team)\s+(?:are|were|'re|am|have|has|had|want|need|would like|plan)\b[^.]*?\b(?:feature|functionality|capability|flow|option|change)\b\s*(?:where|that|which|called|named|for|to|in which|:)?\s*/i,
  /^there\s+(?:is|will be)\s+(?:a|an)\s+(?:new\s+)?(?:feature|functionality)\s*(?:where|that|which|called|named)?\s*/i,
  /^(?:the|this|a|an|our)\s+(?:new\s+)?(?:feature|functionality)\s+(?:is|where|that|which|lets|allows|enables|called|named)\s*/i,
  /^(?:in|for)\s+this\s+(?:feature|release|sprint)\s*,?\s*/i,
  /^(?:in|for|within|on)\s+(?:the\s+)?[\w-]+(?:\s+[\w-]+){0,2}\s+(?:product|tool|module)\b[,:]?\s*/i,
];

/* Words that make a span a statement about the feature rather than its name. */
const FINITE_VERB = /\b(?:is|are|was|were|will|would|can|could|should|must|lets|allows|enables|happens|gets|keeps|carries|shows)\b/i;

/** Product names the lower-casing upstream flattened. */
const PROPER = {
  slack: 'Slack', teams: 'Teams', microsoft: 'Microsoft', google: 'Google',
  sharepoint: 'SharePoint', onedrive: 'OneDrive', dropbox: 'Dropbox',
  outlook: 'Outlook', gmail: 'Gmail', jira: 'Jira', confluence: 'Confluence',
  zoom: 'Zoom', webex: 'Webex', egnyte: 'Egnyte', cloudfuze: 'CloudFuze',
  diy: 'DIY', csv: 'CSV', api: 'API', sso: 'SSO', url: 'URL', pdf: 'PDF',
};

function restoreNames(text) {
  return String(text).replace(/\b[a-z][a-z0-9]*\b/gi, (word) => PROPER[word.toLowerCase()] || word);
}

/**
 * The feature's name, taken from how it was described.
 *
 * A short ask is already a name — "shared channel migration" needs nothing
 * done to it. A described feature is a sentence, and the name is its subject:
 * everything up to the verb, once the framing is off.
 */
function nameFromAsk(feature) {
  let rest = String(feature).trim();
  FRAMING.forEach((pattern) => { rest = rest.replace(pattern, ''); });
  // "...scenarios for a feature where a user renames a workspace" leaves the
  // "where" behind once the framing in front of it has gone
  rest = rest.replace(/^(?:where|when|which|that|in which|whereby)\s+/i, '').trim();
  rest = rest.replace(/^(?:a|an|the)\s+/i, '').trim();

  const words = rest.split(/\s+/).filter(Boolean);
  if (words.length <= 8 && !FINITE_VERB.test(rest)) return rest;

  // a description: the subject is what sits in front of the verb
  const subject = rest.split(FINITE_VERB)[0]
    .replace(/[,;:]\s*$/, '')
    .replace(/\s+(?:and|or|with|from|to)\s*$/i, '')
    .trim();

  return subject.split(/\s+/).length >= 2 ? subject : rest;
}

function titleFor(feature, scenarios) {
  const fromAsk = enhancementName(nameFromAsk(feature));
  const terms = keyTerms(fromAsk);

  /* The real test is not how many words the ask had, but whether they describe
     what came back. "two aslso" is two words and means nothing; if none of its
     words appear in the scenarios, it is not what this set is about. */
  const body = scenarios.map((s) => s.scenario).join(' ').toLowerCase();
  const grounded = terms.filter((term) => body.includes(term)).length;

  const section = (scenarios.find((s) => s.section) || {}).section;

  /* What someone types to ask for scenarios is not always a name for them.
     "I uploaded total 9 data sprawl documents but you rewritten test one" is
     a complaint, and it ended up on the set as its title. Anything that runs
     past eight words is a sentence, and a sentence is never the name: the
     sections the draft came back in are, and failing those, what the first
     scenario is about. */
  const readsAsSentence = fromAsk.split(/\s+/).length > 8;

  if (!readsAsSentence && terms.length >= 2 && grounded >= 1
      && fromAsk.split(/\s+/).length >= 2) {
    return fromAsk;
  }

  if (section) return enhancementName(section);

  const first = (scenarios[0] || {}).scenario || '';
  const subject = first.replace(/^verify that\s+/i, '').split(/\s+(?:is|are|can|should|will|does|do)\s+/)[0];
  return enhancementName(subject || fromAsk || 'Drafted scenarios');
}

/** A title for the enhancement the rows will live under. */
function enhancementName(feature) {
  const first = String(feature).split(/(?<=[.!?])\s/)[0] || String(feature);
  const words = first
    .replace(/[\s:,\-]+$/, '')
    .replace(/[.!?]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ');

  const short = restoreNames(words.slice(0, 12).join(' ').replace(/[\s,\-]+$/, ''));
  const title = short.charAt(0).toUpperCase() + short.slice(1);
  return title.length > 120 ? `${title.slice(0, 117)}…` : title;
}

/** Did the user ask for the rows to go into the tool, not just to see them? */
function wantsSaved(q) {
  return /\b(add|save|upload|put|store|insert|append|create)\b[\s\S]*\b(tool|it|them|these|enhancement|list|table)\b/.test(q)
    || /\b(add|save|upload) (them|it|these|this)\b/.test(q)
    || /\binto the tool\b|\bto the tool\b|\bin the tool\b/.test(q);
}

/**
 * Ask for the kinds of scenario a draft came back without.
 *
 * The already-drafted lines are handed back so the model does not repeat
 * them, and so the numbering it returns can simply be thrown away — the
 * caller renumbers.
 */
async function askAgainFor(kinds, already, { provider, model, context, history, system, images, question }) {
  const wanted = kinds.join(' and ');
  const listed = already.map((s, i) => `${i + 1}. [${s.type}] ${s.scenario}`).join('\n');

  const ask = [
    `These scenarios were drafted for: ${question}`,
    '',
    listed,
    '',
    `They are missing ${wanted} scenarios entirely. Write 5 to 8 more, all of`,
    `them ${wanted}, for the same feature — the ways it is used wrongly, the`,
    'limits exceeded, the mappings missing, the permissions absent, the',
    'boundaries sat exactly upon, the runs repeated and interrupted.',
    '',
    'Do not repeat any scenario above. Number from 1 and label each one in',
    `square brackets exactly as [${kinds.join('] or [')}].`,
  ].join('\n');

  try {
    const answer = provider === 'openai'
      ? await callOpenAi({ model, context, question: ask, history, system, images: [] })
      : await callAnthropic({ model, context, question: ask, history, system, images: [] });

    return parseDraft(String(answer || '')).filter((s) => kinds.includes(s.type));
  } catch (err) {
    // the first draft stands; a set of positives beats no set at all
    return [];
  }
}

/*
 * Asking for scenarios across a shelf of write-ups rather than one.
 *
 * "I uploaded nine documents, write scenarios for them" is one question with
 * nine answers in it. Put to a model as a single call it picks a favourite
 * and writes about that: nine write-ups went in and one came back covered.
 * So each is drafted for in turn, and the sections carry the name of the
 * write-up they came from.
 */
const EVERY_WRITE_UP = new RegExp(
  [
    '\\b(?:all|every|each|both)\\b[\\s\\S]{0,40}\\b(?:documents?|write-?ups?|files?|specs?|specifications?)\\b',
    '\\b(?:documents?|write-?ups?|files?)\\b[\\s\\S]{0,30}\\b(?:all|every|each)\\b',
    '\\b\\d{1,3}\\s+(?:\\w+\\s+){0,3}(?:documents?|write-?ups?|files?)\\b',
    '\\b(?:documents?|write-?ups?)\\b[\\s\\S]{0,30}\\bone by one\\b',
  ].join('|'),
  'i'
);

function wantsEveryWriteUp(q) {
  return EVERY_WRITE_UP.test(String(q || ''));
}

/**
 * Asked for a set each rather than one set between them.
 *
 * This is the instruction people actually give — "write them separately",
 * "keep each one's scenarios on its own" — and it is given about whatever was
 * just named, which may be four write-ups listed by name and never once
 * called a document. So it is read on its own, without needing the word.
 *
 * Spelt as it is typed, which is not always as it is in a dictionary.
 */
const SEPARATELY = new RegExp(
  '\\b(?:'
    + 'sep[ae]r[ae]t(?:e|ely|ly|ed)?'            // separate, seperately, separatly
    + '|individual(?:ly)?'
    + '|one\\s+by\\s+one'
    + '|(?:its|their|his|her|each)\\s+own\\s+(?:set|list|enhancement|card)'
    + '|(?:set|list|enhancement)\\s+(?:each|per\\s+\\w+)'
  + ')\\b',
  'i'
);

function wantsThemApart(q) {
  return SEPARATELY.test(String(q || ''));
}

/* Pointing at a write-up rather than naming it. On the Documents page, with
   one open, "this document" is not a feature called "this document" — it is
   the one on the screen, and what is wanted is scenarios for what it says. */
const POINTS_AT_A_WRITE_UP = new RegExp(
  '\\b(?:this|that|the\\s+(?:open|current|attached|above|uploaded|given))\\s+'
    + '(?:documents?|docs?|write-?ups?|files?|specs?|specifications?|one)\\b'
    + '|\\b(?:inside|within|from|in)\\s+(?:this|that|the)\\s+'
      + '(?:documents?|docs?|write-?ups?|files?)\\b',
  'i'
);

/**
 * The write-ups a question names, in the order it names them.
 *
 * "For Egnyte - Content Sprawl Scope, Google Gmail - Email Sprawl Scope and
 * Slack Message Sprawl-InScope" names three, and those three are the job —
 * not every write-up filed under the product they happen to share.
 */
function writeUpsNamed(question, documents) {
  const q = String(question || '').toLowerCase();

  return documents
    .map((doc) => ({ doc, at: q.indexOf(doc.name.toLowerCase()) }))
    .filter((hit) => hit.at !== -1)
    .sort((a, b) => a.at - b.at)
    .map((hit) => hit.doc);
}

/**
 * The write-ups a question is about: the ones it names, a product's, or all.
 *
 * Says which of those it was, because naming four write-ups is itself an
 * instruction — it asks for those four — while falling back to every write-up
 * on the shelf is a guess, and a guess should not on its own split one answer
 * into fifteen.
 */
async function writeUpsInScope(question, currentProduct) {
  // enough text to specify something; a title page or a screenshot is not
  const all = (await store.allDocuments()).filter((d) => toPlainText(d.html).trim().length > 120);

  /* Named beats scoped. Someone who lists four write-ups has already said
     which ones they mean, and widening that to the product's other eleven
     answers a question nobody asked. */
  const named = writeUpsNamed(question, all);
  if (named.length) return { list: named, named: true };

  const product = findProduct(String(question).toLowerCase(), await store.listProducts());
  const key = product ? product.key : currentProduct;

  const scoped = key ? all.filter((d) => d.product === key) : [];
  return { list: scoped.length ? scoped : all, named: false };
}

/**
 * Draft for each write-up in turn, and label the sections with its name.
 *
 * One failed write-up does not sink the rest: whatever came back is kept and
 * the one that failed is named, so it can be asked for again on its own.
 */
async function draftPerWriteUp(documents, { provider, model, history, system, question, prefixSections = true }) {
  const sets = [];
  const refused = [];
  let total = 0;

  for (const doc of documents) {
    /* A write-up off the shelf is stored as HTML; one still attached to the
       message is plain text already. Either is the same thing to read. */
    const text = doc.text != null ? String(doc.text) : toPlainText(doc.html);
    const ask = [
      `Write test scenarios for the feature specified in this write-up.`,
      '',
      `=== "${doc.name}" ===`,
      text.slice(0, DOC_EXCERPT),
      '',
      'Draft from what it states — its field names, its limits, its messages.',
      'Write about the feature it specifies, never about the write-up itself:',
      'not uploading it, not opening it, not what the Documents page does with it.',
      prefixSections ? `Begin each section name with "${doc.name} — ".` : '',
    ].filter(Boolean).join('\n');

    try {
      const answer = provider === 'openai'
        ? await callOpenAi({ model, context: '', question: ask, history, system, images: [] })
        : await callAnthropic({ model, context: '', question: ask, history, system, images: [] });

      const rows = parseDraft(String(answer || ''));
      if (!rows.length) { refused.push(doc.name); continue; }

      /* Within its own set the write-up's name is on the card, so the section
         keeps whatever the draft called it. Combined into one, the name is
         put in front, because otherwise nothing says which write-up a row
         came from. */
      sets.push({
        name: doc.name,
        scenarios: rows.map((row) => ({ ...row, section: row.section || doc.name })),
      });
      total += rows.length;
    } catch (err) {
      refused.push(doc.name);
    }
  }

  return { sets, refused, total };
}

/* Asked for the lot in one set rather than one set each. */
const TOGETHER = /\b(?:in|as|into)\s+(?:a\s+|one\s+|the\s+)?(?:single|one|same)\s+(?:set|list|enhancement)\b|\btogether\b|\bcombined?\b|\ball in one\b/i;

function wantsThemTogether(q) {
  return TOGETHER.test(String(q || ''));
}

async function askAssistant({
  question,
  history = [],
  currentProduct,
  attachments = [],
  openEnhancement = null,
  openDocument = null,
} = {}) {
  const text = String(question || '').trim();
  if (!text) {
    const err = new Error('Ask a question first.');
    err.status = 400;
    throw err;
  }
  if (text.length > MAX_QUESTION) {
    const err = new Error(`Keep the question under ${MAX_QUESTION} characters.`);
    err.status = 400;
    throw err;
  }

  /* An attachment is the whole point of the message — a screenshot of a bug,
     a sheet of scenarios — so the local answerers, which cannot see it, step
     aside and the model takes the turn. */
  const files = Array.isArray(attachments) ? attachments : [];
  const fileText = files.filter((f) => f.text);

  /* A recording arrives already taken apart: the screens where something
     changed, in order, each knowing the second it came from. They go to the
     model as pictures, because that is what they are. */
  const images = files.flatMap((f) => {
    if (f.image) return [f];
    if (!f.frames) return [];

    return f.frames.map((frame) => ({
      name: `${f.name} at ${Math.floor(frame.at / 60)}:${String(frame.at % 60).padStart(2, '0')}`,
      image: frame.image,
      mime: frame.mime,
    }));
  });

  /* Structured questions are answered from the store: exact, instant, and
     independent of any API key or its billing state. A question that asks for
     a reason, or that points back at the last answer, is not one of those —
     it goes to the model, which has the recent turns and the same data. The
     canned answer is kept as the fallback for when no model is reachable. */
  const reasoned = needsContext(text, history);
  let stored = null;

  if (!files.length) {
    stored = await answerLocally(text);
    if (stored && !(reasoned && activeProvider().ready)) {
      return { answer: stored, model: 'built-in', provider: 'local' };
    }
  }

  /* Describing something is not asking for checks on it. "Describe each
     screen this recording goes through" wants the screens described, and
     answering with eight edge cases nobody asked for answers a different
     question — so an account asked for is an account given, attachment or
     no attachment. */
  const wantsAnAccount = ASKS_FOR_AN_ACCOUNT.test(text) || REASONING.test(text);

  const drafting = !wantsAnAccount
    && (Boolean(scenarioFallback(text)) || (files.length > 0 && isDraftRequest(text.toLowerCase())));

  const { provider, model, ready } = activeProvider();
  if (!ready) {
    const err = new Error(UNAVAILABLE('No AI key is configured'));
    err.status = 503;
    throw err;
  }

  // Only the recent turns, and only the two roles the APIs accept.
  const trimmed = (Array.isArray(history) ? history : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_QUESTION) }));

  const context = (await buildContext(text)) + attachmentContext(fileText);
  // a drafting request only reaches here when no write-up covered the feature
  // briefed to draft only when drafting is what was asked for
  const system = drafting ? SYSTEM_DRAFT : SYSTEM;

  /* A question about more than one write-up is answered a write-up at a time.
     Three ways of asking for that, all meaning the same thing: "all the
     documents", "write them separately", or simply listing them by name. */
  const scope = drafting
    ? await writeUpsInScope(text, currentProduct)
    : { list: [], named: false };

  /* Naming them is asking for them. Saying "separately" is asking for them
     apart. Either one is enough; falling back to the whole shelf is not. */
  const perWriteUp = drafting
    && (wantsEveryWriteUp(text) || wantsThemApart(text)
      || (!files.length && scope.named && scope.list.length > 1));

  /* One write-up, pointed at rather than described.
   *
   * "Write test scenarios for this document" was read as a feature called
   * "this document", and came back as scenarios about uploading documents.
   * What it asks for is the feature the write-up specifies — so the write-up
   * is found, its words are what the scenarios are drafted from, and the set
   * takes its name. */
  const theOpenOne = openDocument && POINTS_AT_A_WRITE_UP.test(text) ? openDocument : null;
  const theNamedOne = scope.named && scope.list.length === 1 ? scope.list[0] : null;

  /* A write-up that came with the message is the one being asked about.
   *
   * It is already filed by the time this runs, so it is also on the shelf —
   * and picking it off the shelf by name, or taking whichever write-up
   * happens to be open behind the chat, drafts from something that is not
   * what was just attached. Attaching it says which one plainly enough, and
   * its text is already in the context below.
   *
   * Naming one beats having one open, for the same reason: it is said rather
   * than inferred. */
  /* A write-up attached to the message is what the scenarios are for.
   *
   * It used to go down the general path, where the model is given the whole
   * tool and the sentence that introduced the file — and the sentence won.
   * "Upload this document in content" produced scenarios about clicking
   * Upload Document and picking a file off a device, from a write-up about
   * migrating Confluence to SharePoint. What is in the write-up is the thing
   * being asked about; the sentence only said where to put it. */
  const attachedWriteUps = files.filter((f) => (
    (f.kind === 'document' || f.kind === 'text') && String(f.text || '').trim().length > 200
  ));

  const theAttachedOne = drafting && !perWriteUp && attachedWriteUps.length === 1
    ? attachedWriteUps[0]
    : null;

  const justTheOne = theAttachedOne || (!files.length && !perWriteUp && drafting
    ? (theNamedOne || theOpenOne)
    : null);

  if (justTheOne) {
    const written = await draftPerWriteUp([justTheOne], {
      provider, model, history: trimmed, system: SYSTEM_DRAFT, question: text, prefixSections: false,
    });

    const set = written.sets[0];
    if (set && set.scenarios.length) {
      const lines = [
        `${plural(set.scenarios.length, 'scenario')} from what "${justTheOne.name}" specifies:`,
        '',
        ...set.scenarios.map((s, i) => `${i + 1}. [${s.type}] ${s.scenario}`),
      ];

      return {
        answer: lines.join('\n'),
        model,
        provider,
        draft: {
          feature: justTheOne.name,
          name: openEnhancement ? openEnhancement.name : justTheOne.name,
          product: openEnhancement
            ? openEnhancement.product
            : (justTheOne.product || guessProduct(text, currentProduct)),
          enhancementId: openEnhancement ? openEnhancement.id : null,
          scenarios: set.scenarios,
          save: wantsSaved(text),
        },
      };
    }
    /* Nothing came back from it — fall through and answer the ordinary way
       rather than saying no. */
  }

  if (perWriteUp) {
    const shelf = scope.list;

    if (shelf.length > 1) {
      const perDoc = await draftPerWriteUp(shelf, {
        provider, model, history: trimmed, system: SYSTEM_DRAFT, question: text,
      });

      if (perDoc.sets.length) {
        const product = openEnhancement ? openEnhancement.product : guessProduct(text, currentProduct);

        /* One set per write-up, which is what the Documents page already
           looks like and what anyone reading the results needs. Three
           hundred and sixty-five scenarios in a single set, named after no
           feature in particular, is a list nobody can work from.

           Asked for them together — "in one set", "combined" — they are
           combined instead. */
        /* Asked for them apart, they go apart even with a set open — the
           instruction is about the write-ups, not about the page. */
        if (!wantsThemTogether(text) && (wantsThemApart(text) || !openEnhancement)) {
          const lines = [
            `${plural(perDoc.total, 'scenario')} across ${plural(perDoc.sets.length, 'write-up')}, `
              + 'each filed under its own name:',
            '',
            ...perDoc.sets.map((s) => `  ${s.name} — ${plural(s.scenarios.length, 'scenario')}`),
          ];
          if (perDoc.refused.length) {
            lines.push('', `Nothing came back for: ${perDoc.refused.join(', ')}. Ask for those on their own.`);
          }

          return {
            answer: lines.join('\n'),
            model,
            provider,
            drafts: perDoc.sets.map((set) => ({
              feature: set.name,
              name: set.name,
              product,
              enhancementId: null,
              scenarios: set.scenarios,
              save: wantsSaved(text),
            })),
          };
        }

        /* Together, then: one set with the write-up's name on each section. */
        const everything = perDoc.sets.flatMap((s) => s.scenarios);
        const label = (await store.listProducts()).find((p) => p.key === product);
        const lines = [
          `${plural(everything.length, 'scenario')} across ${plural(perDoc.sets.length, 'write-up')}:`,
          '',
          ...perDoc.sets.map((s) => `  ${s.name} — ${plural(s.scenarios.length, 'scenario')}`),
          '',
          ...everything.map((s, i) => `${i + 1}. [${s.type}] ${s.scenario}`),
        ];

        return {
          answer: lines.join('\n'),
          model,
          provider,
          draft: {
            feature: 'the uploaded write-ups',
            name: openEnhancement ? openEnhancement.name : `${label ? label.label : 'Uploaded'} write-ups`,
            product,
            enhancementId: openEnhancement ? openEnhancement.id : null,
            scenarios: everything,
            save: wantsSaved(text),
          },
        };
      }
    }
  }

  const ask = (pictures) => (provider === 'openai'
    ? callOpenAi({ model, context, question: text, history: trimmed, system, images: pictures })
    : callAnthropic({ model, context, question: text, history: trimmed, system, images: pictures }));

  let dropped = '';

  try {
    let answer;
    try {
      answer = await ask(images);
    } catch (imageErr) {
      /* A picture the provider will not take should cost the message its
         picture, not its answer: the sheet or the write-up attached beside it
         is still readable, and so is the question. */
      if (!images.length || !rejectsImage(imageErr)) throw imageErr;

      answer = await ask([]);
      dropped = images.length === 1
        ? `I could not read ${images[0].name || 'the image'}, so this answers the rest of your message.\n\n`
        : `I could not read the ${images.length} images attached, so this answers the rest of your message.\n\n`;
    }

    // models leave markdown line-break spaces that do nothing in a chat bubble
    const tidy = answer
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+$/, ''))
      .join('\n')
      .trim();

    if (!tidy) {
      const err = new Error('No answer came back; try again.');
      err.status = 502;
      throw err;
    }
    let full = dropped + tidy;
    if (!drafting) return { answer: full, model, provider };

    let scenarios = parseDraft(tidy);

    /* A write-up states how a feature behaves, so a draft taken from one can
       come back as a list of confirmations — every scenario positive, not a
       refusal among them. The negatives are the point: they are where a
       migration tool is found out. Ask once more for the ones that are
       missing rather than filing a set that only checks the happy path. */
    if (scenarios.length) {
      const missing = ['Negative', 'Edge'].filter((kind) => !scenarios.some((s) => s.type === kind));

      if (missing.length) {
        const more = await askAgainFor(missing, scenarios, {
          provider, model, context, history: trimmed, system, images, question: text,
        });
        if (more.length) {
          scenarios = scenarios.concat(more);
          full += `\n\n${more.length} further ${missing.join(' and ').toLowerCase()} scenarios:\n`
            + more.map((s, i) => `${scenarios.length - more.length + i + 1}. [${s.type}] ${s.scenario}`).join('\n');
        }
      }
    }

    return {
      answer: full,
      model,
      provider,
      draft: scenarios.length ? {
        feature: featureOf(text.toLowerCase()),
        /* A write-up named in the question has already named the set:
           "Egnyte - Content Sprawl Scope" beats anything worked out from the
           sentence that asked for it, and beats "Unknown" by a mile. */
        name: openEnhancement
          ? openEnhancement.name
          : ((scope.named && scope.list.length === 1 && scope.list[0].name)
            || titleFor(featureOf(text.toLowerCase()), scenarios)),
        product: openEnhancement ? openEnhancement.product : guessProduct(text, currentProduct),
        enhancementId: openEnhancement ? openEnhancement.id : null,
        scenarios,
        save: wantsSaved(text),
      } : null,
    };
  } catch (apiErr) {
    if (stored) return { answer: stored, model: 'built-in', provider: 'local' };

    const fallback = scenarioFallback(text);
    if (fallback) return { answer: fallback, model: 'built-in', provider: 'local' };

    if (apiErr.status === 502) throw apiErr;
    const friendly = friendlyApiError(apiErr, provider);
    friendly.message = UNAVAILABLE(friendly.message);
    throw friendly;
  }
}

module.exports = { askAssistant, wantsThemApart, writeUpsNamed, justFileIt, productSaidOutright, buildContext, parseDraft, guessProduct, enhancementName, titleFor };
