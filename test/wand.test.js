'use strict';
// Mocked renderer lifecycle. Authored for owner execution; never touches the desktop.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const G = require('../renderer/shared/wand-geometry');

async function fixture({ reduced = false, deferred = false } = {}) {
  let now = 0, seq = 0, arrived = 0, rewound = 0, feeding = false, resolve;
  const frames = new Map(), timers = new Map(), calls = [];
  const rest = [
    { x: 716 * G.S, y: 1033 * G.S, s: 0, lo: -10, hi: 10 },
    { x: 874 * G.S, y: 992 * G.S, s: 200, lo: -10, hi: 10 },
  ];
  const data = { rest, material: rest }, ready = deferred ? new Promise(r => { resolve = r; }) : Promise.resolve(data);
  const ctx = Object.fromEntries(['setTransform', 'clearRect', 'save', 'restore', 'beginPath', 'rect', 'clip', 'drawImage'].map(name => [name, (...args) => calls.push([name, ...args])]));
  const mark = { ready, getFrame: () => ({ x: 1100, y: 700, scale: .2 }), setFeeding: value => { feeding = value; }, setReducedMotion() {} };
  const media = { matches: reduced, addEventListener() {}, removeEventListener() {} };
  const document = { hidden: false, addEventListener() {}, removeEventListener() {} };
  const window = {
    RougeWandGeometry: G, matchMedia: () => media, addEventListener() {}, removeEventListener() {},
    RougeWandArt: { drawBase: () => calls.push(['base']), drawFront: () => calls.push(['front']), drawArch: () => calls.push(['arch']), createRenderer: () => ({ draw: () => ({}), destroy() {} }) },
  };
  const context = vm.createContext({ window, document, console, location: { search: '' }, URLSearchParams, innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1, performance: { now: () => now },
    requestAnimationFrame: cb => { frames.set(++seq, cb); return seq; }, cancelAnimationFrame: id => frames.delete(id),
    setTimeout: (cb, delay) => { timers.set(++seq, { cb, at: now + delay }); return seq; }, clearTimeout: id => timers.delete(id),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/shared/wand.js'), 'utf8'), context);
  const strand = window.RougeWand.mountStrand({ getContext: () => ctx, width: 1280, height: 800, dataset: {} }, mark, { onArrive: () => arrived++, onRewound: () => rewound++ });
  await Promise.resolve();
  return { strand, calls, get arrived() { return arrived; }, get rewound() { return rewound; }, get feeding() { return feeding; },
    async load() { resolve(data); await Promise.resolve(); },
    advance(time) { now = time; const pending = [...frames.values()]; frames.clear(); pending.forEach(cb => cb(now)); for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.cb(); } },
  };
}

const A = { x: 200, y: 120, w: 140, h: 35 }, B = { x: 650, y: 420, w: 100, h: 40 };

test('a complete cycle returns to the tied knot once at five seconds', async () => {
  const h = await fixture(); h.strand.setTarget(A);
  assert.equal(h.feeding, true); assert.ok(h.calls.some(c => c[0] === 'arch'), 'the initial cut must not blink the upper curve away');
  h.advance(1500); assert.equal(h.strand.getState(), 'pointing'); assert.equal(h.arrived, 1);
  assert.ok(h.calls.some(c => c[0] === 'clip' && c[1] === 'evenodd'), 'target text must be protected from ribbon paint');
  h.advance(3499); assert.equal(h.strand.getState(), 'pointing');
  h.advance(3500); assert.equal(h.strand.getState(), 'rewinding');
  h.advance(5000); assert.equal(h.strand.getState(), 'idle'); assert.equal(h.feeding, false); assert.equal(h.rewound, 1); assert.equal(h.strand.getTarget(), null);
});

test('a new target owns its deadline and an old cycle cannot clear it', async () => {
  const h = await fixture(); h.strand.setTarget(A); h.advance(1000); h.strand.setTarget(B);
  h.advance(2500); assert.equal(h.arrived, 1);
  h.advance(5000); assert.equal(h.strand.getTarget().x, B.x); assert.equal(h.rewound, 0);
  h.advance(6000); assert.equal(h.strand.getState(), 'idle'); assert.equal(h.rewound, 1);
});

test('repeated close requests do not restart a retraction', async () => {
  const h = await fixture(); h.strand.setTarget(A); h.advance(800); h.strand.rewind();
  h.advance(1000); h.strand.rewind(); h.advance(2300);
  assert.equal(h.strand.getState(), 'idle'); assert.equal(h.rewound, 1);
});

test('closing a queued target prevents a late asset load from reopening it', async () => {
  const h = await fixture({ deferred: true }); h.strand.setTarget(A); h.strand.rewind(); await h.load();
  assert.equal(h.strand.getTarget(), null); assert.equal(h.feeding, false); assert.equal(h.rewound, 1);
});

test('reduced motion holds a static target for two seconds then clears it', async () => {
  const h = await fixture({ reduced: true }); h.strand.setTarget(A);
  assert.equal(h.strand.getState(), 'pointing'); assert.equal(h.arrived, 1);
  h.advance(1999); assert.equal(h.strand.getState(), 'pointing');
  h.advance(2000); assert.equal(h.strand.getState(), 'idle'); assert.equal(h.rewound, 1);
});

test('invalid targets do not replace a valid active target', async () => {
  const h = await fixture(); h.strand.setTarget(A);
  assert.equal(h.strand.setTarget({ x: NaN, y: 0, w: 10, h: 10 }), false);
  assert.equal(h.strand.getTarget().x, A.x);
});
