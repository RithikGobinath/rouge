'use strict';
// Authored for the computer loop; intentionally not run during implementation.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createComputerController } = require('../src/computer/controller');

test('computer batches preserve order, reject old refs, and stop at cancellation or an app switch', async () => {
  const ref = 'a'.repeat(32);
  function fixture(cancelOnFirst = false) {
    const abort = new AbortController();
    const calls = [];
    let serial = 0;
    let hwnd = 11;
    const sidecar = {
      fg: async () => ({ hwnd, process: 'chrome' }),
      computerSnapshot: async (expected) => {
        if (expected && expected !== hwnd) return { ok: false, code: 'foreground_changed' };
        return { ok: true, snapshot: { snapshotId: `snapshot-${++serial}`, window: { hwnd, process: 'chrome' }, text: '', elements: [] } };
      },
      computerDescribe: async () => ({ ok: true, element: { ref, type: 'Edit', name: 'Destination' } }),
      computerAction: async (id, action) => { calls.push([id, action.type]); if (cancelOnFirst) abort.abort(); return { ok: true }; },
      computerRelease: async () => ({ ok: true }),
    };
    const session = createComputerController({ sidecar, executor: {}, ui: {} }).createSession({ signal: abort.signal });
    return { session, calls, switchApp: () => { hwnd = 22; } };
  }
  const f = fixture();
  const initial = await f.session.runTool('computer_inspect', {});
  const input = { snapshotId: initial.snapshot.snapshotId, actions: [{ type: 'fill', ref, text: 'SFO' }, { type: 'key', keys: ['tab'] }] };
  const done = await f.session.runTool('computer_act', input);
  assert.equal(done.ok, true);
  assert.deepEqual(f.calls, [['snapshot-1', 'fill'], ['snapshot-1', 'key']]);
  assert.notEqual(done.snapshot.snapshotId, initial.snapshot.snapshotId);
  const stale = await f.session.runTool('computer_act', input);
  assert.equal(stale.error.code, 'stale_snapshot');
  assert.equal(f.calls.length, 2);
  f.switchApp();
  const switched = await f.session.runTool('computer_act', { snapshotId: stale.snapshot.snapshotId, actions: [{ type: 'key', keys: ['tab'] }] });
  assert.equal(switched.stopped, true);
  assert.equal(switched.error.code, 'foreground_changed');
  assert.equal(f.calls.length, 2);
  f.session.close();

  const c = fixture(true);
  const before = await c.session.runTool('computer_inspect', {});
  const cancelled = await c.session.runTool('computer_act', { ...input, snapshotId: before.snapshot.snapshotId });
  assert.equal(cancelled.stopped, true);
  assert.equal(cancelled.error.code, 'cancelled');
  assert.equal(c.calls.length, 1);
  c.session.close();
});
