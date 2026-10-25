'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { systemClockRect } = require('../src/calendar/systemClock');

const display = { x: 0, y: 0, width: 1440, height: 900 };
test('Mac clock uses native point bounds and one bounded metadata query', async () => {
  let calls = 0;
  const rect = await systemClockRect({ platform: 'darwin', helper: '/helper', display, overlayBounds: { x: 0, y: 0 },
    run(file, args, opts, cb) {
      calls += 1; assert.equal(file, '/helper'); assert.deepEqual(args, []); assert.equal(opts.timeout, 1500);
      cb(null, JSON.stringify({ x: 1280, y: 0, w: 160, h: 24 }));
    } });
  assert.equal(calls, 1);
  assert.deepEqual(rect, { x: 1280, y: 0, w: 160, h: 24 });
});

test('missing, hidden, malformed or off-display clocks have no fabricated target', async () => {
  for (const output of ['null', 'invalid', '{"x":1}', '{"x":0,"y":0,"w":0,"h":24}', '{"x":1400,"y":0,"w":160,"h":24}']) {
    assert.equal(await systemClockRect({ platform: 'darwin', helper: '/helper', display, overlayBounds: display,
      run: (_file, _args, _opts, cb) => cb(null, output) }), null);
  }
  assert.equal(await systemClockRect({ platform: 'darwin', helper: '/helper', display, overlayBounds: display,
    run: (_file, _args, _opts, cb) => cb(new Error('timeout'), '') }), null);
});

test('Windows taskbar physical pixels convert to overlay points at high DPI', async () => {
  assert.deepEqual(await systemClockRect({ platform: 'win32', display, overlayBounds: { x: 0, y: 0 },
    sidecar: { available: true, clock: async () => ({ rect: { x: 2640, y: 1720, w: 200, h: 80 } }) },
    physicalToDip: (p) => ({ x: p.x / 2, y: p.y / 2 }) }), { x: 1320, y: 860, w: 100, h: 40 });
  assert.equal(await systemClockRect({ platform: 'win32', display, overlayBounds: display,
    sidecar: { available: false, clock() { throw new Error('helper must stay stopped'); } } }), null);
});
