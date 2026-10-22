'use strict';

/**
 * Where the tool keeps what people put into it.
 *
 * By default, next to the code: `server/data` for the JSON store and
 * `server/uploads` for the write-ups and their screenshots. That is the right
 * answer on a laptop, where the tool is a folder you opened.
 *
 * It is the wrong answer on a server, where the code is replaced on every
 * deploy and anything sitting inside it is replaced with it. So both can be
 * pointed somewhere that outlives the deploy:
 *
 *   CF_DATA_DIR=/var/lib/cftool/data
 *   CF_UPLOAD_DIR=/var/lib/cftool/uploads
 *
 * Neither is set in normal use and nothing moves.
 */

const path = require('path');

function chosen(variable, fallback) {
  const set = String(process.env[variable] || '').trim();
  return set ? path.resolve(set) : fallback;
}

const DATA_DIR = chosen('CF_DATA_DIR', path.join(__dirname, 'data'));
const UPLOAD_DIR = chosen('CF_UPLOAD_DIR', path.join(__dirname, 'uploads'));

/* Write-ups and the images pulled out of them live together, one folder per
   write-up, so that deleting one takes its screenshots with it. */
const DOC_DIR = path.join(UPLOAD_DIR, 'docs');

module.exports = { DATA_DIR, UPLOAD_DIR, DOC_DIR };
