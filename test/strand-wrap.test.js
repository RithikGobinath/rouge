'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('wrapped strand surrounds the time and stops requesting frames after settling', () => {
  let now = 0; let id = 0; let arrived = 0; let spots = 0;
  const frames = new Map(); const painted = [];
  const noop = () => {};
  const context = new Proxy({ moveTo: (x, y) => painted.push([x, y]), lineTo: (x, y) => painted.push([x, y]), rect: () => { spots += 1; } }, { get: (target, key) => target[key] ?? noop });
  const material = { TAU: Math.PI * 2, clamp: (v, lo, hi) => Math.max(lo, Math.min(hi, v)),
    mix: (a, b, t) => a + (b - a) * t, smooth: (v) => { const t = Math.max(0, Math.min(1, v)); return t * t * (3 - 2 * t); },
    parseColor: (_text, fallback) => fallback, norm: (values) => values, shade: () => [255, 0, 0], rgb: () => 'red', glow: noop };
  const window = { SatinMaterial: material, innerWidth: 1440, innerHeight: 900, devicePixelRatio: 1,
    matchMedia: () => ({ matches: false }), location: { search: '' }, addEventListener: noop, removeEventListener: noop };
  const sandbox = { window, performance: { now: () => now }, getComputedStyle: () => ({ getPropertyValue: () => '' }),
    requestAnimationFrame: (fn) => { frames.set(++id, fn); return id; }, cancelAnimationFrame: (key) => frames.delete(key) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/shared/strand.js'), 'utf8'), sandbox);
  const canvas = { getContext: () => context, dataset: {}, width: 0, height: 0 };
  const mark = { getTailFrame: () => ({ x: 100, y: 500, tx: 1, ty: 0, r: 5, hw: 4 }), setUnravel: noop };
  const strand = window.Strand.mount(canvas, mark, { onArrive: () => { arrived += 1; } });
  strand.setTarget({ x: 900, y: 250, w: 120, h: 30 }, { wrap: true, holdMs: 300 });
  for (let count = 0; frames.size && count < 100; count += 1) {
    now += 16; const [key, fn] = frames.entries().next().value; frames.delete(key); fn(now);
  }
  assert.equal(arrived, 1);
  assert.equal(strand.getState(), 'pointing');
  assert.equal(frames.size, 0, 'settled reminder uses no animation loop');
  assert.equal(spots, 0, 'wrap replaces the ordinary corner marker');
  assert.ok(painted.some(([x, y]) => x > 1020 && y >= 245 && y <= 285), 'ribbon reaches right of the time');
  assert.ok(painted.some(([x, y]) => y < 250 && x > 900 && x < 1020), 'ribbon passes above the time');
  assert.ok(painted.some(([x, y]) => y > 280 && x > 900 && x < 1020), 'ribbon passes below the time');
  strand.destroy();
});
