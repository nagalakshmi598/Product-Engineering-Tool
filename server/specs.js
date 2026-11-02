'use strict';

/**
 * Writing up a functionality as a write-up, from the description of it.
 *
 * Someone types what a feature does — in one message or across a few of
 * them — and asks for the document. What comes back is the write-up that
 * would otherwise be typed into Word and uploaded by hand: a title, an
 * opening line, then a section per case, each stating the behaviour one
 * bullet at a time, in the style of the write-ups already on the shelf.
 *
 * It is written straight into the tool. Nobody saves a file, nobody opens
 * the Documents page, nobody picks a product off the dropdown: the message
 * goes in and the write-up is filed.
 *
 * This is the other half of walkthrough.js. That one writes a document from
 * a recording of someone doing the thing; this one writes it from someone
 * saying what the thing is. Neither touches the drafting of test scenarios —
 * "write scenarios for X" is still answered the way it always was, and the
 * reply here offers scenarios rather than writing them unasked.
 */

const crypto = require('crypto');

const { activeProvider, friendlyApiError } = require('./testcases');
const { wantsAGuide, readJson } = require('./walkthrough');
const { escapeHtml, richText } = require('./guides');
const store = require('./store');

const SYSTEM = `You write the enhancement write-up that QA and product keep
for every feature and customisation — the document someone would otherwise
type into Word and upload.

You are given a description of a functionality, in the words of the person
who knows it. Write it up.

HOW THE WRITE-UP READS
- The title names the feature as a document would be titled: "Group DM Name
  Migration", "Shared Mailbox to Google Groups Mapping", "Delta Migration
  Pre-Checks". Not a sentence, not a question, never "The user" or
  "The system".
- The intro is one sentence saying what the feature is and where it applies.
- Each section is a case: a destination, a migration path, a mode, a state,
  a stage of the flow. Its heading names that case the way the write-ups do
  — "For Teams Destination - Slack to Teams, Teams to Teams", "Validation and
  Error Handling", "Out of Scope".
- Name the case in the description's own words. Do not add "Source",
  "Destination", a cloud or a direction that was not given: a heading that
  says more than the description does is already inventing.
- A section's text is one or two sentences of context, and may be left out
  where the bullets say it all.
- The bullets are the write-up. One statement of behaviour per bullet, a
  full sentence, present tense, saying what happens and what is seen:
  "The original Group DM name from the source is preserved during migration."
  "A scan started without owner consent is refused with **Consent required**."
- Put the exact on-screen label of a button, field, tab, status or message
  in **double asterisks**. Use "->" for a source-to-destination path; it is
  rendered as an arrow.

WHAT GOES IN IT
- Only what the description says, or what plainly follows from it. Never
  invent a limit, a count, a character length, a cloud, a field name or an
  error message that was not given. A write-up that states a number nobody
  said is worse than one that leaves it out.
- Cover, where the description gives something to say: what the feature
  does, the cases and paths it applies to, what the user does and sees,
  validation and error handling, and what is out of scope.
- As many sections as the description has cases in it, and no more. A
  sentence makes a short write-up; a page of detail makes a long one. Never
  pad a thin description into a thick document.

HOW MUCH DETAIL
- Write the document, not a summary of it. Someone tests against this, so
  every case the description gives is written out in full: what the user
  does, what the tool does in response, what is shown on the screen, what is
  carried across or stored, and what state things are left in.
- Where the description gives a sequence, write the sequence — one bullet
  per thing that happens, in the order it happens.
- Where it gives a rule, write the rule and the cases it applies to, each on
  its own bullet, including the ones where it does not apply.
- Where it gives a refusal, an error or a block, write what triggers it,
  what is shown, and what the reader can do next.
- A case with a lot in it becomes two or three sections rather than one
  section of twenty bullets. Sections are how the document is navigated.

WHAT IS NOT IN IT
- No "Open Points", "Open Questions", "Assumptions", "Notes", "TBD" or any
  other section about what you were not told. Never ask the reader a
  question, and never say the description did not cover something. Silence
  stays silence: what was not described is simply not in the document.
- Nothing you were not given. Detail means saying everything the
  description implies, not filling gaps with plausible invention.

Return JSON only, no prose and no code fence:
{"title":"...","intro":"...","sections":[{"heading":"...","text":"...","bullets":["..."]}]}`;

