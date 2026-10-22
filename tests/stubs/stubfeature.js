'use strict';
/* Stands in for the model, and answers from whatever write-up it was handed —
   so a draft taken from the question instead of from the write-up shows up as
   the wrong scenarios rather than being hidden by a canned reply. */
const Module = require('module');
const load = Module._load;

class FakeOpenAI {
  constructor() {
    this.chat = {
      completions: {
        create: async ({ messages }) => {
          const user = messages[messages.length - 1];
          const text = typeof user.content === 'string'
            ? user.content
            : (user.content.find((p) => p.type === 'text') || {}).text || '';

          const named = /=== "([^"]+)" ===/.exec(text);

          /* Handed a write-up: answer from what is in it. */
          if (named) {
            const lines = [];
            if (/archived channels/i.test(text)) {
              lines.push('1. [Positive] Verify that messages in archived channels older than 180 days are counted as stale.');
              lines.push('2. [Positive] Verify that direct messages are excluded unless the workspace owner opts in.');
              lines.push('3. [Negative] Verify that a scan started without owner consent is refused.');
            } else {
              lines.push('1. [Positive] Verify that the write-up content was read.');
            }
            if (/never about the write-up itself/i.test(text)) lines.unshift('Scan scope');
            return { choices: [{ message: { content: lines.join('\n') } }] };
          }

          /* Handed only the question: this is the path that produced
             scenarios about uploading documents. */
          return {
            choices: [{
              message: {
                content: [
                  '1. [Positive] Verify that a user can upload a document to the tool.',
                  '2. [Positive] Verify that the uploaded document appears on the Documents page.',
                  '3. [Negative] Verify that an unsupported file type is rejected on upload.',
                ].join('\n'),
              },
            }],
          };
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
