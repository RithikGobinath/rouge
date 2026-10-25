'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

for (const reduced of [false, true]) for (const box of [{ x: 900, y: 250, w: 120, h: 30 }, { x: 1280, y: 0, w: 160, h: 24 }, { x: 1300, y: 860, w: 140, h: 40 }]) {
test(`underline stays below a clock at ${box.x},${box.y} and settles (reduced motion: ${reduced})`, () => {
  let now = 0; let id = 0; let arrived = 0; let spots = 0; let glows = 0; let curves = 0; let rewound = 0;
  const frames = new Map(); const painted = []; const unravel = [];
  const noop = () => {};
  const context = new Proxy({ fillRect: (x, y, w, h) => painted.push({ x, y, w, h, shadow: context.shadowBlur }), moveTo: () => { curves += 1; }, lineTo: () => { curves += 1; }, rect: () => { spots += 1; } }, { get: (target, key) => target[key] ?? noop });
  const material = { TAU: Math.PI * 2, clamp: (v, lo, hi) => Math.max(lo, Math.min(hi, v)),
    mix: (a, b, t) => a + (b - a) * t, smooth: (v) => { const t = Math.max(0, Math.min(1, v)); return t * t * (3 - 2 * t); },
    parseColor: (_text, fallback) => fallback, norm: (values) => values, shade: () => [255, 0, 0], rgb: () => 'red', glow: () => { glows += 1; } };
  const window = { SatinMaterial: material, innerWidth: 1440, innerHeight: 900, devicePixelRatio: 1,
    matchMedia: () => ({ matches: reduced }), location: { search: '' }, addEventListener: noop, removeEventListener: noop };
  const sandbox = { window, performance: { now: () => now }, getComputedStyle: () => ({ getPropertyValue: () => '' }),
    requestAnimationFrame: (fn) => { frames.set(++id, fn); return id; }, cancelAnimationFrame: (key) => frames.delete(key) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/shared/strand.js'), 'utf8'), sandbox);
  const canvas = { getContext: () => context, dataset: {}, width: 0, height: 0 };
  const mark = { getTailFrame: () => ({ x: 100, y: 500, tx: 1, ty: 0, r: 5, hw: 4 }), setUnravel: (value) => unravel.push(value) };
  const strand = window.Strand.mount(canvas, mark, { onArrive: () => { arrived += 1; }, onRewound: () => { rewound += 1; } });
  strand.setTarget(box, { underline: true, holdMs: 0 });
  for (let count = 0; frames.size && count < 100; count += 1) {
    now += 16; const [key, fn] = frames.entries().next().value; frames.delete(key); fn(now);
  }
  assert.equal(arrived, 1);
  assert.equal(strand.getState(), 'pointing');
  assert.equal(frames.size, 0, 'settled reminder uses no animation loop');
  assert.equal(spots, 0, 'no corner markers cover the clock');
  assert.equal(curves, 0, 'no loop or connecting ribbon crosses the digits');
  assert.equal(glows, 0, 'no glow obscures nearby text');
  assert.ok(painted.length > 0);
  const y = Math.min(box.y + box.h + 3, 898);
  assert.ok(painted.every((r) => r.y === y && r.h === 2 && r.shadow === 0), 'all frames use the same thin line');
  assert.ok(painted.every((r) => r.x >= box.x && r.x + r.w <= 1439 && r.w <= box.w && r.y + r.h <= 900), 'underline stays within the display');
  assert.ok(painted.at(-1).w >= Math.min(box.w, 1439 - box.x) - 0.01, 'the line spans the clock');
  assert.ok(unravel.every((value) => value === 0), 'the companion does not unroll an incoming ribbon');
  strand.rewind();
  for (let count = 0; frames.size && count < 100; count += 1) {
    now += 16; const [key, fn] = frames.entries().next().value; frames.delete(key); fn(now);
  }
  assert.equal(rewound, 1);
  assert.equal(strand.getState(), 'idle');
  assert.equal(frames.size, 0);
  strand.destroy();
});
}