/* ---------------- is a write-up what was asked for ---------------- */

/**
 * The ways of asking that walkthrough.js does not already cover.
 *
 * "Write a document for this" is read the same whether a recording came
 * with it or not, so that regex is reused rather than copied; these are the
 * words people reach for when what they have is a description rather than a
 * screen: spec, requirement, feature document, "write this up".
 */
const ALSO_ASKS = new RegExp(
  '\\b(?:'
    + '(?:write|create|make|prepare|produce|generate|draft|build|add|put)'
      + '(?:\\s+(?:me|us|a|an|the|this|that|it|one|new|proper|properly|detailed'
        + '|detail|full|complete|clear|in|into|up|same|format|way|tool|feature)){0,6}'
      + '\\s+(?:spec|specs|specification|requirements?|frd|brd|feature\\s+document)'
    + '|write\\s+(?:this|that|it|these)\\s+up'
    + '|document\\s+(?:this|the)\\s+(?:functionality|feature|behaviou?r|requirement|enhancement|change)'
  + ')\\b',
  'i'
);

/**
 * Asked for a document, rather than for scenarios or for an answer.
 *
 * "Write test scenarios for this document" names a document and asks for
 * nothing of the kind, so the noun alone is not enough; both regexes want
 * the making verb running into the word for the thing.
 */
function wantsAWriteUp(question) {
  const text = String(question || '');
  if (!text.trim()) return false;

  /* The one phrasing that says "document" twice over: scenarios from a
     document that already exists. Nothing is being written up. */
  if (/^(?:please\s+)?(?:can\s+you\s+)?(?:write|draft|generate|create|make|give)\s+(?:me\s+)?(?:some\s+|the\s+|a\s+|all\s+)?(?:test\s+)?(?:scenarios?|cases?)\b/i.test(text.trim())) {
    return false;
  }

  return wantsAGuide(text) || ALSO_ASKS.test(text);
}

/* ---------------- what the write-up is about ---------------- */

/* The ask itself, so that what is left is the description. "Create a
   document for this functionality: ..." leaves the functionality. */
const THE_ASK = new RegExp(
  '^\\s*(?:please\\s+|hi\\s+|hey\\s+|ok(?:ay)?\\s+|and\\s+|also\\s+|now\\s+|then\\s+)*'
    + '(?:can\\s+you\\s+|could\\s+you\\s+|you\\s+(?:need\\s+to\\s+|should\\s+)?)?'
    + '(?:write|create|make|prepare|produce|generate|draft|build|put|add|give)'
    + '(?:\\s+(?:me|us|a|an|the|this|that|it|one|new|proper|properly|detailed|detail'
      + '|full|complete|clear|in|into|up|same|format|way|tool))*'
    + '\\s+(?:document|doc|docs|write-?up|writeup|spec|specs|specification'
      + '|requirements?|guide|manual|sop|frd|brd)'
    /* "... for this functionality:", "... about the feature -", "... of this"
       — the preposition, whatever stands in for the feature, and the colon
       or dash that introduces it. What follows is the description. */
    + '(?:\\s*(?:for|about|on|of|from|with|covering|regarding)'
      + '(?:\\s+(?:me|us|this|that|the|it|our|my|a|an))*'
      + '(?:\\s+(?:functionality|functionalities|feature|features|behaviou?r'
        + '|requirements?|enhancement|change|flow|module|screen|story))?'
    + ')?'
    + '\\s*(?::|-|\\u2014|\\u2013)?\\s*',
  'i'
);

/* Said after the ask and belonging to it, not to the feature: "and upload
   it to the tool", "in the same format", "in detail". */
