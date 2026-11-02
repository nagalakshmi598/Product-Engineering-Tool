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
          const system = String((messages[0] || {}).content || '');
          const user = messages[messages.length - 1];
          const text = typeof user.content === 'string'
            ? user.content
            : (user.content.find((p) => p.type === 'text') || {}).text || '';

          const named = /=== "([^"]+)" ===/.exec(text);
          const who = named ? named[1] : 'unknown';
          asked.push(who);

          /* What the turn asks for, reported back as scenarios, so that a
             briefing which stops asking for cover over the whole write-up
             shows up as a missing line rather than as nothing at all. */
          const briefed = [
            /COVER ALL OF IT/.test(text) && /every statement in turn/.test(text)
              && `Verify that ${who} is read statement by statement.`,
            /WRITE ONLY FROM IT/.test(text) && `Verify that ${who} is drafted from nothing else.`,
            /WHAT IT RULES OUT IS TESTED TOO/.test(text)
              && `Verify that what ${who} rules out is tested too.`,
            /READING ONE WRITE-UP/.test(system) && /count above does not apply/.test(system)
              && `Verify that ${who} is briefed without a scenario count.`,
          ].filter(Boolean);

          return {
            choices: [{
              message: {
                content: [
                  `${who}`,
                  '',
                  `1. [Positive] Verify that ${who} reports its total item count accurately.`,
                  `2. [Positive] Verify that ${who} lists items shared with anyone-with-the-link.`,
                  `3. [Negative] Verify that ${who} rejects a scan started without permissions.`,
                  ...briefed.map((line, i) => `${i + 4}. [Edge] ${line}`),
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
