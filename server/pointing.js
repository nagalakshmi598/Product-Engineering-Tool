'use strict';

/**
 * "This one" — said while pointing at a screenshot.
 *
 * Marking the thing on screen and saying "delete this document" is how anyone
 * asks, and until now nothing read the mark: the instruction arrived with no
 * name in it, the tool could not tell which of fifteen write-ups was meant,
 * and it asked. Asking is the right answer when there is nothing to go on.
 * There is something to go on — the picture is right there.
 *
 * So the picture is read, against the list of things it could be, and the
 * answer is a name off that list or nothing. Nothing is a perfectly good
 * answer: it means asking, which is where this started.
 *
 * Nothing here deletes anything. What it returns is still put to the person
 * before it happens, exactly as a name typed by hand would be.
 */

const { activeProvider, friendlyApiError } = require('./testcases');

const SYSTEM = `You are shown one or more screenshots of a tool, and a numbered
list of the things in it that the user may have meant.

The user said "this one" while looking at those screenshots. Work out which
item on the list they meant.

Look for: an item highlighted, boxed, circled, arrowed or otherwise marked; an
item that is open or expanded; an item the screenshot is centred on; a name
visible in the picture that matches one on the list.

Answer with JSON only, no prose and no code fence:
{"number": 3, "why": "boxed in red in the second screenshot"}

If no item on the list is clearly the one, answer {"number": null, "why": "..."}.
Guessing is worse than not knowing: the user is told what was understood before
anything happens, and a wrong confident answer wastes that.`;

function readJson(answer) {
  const text = String(answer || '').replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '').trim();

  try {
    return JSON.parse(text);
  } catch (err) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try { return JSON.parse(text.slice(start, end + 1)); } catch (err2) { return null; }
  }
}

/** Pictures attached to a message, video frames among them. */
function picturesIn(attached) {
  return (attached || []).flatMap((file) => {
    if (file.image) return [{ image: file.image, mime: file.mime }];
    if (!file.frames) return [];
    return file.frames.map((frame) => ({ image: frame.image, mime: frame.mime || 'image/jpeg' }));
  });
}

/**
 * Which of these is the one in the picture?
 *
 * @param {object} options
 * @param {Array<{image: string, mime: string}>} options.pictures
 * @param {Array<{id: string, name: string}>} options.candidates
 * @param {string} [options.question] what was said while pointing
 * @param {string} [options.noun] what the candidates are, for the prompt
 * @returns {Promise<{id: string, name: string, why: string}|null>}
 */
async function whichOneIsShown({ pictures, candidates, question = '', noun = 'write-up' }) {
  const shots = (pictures || []).slice(0, 6);
  const list = (candidates || []).slice(0, 25);

  if (!shots.length || list.length < 2) return null;

  const { provider, model, ready } = activeProvider();
  if (!ready) return null;

  const text = [
    `The user said: "${String(question).slice(0, 300)}"`,
    '',
    `The ${noun}s they could have meant:`,
    ...list.map((row, i) => `${i + 1}. ${row.name}`),
    '',
    `Which one is the screenshot pointing at?`,
  ].join('\n');

  try {
    let answer;

    if (provider === 'openai') {
      const OpenAIModule = require('openai');
      const OpenAI = OpenAIModule.default || OpenAIModule;
      const client = new OpenAI();

      const completion = await client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: SYSTEM },
          {
            role: 'user',
            content: [
              { type: 'text', text },
              ...shots.map((p) => ({
                type: 'image_url',
                image_url: { url: `data:${p.mime};base64,${p.image}` },
              })),
            ],
          },
        ],
      });

      const choice = completion.choices && completion.choices[0];
      answer = (choice && choice.message && choice.message.content) || '';
    } else {
      const AnthropicModule = require('@anthropic-ai/sdk');
      const Anthropic = AnthropicModule.default || AnthropicModule;
      const client = new Anthropic();

      const message = await client.messages.create({
        model,
        max_tokens: 300,
        system: SYSTEM,
        messages: [{
          role: 'user',
          content: [
            ...shots.map((p) => ({
              type: 'image',
              source: { type: 'base64', media_type: p.mime, data: p.image },
            })),
            { type: 'text', text },
          ],
        }],
      });

      answer = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    }

    const parsed = readJson(answer);
    const n = parsed && Number(parsed.number);

    /* A number off the list, or nothing. Anything else is a model that has
       answered a different question. */
    if (!Number.isInteger(n) || n < 1 || n > list.length) return null;

    return { id: list[n - 1].id, name: list[n - 1].name, why: String((parsed && parsed.why) || '').slice(0, 160) };
  } catch (apiErr) {
    /* Not being able to read the picture is not a failure of the instruction:
       it falls back to asking which, which is what it did before. */
    if (process.env.NODE_ENV !== 'test') {
      console.error('could not read the screenshot:', friendlyApiError(apiErr, provider).message);
    }
    return null;
  }
}

module.exports = { whichOneIsShown, picturesIn, readJson };
