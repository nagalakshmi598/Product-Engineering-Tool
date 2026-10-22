'use strict';

/**
 * Writing up a recording as a walkthrough.
 *
 * Someone records themselves working through the product — signing in,
 * creating a workspace, connecting clouds, running the migration — and what
 * is wanted back is the document that would be written by hand afterwards:
 * numbered steps, a sentence per step saying what to do and what to click,
 * and the screen it was done on underneath.
 *
 * The recording is already a strip of screens by the time it reaches here
 * (see video.js), so the work is reading that strip: which screens are a step
 * and which are the same screen a second later, what the step is called, and
 * what the sentence under it says. That reading is the one part a model does.
 *
 * It reads the strip a handful at a time. A twenty-minute migration is more
 * screens than fit in one turn, and a guide that stops at screen twenty-four
 * stops before the migration starts — so each batch is given the steps
 * already written, and carries on from them.
 */

const { activeProvider, friendlyApiError } = require('./testcases');
const { writeGuide } = require('./guides');

/* How many screens go to the model at once. Small enough that every one of
   them is looked at properly, large enough that a step spanning two screens
   is usually seen whole. */
const PER_BATCH = 8;

/* A step may cover more than one screen — the dialog, then what it did — but
   a step covering nine is a model that has stopped reading. */
const MAX_SHOTS_PER_STEP = 3;

const SYSTEM = `You are writing a product walkthrough from a screen recording,
in the house style of CloudFuze's migration guides.

You are shown consecutive screens from the recording, in order. Each is
labelled with its number and the second it was taken at.

Write the steps a reader would follow to do the same thing themselves.

HOW A STEP READS
- The title is a short noun phrase naming the action: "Sign In", "Create a
  Workspace", "Add the Source Cloud", "Verify the Connection", "Configure
  Migration Options", "Enable Delta Migration".
- The text is one to three sentences, addressed to the reader, saying what to
  do and what happens: "From the Workspaces page, click New Workspace, enter
  the Workspace Name and Tenant Name, then click Create Workspace to create a
  dedicated migration project."
- Put the exact on-screen label of anything clicked, typed into, or read in
  **double asterisks**: buttons, tabs, fields, statuses, page names. Take the
  label from the screen, letter for letter. Never invent one.
- Where a screen offers a list of options or settings, use bullets, one per
  option, each naming the option and saying what it does.

WHICH SCREENS BECOME STEPS
- Consecutive screens showing the same thing — a spinner, a page mid-load, a
  cursor moved — are one step, or none.
- Group the screens of one action into one step: list their numbers in
  "frames", in order. A dialog and its result belong together.
- A screen showing nothing a reader needs is left out entirely.
- Never describe a screen you were not shown, and never carry on past the last
  one you were given.

Return JSON only, no prose and no code fence:
{"steps":[{"frames":[1,2],"title":"Create a Workspace","text":"From the ...","bullets":[]}]}`;

const TITLE_SYSTEM = `You name documents. Given the steps of a walkthrough,
return JSON only: {"title":"...","intro":"..."}.

The title names the journey the way the guide's own heading would: "DIY Email
Migration Guide For Outlook to Gmail". The intro is one sentence saying what
the guide covers and where it starts and ends. No code fence.`;

/* Asked to write it up, rather than asked about it. "What does this recording
   show?" wants an answer in the chat; these want a document on the shelf. */
const ASKS_FOR_A_GUIDE = new RegExp(
  '\\b(?:'
    + 'walk-?through|step[-\\s]?by[-\\s]?step'
    /* The verb, then however the ask runs on to the word for the thing —
       "write a document", "give that in detail in document itself", "make it
       in a proper write-up". The words allowed in between are listed rather
       than left open, so "write scenarios from the document" is not read as
       a request for one. */
    + '|(?:write|make|create|prepare|produce|generate|give|draft|build|do|put)'
      + '(?:\\s+(?:me|us|a|an|the|this|that|it|all|in|into|detail|detailed|proper'
        + '|full|complete|entire|clear|clearly|way|same|format|like)){0,6}'
      + '\\s+(?:document|doc|guide|write-?up|manual|sop)'
    + '|document\\s+(?:it|this|the\\s+(?:steps|process|migration|flow))'
    + '|(?:in|into)\\s+(?:that|this|the\\s+same|pdf)\\s+format'
    + '|(?:same|that)\\s+format'
  + ')\\b',
  'i'
);

function wantsAGuide(question) {
  return ASKS_FOR_A_GUIDE.test(String(question || ''));
}

/** The JSON a model returns, however it chose to wrap it. */
function readJson(answer) {
  const text = String(answer || '').replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '').trim();

  try {
    return JSON.parse(text);
  } catch (err) {
    /* A model that adds a sentence before the JSON has still answered. */
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch (err2) {
      return null;
    }
  }
}

function clock(seconds) {
  const whole = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/* ---------------- asking the model ---------------- */

function openAiTurn(text, images) {
  return {
    role: 'user',
    content: [
      { type: 'text', text },
      ...images.map((img) => ({
        type: 'image_url',
        image_url: { url: `data:${img.mime};base64,${img.image}` },
      })),
    ],
  };
}

function anthropicTurn(text, images) {
  return {
    role: 'user',
    content: [
      ...images.map((img) => ({
        type: 'image',
        source: { type: 'base64', media_type: img.mime, data: img.image },
      })),
      { type: 'text', text },
    ],
  };
}

async function ask({ system, text, images = [] }) {
  const { provider, model, ready } = activeProvider();
  if (!ready) {
    const err = new Error('No AI key is configured, so the recording cannot be read.');
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
        messages: [{ role: 'system', content: system }, openAiTurn(text, images)],
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
      messages: [anthropicTurn(text, images)],
    });

    return message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  } catch (apiErr) {
    throw friendlyApiError(apiErr, provider);
  }
}

