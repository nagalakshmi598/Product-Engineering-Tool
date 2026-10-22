'use strict';
/* Stands in for the OpenAI SDK inside the server, so the walkthrough path can
   be run end to end without calling anything or spending anything. */
const Module = require('module');
const load = Module._load;

let turn = 0;

class FakeOpenAI {
  constructor() {
    this.chat = {
      completions: {
        create: async ({ messages }) => {
          const user = messages[messages.length - 1];
          const parts = Array.isArray(user.content) ? user.content : [];
          const text = (parts.find((p) => p.type === 'text') || {}).text || '';
          const images = parts.filter((p) => p.type === 'image_url');

          /* Everything the real call would be given has to actually be there. */
          if (/You name documents/.test(messages[0].content)) {
            return {
              choices: [{ message: { content: '{"title":"DIY Email Migration Guide For Outlook to Gmail","intro":"This guide covers the migration from signing in to delta migration."} ' } }],
            };
          }

          if (!images.length) throw new Error('the screens were not attached to the turn');
          if (!/image\/jpeg;base64,/.test(images[0].image_url.url)) throw new Error('a screen was not sent as an image');

          turn += 1;
          /* The second batch has to be told what the first wrote, or the
             guide repeats itself from screen nine onwards. */
          if (turn > 1 && !/Steps already written/.test(text)) {
            throw new Error('batch ' + turn + ' was not told what came before');
          }
          const n = Math.min(images.length, 2);

          return {
            choices: [{
              message: {
                content: '```json\n' + JSON.stringify({
                  steps: [
                    {
                      frames: [1],
                      title: `Sign In ${turn}`,
                      text: 'Enter your registered **CloudFuze** email address and password, then click **Sign In**.',
                      bullets: [],
                    },
                    {
                      frames: n > 1 ? [2, 3, 999] : [1],
                      title: `Create a Workspace ${turn}`,
                      text: 'From the **Workspaces** page, click **New Workspace** --> **Create Workspace**.',
                      bullets: ['**From Date** - the date emails are migrated from.', '**Migrate Rules** - recreate Gmail rules in Outlook.'],
                    },
                    /* a page that reports rather than asks: no step number */
                    {
                      frames: [1],
                      title: `Migration Progress ${turn}`,
                      text: 'The migration starts automatically and the **Migration Progress** page opens.',
                      bullets: [],
                      section: true,
                    },
                    { frames: [1], title: '', text: 'dropped: no title' },
                  ],
                }) + '\n```',
              },
            }],
          };
        },
      },
    };
  }
}

Module._load = function patched(request, parent, isMain) {
  if (request === 'openai') return FakeOpenAI;
  return load.apply(this, arguments);
};
