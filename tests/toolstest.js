'use strict';
/* The copy and edit controls, as the browser actually draws them. */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT = path.resolve(__dirname, '..');
const STUBS = path.join(__dirname, 'stubs');
const HERE = path.join(os.tmpdir(), 'cftool-tests', path.basename(__filename, '.js'));
fs.mkdirSync(HERE, { recursive: true });
const PORT = 4439;
const BASE = `http://127.0.0.1:${PORT}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const checks = [];
const record = (n, ok, d) => checks.push({ n, ok, d });

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((p) => fs.existsSync(p));

async function cdp(port) {
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch (_) {}
    await wait(400);
  }
  throw new Error('chrome never answered');
}

function talk(url) {
  const socket = new WebSocket(url);
  let id = 0;
  const waiting = new Map();

  socket.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && waiting.has(msg.id)) {
      const { resolve, reject } = waiting.get(msg.id);
      waiting.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  });

  const ready = new Promise((resolve) => socket.addEventListener('open', resolve));

  return {
    ready,
    send(method, params = {}) {
      id += 1;
      const mine = id;
      return new Promise((resolve, reject) => {
        waiting.set(mine, { resolve, reject });
        socket.send(JSON.stringify({ id: mine, method, params }));
      });
    },
    close: () => socket.close(),
  };
}

(async () => {
  if (!CHROME) { console.log('no Chrome found - skipped'); process.exit(0); }

  fs.rmSync(path.join(HERE, 'tdata'), { recursive: true, force: true });
  fs.rmSync(path.join(HERE, 'tuploads'), { recursive: true, force: true });

  const env = {
    ...process.env,
    CF_DATA_DIR: path.join(HERE, 'tdata'),
    CF_UPLOAD_DIR: path.join(HERE, 'tuploads'),
    PORT: String(PORT),
  };

  const server = spawn(process.execPath, ['server/index.js'], { cwd: PROJECT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', (c) => (log += c));
  server.stderr.on('data', (c) => (log += c));

  let up = false;
  for (let i = 0; i < 90; i += 1) {
    try { if ((await fetch(`${BASE}/api/products`)).ok) { up = true; break; } } catch (_) {}
    await wait(500);
  }
  if (!up) { console.error('never came up:\n' + log); server.kill(); process.exit(1); }

  const profile = path.join(HERE, 'chrome-tools');
  fs.rmSync(profile, { recursive: true, force: true });
  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=9333', `--user-data-dir=${profile}`,
    '--no-first-run', '--window-size=1280,900', BASE,
  ], { stdio: 'ignore' });

  let page;
  try {
    page = talk(await cdp(9333));
    await page.ready;
    await page.send('Runtime.enable');
    await page.send('Page.enable');

    const run = async (expression) => {
      const out = await page.send('Runtime.evaluate', {
        expression, awaitPromise: true, returnByValue: true,
      });
      if (out.exceptionDetails) throw new Error(out.exceptionDetails.text + ' ' + JSON.stringify(out.result));
      return out.result.value;
    };

    await wait(2500);

    /* open the assistant and put two messages in the log by hand: this is
       about what the controls do, not about what the model answers */
    await run(`(() => { toggleBot(true); return true; })()`);
    await wait(300);

    await run(`(() => {
      const row = botBubble('user', 'what is email attribute');
      allowEditing(row, { text: 'what is email attribute', files: [], historyAt: 0 });
      botBubble('bot', 'An email attribute is a field on a mailbox.');
      return true;
    })()`);
    await wait(300);

    const shape = await run(`(() => {
      const rows = [...document.querySelectorAll('#botLog .bot-msg')];
      const mine = rows.find((r) => r.classList.contains('is-user'));
      const theirs = rows.find((r) => r.classList.contains('is-bot'));
      const tools = mine.querySelector('.bot-tools');
      const bubble = mine.querySelector('.bot-bubble');
      const icons = [...tools.querySelectorAll('.bot-tool')];
      const bt = bubble.getBoundingClientRect();
      const tt = tools.getBoundingClientRect();
      return {
        mineTools: icons.length,
        theirTools: theirs.querySelectorAll('.bot-tool').length,
        labels: icons.map((b) => b.getAttribute('aria-label')),
        drawnSvgs: icons.filter((b) => b.querySelector('svg')).length,
        svgBox: icons[0].querySelector('svg').getBoundingClientRect().width,
        below: Math.round(tt.top - bt.bottom),
        rightAligned: Math.abs(tt.right - bt.right) < 14,
        hiddenAtRest: getComputedStyle(icons[0]).opacity,
      };
    })()`);

    record('both controls are on my message', shape.mineTools === 2, shape.labels.join(' | '));
    record('they are drawn, not written', shape.drawnSvgs === 2 && shape.svgBox >= 12,
      `${shape.drawnSvgs} icons, ${Math.round(shape.svgBox)}px`);
    record('copy is on the reply too', shape.theirTools === 1, `${shape.theirTools} on the bot message`);
    record('they sit under the bubble', shape.below >= 0 && shape.below <= 12, `${shape.below}px below`);
    record('and line up with its edge', shape.rightAligned === true, '');
    record('out of the way until hovered', Number(shape.hiddenAtRest) === 0, `opacity ${shape.hiddenAtRest}`);

    /* a real pointer, because :hover does not answer to a synthetic event */
    const where = await run(`(() => {
      const r = document.querySelector('#botLog .bot-msg.is-user .bot-bubble').getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: where.x, y: where.y, buttons: 0 });
    await wait(300);

    const shown = await run(`getComputedStyle(document.querySelector('#botLog .bot-msg.is-user .bot-tool')).opacity`);
    record('and visible once it is', Number(shown) === 1, `opacity ${shown}`);

    /* copying */
    const copied = await run(`(async () => {
      let got = null;
      const was = document.execCommand;
      document.execCommand = (cmd) => { got = document.querySelector('textarea[readonly]').value; return true; };
      document.querySelector('#botLog .bot-msg.is-user .bot-tool[aria-label^="Copy"]').click();
      await new Promise((r) => setTimeout(r, 250));
      document.execCommand = was;
      return { got, toast: document.getElementById('toast').textContent, hidden: document.getElementById('toast').hidden };
    })()`);

    record('copy takes the message', copied.got === 'what is email attribute', JSON.stringify(copied.got));
    record('and says it did', /copied/i.test(copied.toast || '') && copied.hidden === false, copied.toast);

    /* editing */
    const editing = await run(`(() => {
      document.querySelector('#botLog .bot-msg.is-user .bot-tool[aria-label^="Change"]').click();
      const row = document.querySelector('#botLog .bot-msg.is-user');
      const box = row.querySelector('.bot-edit-box');
      return {
        opened: Boolean(box),
        value: box ? box.value : '',
        toolsHidden: row.querySelector('.bot-tools').hidden,
        buttons: [...row.querySelectorAll('.bot-edit-actions .bot-action')].map((b) => b.textContent),
      };
    })()`);

    record('edit opens the message for typing', editing.opened === true, editing.value);
    record('with the words that were sent', editing.value === 'what is email attribute', editing.value);
    record('the icons step aside while editing', editing.toolsHidden === true, '');
    record('and there is a way back', editing.buttons.join(' / '), editing.buttons.join(' / '));

    const cancelled = await run(`(() => {
      [...document.querySelectorAll('#botLog .bot-msg.is-user .bot-edit-actions .bot-action')]
        .find((b) => b.textContent === 'Cancel').click();
      const row = document.querySelector('#botLog .bot-msg.is-user');
      return { text: row.querySelector('.bot-bubble').textContent, tools: row.querySelector('.bot-tools').hidden };
    })()`);

    record('cancel puts it back untouched',
      cancelled.text === 'what is email attribute' && cancelled.tools === false, cancelled.text);

    /* ---- the pencil while an answer is still coming back ----
       This is the moment people reach for it: the wording is wrong and you
       can see it is wrong. It used to do nothing at all. */
    const midAnswer = await run(`(() => {
      bot.busy = true;                       // as it is while the tool is thinking
      bot.inflight = new AbortController();
      document.querySelector('#botLog .bot-msg.is-user .bot-tool[aria-label^="Change"]').click();
      const row = document.querySelector('#botLog .bot-msg.is-user');
      return { opened: Boolean(row.querySelector('.bot-edit-box')) };
    })()`);

    record('the pencil works while the bot is thinking', midAnswer.opened === true,
      midAnswer.opened ? 'the message opened for typing' : 'nothing happened');

    const resent = await run(`(() => {
      const row = document.querySelector('#botLog .bot-msg.is-user');
      row.querySelector('.bot-edit-box').value = 'what is a mailbox alias';
      let calledOff = false;
      bot.inflight.signal.addEventListener('abort', () => { calledOff = true; });
      [...row.querySelectorAll('.bot-edit-actions .bot-action')]
        .find((b) => b.textContent === 'Ask again').click();
      return {
        calledOff,
        freed: bot.busy === false || bot.busy === undefined,
        asked: [...document.querySelectorAll('#botLog .bot-msg.is-user .bot-bubble')]
          .map((b) => b.textContent).join(' | '),
      };
    })()`);

    record('sending it calls off the answer in flight', resent.calledOff === true, '');
    record('and the edited question goes instead',
      /what is a mailbox alias/.test(resent.asked) && !/what is email attribute/.test(resent.asked),
      resent.asked.slice(0, 60));
  } catch (err) {
    record('threw', false, err.message);
  }

  console.log('\n--- copy and edit, under a message ---');
  checks.forEach((c) => console.log((c.ok ? '  PASS  ' : '  FAIL  ') + c.n.padEnd(36) + ' ' + (c.d || '')));
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n${failed} FAILED` : '\nall checks passed');

  if (page) page.close();
  chrome.kill();
  server.kill();
  spawnSync('taskkill', ['/F', '/IM', 'chrome.exe', '/FI', 'WINDOWTITLE eq *'], { stdio: 'ignore' });
  process.exit(failed ? 1 : 0);
})();