/* ---------------- reading the strip ---------------- */

/**
 * Every screen from every recording attached to the message, in order.
 *
 * Two clips are two halves of one session often enough — the migration ran
 * long and the recording was split — that they are read as one run of screens
 * rather than two guides.
 */
function screensFrom(clips) {
  const out = [];

  clips.forEach((clip) => {
    (clip.frames || []).forEach((frame) => {
      /* The model is given the picture as base64, because that is what the
         APIs take; the document is given the bytes, because that is what gets
         written to disk. A frame arrives as one or the other depending on who
         pulled it out of the recording, so both are kept. */
      const base64 = Buffer.isBuffer(frame.image) ? frame.image.toString('base64') : String(frame.image || '');
      if (!base64) return;

      out.push({
        at: frame.at,
        image: base64,
        bytes: Buffer.isBuffer(frame.image) ? frame.image : Buffer.from(base64, 'base64'),
        mime: frame.mime || 'image/jpeg',
        clip: clip.name,
      });
    });
  });

  return out;
}

/** Read one batch of screens into steps, knowing what came before. */
async function stepsFrom(batch, { offset, done, question }) {
  const already = done.slice(-6).map((s, i) => `${done.length - Math.min(done.length, 6) + i + 1}. ${s.title}`);

  const lines = [
    done.length
      ? `Steps already written, which you are continuing from (do not repeat them):\n${already.join('\n')}\n`
      : 'These are the opening screens of the recording.\n',
    `Screens ${offset + 1} to ${offset + batch.length}, in order:`,
    ...batch.map((s, i) => `  ${i + 1}. at ${clock(s.at)}`),
    '',
    'Write the steps these screens show. Number the frames as listed above,',
    'starting at 1 for the first screen in this batch.',
  ];

  if (question) lines.push('', `What was asked for: ${String(question).slice(0, 400)}`);

  const parsed = readJson(await ask({ system: SYSTEM, text: lines.join('\n'), images: batch }));
  const steps = parsed && Array.isArray(parsed.steps) ? parsed.steps : [];

  return steps
    .map((step) => {
      /* Frame numbers are the model's one chance to get the screenshot wrong,
         so they are checked against the batch rather than trusted. */
      const picked = (Array.isArray(step.frames) ? step.frames : [step.frame])
        .map((n) => Number(n))
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= batch.length)
        .filter((n, i, all) => all.indexOf(n) === i)
        .sort((a, b) => a - b)
        .slice(0, MAX_SHOTS_PER_STEP);

      return {
        title: String(step.title || '').trim(),
        text: String(step.text || '').trim(),
        bullets: (Array.isArray(step.bullets) ? step.bullets : []).map((b) => String(b || '').trim()).filter(Boolean),
        screenshots: picked.map((n) => batch[n - 1].bytes),
        at: picked.length ? batch[picked[0] - 1].at : batch[0].at,
      };
    })
    .filter((step) => step.title && step.text);
}

/** What to call the finished thing. */
async function nameIt(steps, question) {
  const asked = /["'“]([^"'”]{8,80})["'”]/.exec(String(question || ''));
  const given = asked ? asked[1].trim() : '';

  try {
    const parsed = readJson(await ask({
      system: TITLE_SYSTEM,
      text: [
        'The walkthrough has these steps, in order:',
        ...steps.map((s, i) => `${i + 1}. ${s.title}`),
        question ? `\nWhat was asked for: ${String(question).slice(0, 400)}` : '',
      ].join('\n'),
    }));

    return {
      title: given || String((parsed && parsed.title) || '').trim() || 'Walkthrough',
      intro: String((parsed && parsed.intro) || '').trim(),
    };
  } catch (err) {
    /* A guide with a plain name is worth more than no guide. */
    return { title: given || 'Walkthrough', intro: '' };
  }
}

/**
 * Turn the recordings attached to a message into a guide on the shelf.
 *
 * @param {object} options
 * @param {Array} options.clips   attachments of kind 'video', with their frames
 * @param {string} options.question what was asked
 * @param {string} [options.product] the product tab to file it under
 * @returns {Promise<{document: object, steps: number, screens: number, used: number}>}
 */
async function writeWalkthrough({ clips, question = '', product = '' }) {
  const screens = screensFrom(clips);
  if (!screens.length) {
    const err = new Error('No screens could be read from that recording.');
    err.status = 400;
    throw err;
  }

  const steps = [];

  for (let i = 0; i < screens.length; i += PER_BATCH) {
    const batch = screens.slice(i, i + PER_BATCH);
    // one batch at a time, on purpose: each needs to know what the last wrote
    // eslint-disable-next-line no-await-in-loop
    const written = await stepsFrom(batch, { offset: i, done: steps, question });
    steps.push(...written);
  }

  if (!steps.length) {
    const err = new Error('Nothing in that recording read as a step worth writing down.');
    err.status = 422;
    throw err;
  }

  const { title, intro } = await nameIt(steps, question);

  const document = await writeGuide({
    title,
    product,
    intro,
    steps: steps.map(({ title: stepTitle, text, bullets, screenshots }) => ({
      title: stepTitle, text, bullets, screenshots,
    })),
  });

  return {
    document,
    steps: steps.length,
    screens: screens.length,
    used: steps.reduce((n, s) => n + s.screenshots.length, 0),
  };
}

module.exports = { writeWalkthrough, wantsAGuide, readJson, screensFrom, PER_BATCH };
