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

test('a Terminal foreground can transition into Chrome without reading the shell tree', async () => {
  let processName = 'WindowsTerminal';
  let hwnd = 7;
  let serial = 0;
  const snapshots = [];
  const asked = [];
  const sidecar = {
    fg: async () => ({ hwnd, process: processName, title: processName === 'chrome' ? 'New Tab' : 'PowerShell' }),
    computerSnapshot: async () => {
      snapshots.push(processName);
      return { ok: true, snapshot: { snapshotId: `snapshot-${++serial}`, window: { hwnd, process: processName }, text: 'page body', elements: [{ name: 'Results', type: 'ListItem' }] } };
    },
    computerDescribe: async () => ({ ok: true, element: { type: 'Edit', name: 'Address' } }),
    computerAction: async () => ({ ok: true }),
    computerRelease: async () => ({ ok: true }),
  };
  const executor = {
    run: async () => {
      processName = 'chrome';
      hwnd = 99;
      return { ok: true };
    },
  };
  const session = createComputerController({
    sidecar, executor, ui: { ask: async (card) => { asked.push(card); return true; } },
  }).createSession({});
  const first = await session.runTool('computer_inspect', {});
  assert.equal(first.ok, true);
  assert.equal(first.snapshot.blocked, true);
  assert.equal(first.snapshot.elements.length, 0);
  assert.deepEqual(snapshots, [], 'blocked shells are not accessibility-walked');
  const opened = await session.runTool('computer_act', {
    snapshotId: first.snapshot.snapshotId,
    actions: [{ type: 'open_app', app: 'chrome' }],
  });
  assert.equal(opened.ok, true);
  assert.equal(opened.snapshot.blocked, undefined);
  assert.equal(opened.snapshot.window.process, 'chrome');
  assert.ok(snapshots.length >= 1 && snapshots.every((p) => p === 'chrome'));
  session.close();
});

test('Delete in Explorer asks first, matching click Delete', async () => {
  const asked = [];
  let serial = 0;
  const hwnd = 3;
  const sidecar = {
    fg: async () => ({ hwnd, process: 'explorer', title: 'Documents' }),
    computerSnapshot: async () => ({ ok: true, snapshot: { snapshotId: `snapshot-${++serial}`, window: { hwnd, process: 'explorer', title: 'Documents' }, text: '', elements: [] } }),
    computerDescribe: async () => ({ ok: true, element: { type: 'ListItem', name: 'report.docx' } }),
    computerAction: async () => ({ ok: true }),
    computerRelease: async () => ({ ok: true }),
  };
  const session = createComputerController({
    sidecar, executor: {}, ui: { ask: async (card) => { asked.push(card); return false; } },
  }).createSession({});
  const initial = await session.runTool('computer_inspect', {});
  const denied = await session.runTool('computer_act', {
    snapshotId: initial.snapshot.snapshotId,
    actions: [{ type: 'key', keys: ['delete'] }],
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'declined');
  assert.equal(asked.length, 1);
  assert.match(asked[0].hint, /deletes/);
  session.close();
});

test('F5 reloads a page that opened blank or stuck, and other reload chords stay out of reach', async () => {
  const actions = [];
  const sidecar = {
    fg: async () => ({ hwnd: 11, process: 'chrome' }),
    computerSnapshot: async () => ({ ok: true, snapshot: { snapshotId: `snapshot-${actions.length + 1}`, window: { hwnd: 11, process: 'chrome' }, text: '', elements: [] } }),
    computerDescribe: async () => ({ ok: true, element: null }),
    computerAction: async (id, action) => { actions.push(action); return { ok: true }; },
    computerRelease: async () => ({ ok: true }),
  };
  const session = createComputerController({ sidecar, executor: {}, ui: {} }).createSession({});
  const first = await session.runTool('computer_inspect', {});
  const reload = await session.runTool('computer_act', { snapshotId: first.snapshot.snapshotId, actions: [{ type: 'key', keys: ['f5'] }] });
  assert.equal(reload.ok, true);
  assert.deepEqual(actions, [{ type: 'key', vks: [0x74] }]);
  const other = await session.runTool('computer_act', { snapshotId: reload.snapshot.snapshotId, actions: [{ type: 'key', keys: ['ctrl', 'r'] }] });
  assert.equal(other.error.code, 'invalid_input');
  assert.equal(actions.length, 1, 'nothing was sent for the refused chord');
  session.close();
});
