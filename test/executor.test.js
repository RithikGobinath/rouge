'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createExecutor } = require('../src/actions/executor');
const { createApps, bestStart } = require('../src/actions/apps');
const { parse } = require('../src/voice/reflex');

/** A pretend PC: a front window, and a log of everything done to it. */
function fakePc(opts = {}) {
  const log = [];
  const pc = {
    log,
    fg: { hwnd: 1, title: 'Claude', process: 'claude', behindSelf: false },
    focusedEl: { name: 'Notes', type: 'Edit', isPassword: false, automationId: '', pid: 1, rect: { x: 1, y: 1, w: 40, h: 20 } },
    asked: [],
    answers: opts.answers || [],
    pending: null,
  };
  pc.sidecar = {
    fg: async () => { if (pc.pending && --pc.pending.polls <= 0) { pc.fg = pc.pending.window; pc.pending = null; } return { ...pc.fg }; },
    focused: async () => ({ element: pc.focusedEl ? { ...pc.focusedEl } : null }),
    typeText: async (t) => { log.push(['type', t]); },
    chord: async (k) => { log.push(['chord', k.join('+')]); },
    media: async (op, n) => { log.push(['media', op, n]); },
    windowOp: async (op) => { log.push(['window', op]); return { ok: true }; },
    focusWindow: async (t, p) => { log.push(['focus', t, p]); if (opts.hasWindow && pc.fg) pc.fg = { ...pc.fg, behindSelf: false }; return { ok: Boolean(opts.hasWindow) }; },
    uiaInvoke: async (name) => { log.push(['invoke', name]); return { ok: name.toLowerCase() !== 'nothing' }; },
    uiaFind: async (name, hwnd, type) => ({
      element: { name, type: type || 'Button', automationId: '', pid: 1, rect: { x: 10, y: 20, w: 100, h: 40 } },
      score: name.toLowerCase() === 'nothing' ? 0 : 100,
    }),
    click: async (x, y, b, d) => { log.push(['click', x, y, b, d]); },
  };
  pc.shell = { openExternal: async (u) => {
    log.push(['url', u]);
    if (u === 'calculator:') pc.fg = { hwnd: 3, title: 'Calculator', process: 'calculatorapp' };
    if (u === 'spotify:') pc.fg = { hwnd: 4, title: 'Spotify', process: 'spotify' };
  }, openPath: async (p) => { log.push(['path', p]); return ''; } };
  pc.spawnDetached = (file, args) => {
    log.push(['spawn', file, ...args]);
    if (args.includes('notepad.exe')) pc.pending = { polls: 2, window: { hwnd: 2, title: 'Untitled - Notepad', process: 'Notepad', behindSelf: false } };
  };
  pc.ask = async (card) => { pc.asked.push(card); return pc.answers.length ? pc.answers.shift() : true; };
  return pc;
}

