'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createHotkeys, alternatives, canonicalKeys } = require('../src/app/hotkeys');

const KEYS = { talk: 'Control+Alt+Space', point: 'Control+Shift+T', hide: 'Control+Shift+Space', panic: 'Control+Shift+X' };

function rig({ taken = [], keysDown = true } = {}) {
  const registered = new Map();
  const events = new EventEmitter();
  const calls = [];
  const sidecar = {
    on: (ev, cb) => { events.on(ev, cb); return () => events.off(ev, cb); },
    watch: async (vks, click, fg, owner) => { calls.push(['watch', vks, owner]); return { ok: true }; },
    unwatch: async (owner) => { calls.push(['unwatch', owner]); },
    keyState: async (vks) => ({ keys: Object.fromEntries(vks.map((v) => [String(v), keysDown])) }),
    tap: async (vk) => { calls.push(['tap', vk]); },
  };
  let clock = 1000;
  const handlers = {
    talkDown: async () => { calls.push(['talkDown']); }, talkUp: async (o) => { calls.push(['talkUp', o.tap]); },
    point: () => calls.push(['point']), toggle: () => calls.push(['toggle']), panic: () => calls.push(['panic']),
  };
  const hk = createHotkeys({
    sidecar, handlers, now: () => clock, log: () => {},
    register: (a, f) => { if (taken.includes(a)) return false; registered.set(a, f); return true; },
    unregister: (a) => registered.delete(a),
  });
  return { hk, registered, events, calls, tick: (ms) => { clock += ms; } };
}

test('a chord another app owns moves to its nearest free neighbour', () => {
  assert.deepEqual(alternatives('Control+Alt+Space'), ['Control+Alt+Shift+Space']);
  assert.deepEqual(alternatives('Control+Shift+X'), ['Control+Shift+Alt+X', 'Control+Alt+Shift+X']);
  assert.deepEqual(alternatives('Control+Alt+Shift+T'), []);
  const { hk, registered } = rig({ taken: ['Control+Alt+Space', 'Control+Shift+X'] });
  const result = hk.register(KEYS);
  assert.deepEqual(result, { talk: true, point: true, hide: true, panic: true });
  assert.deepEqual(hk.used, { talk: 'Control+Alt+Shift+Space', point: 'Control+Shift+T', hide: 'Control+Shift+Space', panic: 'Control+Shift+Alt+X' });
  assert.ok(registered.has('Control+Alt+Shift+Space') && !registered.has('Control+Alt+Space'));
});

test('when nothing is free, that hotkey is off, and the others are not', () => {
  const { hk } = rig({ taken: ['Control+Alt+Space', 'Control+Alt+Shift+Space'] });
  const r = hk.register(KEYS);
  assert.equal(r.talk, false);
  assert.equal(r.point, true);
  assert.equal(hk.used.talk, undefined);
  const strict = rig({ taken: ['Control+Alt+Space'] }).hk.register(KEYS, { fallback: false });
  assert.equal(strict.talk, false, 'with fallback off it does not wander');
});

test('chords turn into the keys to watch', () => {
  assert.deepEqual(canonicalKeys('Control+Alt+Shift+Space'), ['ctrl', 'alt', 'shift', 'space']);
  assert.deepEqual(canonicalKeys('CommandOrControl+F8'), ['ctrl', 'f8']);
});

test('hold to talk: down starts it, letting go of any key in the chord ends it', async () => {
  const { hk, registered, events, calls, tick } = rig();
  hk.register(KEYS);
  await registered.get('Control+Alt+Space')();
  assert.deepEqual(calls.map((c) => c[0]), ['watch', 'tap', 'talkDown'], 'watching, a keystroke that keeps Alt from opening a menu, then listening');
  assert.deepEqual(calls[0], ['watch', [0x11, 0x12, 0x20], 'talk']);
  assert.deepEqual(calls[1], ['tap', 0xE8]);
  assert.equal(hk.holding, true);
  await registered.get('Control+Alt+Space')();
  assert.equal(calls.filter((c) => c[0] === 'talkDown').length, 1, 'auto-repeat while held does not start it twice');
  tick(1500);
  events.emit('key', { vk: 0x20, down: false });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(calls.slice(-2), [['unwatch', 'talk'], ['talkUp', false]]);
  assert.equal(hk.holding, false);
});

test('a quick tap is a tap, and a key already up when the watch began ends it at once', async () => {
  const quick = rig();
  quick.hk.register(KEYS);
  await quick.registered.get('Control+Alt+Space')();
  quick.tick(120);
  quick.events.emit('key', { vk: 0x11, down: false });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(quick.calls.at(-1), ['talkUp', true]);

  const late = rig({ keysDown: false });
  late.hk.register(KEYS);
  await late.registered.get('Control+Alt+Space')();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(late.hk.holding, false);
  assert.equal(late.calls.at(-1)[0], 'talkUp');
});

test('the other hotkeys call their handlers', () => {
  const { hk, registered, calls } = rig();
  hk.register(KEYS);
  registered.get('Control+Shift+T')(); registered.get('Control+Shift+Space')(); registered.get('Control+Shift+X')();
  assert.deepEqual(calls.map((c) => c[0]), ['point', 'toggle', 'panic']);
  hk.unregister();
  assert.equal(registered.size, 0);
});
