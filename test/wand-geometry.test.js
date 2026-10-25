'use strict';
// Pure geometry only; no model, Electron window, screenshot or desktop input.
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../renderer/shared/wand-geometry');

test('the wand has a five-second symmetric cycle with a two-second hold', () => {
  assert.equal(G.TOTAL_MS, 5000);
  assert.equal(G.timeline(0).reach, 0);
  assert.equal(G.timeline(1500).phase, 'pointing');
  assert.equal(G.timeline(3499).reach, 1);
  assert.equal(G.timeline(3500).phase, 'rewinding');
  assert.equal(G.timeline(5000).phase, 'idle');
  assert.equal(G.timeline(5000).reach, 0);
  for (let t = 0; t <= 1500; t += 50) assert.ok(Math.abs(G.timeline(t).reach - G.timeline(5000 - t).reach) < 1e-10);
  assert.equal(G.timeline(0, .7).reach, .7, 'retargeting must preserve the current release');
});

test('a target must contain finite numeric coordinates and positive dimensions', () => {
  for (const value of [{ x: NaN, y: 0, w: 1, h: 1 }, { x: 1, y: 1, w: -1, h: 1 }, { x: '4', y: 1, w: 4, h: 4 }]) assert.equal(G.rect(value), null);
  assert.deepEqual(G.rect({ x: 1, y: 2, width: 3, height: 4 }), { x: 1, y: 2, w: 3, h: 4 });
});

test('the open orbit encloses every target corner while staying outside its text', () => {
  const box = { x: 400, y: 260, w: 210, h: 36 };
  for (const [x, y] of [[50, 50], [1200, 50], [50, 720], [1200, 720]]) {
    const plan = G.plan({ x, y, scale: .23 }, box);
    for (const cx of [box.x, box.x + box.w]) for (const cy of [box.y, box.y + box.h]) assert.ok(((cx - plan.cx) / plan.rx) ** 2 + ((cy - plan.cy) / plan.ry) ** 2 < 1);
    for (const p of plan.points.filter(p => p.s >= plan.entry.s)) assert.ok(p.x < box.x - 3 || p.x > box.x + box.w + 3 || p.y < box.y - 3 || p.y > box.y + box.h + 3);
    assert.ok(Math.hypot(plan.points.at(-1).x - plan.entry.x, plan.points.at(-1).y - plan.entry.y) > 10, 'the arc must remain open');
  }
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
