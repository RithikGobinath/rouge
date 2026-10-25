'use strict';
// Pure geometry only; no model, Electron window, screenshot or desktop input.
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../renderer/shared/wand-geometry');

test('the wand has a seven-second symmetric cycle with a four-second hold', () => {
  assert.equal(G.TOTAL_MS, 7000);
  assert.equal(G.timeline(0).reach, 0);
  assert.equal(G.timeline(1500).phase, 'pointing');
  assert.equal(G.timeline(5499).reach, 1);
  assert.equal(G.timeline(5500).phase, 'rewinding');
  assert.equal(G.timeline(7000).phase, 'idle');
  assert.equal(G.timeline(7000).reach, 0);
  for (let t = 0; t <= 1500; t += 50) assert.ok(Math.abs(G.timeline(t).reach - G.timeline(7000 - t).reach) < 1e-10);
  assert.equal(G.timeline(0, .7).reach, .7, 'retargeting must preserve the current release');
});

test('the hold grows with the amount of text, from a four-second minimum to a fifteen-second cap', () => {
  assert.equal(G.holdFor(''), G.HOLD_MS); assert.equal(G.holdFor(undefined), G.HOLD_MS); assert.equal(G.holdFor('   '), G.HOLD_MS);
  assert.ok(G.holdFor('Click Save.') > G.HOLD_MS);
  assert.ok(G.holdFor('x'.repeat(100)) > G.holdFor('x'.repeat(40)));
  assert.equal(G.holdFor('x'.repeat(5000)), G.MAX_HOLD_MS);
});

test('a longer hold delays the retraction and keeps the same return time', () => {
  const hold = 9000;
  assert.equal(G.timeline(G.OUT_MS + hold - 1, 0, hold).phase, 'pointing');
  assert.equal(G.timeline(G.OUT_MS + hold, 0, hold).phase, 'rewinding');
  assert.equal(G.timeline(G.OUT_MS + hold + G.BACK_MS, 0, hold).phase, 'idle');
});

test('a target must contain finite numeric coordinates and positive dimensions', () => {
  for (const value of [{ x: NaN, y: 0, w: 1, h: 1 }, { x: 1, y: 1, w: -1, h: 1 }, { x: '4', y: 1, w: 4, h: 4 }]) assert.equal(G.rect(value), null);
  assert.deepEqual(G.rect({ x: 1, y: 2, width: 3, height: 4 }), { x: 1, y: 2, w: 3, h: 4 });
});

test('the wrap hugs the target: every lap clears the text, the last lap lies tight against it', () => {
  const dist = (p, box) => Math.hypot(Math.max(box.x - p.x, 0, p.x - box.x - box.w), Math.max(box.y - p.y, 0, p.y - box.y - box.h));
  for (const box of [{ x: 400, y: 260, w: 210, h: 36 }, { x: 900, y: 20, w: 60, h: 18 }, { x: 300, y: 300, w: 20, h: 20 }]) {
    for (const [x, y] of [[50, 50], [1200, 50], [50, 720], [1200, 720]]) {
      const plan = G.plan({ x, y, scale: .23 }, box), wrap = plan.points.filter(p => p.s >= plan.entry.s), d = wrap.map(p => dist(p, box));
      assert.ok(Math.min(...d) >= plan.halfWidth + 3, 'the ribbon edge never reaches the text');
      assert.ok(Math.abs(d.at(-1) - plan.tight) < 1e-6, 'the last lap sits one gap off the text');
      assert.ok(Math.abs(Math.min(...d) - plan.tight) < 1e-6, 'no part of the wrap is closer than the tight lap');
      assert.ok(Math.max(...d) <= plan.tight + 2 * plan.halfWidth + 1 + 1e-6, 'the wrap never drifts further than one coil out');
      for (let i = 1; i < d.length; i++) assert.ok(d[i] <= d[i - 1] + 1e-6 || d[i] - d[i - 1] < 1, 'the coil only tightens');
    }
  }
});

test('the wrap goes around the whole target at least twice', () => {
  const box = { x: 400, y: 260, w: 210, h: 36 }, plan = G.plan({ x: 1200, y: 720, scale: .23 }, box);
  const wrap = plan.points.filter(p => p.s >= plan.entry.s);
  let turned = 0, last = Math.atan2(wrap[0].y - plan.cy, wrap[0].x - plan.cx);
  for (const p of wrap.slice(1)) {
    let step = Math.atan2(p.y - plan.cy, p.x - plan.cx) - last;
    while (step > Math.PI) step -= 2 * Math.PI; while (step < -Math.PI) step += 2 * Math.PI;
    turned += step; last += step;
  }
  assert.ok(Math.abs(turned) > 2 * 2 * Math.PI * .98, 'two full laps');
});

test('retarget and resize morphs remain attached to the current fixed base', () => {
  const a = G.plan({ x: 1100, y: 700, scale: .2 }, { x: 100, y: 100, w: 100, h: 30 });
  const b = G.plan({ x: 70, y: 60, scale: .15 }, { x: 800, y: 500, w: 120, h: 40 });
  for (const t of [0, .1, .5, 1]) {
    const path = G.blendPlans(a, b, t);
    assert.ok(Math.hypot(path.points[0].x - b.points[0].x, path.points[0].y - b.points[0].y) < 1e-9);
    assert.ok(path.points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)));
  }
});

test('the opening ribbon keeps its root fixed and never produces an invalid tip', () => {
  const rest = [
    { x: 716 * G.S, y: 1033 * G.S, s: 0, lo: -12, hi: 12 },
    { x: 817 * G.S, y: 868 * G.S, s: 125, lo: -18, hi: 18 },
    { x: 874 * G.S, y: 992 * G.S, s: 225, lo: -9, hi: 9 },
  ];
  const frame = { x: 1150, y: 700, scale: .2 }, path = G.plan(frame, { x: 200, y: 180, w: 180, h: 36 });
  for (const reach of [0, .01, .04, .08, .12, .16, .5, 1]) {
    const pose = G.pose(rest, rest, path, reach, frame), first = pose.centers[0], last = pose.centers.at(-1), prior = pose.centers.at(-2);
    assert.ok(Math.hypot(first.x - path.points[0].x, first.y - path.points[0].y) < 1e-9);
    assert.ok(pose.centers.every(p => Object.values(p).every(Number.isFinite) && p.hi > p.lo));
    assert.ok(Math.hypot(last.x - prior.x, last.y - prior.y) > .00001);
  }
});
