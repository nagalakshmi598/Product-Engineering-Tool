'use strict';

/**
 * Looking at a screen recording.
 *
 * Nothing can watch a video. What a model can do is look at pictures, so a
 * recording is turned into a strip of them — evenly spaced, in order, each
 * labelled with the second it was taken at — and the model reads the strip
 * the way someone would read a storyboard.
 *
 * Evenly spaced rather than every frame: a five-minute recording of somebody
 * filling in a form is nine thousand frames of almost nothing, and the few
 * that matter are the ones where the screen changed. Sampling widely and
 * discarding the duplicates finds those for a fraction of the cost.
 */

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ffmpeg = require('ffmpeg-static');

/* Enough of a walkthrough to follow it, few enough to send. A screen
   recording of a migration is a dozen distinct screens; this allows for the
   pauses and retries around them. */
const MAX_FRAMES = 24;

/* Wide enough to read a button's label, small enough to send two dozen of. */
const FRAME_WIDTH = 1100;

/* How much of the picture has to change before it counts as a new screen.
   Low enough to catch a dialog opening, high enough to ignore a cursor
   moving or a spinner turning. */
const SCENE_CHANGE = 0.15;

/* Asking what a file is means running ffmpeg with an input and no output,
   which ffmpeg reports as a failure although it has just told us everything
   we asked for. */
const NOT_REALLY_WRONG = /Output file .* empty|At least one output file must be specified/i;

function run(args, { timeout = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(ffmpeg, args, { timeout, maxBuffer: 1 << 26 }, (err, stdout, stderr) => {
      // ffmpeg writes everything it has to say to stderr, success included
      if (err && !NOT_REALLY_WRONG.test(String(stderr))) {
        return reject(new Error(String(stderr || err.message).split('\n').slice(-4).join(' ').trim()));
      }
      return resolve(String(stderr || ''));
    });
  });
}

/** How long the recording runs, in seconds. */
async function lengthOf(file) {
  const said = await run(['-hide_banner', '-i', file], { timeout: 30000 });
  const found = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(said);
  if (!found) return 0;

  return (Number(found[1]) * 3600) + (Number(found[2]) * 60) + Number(found[3]);
}

/**
 * Pull a strip of stills out of a recording.
 *
 * @param {Buffer} buffer the recording
 * @param {string} name what it was called, for the file extension
 * @returns {Promise<{frames: Array<{at: number, image: Buffer}>, seconds: number, note: string}>}
 */
async function framesFrom(buffer, name) {
  const ext = path.extname(name || '').toLowerCase() || '.mp4';
  const folder = path.join(os.tmpdir(), `cf-video-${crypto.randomUUID()}`);
  fs.mkdirSync(folder, { recursive: true });

  const source = path.join(folder, `source${ext}`);
  fs.writeFileSync(source, buffer);

  try {
    const seconds = await lengthOf(source);
    if (!seconds) {
      return { frames: [], seconds: 0, note: 'this file does not look like a recording' };
    }

    /* The steps of a walkthrough are the moments the screen changed: a page
       opened, a dialog appeared, a field filled. ffmpeg finds those directly,
       which beats sampling on a timer and hoping no step fell between two
       ticks.
       "eq(n,0)" keeps the opening screen — there is nothing before it for the
       scene test to compare against, so without it a walkthrough starts at
       its second step. showinfo makes ffmpeg report when each kept frame came
       from, so the times are read rather than assumed. */
    const said = await run([
      '-hide_banner', '-loglevel', 'info',
      '-i', source,
      '-vf', `select='eq(n\\,0)+gt(scene,${SCENE_CHANGE})',scale=${FRAME_WIDTH}:-2,showinfo`,
      '-vsync', 'vfr',
      '-frames:v', String(MAX_FRAMES),
      '-q:v', '4',
      path.join(folder, 'scene-%03d.jpg'),
    ]);

    const times = [...String(said).matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1]));
    const scenes = fs.readdirSync(folder).filter((f) => /^scene-\d+\.jpg$/.test(f)).sort();

    /* A recording of one long form being filled in may never change enough to
       trip the scene test, so there is always the timer to fall back on. */
    const every = Math.max(1, seconds / MAX_FRAMES);
    let spacedEvenly = false;

    if (scenes.length < 3) {
      scenes.forEach((f) => fs.unlinkSync(path.join(folder, f)));
      spacedEvenly = true;
      await run([
        '-hide_banner', '-loglevel', 'error',
        '-i', source,
        '-vf', `fps=1/${every.toFixed(3)},scale=${FRAME_WIDTH}:-2`,
        '-frames:v', String(MAX_FRAMES),
        '-q:v', '4',
        path.join(folder, 'frame-%03d.jpg'),
      ]);
    } else {
      scenes.forEach((f, i) => {
        fs.renameSync(path.join(folder, f), path.join(folder, `frame-${String(i + 1).padStart(3, '0')}.jpg`));
      });
    }

    const frames = fs.readdirSync(folder)
      .filter((f) => /^frame-\d+\.jpg$/.test(f))
      .sort()
      .map((f, i) => ({
        /* Read from the recording where ffmpeg reported it; worked out from
           the interval only when the frames were taken on a timer. */
        at: spacedEvenly || times[i] == null ? Math.round(i * every) : Math.round(times[i]),
        image: fs.readFileSync(path.join(folder, f)),
      }));

    if (!frames.length) {
      return { frames: [], seconds, note: 'no pictures could be taken from this recording' };
    }

    return {
      frames,
      seconds,
      note: spacedEvenly
        ? `${frames.length} stills taken every ${Math.round(every)}s across ${Math.round(seconds)} seconds`
        : `${frames.length} screens, taken where the screen changed, across ${Math.round(seconds)} seconds`,
    };
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
}

module.exports = { framesFrom, lengthOf, MAX_FRAMES };