function exec(pc, extra = {}) {
  let clock = 1000000;   // virtual time: a sleep moves it, so a 6 s wait costs no real time
  const apps = createApps({ run: async () => '[]' });
  apps._setEntries([{ Name: 'Spotify', AppID: 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify' }, { Name: 'Visual Studio Code', AppID: 'C:\\VSCode\\Code.exe' }]);
  return createExecutor({
    sidecar: pc.sidecar, shell: pc.shell, spawnDetached: pc.spawnDetached, apps,
    paths: { downloads: 'C:\\Users\\me\\Downloads', desktop: 'C:\\Users\\me\\Desktop' },
    folders: { resolve: (n) => (n === 'class notes' ? 'D:\\Notes\\Class notes' : null) },
    ask: pc.ask, sleep: async (ms) => { clock += ms; }, now: () => clock, ...extra,
  });
}

test('"open Notepad, type hello": launches, waits for the window, then types', async () => {
  const pc = fakePc();
  const ex = exec(pc);
  const actions = parse('open notepad then type hello').map((c) => c.action);
  const r = await ex.runAll(actions);
  assert.equal(r.ok, true);
  assert.deepEqual(pc.log.map((l) => l[0]), ['spawn', 'type']);
  assert.deepEqual(pc.log[0], ['spawn', 'cmd.exe', '/c', 'start', '""', 'notepad.exe']);
  assert.deepEqual(pc.log[1], ['type', 'hello']);
  assert.equal(pc.fg.title, 'Untitled - Notepad', 'typed only after Notepad was in front');
});

test('apps: static list, Start menu, websites as a last resort, honest failure', async () => {
  const pc = fakePc();
  const ex = exec(pc);
  assert.equal((await ex.run({ type: 'open_app', app: 'calculator' })).ok, true);
  assert.deepEqual(pc.log.at(-1), ['url', 'calculator:']);
  await ex.run({ type: 'open_app', app: 'spotify' });
  assert.deepEqual(pc.log.at(-1), ['url', 'spotify:'], 'the static list wins over the Start menu');
  await ex.run({ type: 'open_app', app: 'visual studio code' });
  assert.deepEqual(pc.log.at(-1), ['spawn', 'cmd.exe', '/c', 'start', '""', 'code']);
  const fromStart = createApps({ run: async () => '[]' });
  fromStart._setEntries([{ Name: 'Obsidian', AppID: 'md.obsidian.Obsidian' }]);
  assert.deepEqual(fromStart.resolve('obsidian'), { kind: 'appsfolder', id: 'md.obsidian.Obsidian', label: 'Obsidian', match: { process: [], title: 'obsidian' } });
  assert.equal(fromStart.resolve('flarbnitz'), null);
  const r = await ex.run({ type: 'open_app', app: 'flarbnitz' });
  assert.equal(r.ok, false);
  assert.match(r.note, /couldn't find an app called flarbnitz/);
  const site = await ex.run({ type: 'open_app', app: 'youtube' });
  assert.equal(site.ok, true);
  assert.deepEqual(pc.log.at(-1), ['url', 'https://www.youtube.com']);
  assert.equal(bestStart([{ Name: 'Notepad++' }, { Name: 'Notes' }], 'notepad').Name, 'Notepad++');
});

test('opening an already foreground app returns promptly; an unseen app fails honestly', async () => {
  const pc = fakePc();
  pc.fg = { hwnd: 3, title: 'Chrome', process: 'chrome' };
  let clock = 0;
  const ex = exec(pc, {
    apps: { resolve: () => ({ kind: 'exe', cmd: 'chrome.exe', label: 'Chrome', match: { process: ['chrome'] } }) },
    now: () => clock, sleep: async (ms) => { clock += ms; },
  });
  assert.equal((await ex.run({ type: 'open_app', app: 'chrome' })).ok, true);
  assert.ok(clock < 1000, 'does not wait for an unnecessary window change');
  pc.fg = { hwnd: 4, title: 'Notes', process: 'notepad' };
  const missing = await ex.run({ type: 'open_app', app: 'chrome' });
  assert.equal(missing.ok, false);
  assert.match(missing.note, /couldn't bring Chrome/);
});

test('typing refuses password boxes, and hands focus back from our own window', async () => {
  const pc = fakePc({ hasWindow: true });
  const ex = exec(pc);
  pc.focusedEl = { name: 'Secret', type: 'Edit', isPassword: true, automationId: '', pid: 1, rect: { x: 1, y: 1, w: 40, h: 20 } };
  const r = await ex.run({ type: 'type_text', text: 'hunter2' });
  assert.equal(r.ok, false);
  assert.match(r.note, /safe focused control|password/i);
  assert.ok(!pc.log.some((l) => l[0] === 'type'));
  pc.focusedEl = { name: 'Notes', type: 'Edit', isPassword: false, automationId: '', pid: 1, rect: { x: 1, y: 1, w: 40, h: 20 } };
  pc.fg = { hwnd: 5, title: 'Untitled - Notepad', process: 'notepad', behindSelf: true };
  const ok = await ex.run({ type: 'type_text', text: 'hi' });
  assert.equal(ok.ok, true);
  assert.deepEqual(pc.log.find((l) => l[0] === 'focus'), ['focus', 'Untitled - Notepad', ''], 'refocused the app behind us first');
});

test('typing stops when focus cannot be verified', async () => {
  const pc = fakePc();
  pc.focusedEl = null;
  const ex = exec(pc);
  const r = await ex.run({ type: 'type_text', text: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.note, /safe focused control/i);
});

test('ask first: Send waits for a yes, a no stops the rest', async () => {
  const pc = fakePc({ answers: [false, true] });
  const ex = exec(pc);
  const declined = await ex.runAll([{ type: 'click', name: 'Send' }, { type: 'type_text', text: 'after' }]);
  assert.equal(declined.ok, false);
  assert.equal(declined.declined, true);
  assert.deepEqual(pc.asked[0], { kicker: 'Check first', title: 'Click “Send”?', hint: 'This looks like it sends something.' });
  assert.ok(!pc.log.some((l) => l[0] === 'invoke' || l[0] === 'type'), 'nothing ran after a no');
  const yes = await ex.run({ type: 'click', name: 'Send' });
  assert.equal(yes.ok, true);
  assert.deepEqual(pc.log.at(-1), ['invoke', 'Send']);
  await ex.run({ type: 'click', name: 'Bold' });
  assert.equal(pc.asked.length, 2, 'harmless clicks do not ask');
  const miss = await ex.run({ type: 'click', name: 'nothing' });
  assert.equal(miss.ok, false);
  assert.match(miss.note, /couldn't find/);
});

test('Enter after typing in a mail window asks first; in Notepad it does not', async () => {
  const pc = fakePc();
  const ex = exec(pc);
  pc.fg = { hwnd: 9, title: 'Re: lab report - Outlook', process: 'olk', behindSelf: false };
  await ex.run({ type: 'type_text', text: 'thanks' });
  await ex.run({ type: 'press_keys', keys: ['enter'] });
  assert.equal(pc.asked.length, 1);
  assert.equal(pc.asked[0].title, 'Press Enter?');
  pc.fg = { hwnd: 2, title: 'Untitled - Notepad', process: 'notepad', behindSelf: false };
  await ex.run({ type: 'press_keys', keys: ['enter'] });
  assert.equal(pc.asked.length, 1);
});

test('keys, windows, media, scroll', async () => {
  const pc = fakePc();
  const ex = exec(pc);
  await ex.runAll([
    { type: 'press_keys', keys: ['ctrl', 's'] }, { type: 'window_op', op: 'minimize' }, { type: 'window_op', op: 'show_desktop' },
    { type: 'media', op: 'vol_up', times: 5 }, { type: 'media', op: 'volume_set', level: 40 },
    { type: 'scroll', dir: 'down', amount: 'page' }, { type: 'scroll', dir: 'up', amount: 'edge' }, { type: 'scroll', dir: 'down', amount: 'lot' },
  ]);
  assert.deepEqual(pc.log, [
    ['chord', 'ctrl+s'], ['window', 'minimize'], ['chord', 'win+d'],
    ['media', 'vol_up', 5], ['media', 'vol_down', 50], ['media', 'vol_up', 20],
    ['chord', 'pagedown'], ['chord', 'ctrl+home'], ['chord', 'pagedown'], ['chord', 'pagedown'], ['chord', 'pagedown'],
  ]);
});

test('web, folders, email drafts', async () => {
  const pc = fakePc();
  const ex = exec(pc);
  assert.equal((await ex.run({ type: 'open_url', url: 'https://example.com/a' })).ok, true);
  const bad = await ex.run({ type: 'open_url', url: 'file:///C:/Windows/win.ini' });
  assert.equal(bad.ok, false, 'the schema stops a file: link before it gets here');
  assert.equal((await ex.run({ type: 'open_folder', name: 'downloads' })).ok, true);
  assert.deepEqual(pc.log.at(-1), ['path', 'C:\\Users\\me\\Downloads']);
  await ex.run({ type: 'open_folder', name: 'class notes' });
  assert.deepEqual(pc.log.at(-1), ['path', 'D:\\Notes\\Class notes']);
  const nope = await ex.run({ type: 'open_folder', name: 'secrets' });
  assert.match(nope.note, /couldn't find a folder/);
  await ex.run({ type: 'compose_email', to: 'sam@example.com', subject: 'Lab report', body: 'Hi Sam,\nHere it is.' });
  assert.equal(pc.log.at(-1)[1], 'mailto:sam@example.com?subject=Lab%20report&body=Hi%20Sam%2C%0AHere%20it%20is.');
  await ex.run({ type: 'compose_email', to: 'Sam', subject: 'Lab report', body: '' });
  assert.equal(pc.log.at(-1)[1], 'mailto:?subject=Lab%20report&body=Hi%20Sam%2C%0A%0A');
});

test('routines run their steps, in order, and a failed step stops them', async () => {
  const pc = fakePc();
  const steps = [{ type: 'press_keys', keys: ['ctrl', 'a'] }, { type: 'type_text', text: 'x' }];
  const routines = { match: (n) => (n === 'none' ? null : { id: 'r1', name: 'Morning', actions: steps }), touch: (id) => pc.log.push(['touch', id]) };
  const ex = exec(pc, { routines });
  const r = await ex.run({ type: 'run_routine', name: 'morning' });
  assert.equal(r.ok, true);
  assert.deepEqual(pc.log, [['chord', 'ctrl+a'], ['type', 'x'], ['touch', 'r1']]);
  const none = await ex.run({ type: 'run_routine', name: 'none' });
  assert.equal(none.ok, false);
  assert.match(none.note, /don't have a shortcut/);
});

test('keyboard actions wait for the hook; the rest do not', async () => {
  const pc = fakePc();
  const ex = exec(pc);
  let open; const gate = new Promise((r) => { open = r; });
  const ctx = { beforeKeyboard: () => gate };
  const typing = ex.run({ type: 'type_text', text: 'late' }, ctx);
  const opening = await ex.run({ type: 'open_url', url: 'https://example.com' }, ctx);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(opening.ok, true);
  assert.deepEqual(pc.log, [['url', 'https://example.com']], 'opening a page did not wait; typing did');
  open();
  await typing;
  assert.deepEqual(pc.log.at(-1), ['type', 'late']);
});

test('steps are reported, and an abort stops the run', async () => {
  const pc = fakePc();
  const ex = exec(pc);
  const seen = [];
  const ac = new AbortController();
  const r = await ex.runAll([{ type: 'press_keys', keys: ['ctrl', 'c'] }, { type: 'press_keys', keys: ['ctrl', 'v'] }], {
    signal: ac.signal,
    onStep: (s) => { seen.push(`${s.phase}:${s.label}`); if (s.phase === 'done') ac.abort(); },
  });
  assert.equal(r.cancelled, true);
  assert.deepEqual(seen, ['start:Pressing Ctrl+C', 'done:Pressed Ctrl+C']);
  assert.equal(pc.log.length, 1);
  assert.equal((await ex.run({ type: 'format_disk' })).ok, false, 'unknown actions are refused');
});
