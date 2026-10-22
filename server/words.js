'use strict';

/**
 * Words typed in a hurry.
 *
 * Instructions to this tool are typed into a chat box between other work, and
 * they come out as "delte this document", "renmae this", "genrate test
 * cases". A tool that reads those as something other than what they plainly
 * say is worse than one that refuses them: "delte this document" was read as
 * a feature to write test scenarios about, and nineteen scenarios were filed
 * under a set named after the typo.
 *
 * So the words that carry the instruction — the verb at the front, and the
 * nouns naming what the tool holds — are corrected before anything is read
 * into them. Only those words: everything else may be somebody's name for
 * something, and a name is never a misspelling.
 */

/**
 * How many slips turn one word into the other.
 *
 * Two letters swapped counts as one slip, not two. It is the commonest typing
 * mistake there is — "renmae" for "rename" — and counting it as two puts it
 * out of reach of any allowance tight enough to be safe.
 */
function editDistance(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d = Array.from({ length: rows }, (_, i) => [i, ...Array(cols - 1).fill(0)]);

  for (let j = 0; j < cols; j += 1) d[0][j] = j;

  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const same = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + same);

      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }

  return d[rows - 1][cols - 1];
}

/* What an instruction to this tool is made of. The verb it opens with, and
   the words for the things it holds. */
const VERBS = [
  'delete', 'remove', 'drop', 'rename', 'move', 'file', 'clear', 'empty',
  'mark', 'set', 'change', 'update', 'edit', 'reword', 'rewrite', 'correct',
  'generate', 'regenerate', 'write', 'create', 'make', 'add', 'append',
  'replace', 'produce', 'prepare', 'fill',
];

const NOUNS = [
  'document', 'documents', 'doc', 'docs', 'file', 'files',
  'scenario', 'scenarios', 'row', 'rows', 'case', 'cases',
  'set', 'sets', 'enhancement', 'enhancements',
  'column', 'columns', 'section', 'status', 'test',
];

/**
 * How wrong a word may be and still be that word.
 *
 * One letter in a short word is the difference between "set" and "get", which
 * are both things you might say, so short words have to be right. A long word
 * has room to be wrong in.
 */
function allowance(word) {
  if (word.length <= 4) return 0;
  if (word.length <= 7) return 1;
  return 2;
}

/** The one word in the list this was meant to be, if exactly one is close. */
function nearestWord(word, list) {
  const lower = word.toLowerCase();
  if (list.includes(lower)) return null;          // already itself

  const room = allowance(lower);
  if (!room) return null;

  const near = list
    .map((known) => ({ known, off: editDistance(lower, known) }))
    .filter((hit) => hit.off <= room);

  if (!near.length) return null;

  /* The closest, when one is closer than the rest: "scenarious" is one slip
     from "scenarios" and two from "scenario", and it is plainly the first.
     A tie is genuinely unclear, and guessing between two is how "rows"
     becomes "rename". */
  const closest = Math.min(...near.map((hit) => hit.off));
  const best = near.filter((hit) => hit.off === closest);

  return best.length === 1 ? best[0].known : null;
}

/** Put the capitals back the way the person typed them. */
function likeTheOriginal(original, fixed) {
  if (original === original.toUpperCase() && original.length > 1) return fixed.toUpperCase();
  if (original[0] === original[0].toUpperCase()) return fixed[0].toUpperCase() + fixed.slice(1);
  return fixed;
}

/**
 * Correct the words an instruction is made of, and leave the rest alone.
 *
 * @param {string} text what was typed
 * @returns {{text: string, fixed: Array<{from: string, to: string}>}}
 */
function correctInstruction(text) {
  const fixed = [];
  const words = String(text || '').split(/(\s+)/);

  /* The verb is the first word, and it is the one that decides what happens,
     so it is corrected against the verbs. Everything after is corrected
     against the nouns — a verb in the middle of a sentence is usually part
     of a name. */
  let seenAWord = false;

  const out = words.map((piece) => {
    if (!/\S/.test(piece)) return piece;

    const bare = piece.replace(/[^A-Za-z-]/g, '');
    if (!bare) return piece;

    const against = seenAWord ? NOUNS : VERBS;
    seenAWord = true;

    const meant = nearestWord(bare, against);
    if (!meant) return piece;

    fixed.push({ from: bare, to: meant });
    return piece.replace(bare, likeTheOriginal(bare, meant));
  });

  return { text: out.join(''), fixed };
}

module.exports = { correctInstruction, nearestWord, editDistance, VERBS, NOUNS };