const TRAILING_ASK = new RegExp(
  '\\s*(?:,|and|then|also)?\\s*(?:please\\s+)?'
    + '(?:upload|save|store|keep|file|put|add)\\s+(?:it|this|that|them)?'
    + '(?:\\s+(?:in|into|to|under|on))?\\s*(?:the\\s+)?(?:tool|documents?\\s*page|documents?|content|shelf)?\\s*\\.?\\s*$',
  'i'
);

/** What is left of a message once the asking is taken out of it. */
function describedIn(question) {
  let text = String(question || '').trim();
  if (!text) return '';

  text = text.replace(THE_ASK, '');
  /* Run the trailing clause off twice: "and upload it" then a stray "in the
     tool" left behind by the first pass. */
  text = text.replace(TRAILING_ASK, '').replace(TRAILING_ASK, '');

  return text.trim();
}

/* A description has to say something. One word left over — "this", "it",
   "functionality" — is a pointer to a description, not a description. */
const A_POINTER = /^(?:this|that|it|them|these|the\s+)?(?:functionality|feature|behaviou?r|requirement|enhancement|change|one|thing)?[\s.:,-]*$/i;

/**
 * The description the write-up is written from.
 *
 * Usually the message itself. Often not: "I will give you functionality
 * then you should create document" is how people work — the feature is
 * described, then the document is asked for, and the description is a
 * message or two back. So what was said before counts, newest last, as
 * long as it was said by the person rather than by the tool.
 */
function whatToWriteAbout(question, history = []) {
  const here = describedIn(question);
  const said = [];

  (Array.isArray(history) ? history : [])
    .slice(-8)
    .filter((turn) => turn && turn.role === 'user' && String(turn.content || '').trim())
    .forEach((turn) => {
      const text = String(turn.content).trim();
      /* An earlier ask for a document is not a description of one. */
      if (wantsAWriteUp(text) && describedIn(text).length < 25) return;
      if (text.length < 30) return;
      said.push(text);
    });

  const substantial = here.length >= 25 && !A_POINTER.test(here);

  if (substantial) {
    /* The message carries the feature. Earlier turns are context around it,
       not the subject, so they go in behind it and only if there are any. */
    return said.length
      ? `${here}\n\nSaid earlier in the same conversation:\n${said.slice(-3).join('\n\n')}`
      : here;
  }

  if (!said.length) return '';

  return said.slice(-3).join('\n\n');
}

/* ---------------- asking the model ---------------- */

async function ask({ system, text }) {
  const { provider, model, ready } = activeProvider();
  if (!ready) {
    const err = new Error('No AI key is configured, so the write-up cannot be written.');
    err.status = 503;
    throw err;
  }

  try {
    if (provider === 'openai') {
      const OpenAIModule = require('openai');
      const OpenAI = OpenAIModule.default || OpenAIModule;
      const client = new OpenAI();

      const completion = await client.chat.completions.create({
        model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: text }],
      });

      const choice = completion.choices && completion.choices[0];
      return (choice && choice.message && choice.message.content) || '';
    }

    const AnthropicModule = require('@anthropic-ai/sdk');
    const Anthropic = AnthropicModule.default || AnthropicModule;
    const client = new Anthropic();

    const message = await client.messages.create({
      model,
      max_tokens: 4000,
      system,
      messages: [{ role: 'user', content: text }],
    });

    return message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  } catch (apiErr) {
    throw friendlyApiError(apiErr, provider);
  }
}

/* ---------------- writing it into the tool ---------------- */

