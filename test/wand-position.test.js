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
