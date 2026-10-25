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
      elements.set(selector, { dataset: {}, style: { setProperty: noop }, textContent: '',
        offsetWidth: selector === '#meeting-reminder' ? 220 : 250, offsetHeight: selector === '#meeting-reminder' ? 118 : 150,
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
    setTimeout: (fn) => { const key = ++id; timers.set(key, () => { timers.delete(key); return fn(); }); return key; }, clearTimeout: (key) => timers.delete(key),
  });
  return { events, elements, targets, timers, notify: (meetings = [{ title: 'Meeting', startMs: Date.now() + 15 * 60000 }]) => events.get('calendar:reminder')({ events: meetings }) };
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
  assert.equal(r.targets.at(-1).options.holdMs, 600);
  assert.equal(r.targets.at(-1).options.wrap, undefined);
  r.elements.get('#meeting-dismiss').handlers.get('click')();
  assert.equal(r.elements.get('#meeting-reminder').classList.contains('hidden'), true);
  assert.equal(r.elements.get('#clock-highlight').classList.contains('hidden'), true);
  assert.equal(r.timers.size, 0);
});

test('hidden clock and late responses never target the popup or revive a dismissed reminder', async () => {
  let resolve;
  const r = rig(() => new Promise((done) => { resolve = done; })); await flush();
  r.notify(); r.elements.get('#meeting-dismiss').handlers.get('click')();
  resolve({ x: 1280, y: 0, w: 160, h: 24 }); await flush();
  assert.equal(r.targets.length, 0);
  assert.equal(r.elements.get('#clock-highlight').classList.contains('hidden'), true);
  const hidden = rig(async () => null); await flush(); hidden.notify(); await flush();
  assert.equal(hidden.targets.length, 0);
  assert.equal(hidden.elements.get('#clock-highlight').classList.contains('hidden'), true);
  assert.match(hidden.elements.get('#meeting-countdown').textContent, /System clock unavailable/);
  assert.equal(hidden.elements.get('#meeting-reminder').classList.contains('hidden'), false);
});

test('compact event details sit left of the Windows clock and above the taskbar', async () => {
  const clock = { x: 1300, y: 860, w: 100, h: 40 };
  const r = rig(async () => clock); await flush();
  r.events.get('overlay:area')({ x: 0, y: 0, width: 1440, height: 860, right: 0, bottom: 40 });
  const startMs = Date.now() + 5 * 60000;
  r.notify([{ title: 'Design review', startMs }]); await flush();
  const card = r.elements.get('#meeting-reminder'); const outline = r.elements.get('#clock-highlight');
  assert.equal(outline.classList.contains('hidden'), false);
  assert.equal(outline.style.left, '1300px'); assert.equal(outline.style.top, '860px');
  assert.equal(outline.style.width, '100px'); assert.equal(outline.style.height, '40px');
  assert.deepEqual(r.targets.at(-1).rect, clock);
  assert.equal(card.style.left, '1072px'); assert.equal(card.style.top, '734px');
  assert.ok(parseFloat(card.style.left) + card.offsetWidth < clock.x);
  assert.ok(parseFloat(card.style.top) + card.offsetHeight < clock.y);
  assert.equal(r.elements.get('#meeting-title').textContent, 'Design review');
  assert.equal(r.elements.get('#meeting-time').dateTime, new Date(startMs).toISOString());
  assert.match(r.elements.get('#meeting-countdown').textContent, /^Starts in [1-5] minutes?$/);
  [...r.timers.values()][0]();
  assert.equal(card.classList.contains('hidden'), true);
  assert.equal(outline.classList.contains('hidden'), true);
});

test('clock popup stays in the work area for top and side taskbars and moves with display changes', async () => {
  let clock = { x: 1280, y: 0, w: 160, h: 24 };
  const r = rig(async () => clock); await flush();
  r.events.get('overlay:area')({ x: 0, y: 24, width: 1440, height: 876, right: 0, bottom: 0 });
  r.notify(); await flush();
  const card = r.elements.get('#meeting-reminder');
  assert.equal(card.style.left, '1212px'); assert.equal(card.style.top, '32px');
  clock = { x: 0, y: 730, w: 48, h: 130 };
  r.events.get('overlay:area')({ x: 48, y: 0, width: 1392, height: 900, right: 0, bottom: 0 });
  await flush();
  assert.equal(card.style.left, '56px'); assert.equal(card.style.top, '736px');
  assert.equal(r.elements.get('#clock-highlight').style.width, '48px');
  clock = null;
  r.events.get('overlay:area')({ x: 0, y: 0, width: 1440, height: 900, right: 0, bottom: 0 });
  await flush();
  assert.equal(r.elements.get('#clock-highlight').classList.contains('hidden'), true);
  assert.equal(card.classList.contains('hidden'), false);
  assert.match(r.elements.get('#meeting-countdown').textContent, /System clock unavailable/);
});

test('a clock near the left edge keeps the compact reminder on screen', async () => {
  const r = rig(async () => ({ x: 120, y: 860, w: 100, h: 40 })); await flush();
  r.events.get('overlay:area')({ x: 0, y: 0, width: 1440, height: 860, right: 0, bottom: 40 });
  r.notify(); await flush();
  const card = r.elements.get('#meeting-reminder');
  assert.equal(card.style.left, '8px'); assert.equal(card.style.top, '734px');
  assert.equal(r.elements.get('#meeting-title').textContent, 'Meeting');
});

test('a cold Windows clock lookup retries once and dismissal cancels the retry', async () => {
  const clock = { x: 1300, y: 860, w: 100, h: 40 }; let reads = 0;
  const r = rig(async () => ++reads === 1 ? null : clock); await flush();
  r.notify(); await flush();
  assert.equal(r.targets.length, 0); assert.equal(r.timers.size, 2);
  await [...r.timers.values()].at(-1)(); await flush();
  assert.equal(reads, 2); assert.deepEqual(r.targets.at(-1).rect, clock);
  assert.equal(r.elements.get('#clock-highlight').classList.contains('hidden'), false);
  assert.doesNotMatch(r.elements.get('#meeting-countdown').textContent, /unavailable/);
  assert.equal(r.timers.size, 1);
  const missing = rig(async () => null); await flush(); missing.notify(); await flush();
  await [...missing.timers.values()].at(-1)(); await flush();
  assert.equal(missing.timers.size, 1, 'there is no continuing clock poll');
  missing.elements.get('#meeting-dismiss').handlers.get('click')();
  assert.equal(missing.timers.size, 0);
});
