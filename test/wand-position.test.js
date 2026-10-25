'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { positionTarget } = require('../src/pointing/positions');
const { createPointAsk } = require('../src/pointing/pointAsk');
const { createVoice } = require('../src/voice/session');

test('positions stay inside the overlay at normal and tiny sizes', () => {
  for (const size of [{ width: 1440, height: 900 }, { width: 20, height: 12 }]) {
    for (const text of ['top left corner', 'point to top right', 'bottom left', 'bottom right', 'center', 'left', 'right', 'top', 'bottom']) {
      const target = positionTarget(text, size);
      assert.ok(target, text);
      const r = target.rect;
      assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= size.width && r.y + r.h <= size.height);
    }
  }
  assert.deepEqual(positionTarget('point to the top-left corner of the screen', { width: 1440, height: 900 }).rect, { x: 16, y: 16, w: 40, h: 40 });
  assert.deepEqual(positionTarget('please move the wand to the middle', { width: 1440, height: 900 }).rect, { x: 700, y: 430, w: 40, h: 40 });
  for (const text of ['explain the top left corner', 'point to top left and click', 'point to the close button', '__proto__']) assert.equal(positionTarget(text, { width: 1440, height: 900 }), null);
  assert.equal(positionTarget('top left', { width: 0, height: 900 }), null);
  assert.deepEqual(positionTarget('top left', { x: 0, y: 24, width: 1440, height: 800 }).rect, { x: 16, y: 40, w: 40, h: 40 });
});

test('typed wand requests and known rectangles never touch AI, capture or computer controls', async () => {
  const forbidden = new Proxy({}, { get(_target, key) { throw new Error(`Unexpected call: ${String(key)}`); } });
  const sent = [];
  const overlay = { win: { getBounds: () => ({ width: 1440, height: 900 }) }, show() {}, send: (name, data) => sent.push([name, data]), physToOverlay: (r) => r };
  const ui = { state() {}, transcript() {}, closeAll() {} };
  const pointAsk = createPointAsk({ overlay, ui, ai: forbidden, capture: forbidden, sidecar: forbidden });
  const voice = createVoice({ pointAsk, ui, ai: { usesClaudeRouting: () => true, canAnswer() { throw new Error('No key check needed'); } },
    sidecar: forbidden, executor: forbidden, calendar: forbidden, settings: () => ({}), sleep: async () => {} });
  assert.equal(await voice.runText('point to the top left corner'), true);
  assert.equal(sent.find(([name]) => name === 'point:target')[1].label, 'Top left');
  assert.equal(await pointAsk.followUp('explain'), false);
  assert.equal(await voice.runText('stop'), true);
  assert.equal(pointAsk.active, false);
  assert.equal(await pointAsk.pointAt({ x: 40, y: 50, w: 20, h: 30 }, { name: 'Known button' }), true);
  assert.equal(sent.filter(([name]) => name === 'point:target').at(-1)[1].label, 'Known button');
  pointAsk.close();
});

test('known controls keep main window tracking without capture or model calls', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const forbidden = new Proxy({}, { get() { throw new Error('No model or capture for a known control'); } });
  const sent = []; const released = []; const listeners = new Map(); let reads = 0;
  const moved = { x: 60, y: 70, w: 20, h: 30 };
  const pointAsk = createPointAsk({ ai: forbidden, capture: forbidden, ui: { state() {} },
    overlay: { show() {}, send: (name, data) => sent.push([name, data]), physToOverlay: (r) => r },
    sidecar: {
      computerSnapshot: async (hwnd) => { assert.equal(hwnd, 41); reads += 1; return { snapshot: {
        snapshotId: 'fresh', elements: [{ name: '', rect: { x: 0, y: 0, w: 1, h: 1 } }, { name: 'Known button', rect: moved }],
      } }; },
      computerRelease: async (id) => released.push(id),
      on: (event, fn) => { listeners.set(event, fn); return () => listeners.delete(event); },
    },
  });
  t.after(() => pointAsk.close());
  assert.equal(await pointAsk.pointAt({ x: 40, y: 50, w: 20, h: 30 }, { name: 'Known button' }, { hwnd: 41 }, 'old', 41), true);
  t.mock.timers.tick(0); await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent.filter(([name]) => name === 'point:target').at(-1)[1].rect, moved);
  assert.deepEqual(released, ['fresh']);
  listeners.get('fg')({ hwnd: 42 });
  assert.equal(pointAsk.active, false); assert.equal(listeners.size, 0);
  t.mock.timers.tick(150); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 1, 'tracking stops when the target window loses focus');
});
