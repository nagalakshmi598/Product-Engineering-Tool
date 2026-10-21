'use strict';

/**
 * Driving a web app and writing down what happened.
 *
 * A step is an instruction and a caption: go here, click that, type this —
 * and a sentence for the guide. After each one the page is photographed, so
 * the guide ends up with a screenshot of the screen the step was performed
 * on, which is the shape of a walkthrough written by hand.
 *
 * Chrome is driven over the DevTools protocol rather than through Playwright
 * or Puppeteer, because Chrome is already on this machine and neither of
 * those is: one fewer thing to install on a machine that runs a QA tool.
 *
 * Credentials never appear in a step. A step asks for a secret by name and
 * the value is read from the environment, so a password lives in .env — which
 * is not committed — and not in a script, a chat message or a log.
 */

const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const path = require('path');

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

const SETTLE = 900;          // what a page is given to finish drawing itself

function waitFor(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function chromePath() {
  const fs = require('fs');
  const found = CHROME.find((candidate) => fs.existsSync(candidate));
  if (found) return found;

  const err = new Error('Chrome was not found, and the recorder drives Chrome.');
  err.status = 500;
  throw err;
}

/** A secret, by name, from the environment — never from the step itself. */
function secret(name) {
  const value = process.env[name];
  if (!value) {
    const err = new Error(
      `${name} is not set. Put it in the .env file in the project folder — `
        + 'it is not committed, and a password does not belong in a script.'
    );
    err.status = 400;
    throw err;
  }
  return value;
}

/* ---------------- the connection ---------------- */

function ask(port, route) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: route }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
      });
    }).on('error', reject);
  });
}

async function openChrome({ port, headless, profile }) {
  const args = [
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1500,1000',
    `--user-data-dir=${path.join(os.tmpdir(), profile)}`,
    'about:blank',
  ];
  if (headless) args.unshift('--headless=new', '--disable-gpu');

  const chrome = spawn(chromePath(), args, { stdio: 'ignore' });

  for (let i = 0; i < 60; i += 1) {
    try {
      const tabs = await ask(port, '/json/list');
      const page = tabs.find((t) => t.type === 'page');
      if (page) return { chrome, page };
    } catch (err) { /* not listening yet */ }
    await waitFor(250);
  }

  chrome.kill();
  throw new Error('Chrome started but never answered on the debugging port.');
}

/* Node's own WebSocket, rather than the `ws` package: this runs beside a QA
   tool, and a dependency that does not have to be installed is one that
   cannot be missing. */
function connect(page) {
  const socket = new WebSocket(page.webSocketDebuggerUrl);

  let id = 0;
  const pending = new Map();
  const problems = [];

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') {
      problems.push(message.params.exceptionDetails.text);
    }
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });

  const send = (method, params = {}) => new Promise((resolve) => {
    const mine = (id += 1);
    pending.set(mine, resolve);
    socket.send(JSON.stringify({ id: mine, method, params }));
  });

  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('Chrome refused the debugging connection.')), { once: true });
  });

  return { socket, send, problems, ready };
}

/* ---------------- what a step can be ---------------- */

const AS_TEXT = (value) => JSON.stringify(String(value));

/**
 * Carry out one step and say what it did.
 * @returns {Promise<string>} empty when it worked, otherwise what went wrong
 */
async function perform(step, { send }) {
  const run = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.result && result.result.exceptionDetails) {
      const detail = result.result.exceptionDetails;
      return { failed: (detail.exception && detail.exception.description) || detail.text };
    }
    return { value: result.result && result.result.result ? result.result.result.value : null };
  };

  if (step.goto) {
    await send('Page.navigate', { url: step.goto });
    await waitFor(step.settle || SETTLE * 2);
    return '';
  }

  if (step.click) {
    const outcome = await run(
      `(function () { var el = document.querySelector(${AS_TEXT(step.click)});`
        + ' if (!el) return "missing"; el.click(); return "clicked"; })()'
    );
    if (outcome.failed) return outcome.failed;
    if (outcome.value === 'missing') return `nothing matched ${step.click}`;
    await waitFor(step.settle || SETTLE);
    return '';
  }

  if (step.type) {
    /* A secret is named, not written: "fromEnv" says which variable holds it. */
    const value = step.fromEnv ? secret(step.fromEnv) : String(step.value == null ? '' : step.value);
    const outcome = await run(
      `(function () { var el = document.querySelector(${AS_TEXT(step.type)});`
        + ' if (!el) return "missing";'
        + ' var setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, "value");'
        + ` setter && setter.set ? setter.set.call(el, ${AS_TEXT(value)}) : (el.value = ${AS_TEXT(value)});`
        + ' el.dispatchEvent(new Event("input", { bubbles: true }));'
        + ' el.dispatchEvent(new Event("change", { bubbles: true }));'
        + ' return "typed"; })()'
    );
    if (outcome.failed) return outcome.failed;
    if (outcome.value === 'missing') return `nothing matched ${step.type}`;
    await waitFor(step.settle || 300);
    return '';
  }

  if (step.waitFor) {
    const until = Date.now() + (step.timeout || 20000);
    for (;;) {
      const outcome = await run(`Boolean(document.querySelector(${AS_TEXT(step.waitFor)}))`);
      if (outcome.value) { await waitFor(step.settle || SETTLE); return ''; }
      if (Date.now() > until) return `${step.waitFor} never appeared`;
      await waitFor(400);
    }
  }

  if (step.wait) {
    await waitFor(step.wait);
    return '';
  }

  // a step with nothing to do is a caption and a photograph, which is allowed
  await waitFor(step.settle || 200);
  return '';
}

/**
 * Walk a list of steps, photographing the screen after each.
 *
 * Stops at the first step that cannot be carried out: the steps after it
 * assume it worked, and a guide of screenshots taken from the wrong screen is
 * worse than a short one. What was captured up to that point is returned, so
 * the guide can still be written and the failure is named in it.
 *
 * @returns {Promise<{captured: Array, stoppedAt: object|null, problems: string[]}>}
 */
async function record(steps, { headless = true, port = 9333, profile = 'cf-recorder' } = {}) {
  const { chrome, page } = await openChrome({ port, headless, profile });
  const { socket, send, problems, ready } = connect(page);
  await ready;

  await send('Page.enable');
  await send('Runtime.enable');

  const captured = [];
  let stoppedAt = null;

  try {
    for (const step of steps) {
      const wrong = await perform(step, { send });
      if (wrong) {
        stoppedAt = { title: step.title || 'Step', why: wrong };
        break;
      }

      const shot = await send('Page.captureScreenshot', { format: 'png' });
      captured.push({
        title: step.title || 'Step',
        text: step.text || '',
        screenshot: shot.result && shot.result.data
          ? Buffer.from(shot.result.data, 'base64')
          : null,
      });
    }
  } finally {
    socket.close();
    chrome.kill();
  }

  return { captured, stoppedAt, problems };
}

module.exports = { record, perform, secret, chromePath };
