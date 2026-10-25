'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createVoice } = require('../src/voice/session');
const { createExecutor } = require('../src/actions/executor');
const { createApps } = require('../src/actions/apps');
const { createRoutines } = require('../src/routines');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('a planned completion is shown only after all actions succeed', async (t) => {
  const calls = [];
  let succeeds = true;
  const ai = {
    canAnswer: () => true, usesClaudeRouting: () => true,
    plan: async () => ({ say: 'Finished.', actions: [{ type: 'open_app', app: 'chrome' }] }),
  };
  const executor = { runAll: async () => { calls.push('action'); return { ok: succeeds, results: [], note: succeeds ? '' : 'Could not open Chrome.' }; } };
  const { voice, ui } = rig(t, { ai, executor });
  ui.say = (text) => calls.push(text);
  await voice.runText('open chrome');
  assert.deepEqual(calls, ['action', 'Finished.']);
  calls.length = 0; succeeds = false;
  await voice.runText('open chrome');
  assert.deepEqual(calls, ['action']);
});

test('typed stop aborts an active worker instead of reporting busy', async (t) => {
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const ai = {
    canAnswer: () => true, usesClaudeRouting: () => true,
    plan: async (_text, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      started();
    }),
  };
  const { voice } = rig(t, { ai });
  const active = voice.runText('open chrome and check flights');
  await ready;
  assert.equal(await voice.runText('stop'), true);
  await active;
  assert.equal(voice.active, false);
});
async function until(fn, ms = 3000) { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timed out waiting'); await sleep(15); } }

/** The ears: tests push words in, the way the recognizer would. */
function fakeSpeech() {
  const on = { update: [], level: [], error: [] };
  const sp = {
    text: '', finals: [], listening: false, canceled: false,
    on: (k, f) => { on[k].push(f); return () => { on[k] = on[k].filter((x) => x !== f); }; },
    async listen() { sp.listening = true; sp.text = ''; },
    async finish() { sp.listening = false; return { text: sp.text }; },
    async cancel() { sp.canceled = true; sp.listening = false; },
    hear(text, kind = 'hyp') { sp.text = text; on.update.forEach((f) => f({ text, kind, finals: [], partial: '' })); },
  };
  return sp;
}

function fakeUi() {
  const ev = [];
  const ui = {
    ev, asks: [], offers: [], offerAnswer: 'keep', askAnswers: [],
    state: (s, i) => ev.push(['state', s, i && i.line]),
    transcript: (t, o) => ev.push(['transcript', t, Boolean(o && o.final)]),
    level: () => {},
    say: (t, o) => ev.push(['say', t, o && o.kicker]),
    notice: (t) => ev.push(['notice', t]),
    ask: (card) => { ui.asks.push(card); return new Promise((res) => { ui.resolveAsk = res; if (ui.askAnswers.length) setTimeout(() => res(ui.askAnswers.shift()), 5); }); },
    offerRoutine: async (o) => { ui.offers.push(o); return ui.offerAnswer; },
    speak: (t) => ev.push(['speak', t]),
  };
  return ui;
}

function fakePc() {
  const pc = { log: [], fg: { hwnd: 1, title: 'Claude', process: 'claude', behindSelf: false }, pending: null };
  const focused = { name: 'Notes', type: 'Edit', isPassword: false, automationId: '', pid: 1, rect: { x: 1, y: 1, w: 40, h: 20 } };
  pc.sidecar = {
    fg: async () => { if (pc.pending && --pc.pending.polls <= 0) { pc.fg = pc.pending.window; pc.pending = null; } return { ...pc.fg }; },
    focused: async () => ({ element: { ...focused } }),
    typeText: async (t) => { pc.log.push(['type', t]); }, chord: async (k) => { pc.log.push(['chord', k.join('+')]); },
    media: async () => {}, windowOp: async () => ({ ok: true }), focusWindow: async () => ({ ok: false }),
    uiaInvoke: async (n) => { pc.log.push(['invoke', n]); return { ok: true }; },
    uiaFind: async (name, _hwnd, type) => ({
      element: { name, type: type || 'Button', automationId: '', pid: 1, rect: { x: 10, y: 20, w: 100, h: 40 } },
      score: 100,
    }),
    click: async () => {},
  };
  pc.shell = { openExternal: async (u) => { pc.log.push(['url', u]); }, openPath: async () => '' };
  pc.spawn = (file, args) => { pc.log.push(['spawn', args[args.length - 1]]); if (args.includes('notepad.exe')) pc.pending = { polls: 1, window: { hwnd: 2, title: 'Untitled - Notepad', process: 'Notepad', behindSelf: false } }; };
  return pc;
}

function rig(t, over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-session-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const speech = fakeSpeech(); const ui = fakeUi(); const pc = fakePc();
  const routines = createRoutines({ file: path.join(dir, 'routines.json') });
  const apps = createApps({ run: async () => '[]' }); apps._setEntries([]);
  const voice = { v: null };
  const executor = createExecutor({
    sidecar: pc.sidecar, shell: pc.shell, spawnDetached: pc.spawn, apps, routines, paths: {}, sleep: async () => {},
    ask: (card) => voice.v.ask(card),
  });
  voice.v = createVoice({ speech, ui, executor, routines, apps, sidecar: pc.sidecar, settings: () => ({ speakReplies: false, useClaudeCode: false }), sleep: async () => {}, ...over });
  return { speech, ui, pc, routines, voice: voice.v };
}

test('words are acted on while the sentence is still being said', async (t) => {
  const { speech, pc, voice, ui } = rig(t);
  await voice.begin();
  assert.deepEqual(ui.ev[0], ['state', 'listening', 'You:']);
  speech.hear('open notepad');
  await sleep(40);
  assert.equal(pc.log.length, 0, 'nothing runs while the last clause may still be growing');
  speech.hear('open notepad then type');
  await sleep(330);                                   // the first clause has now read the same for a quarter second
  speech.hear('open notepad then type hello');
  await until(() => pc.log.some((l) => l[0] === 'spawn'));
  assert.deepEqual(pc.log[0], ['spawn', 'notepad.exe'], 'Notepad opened before the key was released');
  assert.ok(!pc.log.some((l) => l[0] === 'type'), 'the last clause waits for the release');
  assert.equal(voice.listening, true);
  await voice.release();
  assert.deepEqual(pc.log.map((l) => l[0]), ['spawn', 'type']);
  assert.deepEqual(pc.log[1], ['type', 'hello']);
  assert.ok(ui.ev.some((e) => e[0] === 'state' && e[1] === 'acting' && e[2] === 'Opening Notepad'));
});

test('shortcuts and typing wait until the talk keys are up; opening things does not', async (t) => {
  const { speech, pc, voice } = rig(t);
  await voice.begin();
  const said = 'open notepad then press control s then type hi';
  speech.hear(said);
  await sleep(300);
  speech.hear(said, 'final');
  await until(() => pc.log.some((l) => l[0] === 'spawn'), 3000);
  await sleep(1200);
  assert.deepEqual(pc.log.map((l) => l[0]), ['spawn'], 'a synthetic Ctrl-up now would let go of the keys the person is holding');
  await voice.release();
  assert.deepEqual(pc.log.map((l) => l[0]), ['spawn', 'chord', 'type']);
  assert.deepEqual(pc.log.slice(1), [['chord', 'ctrl+s'], ['type', 'hi']]);
});

test('a typed command holds no keys, so it does not wait', async (t) => {
  const { pc, voice } = rig(t);
  await voice.runText('press control s then type hi');
  assert.deepEqual(pc.log, [['chord', 'ctrl+s'], ['type', 'hi']]);
});

test('releasing runs whatever is left, then offers to keep two or more actions as a routine', async (t) => {
  const { speech, pc, voice, ui, routines } = rig(t);
  await voice.begin();
  speech.hear('select all then copy');
  await voice.release();
  assert.deepEqual(pc.log, [['chord', 'ctrl+a'], ['chord', 'ctrl+c']]);
  await until(() => ui.offers.length === 1);
  assert.deepEqual(ui.offers[0].labels, ['Pressing Ctrl+A', 'Pressing Ctrl+C']);
  await until(() => routines.list().length === 1);
  assert.equal(routines.list()[0].actions.length, 2);
  assert.ok(ui.ev.some((e) => e[0] === 'say' && /Saved as/.test(e[1])));
  // the same chain is not offered twice
  await voice.begin(); speech.hear('paste'); await voice.release();
  await sleep(30);
  assert.equal(ui.offers.length, 1);
});

test('"skip" keeps nothing, and one action alone is never offered', async (t) => {
  const r = rig(t);
  r.ui.offerAnswer = 'skip';
  await r.voice.begin(); r.speech.hear('select all then copy'); await r.voice.release();
  await until(() => r.ui.offers.length === 1);
  await sleep(20);
  assert.equal(r.routines.list().length, 0);
  const one = rig(t);
  await one.voice.begin(); one.speech.hear('save'); await one.voice.release();
  await sleep(30);
  assert.equal(one.ui.offers.length, 0);
});

test('"run my routine" and "save that as a routine" by voice', async (t) => {
  const { speech, pc, voice, routines, ui } = rig(t);
  routines.save({ name: 'Morning', actions: [{ type: 'press_keys', keys: ['ctrl', 'a'] }, { type: 'type_text', text: 'x' }] });
  await voice.begin(); speech.hear('run my routine'); await voice.release();
  assert.deepEqual(pc.log, [['chord', 'ctrl+a'], ['type', 'x']]);
  assert.equal(routines.list()[0].runs, 1);
  ui.offerAnswer = 'skip';
  await voice.begin(); speech.hear('copy then paste then save that as a routine called pair'); await voice.release();
  await until(() => routines.list().length === 2);
  assert.ok(routines.list().some((r) => r.name === 'pair' && r.actions.length === 2));
});

test('a step that fails stops the rest of the sentence', async (t) => {
  const { speech, pc, voice, ui } = rig(t);
  await voice.begin(); speech.hear('open flarbnitz then type hello'); await voice.release();
  assert.ok(!pc.log.some((l) => l[0] === 'type'));
  assert.ok(ui.ev.some((e) => e[0] === 'notice' && /couldn't find an app called flarbnitz/.test(e[1])));
});

test('words the grammar does not know go to Jev, then to a model', async (t) => {
  const asked = [];
  const getJev = () => ({ plan: async (text) => { asked.push(text); return /make it louder/.test(text) ? { actions: [{ type: 'media', op: 'vol_up', times: 5 }], confidence: 0.9 } : { actions: [], confidence: 0.1 }; } });
  const ai = {
    canAnswer: () => true, claudeCode: { available: async () => false },
    answer: async (q) => ({ text: `Answer to: ${q}`, sources: [{ folder: 'Notes', file: 'a.md' }] }),
    plan: async (q) => ({ say: 'Drafting it.', actions: [{ type: 'compose_email', to: 'Sam', subject: 'Lab report', body: 'Hi' }], dropped: 0 }),
  };
  const { speech, pc, voice, ui } = rig(t, { getJev, ai });
  await voice.begin(); speech.hear('make it louder'); await voice.release();
  assert.deepEqual(asked, ['make it louder']);
  assert.ok(pc.log.length === 0, 'volume keys go through the sidecar media call, not the log');
  await voice.begin(); speech.hear("what's on my calendar"); await voice.release();
  assert.ok(ui.ev.some((e) => e[0] === 'say' && e[1] === "Answer to: what's on my calendar"));
  await voice.begin(); speech.hear('email sam the lab report'); await voice.release();
  assert.ok(pc.log.some((l) => l[0] === 'url' && l[1].startsWith('mailto:')), 'the planned email draft opened');
});

test('without any key, an unknown request says how to fix it instead of failing quietly', async (t) => {
  const ai = { canAnswer: () => false, claudeCode: { available: async () => false } };
  const { speech, voice, ui } = rig(t, { ai });
  await voice.begin(); speech.hear('what is a trefoil knot'); await voice.release();
  assert.ok(ui.ev.some((e) => e[0] === 'notice' && /Anthropic key/.test(e[1])));
});

test('Check first can be answered by voice', async (t) => {
  const { speech, pc, voice, ui } = rig(t);
  await voice.begin(); speech.hear('click send');
  const finished = voice.release();
  await until(() => ui.asks.length === 1);
  assert.equal(ui.asks[0].title, 'Click “Send”?');
  assert.equal(voice.asking, true);
  await voice.begin(); speech.hear('yes'); await voice.release();
  await finished;
  assert.deepEqual(pc.log, [['invoke', 'send']]);
  assert.equal(voice.asking, false);
});

test('Check first, answered "not now" by voice: nothing is clicked', async (t) => {
  const { speech, pc, voice, ui } = rig(t);
  await voice.begin(); speech.hear('click send');
  const finished = voice.release();
  await until(() => ui.asks.length === 1);
  await voice.begin(); speech.hear('not now'); await voice.release();
  await finished;
  assert.deepEqual(pc.log, []);
});

test('conditional yes does not approve the original action', async (t) => {
  const { speech, pc, voice, ui } = rig(t);
  ui.closeAll = () => ui.ev.push(['closeAll']);
  await voice.begin(); speech.hear('click send');
  const finished = voice.release();
  await until(() => ui.asks.length === 1);
  await voice.begin(); speech.hear('yes, but change the recipient first'); await voice.release();
  await finished;
  assert.deepEqual(pc.log, []);
  assert.ok(ui.ev.some((e) => e[0] === 'notice' && /revised request/i.test(e[1])));
});

test('panel shortcuts share the cancellable voice session and reject overlap', async (t) => {
  const { voice, pc } = rig(t);
  const out = await voice.runRoutine({ id: 'r1', name: 'Morning', actions: [{ type: 'type_text', text: 'hi' }] });
  assert.equal(out.ok, true);
  assert.deepEqual(pc.log, [['type', 'hi']]);

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const blocked = rig(t, {
    executor: {
      runAll: async (_actions, ctx) => {
        await gate;
        return { ok: !(ctx.signal && ctx.signal.aborted), results: [], cancelled: Boolean(ctx.signal && ctx.signal.aborted) };
      },
    },
  });
  const first = blocked.voice.runRoutine({ id: 'r2', name: 'Slow', actions: [{ type: 'type_text', text: 'a' }] });
  await until(() => blocked.voice.active);
  const second = await blocked.voice.runRoutine({ id: 'r3', name: 'Overlap', actions: [{ type: 'type_text', text: 'b' }] });
  assert.equal(second.ok, false);
  assert.match(second.error, /already running/i);
  blocked.voice.cancel();
  release();
  assert.equal((await first).ok, false);
});

test('cancelling stops everything and frees the keys', async (t) => {
  const { speech, voice, ui } = rig(t);
  await voice.begin(); speech.hear('open notepad');
  voice.cancel();
  assert.equal(voice.active, false);
  assert.equal(speech.canceled, true);
  assert.deepEqual(ui.ev.at(-1), ['state', 'idle', undefined]);
  assert.equal(await voice.begin(), true, 'ready for the next one');
});

test('typing a command works like saying it', async (t) => {
  const { pc, voice } = rig(t);
  assert.equal(await voice.runText('open notepad then type hello'), true);
  assert.deepEqual(pc.log.map((l) => l[0]), ['spawn', 'type']);
});

test('hearing nothing says so', async (t) => {
  const { voice, ui } = rig(t);
  await voice.begin(); await voice.release();
  assert.ok(ui.ev.some((e) => e[0] === 'notice' && /did not catch/.test(e[1])));
});

test('autoWand fires after a computer navigation task (empty actions list)', async (t) => {
  // Regression: computer agent returns actions:[] so askModel returned {ok,said} with no completion,
  // causing doClause to return early before the autoWand check was reached.
  const pointAtCalls = [];
  const pointAsk = { pointAt: async (rect, el, win) => { pointAtCalls.push({ rect, el, win }); } };
  const snapshot = {
    elements: [{ name: 'Close', type: 'Button', rect: { x: 1300, y: 10, w: 50, h: 30 } }],
    window: { title: 'My App' },
  };
  const ai = {
    canAnswer: () => true, usesClaudeRouting: () => true,
    plan: async () => ({ say: 'Click the Close button in the top-right corner.', actions: [], snapshot, computerUsed: true }),
  };
  const { voice } = rig(t, { ai, pointAsk });
  await voice.runText('show me where to close the current window');
  assert.equal(pointAtCalls.length, 1, 'autoWand fired after computer navigation');
  assert.equal(pointAtCalls[0].el.name, 'Close');
  assert.deepEqual(pointAtCalls[0].rect, { x: 1300, y: 10, w: 50, h: 30 });
  assert.equal(pointAtCalls[0].win.title, 'My App');
});

test('autoWand matches multi-word element name by its significant word', async (t) => {
  // The agent says "Close button" but the element is named "Close Window"; the
  // fallback word-level match should still find it.
  const pointAtCalls = [];
  const pointAsk = { pointAt: async (rect, el) => { pointAtCalls.push(el.name); } };
  const snapshot = {
    elements: [{ name: 'Close Window', type: 'Button', rect: { x: 1300, y: 10, w: 50, h: 30 } }],
    window: { title: 'My App' },
  };
  const ai = {
    canAnswer: () => true, usesClaudeRouting: () => true,
    plan: async () => ({ say: 'Use the Close button at the top right to dismiss the window.', actions: [], snapshot, computerUsed: true }),
  };
  const { voice } = rig(t, { ai, pointAsk });
  await voice.runText('show me where to close the current window');
  assert.equal(pointAtCalls.length, 1, 'autoWand matched on significant word from multi-word name');
  assert.equal(pointAtCalls[0], 'Close Window');
});
