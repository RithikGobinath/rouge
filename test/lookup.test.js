'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLookupWatch, tidy, looksPrivate, buildQuestion } = require('../src/lookup/watch');
const { pickAuto } = require('../src/ai/auto');
const { createStore } = require('../src/store');

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

test('a selection is one line of words, neither too short nor too long', () => {
  assert.equal(tidy('  quantum\n  entanglement\t'), 'quantum entanglement');
  assert.equal(tidy('​hello​'), 'hello');
  assert.equal(tidy('ab'), '');
  assert.equal(tidy('1234 5678'), '', 'no letters');
  assert.equal(tidy('word '.repeat(100)), '', 'a paragraph is copied, not looked up');
  assert.equal(tidy(null), '');
});

test('numbers, addresses and keys are never offered', () => {
  for (const text of ['4111 1111 1111 1111', '555-867-5309 ext 12', 'jane.doe@example.com', 'sk9fA2kQp0Zx81LmN34vB7tYc5Hd']) assert.equal(looksPrivate(text), true, text);
  for (const text of ['Schrödinger equation', 'iPhone 15 Pro Max 256GB', 'Windows 11 version 23H2 build 22631', 'ERR_CONNECTION_REFUSED']) assert.equal(looksPrivate(text), false, text);
});

test('the question names the text on its own line and is routed to Sonnet with the web tools', () => {
  const q = buildQuestion('Kolmogorov complexity');
  assert.ok(q.includes('Highlighted text: “Kolmogorov complexity”'));
  assert.deepEqual(pickAuto({ task: 'answer', user: q, goal: q }), { role: 'B', mode: 'reply' });
});

test('Look up highlighted text is a setting, on by default, and only a boolean', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rouge-lookup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const store = createStore({ dir, cipher: { available: () => true, encrypt: (v) => Buffer.from(v), decrypt: (b) => b.toString() } });
  assert.equal(store.settings().lookupOffers, true);
  assert.deepEqual(store.patch({ lookupOffers: false }), { ok: true });
  assert.equal(store.settings().lookupOffers, false);
  assert.equal(store.patch({ lookupOffers: 'no' }).ok, false, 'a non-boolean is refused');
});

function lookup(over = {}) {
  const ev = [];
  const st = { text: 'Kolmogorov complexity', own: false, title: 'Wikipedia - Google Chrome', busy: false, on: true, keys: { anthropic: true }, web: true, pending: { asks: 0, offers: 0 } };
  let answer = null; let now = 0; let click = null;
  const sidecar = {
    available: true,
    on: (name, fn) => { if (name === 'click') click = fn; },
    off: () => { click = null; },
    watch: async (keys, wantClick, fg, owner) => { ev.push(['watch', owner, wantClick]); },
    unwatch: async (owner) => { ev.push(['unwatch', owner]); },
    selection: async () => ({ text: st.text, own: st.own }),
    fg: async () => ({ hwnd: 7, title: st.title, process: 'chrome' }),
  };
  const ui = {
    pending: () => st.pending,
    ask: (card, o) => new Promise((resolve) => { ev.push(['ask', card.title, card.yes]); answer = resolve; o.signal.addEventListener('abort', () => resolve(false), { once: true }); }),
    state: (s) => ev.push(['state', s]),
    say: (text, o) => ev.push(['say', o.kicker, text]),
    notice: (text, o) => ev.push(['notice', text, o.tone]),
  };
  const store = { settings: () => ({ lookupOffers: st.on, webAccess: st.web, markHidden: false }), keyStatus: () => st.keys };
  const ai = over.ai || { research: async (question, o) => { ev.push(['research', question, o.system.includes('untrusted')]); return { text: 'A measure of how complex a string is.', sources: [], webUsed: true }; } };
  const watch = createLookupWatch({ sidecar, ui, ai, store, now: () => now, gapMs: 0, settleMs: 0, busy: () => st.busy });
  return { ev, st, watch, answer: (yes) => answer(yes), later: (ms) => { now += ms; }, click: () => click };
}
const asks = (h) => h.ev.filter((e) => e[0] === 'ask').length;

test('a highlighted phrase gets one card, and accepting it shows what Claude found', async () => {
  const h = lookup();
  h.watch.start();
  assert.deepEqual(h.ev, [['watch', 'lookup', true]]);
  await h.watch.check();
  await h.watch.check();
  assert.deepEqual(h.ev.slice(1), [['ask', 'Look up “Kolmogorov complexity”', 'Look up']]);
  h.answer(true);
  await settle();
  assert.deepEqual(h.ev.slice(2), [
    ['state', 'thinking'],
    ['research', buildQuestion('Kolmogorov complexity'), true],
    ['say', 'Look up · Kolmogorov complexity', 'A measure of how complex a string is.'],
    ['state', 'idle'],
  ]);
});

test('clicks, not a timer, trigger the check', async () => {
  const h = lookup();
  h.watch.start();
  h.click()();
  h.click()();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(asks(h), 1, 'two quick clicks (a double click) are one check');
});

test('nothing is offered for private windows, a busy Rouge, the off switch, missing keys, or private-looking text', async () => {
  const leave = [
    (st) => { st.title += ' (Incognito)'; },
    (st) => { st.busy = true; },
    (st) => { st.on = false; },
    (st) => { st.keys = {}; },
    (st) => { st.web = false; },
    (st) => { st.own = true; },
    (st) => { st.text = ''; },
    (st) => { st.text = 'a@b.co'; },
    (st) => { st.pending = { asks: 1, offers: 0 }; },
  ];
  for (const change of leave) {
    const h = lookup();
    change(h.st);
    await h.watch.check();
    assert.deepEqual(h.ev, [], String(change));
  }
});

test('a declined phrase is not offered again soon, and deselecting takes the card back', async () => {
  const h = lookup();
  await h.watch.check();
  h.answer(false);
  await settle();
  await h.watch.check();
  assert.equal(asks(h), 1, 'the same text within ten minutes');
  h.later(11 * 60000);
  await h.watch.check();
  assert.equal(asks(h), 2, 'after the cooldown');
  h.st.text = '';
  await h.watch.check();
  await settle();
  assert.equal(h.ev.filter((e) => e[0] === 'research').length, 0, 'the withdrawn card counts as no');
});

test('a different highlight replaces the card on screen', async () => {
  const h = lookup();
  await h.watch.check();
  h.st.text = 'Turing machine';
  await h.watch.check();
  assert.deepEqual(h.ev.filter((e) => e[0] === 'ask').map((e) => e[1]), ['Look up “Kolmogorov complexity”', 'Look up “Turing machine”']);
});

test('a lookup that fails says so, and one with no web search says it was not checked online', async () => {
  const failing = lookup({ ai: { research: async () => { throw Object.assign(new Error('Claude took too long to answer.'), { code: 'timeout' }); } } });
  await failing.watch.check();
  failing.answer(true);
  await settle();
  assert.deepEqual(failing.ev.filter((e) => e[0] === 'notice'), [['notice', 'Claude took too long to answer.', 'error']]);

  const memory = lookup({ ai: { research: async () => ({ text: 'A thing.', sources: [], webUsed: false }) } });
  await memory.watch.check();
  memory.answer(true);
  await settle();
  assert.deepEqual(memory.ev.find((e) => e[0] === 'say'), ['say', 'Look up · Kolmogorov complexity · not checked online', 'A thing.']);
});

test('stopping gives the helper its click watch back', async () => {
  const h = lookup();
  h.watch.start();
  h.watch.stop();
  assert.deepEqual(h.ev, [['watch', 'lookup', true], ['unwatch', 'lookup']]);
  assert.equal(h.click(), null);
});
