'use strict';
// Drives the real Windows sidecar against a real WinForms window of our own.
// Skipped off Windows, or with CLIPPY_NO_UI_TESTS=1 (it moves focus around).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createWinSidecar } = require('../src/win/sidecar');

const skip = process.platform !== 'win32' || process.env.CLIPPY_NO_UI_TESTS === '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, step = 60) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(step);
  }
}

test('the sidecar types, chords, clicks and manages windows', { skip, timeout: 120000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-sidecar-'));
  const title = `ClippyTestWindow-${process.pid}-${Date.now() % 100000}`;
  const files = { text: path.join(dir, 'text.txt'), ready: path.join(dir, 'ready'), state: path.join(dir, 'state.txt') };
  const form = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'fixtures', 'testwindow.ps1')], {
    env: { ...process.env, CLIPPY_TEST_TITLE: title, CLIPPY_TEST_TEXT: files.text, CLIPPY_TEST_READY: files.ready, CLIPPY_TEST_STATE: files.state },
    stdio: 'ignore', windowsHide: false,
  });
  const side = createWinSidecar({ log: () => {} });
  t.after(() => { side.stop(); try { form.kill(); } catch (_) { /* gone */ } fs.rmSync(dir, { recursive: true, force: true }); });

  side.start();
  await side.ready(45000);
  assert.ok(await until(() => fs.existsSync(files.ready), 20000), 'the test window opened');

  const readText = () => fs.readFileSync(files.text, 'utf8');
  const frontIsOurs = async () => { const f = await side.fg(); return f.title === title; };
  const rectOf = async (name) => {
    const list = await side.uiaList((await side.fg()).hwnd);
    const el = list.elements.find((e) => e.name === name);
    assert.ok(el, `${name} is listed`);
    return el.rect;
  };
  // Bring the test window forward and put the caret in the Notes box. The
  // keystrokes are real, so nothing types unless our own window is in front.
  const ready = async () => {
    const r = await side.focusWindow(title);
    assert.equal(r.ok, true, 'found the test window');
    assert.ok(await until(frontIsOurs, 4000), 'the test window is in front');
    const notes = await rectOf('Notes');
    await side.click(notes.x + 12, notes.y + 12);
    assert.ok(await until(async () => { const f = await side.focused(); return f.element && f.element.name === 'Notes'; }, 3000), 'Notes has focus');
    assert.ok(await frontIsOurs(), 'refusing to type: the test window is not in front');
  };

  await t.test('lists windows and finds ours', async () => {
    const { windows } = await side.windows();
    assert.ok(windows.some((w) => w.title === title));
  });

  await t.test('focus, then type text into the focused control', async () => {
    await ready();
    await side.typeText('hello');
    assert.ok(await until(() => readText() === 'hello'), `typed hello, got ${JSON.stringify(readText())}`);
    await side.typeText(' line\nnext');
    assert.ok(await until(() => readText() === 'hello line\r\nnext'), `got ${JSON.stringify(readText())}`);
  });

  await t.test('chords: select all then type replaces, and unicode survives', async () => {
    await ready();
    await side.chord(['ctrl', 'a']);
    await side.typeText('x');
    assert.ok(await until(() => readText() === 'x'), `got ${JSON.stringify(readText())}`);
    await side.chord(['ctrl', 'a']);
    await side.typeText('Crème brûlée 日本');
    assert.ok(await until(() => readText() === 'Crème brûlée 日本'), `got ${JSON.stringify(readText())}`);
  });

  await t.test('the focused control is reported, and passwords are flagged', async () => {
    await ready();
    const f = await side.focused();
    assert.equal(f.element.name, 'Notes');
    assert.equal(f.element.isPassword, false);
    const secret = await rectOf('Secret code');
    await side.click(secret.x + 10, secret.y + 10);
    const after = await until(async () => { const r = await side.focused(); return r.element && r.element.name === 'Secret code' ? r : null; }, 3000);
    assert.ok(after && after.element.isPassword === true, 'password box is flagged');
  });

  await t.test('invoke a control by name', async () => {
    await ready();
    await side.chord(['ctrl', 'a']);
    await side.typeText('go ');
    const r = await side.uiaInvoke('Send now');
    assert.equal(r.ok, true);
    assert.ok(await until(() => readText() === 'go [clicked]'), `got ${JSON.stringify(readText())}`);
    const miss = await side.uiaInvoke('Definitely not a control');
    assert.equal(miss.ok, false);
  });

  await t.test('the control under a point is found', async () => {
    const btn = await rectOf('Send now');
    const hit = await side.fromPoint(btn.x + 5, btn.y + 5);
    assert.equal(hit.element.name, 'Send now');
  });

  await t.test('minimize and restore the front window', async () => {
    await ready();
    const r = await side.windowOp('minimize');
    assert.equal(r.ok, true);
    assert.ok(await until(() => fs.readFileSync(files.state, 'utf8') === 'Minimized'), 'minimized');
    await side.focusWindow(title);
    assert.ok(await until(() => fs.readFileSync(files.state, 'utf8') === 'Normal'), 'restored');
  });

  await t.test('key state reads released keys', async () => {
    const s = await side.keyState([0x20, 0x11]);
    assert.equal(s.keys['32'], false);
  });
});

test('the sidecar refuses an unknown key name before sending anything', { skip }, () => {
  const { chordVks } = require('../src/win/vk');
  assert.throws(() => chordVks(['ctrl', 'banana']), /unknown key/);
  assert.deepEqual(chordVks(['ctrl', 'shift', 't']), [0x11, 0x10, 0x54]);
  assert.deepEqual(chordVks(['win', 'f12']), [0x5B, 0x7B]);
});