/** A title that names the feature, or nothing — never "The user". */
function cleanTitle(title) {
  const name = String(title || '').trim().replace(/^["'“]|["'”]$/g, '').replace(/\.$/, '');
  if (name.length < 3 || name.length > 120) return '';
  if (/^(?:the|an?)\s+(?:user|system|feature|functionality|document|write-?up)\b/i.test(name)) return '';
  return name;
}

/* A heading that is about the description rather than about the feature.
   The write-up says what the functionality does; what it was not told is
   not a part of it, and a model that adds the section anyway has it taken
   back off here rather than only being asked not to. */
const NOT_ABOUT_THE_FEATURE = /^(?:open\s+(?:points|questions|items|issues)|questions|assumptions?|clarifications?|to\s*be\s*(?:confirmed|decided)|tbd|notes?\s+for\s+(?:review|product|qa))\b/i;

function sectionsFrom(parsed) {
  const raw = parsed && Array.isArray(parsed.sections) ? parsed.sections : [];

  return raw
    .filter((section) => !NOT_ABOUT_THE_FEATURE.test(String((section && (section.heading || section.title)) || '').trim()))
    .map((section) => ({
      heading: String(section.heading || section.title || '').trim(),
      text: String(section.text || '').trim(),
      bullets: (Array.isArray(section.bullets) ? section.bullets : [])
        .map((b) => String(b || '').trim())
        .filter(Boolean),
    }))
    .filter((section) => section.heading && (section.text || section.bullets.length));
}

/** The HTML, in the shape the Documents page already renders. */
function pageOf({ title, intro, sections }) {
  const lines = [`<h1>${escapeHtml(title)}</h1>`];
  if (intro) lines.push(`<p>${richText(intro)}</p>`);

  sections.forEach((section) => {
    lines.push(`<h3>${richText(section.heading)}</h3>`);
    if (section.text) lines.push(`<p>${richText(section.text)}</p>`);
    if (section.bullets.length) {
      lines.push('<ul>');
      section.bullets.forEach((b) => lines.push(`<li>${richText(b)}</li>`));
      lines.push('</ul>');
    }
  });

  return lines.join('\n');
}

/**
 * Write a functionality up and file it.
 *
 * @param {object} args
 * @param {string} args.question    what was asked
 * @param {Array}  [args.history]   the conversation so far
 * @param {string} [args.product]   the product to file it under
 * @returns {Promise<{document: object, title: string, sections: number, bullets: number}>}
 */
async function writeSpec({ question, history = [], product = '' }) {
  const source = whatToWriteAbout(question, history);
  if (!source) {
    const err = new Error('Nothing was described, so there is nothing to write up.');
    err.status = 400;
    err.needsADescription = true;
    throw err;
  }

  const answer = await ask({
    system: SYSTEM,
    text: [
      'The functionality, as described:',
      '',
      source.slice(0, 12000),
      '',
      'Write it up in full: a section for each case it gives, and in each',
      'section everything the description settles about that case. No section',
      'about what it did not settle.',
    ].join('\n'),
  });

  const parsed = readJson(answer);
  const sections = sectionsFrom(parsed);

  if (!sections.length) {
    const err = new Error('The write-up came back empty. Say the functionality again and I will try once more.');
    err.status = 502;
    throw err;
  }

  /* A model that will not name the document does not stop the document
     being written: the first section names it well enough. */
  const title = cleanTitle(parsed && parsed.title) || cleanTitle(sections[0].heading) || 'Feature Write-up';
  const intro = String((parsed && parsed.intro) || '').trim();
  const html = pageOf({ title, intro, sections });

  const document = await store.createDocument({
    id: crypto.randomUUID(),
    name: title,
    description: '',
    product,
    enhancementId: '',
    fileName: `${title}.html`,
    kind: 'text',
    html,
    imageCount: 0,
    storedFile: '',
    mime: 'text/html; charset=utf-8',
    sizeBytes: Buffer.byteLength(html, 'utf8'),
  });

  return {
    document,
    title,
    sections: sections.length,
    bullets: sections.reduce((n, s) => n + s.bullets.length, 0),

    /* The write-up as it was written, rather than as it was stored. The
       chat shows it where it was asked for — the Documents page is a click
       away, not the only place it can be read. */
    page: { title, intro, sections },
  };
}

module.exports = {
  writeSpec,
  wantsAWriteUp,
  whatToWriteAbout,
  describedIn,
  cleanTitle,
  sectionsFrom,
  pageOf,
};
