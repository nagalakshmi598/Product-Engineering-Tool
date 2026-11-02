'use strict';
/* Stands in for the model when a functionality is being written up.
 *
 * It answers from the description it was handed, so a write-up built out of
 * the asking sentence instead of out of the feature shows up as the wrong
 * document rather than being hidden behind a canned reply. */
const Module = require('module');
const load = Module._load;

/* The write-up the stub returns, built from whatever it was told. */
function spec(text) {
  const sections = [];

  if (/canvas/i.test(text)) {
    sections.push({
      heading: 'Retention Window',
      text: 'The window applies to every canvas in the workspace.',
      bullets: [
        'A canvas untouched for 90 days is marked **Expired**.',
        'An expired canvas is read-only until it is restored.',
      ],
    });
  }

  if (/export|csv/i.test(text)) {
    sections.push({
      heading: 'Exporting the Report',
      text: '',
      bullets: [
        'Clicking **Export** downloads the report as a CSV file.',
        'The export covers every row currently shown.',
      ],
    });
  }

  if (/group dm|slack|teams/i.test(text)) {
    sections.push({
      heading: 'For Teams Destination - Slack -> Teams',
      text: '',
      bullets: ['The original Group DM name from the source is preserved during migration.'],
    });
  }

  /* Nothing recognised: say so in the document rather than inventing one,
     which is how a write-up made from the asking sentence shows up. */
  if (!sections.length) {
    sections.push({
      heading: 'Uploading a Document',
      text: 'The write-up was built from the sentence, not from the feature.',
      bullets: ['A user can upload a document to the tool.'],
    });
  }

  const title = /canvas/i.test(text) ? 'Canvas Retention Window'
    : /export|csv/i.test(text) ? 'Sprawl Report CSV Export'
      : /group dm/i.test(text) ? 'Group DM Name Migration'
        : 'The user uploads a document';

  /* A model that writes its own Open Points section although it was told
     not to, so that the taking of it back off is what is being tested. */
  if (/group dm/i.test(text)) {
    sections.push({
      heading: 'Open Points',
      text: '',
      bullets: ['Which character limit applies when the two differ?'],
    });
  }

  return JSON.stringify({
    title,
    intro: 'This write-up specifies the behaviour described.',
    sections,
    open: /canvas|export|csv|group dm/i.test(text)
      ? [
        'What happens to a canvas restored after it has expired?',
        'Who may restore one?',
        'What happens to a canvas restored after it has expired?',
      ]
      : [],
  });
}

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

          /* Writing a functionality up. */
          if (/enhancement write-up/i.test(system)) {
            return { choices: [{ message: { content: spec(text) } }] };
          }

          /* Anything else the tool asks for while these tests run: the
             scenario drafting path, which must still work. */
          return {
            choices: [{
              message: {
                content: [
                  '1. [Positive] Verify that the feature behaves as specified.',
                  '2. [Negative] Verify that an invalid input is refused.',
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
