'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function rig(readClock) {
  const events = new Map(); const elements = new Map(); const targets = []; const timers = new Map();
  const noop = () => {}; let hooks; let target; let id = 0;
  const element = (selector) => {
    if (!elements.has(selector)) {
      const classes = new Set(['hidden']); const handlers = new Map();
      elements.set(selector, { dataset: {}, style: { setProperty: noop }, textContent: '', offsetWidth: 250, offsetHeight: 150,
        classList: { contains: (c) => classes.has(c), add: (c) => classes.add(c), remove: (c) => classes.delete(c),
          toggle: (c, on) => on ? classes.add(c) : classes.delete(c) },
        getBoundingClientRect() {
          assert.notEqual(selector, '#meeting-time', 'the popup time must never be measured as a wand target');
          return { left: 1300, right: 1400, top: 750, bottom: 850, width: 100, height: 100 };
        },
        addEventListener: (name, fn) => handlers.set(name, fn), handlers, appendChild: noop, replaceChildren: noop });
    }
    return elements.get(selector);
  };
  const mark = { setState: noop, setScale: noop, pause: noop, resume: noop, setRotate: noop, getTailAnchor: () => null };
  const strand = { getTarget: () => target, setTarget: (rect, options) => { target = rect; targets.push({ rect, options }); },
    rewind: () => { target = null; hooks.onRewound(); }, relayout: noop };
  const bridge = { on: (name, fn) => events.set(name, fn), ready: noop, settingsGet: async () => ({}), clockRect: readClock, dismissReminder: noop };
  const Mark3D = { mount: () => mark }; const Strand = { mount: (_canvas, _mark, options) => { hooks = options; return strand; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/overlay/overlay.js'), 'utf8'), {
    window: { overlayApi: bridge, Mark3D, Strand }, Mark3D, Strand, innerWidth: 1440, innerHeight: 900,
    document: { querySelector: element, addEventListener: noop, body: element('body'), documentElement: element('html') },
    location: { search: '' }, addEventListener: noop, requestAnimationFrame: () => 1, cancelAnimationFrame: noop,
    setTimeout: (fn) => { timers.set(++id, fn); return id; }, clearTimeout: (key) => timers.delete(key),
  });
  return { events, elements, targets, timers, notify: () => events.get('calendar:reminder')({ events: [{ title: 'Meeting', startMs: Date.now() + 15 * 60000 }] }) };
}
const flush = async () => { await new Promise((resolve) => setImmediate(resolve)); };

test('meeting popup underlines the actual system clock, yields to guidance and retracts on dismissal', async () => {
  const clock = { x: 1280, y: 0, w: 160, h: 24 }; let reads = 0;
  const r = rig(async () => { reads += 1; return clock; });
  await flush();
  r.events.get('point:target')({ rect: { x: 100, y: 100, w: 40, h: 40 } });
  r.notify(); await flush();
  assert.equal(reads, 1);
  assert.equal(r.targets.length, 1, 'active guidance keeps priority');
  r.events.get('point:clear')();
  assert.deepEqual(r.targets.at(-1).rect, clock);
  assert.equal(r.targets.at(-1).options.underline, true);
  assert.equal(r.targets.at(-1).options.wrap, undefined);
  r.elements.get('#meeting-dismiss').handlers.get('click')();
  assert.equal(r.elements.get('#meeting-reminder').classList.contains('hidden'), true);
  assert.equal(r.timers.size, 0);
});

test('hidden clock and late responses never target the popup or revive a dismissed reminder', async () => {
  let resolve;
  const r = rig(() => new Promise((done) => { resolve = done; })); await flush();
  r.notify(); r.elements.get('#meeting-dismiss').handlers.get('click')();
  resolve({ x: 1280, y: 0, w: 160, h: 24 }); await flush();
  assert.equal(r.targets.length, 0);
  const hidden = rig(async () => null); await flush(); hidden.notify(); await flush();
  assert.equal(hidden.targets.length, 0);
  assert.match(hidden.elements.get('#meeting-countdown').textContent, /System clock unavailable/);
  assert.equal(hidden.elements.get('#meeting-reminder').classList.contains('hidden'), false);
});
