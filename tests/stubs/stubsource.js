'use strict';
/*
 * Stands in for the model, and answers from the part of the turn a model
 * would answer from — so drafting from the wrong source shows up as the wrong
 * scenarios rather than being hidden.
 *
 * A write-up attached to the message is put in its own block, and so is the
 * one a per-write-up ask is built around. Either block, when present, is what
 * the answer comes from; only when there is neither does the whole context
 * count.
 */
const Module = require('module');
const load = Module._load;

/* Each write-up carries one phrase that appears in no other. */
const MARKS = [
  { has: /retention cutover window/i, say: 'the retention cutover window is honoured for every mailbox' },
  { has: /archived channels/i, say: 'messages in archived channels are counted as stale' },
  { has: /anyone-with-the-link/i, say: 'items shared with anyone-with-the-link are listed' },
];

function whatToAnswerFrom(system, question) {
  /* A per-write-up ask: one write-up, fenced, as the question itself. */
  const fenced = /=== "[^"]+" ===\n([\s\S]*?)(?:\n\nDraft from what it states|$)/.exec(question);
  if (fenced) return fenced[1];

  /* A write-up attached to the message, in the context. */
  const attached = /=== FILES THE USER ATTACHED TO THIS MESSAGE ===([\s\S]*)$/.exec(system);
  if (attached) return attached[1];

  return `${system}\n${question}`;
}

class FakeOpenAI {
  constructor() {
    this.chat = {
      completions: {
        create: async ({ messages }) => {
          const system = messages[0].content || '';
          const user = messages[messages.length - 1];
          const question = typeof user.content === 'string'
            ? user.content
            : (user.content.find((p) => p.type === 'text') || {}).text || '';

          const source = whatToAnswerFrom(system, question);
          const found = MARKS.filter((m) => m.has.test(source));

          const lines = found.length
            ? found.map((m, i) => `${i + 1}. [Positive] Verify that ${m.say}.`)
            : ['1. [Positive] Verify that a user can upload a document to the tool.'];

          return { choices: [{ message: { content: lines.join('\n') } }] };
        },
      },
    };
  }
}

Module._load = function patched(request) {
  if (request === 'openai') return FakeOpenAI;
  // eslint-disable-next-line prefer-rest-params
  return load.apply(this, arguments);
};
