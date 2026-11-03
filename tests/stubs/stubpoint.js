'use strict';
/* Stands in for the model while "this one, in the screenshot" is tested. It
   checks the picture and the list actually arrived, then points at one. */
const Module = require('module');
const load = Module._load;

class FakeOpenAI {
  constructor() {
    this.chat = {
      completions: {
        create: async ({ messages }) => {
          const system = messages[0].content;
          const user = messages[messages.length - 1];
          const parts = Array.isArray(user.content) ? user.content : [];
          const text = (parts.find((p) => p.type === 'text') || {}).text || '';
          const images = parts.filter((p) => p.type === 'image_url');

          if (!/which\s+item on the list they meant/i.test(system)) {
            throw new Error('the pointing question was not the one asked');
          }
          if (!images.length) throw new Error('the screenshot was not attached');
          if (!/^data:image\/png;base64,/.test(images[0].image_url.url)) {
            throw new Error('the screenshot was not sent as a picture');
          }
          if (!/(?:write-up|set|thing)s they could have meant/i.test(text)) {
            throw new Error('the candidates were not listed');
          }

          /* Where the instruction said neither a set nor a write-up, both
             are on the list — and the list has to say which is which, or
             the two of them read as the same thing twice. */
          if (/things they could have meant/i.test(text)
            && !(/— set of scenarios/.test(text) && /— write-up/.test(text))) {
            throw new Error('a mixed list did not say which was which');
          }

          /* Pick whichever line mentions Dropbox, the way a reader would
             having seen it boxed in the picture. */
          const lines = text.split('\n').filter((l) => /^\d+\. /.test(l));
          const at = lines.findIndex((l) => /Dropbox/.test(l));

          return {
            choices: [{
              message: {
                content: JSON.stringify(at === -1
                  ? { number: null, why: 'nothing on the list is marked' }
                  : { number: at + 1, why: 'boxed in red in the screenshot' }),
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
