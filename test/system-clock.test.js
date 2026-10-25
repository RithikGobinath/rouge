'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { systemClockRect } = require('../src/calendar/systemClock');

const display = { x: 0, y: 0, width: 1440, height: 900 };
const nativeClock = path.join(__dirname, '../../rouge-user-data/bin/menu-clock');
test('built Mac helper resolves menu-bar time without discovering a display itself', {
  skip: process.platform !== 'darwin' || !fs.existsSync(nativeClock) ? 'Requires the local Mac development helper' : false,
}, () => {
  for (const [width, height, bar] of [[1440, 900, 30], [1920, 1080, 38], [1280, 800, 25]]) {
    const r = JSON.parse(execFileSync(nativeClock, ['0', '0', String(width), String(height), String(bar)], { encoding: 'utf8', timeout: 1500 }));
    assert.ok(r && r.w > 10 && r.w < 500);
    assert.ok(Math.abs(r.x + r.w - width) <= 2);
    assert.ok(r.y >= 0 && r.y < 64 && r.h > 0 && r.h <= 64);
  }
});

test('Mac clock uses native point bounds and one bounded metadata query', async () => {
  let calls = 0;
  const rect = await systemClockRect({ platform: 'darwin', helper: '/helper', display, workArea: { y: 25 }, overlayBounds: { x: 0, y: 0 },
    run(file, args, opts, cb) {
      calls += 1; assert.equal(file, '/helper'); assert.deepEqual(args, ['0', '0', '1440', '900', '25']); assert.equal(opts.timeout, 1500);
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

test('Windows clock failures report safe diagnostic codes instead of hiding the cause', async () => {
  for (const status of ['taskbar_missing', 'clock_not_found', 'ambiguous_clock', 'private control name']) {
    const logs = [];
    assert.equal(await systemClockRect({ platform: 'win32', display, overlayBounds: display,
      sidecar: { available: true, clock: async () => ({ rect: null, status }) }, log: (line) => logs.push(line) }), null);
    assert.deepEqual(logs, [`system clock: ${status === 'private control name' ? 'clock_not_found' : status}`]);
  }
  for (const [message, code] of [['system.clock timed out after 5000ms', 'lookup_timeout'], ['private helper text', 'lookup_failed']]) {
    const logs = [];
    assert.equal(await systemClockRect({ platform: 'win32', display, overlayBounds: display,
      sidecar: { available: true, clock: async () => { throw new Error(message); } }, log: (line) => logs.push(line) }), null);
    assert.deepEqual(logs, [`system clock: ${code}`]);
  }
});

test('invalid native bounds never reach DPI conversion or become a clock target', async () => {
  for (const rect of [{ x: 10, y: 10, w: -4, h: 20 }, { x: '10', y: 10, w: 4, h: 20 }, { x: 10, y: 10, w: 4, h: NaN }]) {
    const logs = [];
    assert.equal(await systemClockRect({ platform: 'win32', display, overlayBounds: display,
      sidecar: { available: true, clock: async () => ({ rect }) }, physicalToDip() { assert.fail('invalid bounds must be rejected first'); },
      log: (line) => logs.push(line) }), null);
    assert.deepEqual(logs, ['system clock: invalid_native_bounds']);
  }
  const logs = [];
  assert.equal(await systemClockRect({ platform: 'win32', display, overlayBounds: display,
    sidecar: { available: true, clock: async () => ({ rect: { x: 10, y: 10, w: 4, h: 20 } }) },
    physicalToDip() { throw new Error('conversion failed'); }, log: (line) => logs.push(line) }), null);
  assert.deepEqual(logs, ['system clock: coordinate_conversion_failed']);
});
