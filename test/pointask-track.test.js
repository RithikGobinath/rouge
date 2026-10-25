'use strict';
// The wand follows a control it was sent to, and never wanders onto some other element.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPointAsk } = require('../src/pointing/pointAsk');

const CARD = 'From 609 US dollars. 1 stop flight with Delta. Leaves San Francisco International Airport at 6:05 AM on Sunday, October 25.';
const rect = { x: 2392, y: 1006, w: 260, h: 64 };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function rig(snapshots, clock) {
  const sent = []; const focus = new Set(); let call = 0;
  const sidecar = {
    computerSnapshot: async () => { const elements = snapshots[Math.min(call++, snapshots.length - 1)]; return { snapshot: { snapshotId: 's' + call, elements } }; },
    computerRelease: async () => {},
    on: (event, cb) => { focus.add(cb); return () => focus.delete(cb); },
  };
  const overlay = { send: (c, p) => sent.push([c, p]), physToOverlay: (r) => ({ x: r.x / 2, y: r.y / 2, w: r.w / 2, h: r.h / 2 }), win: {} };
  const p = createPointAsk({ sidecar, ai: {}, overlay, ui: { state() {}, notice() {} }, capture: {}, ...(clock ? { now: clock } : {}) });
  return { p, sent, polls: () => call, listeners: () => focus.size };
}
const targets = (sent) => sent.filter(([c]) => c === 'point:target').map(([, m]) => m);

test('a blank-named element in the window does not pull the wand away from the control', async () => {
  const { p, sent, polls } = rig([[{ name: ' ', rect: { x: 1448, y: 864, w: 7, h: 29 } }, { name: CARD, rect }]]);
  await p.pointAt(rect, { name: CARD, type: 'Group' }, { title: 'Flights' }, 'snap', 99);
  await wait(60);
  assert.ok(polls() >= 1, 'it did check');
  p.close();
  const all = targets(sent);
  assert.equal(all.length, 1, 'one target, the control itself');
  assert.deepEqual(all[0].rect, { x: 1196, y: 503, w: 130, h: 32 });
  assert.ok(!all[0].follow);
});

test('when the control scrolls the wand follows it, marked as a follow so its cycle is not restarted', async () => {
  const moved = { x: 2392, y: 900, w: 260, h: 64 };
  const { p, sent } = rig([[{ name: ' ', rect: { x: 1, y: 1, w: 7, h: 29 } }, { name: CARD, rect: moved }]]);
  await p.pointAt(rect, { name: CARD, type: 'Group' }, { title: 'Flights' }, 'snap', 99);
  await wait(60);
  p.close();
  const all = targets(sent);
  assert.equal(all.length, 2);
  assert.deepEqual(all[1], { rect: { x: 1196, y: 450, w: 130, h: 32 }, label: CARD, follow: true });
});

test('an unmoved control causes no retarget at all', async () => {
  const { p, sent } = rig([[{ name: CARD, rect }]]);
  await p.pointAt(rect, { name: CARD, type: 'Group' }, { title: 'Flights' }, 'snap', 99);
  await wait(400);
  p.close();
  assert.equal(targets(sent).length, 1);
});

test('when the wand has drawn back in, the control is no longer watched', async () => {
  const { p, sent, polls, listeners } = rig([[{ name: CARD, rect }]]);
  await p.pointAt(rect, { name: CARD, type: 'Group' }, { title: 'Flights' }, 'snap', 99);
  await wait(60);
  assert.ok(polls() >= 1); assert.equal(listeners(), 1);
  p.release();
  const seen = polls();
  await wait(500);
  assert.ok(polls() - seen <= 1, 'at most the poll already in flight finishes');
  assert.equal(listeners(), 0, 'no longer listening for focus changes');
  assert.equal(sent.filter(([c]) => c === 'point:clear').length, 1, 'release does not clear the screen: only the opening close() did');
  assert.equal(p.active, true, 'the session, and so its answer and Ask more, remain');
  p.close();   // closing after a release must not throw
  assert.equal(p.active, false);
});

test('release with nothing pointed at does nothing', () => {
  const { p } = rig([[]]);
  assert.doesNotThrow(() => p.release());
});

test('a control is never watched for longer than the cap', async () => {
  let clock = 1000;
  const { p, polls, listeners } = rig([[{ name: CARD, rect }]], () => clock);
  await p.pointAt(rect, { name: CARD, type: 'Group' }, { title: 'Flights' }, 'snap', 99);
  await wait(60);
  clock += 46000;
  await wait(250);
  const seen = polls();
  await wait(500);
  assert.equal(polls(), seen, 'polling has stopped');
  p.close();
  assert.equal(listeners(), 0);
});
