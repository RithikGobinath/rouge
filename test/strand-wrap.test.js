'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const cases = [
  { box: { x: 900, y: 250, w: 120, h: 30 }, origin: { x: 100, y: 500 }, y: 292, ratio: 1 },
  { box: { x: 1280, y: 0, w: 160, h: 24 }, origin: { x: 100, y: 500 }, y: 36, ratio: 2 },
  { box: { x: 1280, y: 0, w: 160, h: 24 }, origin: { x: 1390, y: 700 }, y: 36, ratio: 1 },
  { box: { x: 1300, y: 860, w: 140, h: 40 }, origin: { x: 1330, y: 780 }, y: 848, ratio: 2 },
];
for (const reduced of [false, true]) for (const { box, origin, y, ratio } of cases) {
  test(`wand connects to thick clock underline at ${box.x},${box.y}, from ${origin.x}, reduced motion ${reduced}`, () => {
    let now = 0; let id = 0; let arrived = 0; let rewound = 0; let glows = 0; let detached = 0;
    let clip = null; let polygon = []; let rects = [];
    const stack = []; const frames = new Map(); const painted = []; const unravel = [];
    const noop = () => {};
    const context = new Proxy({
      save: () => stack.push(clip), restore: () => { clip = stack.pop(); },
      beginPath: () => { polygon = []; rects = []; },
      moveTo: (x, y) => polygon.push([x, y]), lineTo: (x, y) => polygon.push([x, y]),
      rect: (x, y, w, h) => rects.push({ x, y, w, h }),
      clip: (rule) => { assert.equal(rule, 'evenodd'); assert.equal(rects.length, 2); clip = rects[1]; },
      fill: () => painted.push({ points: polygon, clip, at: now, shadow: context.shadowBlur }),
      stroke: () => { assert.ok(clip, 'every stroke protects the clock'); },
      fillRect: () => { detached += 1; },
    }, { get: (target, key) => target[key] ?? noop });
    const material = { clamp: (v, lo, hi) => Math.max(lo, Math.min(hi, v)),
      mix: (a, b, t) => a + (b - a) * t, smooth: (v) => { const t = Math.max(0, Math.min(1, v)); return t * t * (3 - 2 * t); },
      parseColor: (_text, fallback) => fallback, norm: (values) => values, shade: () => [255, 0, 0], rgb: () => 'red', glow: () => { glows += 1; } };
    const window = { SatinMaterial: material, innerWidth: 1440, innerHeight: 900, devicePixelRatio: ratio,
      matchMedia: () => ({ matches: reduced }), location: { search: '' }, addEventListener: noop, removeEventListener: noop };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/shared/strand.js'), 'utf8'), {
      window, performance: { now: () => now }, getComputedStyle: () => ({ getPropertyValue: () => '' }),
      requestAnimationFrame: (fn) => { frames.set(++id, fn); return id; }, cancelAnimationFrame: (key) => frames.delete(key),
    });
    const canvas = { getContext: () => context, dataset: {}, width: 0, height: 0 };
    const mark = { getTailFrame: () => ({ ...origin, tx: 1, ty: 0, r: 5, hw: 4 }), setUnravel: (value) => unravel.push(value) };
    const strand = window.Strand.mount(canvas, mark, { onArrive: () => { arrived += 1; }, onRewound: () => { rewound += 1; } });
    const drain = () => {
      for (let count = 0; frames.size && count < 100; count += 1) {
        now += 16; const [key, fn] = frames.entries().next().value; frames.delete(key); fn(now);
      }
    };
    strand.setTarget(box, { underline: true, holdMs: 0 }); drain();
    assert.equal(arrived, 1); assert.equal(strand.getState(), 'pointing'); assert.equal(frames.size, 0);
    assert.equal(detached, 0, 'uses the actual ribbon instead of a detached line');
    assert.equal(glows, 0, 'no glow obscures nearby text');
    assert.ok(unravel.some((value) => value > 0), 'the companion unrolls its wand');
    assert.ok(painted.length > 0);
    for (const paint of painted) {
      assert.ok(paint.clip, 'every filled piece protects the clock in every animation frame');
      assert.equal(paint.shadow, 0);
      assert.ok(paint.clip.x <= box.x * ratio && paint.clip.y <= box.y * ratio);
      assert.ok(paint.clip.x + paint.clip.w >= (box.x + box.w) * ratio);
      assert.ok(paint.clip.y + paint.clip.h >= (box.y + box.h) * ratio);
    }
    const settled = painted.filter((paint) => paint.at === now);
    assert.ok(settled.some((paint) => paint.points.some(([x, y]) => Math.hypot(x - origin.x, y - origin.y) < 10)), 'wand remains connected to the companion');
    const end = settled.slice(-10);
    assert.ok(end.every((paint) => paint.points.length === 4 && paint.points[1][1] === y && paint.points[2][1] === y), 'ends in a horizontal stroke without a curl or loop');
    assert.ok(end.every((paint) => Math.abs(paint.points[0][1] - y) === 4), 'underline is eight pixels thick');
    const centers = settled.filter((paint) => paint.points.length === 4 && paint.points[1][1] === y).flatMap((paint) => [paint.points[1][0], paint.points[2][0]]);
    assert.ok(Math.min(...centers) <= box.x + 3 && Math.max(...centers) >= Math.min(box.x + box.w, 1434) - 3, 'underline spans the clock');
    strand.rewind(); drain();
    assert.equal(rewound, 1); assert.equal(strand.getState(), 'idle'); assert.equal(frames.size, 0);
    strand.destroy();
  });
}
