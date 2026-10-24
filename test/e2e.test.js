'use strict';
// The real app, the real hotkeys, real speech recognition, a real window to
// act on. Only the AI is a stand-in (a local server that speaks Anthropic's
// protocol). It takes over the keyboard and pointer for a few seconds, so it
// only runs when asked:   set CLIPPY_E2E=1   then   npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const { createWinSidecar } = require('../src/win/sidecar');

const skip = process.platform !== 'win32' || process.env.CLIPPY_E2E !== '1';
const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000, step = 80) {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(step); }
}

/** Talk to a page of the running app through the DevTools protocol. */
async function connect(port, match) {
  const targets = await until(async () => { try { const t = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); return t.find((x) => x.type === 'page' && x.url.includes(match)); } catch (_) { return null; } }, 20000);
  assert.ok(targets, `a page matching ${match}`);
  const ws = new WebSocket(targets.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const waiting = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } };
  return {
    eval: (expression, awaitPromise = false) => new Promise((res) => { const n = ++id; waiting.set(n, res); ws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise } })); }).then((r) => r.result && r.result.result && r.result.result.value),
    close: () => ws.close(),
  };
}

test('hold to talk acts on the front window; point and ask answers where the pointer is', { skip, timeout: 240000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-e2e-'));
  const data = path.join(dir, 'data'); fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ version: 1, onboarded: true, hotkeys: { talk: 'Control+Alt+F8', panic: 'Control+Alt+F9' } }));
  const title = `ClippyE2E-${process.pid}-${Date.now() % 100000}`;
  const files = { text: path.join(dir, 'text.txt'), ready: path.join(dir, 'ready'), state: path.join(dir, 'state.txt') };
  const wav = path.join(dir, 'say.wav');
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'fixtures', 'tts.ps1'), 'Press control A, then type hello world.', wav], { stdio: 'ignore' });

  // a stand-in for Anthropic
  const asked = [];
  const mock = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      asked.push({ url: req.url, key: req.headers['x-api-key'], body: JSON.parse(body) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'text', text: '{"kicker":"Explain","text":"That is the Send button. It sends your note.","confidence":0.9}' }] }));
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));

  const form = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'fixtures', 'testwindow.ps1')], {
    env: { ...process.env, CLIPPY_TEST_TITLE: title, CLIPPY_TEST_TEXT: files.text, CLIPPY_TEST_READY: files.ready, CLIPPY_TEST_STATE: files.state }, stdio: 'ignore',
  });
  const port = 9300 + (process.pid % 500);
  const log = [];
  const app = spawn(require('electron'), ['.', '--panel', `--remote-debugging-port=${port}`], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CLIPPY_USER_DATA: data, CLIPPY_E2E: '1', CLIPPY_E2E_WAV: wav, CLIPPY_E2E_KEYS: JSON.stringify({ anthropic: 'sk-ant-e2e' }), CLIPPY_ANTHROPIC_BASE: `http://127.0.0.1:${mock.address().port}`, CLIPPY_VERBOSE: '1' },
  });
  app.stdout.on('data', (d) => log.push(String(d))); app.stderr.on('data', (d) => log.push(String(d)));
  const driver = createWinSidecar({ log: () => {} });
  let overlay = null;
  let panel = null;
  t.after(async () => {
    try { if (overlay) overlay.close(); } catch (_) { /* gone */ }
    try { if (panel) panel.close(); } catch (_) { /* gone */ }
    driver.stop();
    try { execFileSync('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (_) { /* exited */ }
    try { form.kill(); } catch (_) { /* gone */ }
    mock.close();
    await sleep(600);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  });

  driver.start();
  await driver.ready(60000);
  assert.ok(await until(() => fs.existsSync(files.ready), 30000), 'the test window opened');
  assert.ok(await until(() => log.join('').includes('speech: en-US'), 90000), `the app heard the recognizer come up\n${log.join('').slice(-800)}`);
  assert.ok(await until(() => log.join('').includes('win-sidecar is up'), 30000), 'the app\'s Windows helper is up');
  overlay = await connect(port, 'overlay.html');
  assert.ok(await until(async () => (await overlay.eval('document.body.dataset.corner')) === 'br', 10000), 'the overlay has its settings');

  panel = await connect(port, 'panel.html');
  /** The middle of something on the overlay page, in physical screen pixels: where a real mouse has to go to touch it. */
  const screenPoint = async (selector) => {
    const m = await overlay.eval(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, dpr: devicePixelRatio, sx: screenX, sy: screenY }; })()`);
    return { x: Math.round((m.sx + m.x) * m.dpr), y: Math.round((m.sy + m.y) * m.dpr) };
  };
  /** Move onto it, give the overlay a moment to notice the pointer is over its own UI, then click. */
  const clickOverlay = async (selector) => { const p = await screenPoint(selector); await driver.move(p.x, p.y); await sleep(400); await driver.click(p.x, p.y); };
  const showing = async (selector) => (await overlay.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); return Boolean(e) && !e.classList.contains('hidden'); })()`)) === true;

  const front = async () => { const r = await driver.focusWindow(title); assert.equal(r.ok, true); assert.ok(await until(async () => (await driver.fg()).title === title, 4000), 'the test window is in front'); };
  const rectOf = async (name) => { const l = await driver.uiaList((await driver.fg()).hwnd); const e = l.elements.find((x) => x.name === name); assert.ok(e, `${name} is listed`); return e.rect; };

  await t.test('hold to talk: say it, it acts', async () => {
    await front();
    const notes = await rectOf('Notes');
    await driver.click(notes.x + 12, notes.y + 12);
    assert.ok(await until(async () => (await driver.fg()).title === title, 3000));
    await driver.hold(['ctrl', 'alt', 'f8'], 3500);
    assert.ok(await until(() => fs.readFileSync(files.text, 'utf8') === 'hello world', 12000), `typed hello world, got ${JSON.stringify(fs.readFileSync(files.text, 'utf8'))}\n${log.join('').slice(-1200)}`);
    // the overlay went through listening and back to rest
    assert.ok(await until(async () => (await overlay.eval('document.querySelector("#mark-dock") !== null')) === true, 2000));
  });

  await t.test('the look-here hotkey over a button: the ribbon goes there and the answer lands', async () => {
    await front();
    const btn = await rectOf('Send now');
    await driver.move(btn.x + Math.round(btn.w / 2), btn.y + Math.round(btn.h / 2));
    await sleep(250);
    await driver.hold(['ctrl', 'alt', 'l'], 250);
    assert.ok(await until(() => asked.length === 1, 20000), `Claude was asked\n${log.join('').slice(-1200)}`);
    assert.equal(asked[0].key, 'sk-ant-e2e');
    const content = asked[0].body.messages[0].content;
    assert.deepEqual(content.map((c) => c.type), ['image', 'image', 'text']);
    assert.match(content[2].text, /Send now/);
    assert.match(content[2].text, new RegExp(title));
    const said = await until(async () => { const v = await overlay.eval('(() => { const b = document.querySelector("#bubble"); return b && !b.classList.contains("hidden") ? document.querySelector("#bub-text").textContent : ""; })()'); return v || null; }, 15000);
    assert.equal(said, 'That is the Send button. It sends your note.');
    assert.equal(await overlay.eval('document.querySelector("#bub-k").textContent'), 'Explain');
    // the picture sent is the display, not an empty frame
    assert.ok(content[0].source.data.length > 2000 && content[1].source.data.length > 2000);
  });

  await t.test('the overlay is click-through: a real click lands on the window underneath', async () => {
    await overlay.eval('overlayApi.pointClose()');           // the answer from the last test is still up, and it is the one thing here that takes the mouse
    await sleep(1200);
    await front();
    const before = fs.readFileSync(files.text, 'utf8');
    const btn = await rectOf('Send now');
    await driver.click(btn.x + Math.round(btn.w / 2), btn.y + Math.round(btn.h / 2));
    assert.ok(await until(() => fs.readFileSync(files.text, 'utf8') === `${before}[clicked]`, 5000), `the button got the click, got ${JSON.stringify(fs.readFileSync(files.text, 'utf8'))}`);
  });

  await t.test('click the ribbon, type a command, and it acts on the window you were just in', async () => {
    await front();
    const notes = await rectOf('Notes');
    await driver.click(notes.x + 12, notes.y + 12);          // the caret is in the Notes box
    await clickOverlay('#mark-dock');
    assert.ok(await until(() => showing('#quick'), 4000), 'the typing box opened');
    assert.ok(await until(async () => (await overlay.eval('document.activeElement && document.activeElement.id')) === 'quick-input', 4000), 'and it has the keyboard');
    await driver.typeText('press control A, then type hello again');
    await driver.tap(0x0D);
    assert.ok(await until(() => fs.readFileSync(files.text, 'utf8') === 'hello again', 12000), `typed into the window behind, got ${JSON.stringify(fs.readFileSync(files.text, 'utf8'))}\n${log.join('').slice(-1200)}`);
    assert.ok(await until(async () => !(await showing('#quick')), 3000), 'the box went away');
    assert.ok(await until(async () => (await driver.fg()).title === title, 4000), 'and the window you were in is in front again');
  });

  await t.test('the panic hotkey stops everything and hides the ribbon', async () => {
    await driver.hold(['ctrl', 'alt', 'f9'], 200);
    assert.ok(await until(async () => (await overlay.eval('document.body.classList.contains("mark-hidden")')) === true, 8000), 'the ribbon is hidden');
  });
});
