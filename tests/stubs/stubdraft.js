'use strict';
/* Stands in for the OpenAI SDK while the per-write-up drafting is tested, so
   the split can be checked without calling anything. Each call answers about
   whichever write-up it was handed, so a set carrying another one's scenarios
   is visible in the result rather than hidden by a canned reply. */
const Module = require('module');
const load = Module._load;

const asked = [];

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
          const who = named ? named[1] : 'unknown';
          asked.push(who);

          return {
            choices: [{
              message: {
                content: [
                  `${who}`,
                  '',
                  `1. [Positive] Verify that ${who} reports its total item count accurately.`,
                  `2. [Positive] Verify that ${who} lists items shared with anyone-with-the-link.`,
                  `3. [Negative] Verify that ${who} rejects a scan started without permissions.`,
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
