'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMeetingReminders, meetingEvents, LEAD_MS } = require('../src/calendar/reminders');
const BASE = Date.parse('2026-10-24T19:00:00Z');
const MINUTE = 60000;
const event = (id, minutes = 30, extra = {}) => ({ id, title: id, source: 'fixture',
  start: { dateTime: new Date(BASE + minutes * MINUTE).toISOString() },
  end: { dateTime: new Date(BASE + (minutes + 30) * MINUTE).toISOString() }, ...extra });

function rig(t, initial = { events: [event('Meeting')] }, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rouge-reminders-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'calendar.json'); const stateFile = path.join(dir, 'seen.json');
  if (initial !== null) fs.writeFileSync(file, JSON.stringify(initial));
  const delivered = []; const timers = new Map(); let clock = BASE; let serial = 0; let changed; let closed = false;
  const deps = { file, stateFile, now: () => clock, notify: (batch) => delivered.push(batch),
    watch: (_dir, listener) => { changed = listener; return { on() {}, close() { closed = true; } }; },
    setTimer: (fn, ms) => { timers.set(++serial, { fn, at: clock + ms, ms }); return serial; }, clearTimer: (id) => timers.delete(id), ...overrides };
  const reminders = createMeetingReminders(deps);
  t.after(() => reminders.stop());
  function advance(ms) {
    clock += ms;
    for (let count = 0; count < 30; count += 1) {
      const next = [...timers].find(([, value]) => value.at <= clock);
      if (!next) return;
      timers.delete(next[0]); next[1].fn();
    }
    throw new Error('Timer loop did not settle');
  }
  return { reminders, delivered, timers, deps, file, stateFile, advance, at: (value) => { clock = value; },
    change(snapshot) { fs.writeFileSync(file, typeof snapshot === 'string' ? snapshot : JSON.stringify(snapshot)); changed('rename', 'calendar.json'); },
    get closed() { return closed; } };
}

test('one deadline fires exactly 15 minutes before a meeting, once', (t) => {
  const h = rig(t); h.reminders.start();
  assert.equal(h.timers.size, 1);
  h.advance(LEAD_MS - 1); assert.equal(h.delivered.length, 0);
  h.advance(1); assert.equal(h.delivered.length, 1);
  assert.equal(h.delivered[0][0].title, 'Meeting');
  assert.equal(h.timers.size, 0);
  h.reminders.refresh(); assert.equal(h.delivered.length, 1);
  const saved = fs.readFileSync(h.stateFile, 'utf8');
  assert.ok(!saved.includes('Meeting'), 'journal stores hashes and times, not meeting titles');
});

test('simultaneous meetings share one notification and duplicate records collapse', (t) => {
  const h = rig(t, { events: [event('A'), event('B'), event('A')] }); h.reminders.start(); h.advance(LEAD_MS);
  assert.deepEqual(h.delivered[0].map((item) => item.title), ['A', 'B']);
  assert.equal(h.delivered.length, 1);
});

test('restart does not repeat an alert; wake inside the reminder window catches up', (t) => {
  const h = rig(t); h.reminders.start(); h.advance(LEAD_MS); h.reminders.stop();
  const restarted = createMeetingReminders(h.deps); restarted.start();
  assert.equal(h.delivered.length, 1); restarted.stop();
  const wake = rig(t); wake.reminders.start(); wake.at(BASE + 20 * MINUTE); wake.reminders.refresh();
  assert.equal(wake.delivered.length, 1);
  const past = rig(t); past.at(BASE + 31 * MINUTE); past.reminders.start();
  assert.equal(past.delivered.length, 0);
});

test('file replacement cancels the old deadline and reschedules an edited meeting', (t) => {
  const h = rig(t); h.reminders.start(); h.advance(10 * MINUTE);
  h.change({ events: [event('Meeting', 50)] }); assert.equal(h.timers.size, 1);
  h.advance(200); h.advance(5 * MINUTE); assert.equal(h.delivered.length, 0);
  h.advance(20 * MINUTE); assert.equal(h.delivered.length, 1);
  assert.equal(h.delivered[0][0].startMs, BASE + 50 * MINUTE);
});

test('missing, malformed and expired calendars do not fabricate reminders; file changes recover', (t) => {
  const h = rig(t, null); h.reminders.start(); assert.equal(h.reminders.status(), 'missing');
  h.change('{'); h.advance(200); assert.equal(h.reminders.status(), 'invalid');
  h.change({ events: [event('A', 10)], coverageEnd: new Date(BASE - 1).toISOString() });
  h.advance(200); assert.equal(h.reminders.status(), 'stale'); assert.equal(h.delivered.length, 0);
  h.change({ events: [event('A', 10)] }); h.advance(200);
  assert.equal(h.reminders.status(), 'ready'); assert.equal(h.delivered.length, 1);
});

test('cancelled, declined, all-day, past, invalid and recurrence masters are skipped', (t) => {
  const h = rig(t, { events: [event('Cancelled', 10, { cancelled: true }), event('Declined', 10, { response: 'declined' }),
    event('All day', 10, { isAllDay: true }), event('Past', -10), event('Invalid', 10, { start: {} }),
    event('Series', 10, { type: 'seriesMaster' }), event('Valid', 10)] });
  h.reminders.start(); assert.deepEqual(h.delivered[0].map((item) => item.title), ['Valid']);
});

test('calendar timezone conversion is independent of the computer timezone and respects DST', () => {
  const events = meetingEvents({ events: [
    event('Before DST', 30, { start: { dateTime: '2026-10-26T14:00:00', timeZone: 'Pacific Standard Time' }, end: { dateTime: '2026-10-26T14:30:00', timeZone: 'Pacific Standard Time' } }),
    event('After DST', 30, { start: { dateTime: '2026-11-03T14:00:00', timeZone: 'Pacific Standard Time' }, end: { dateTime: '2026-11-03T14:30:00', timeZone: 'Pacific Standard Time' } }),
  ] });
  assert.equal(new Date(events[0].startMs).toISOString(), '2026-10-26T21:00:00.000Z');
  assert.equal(new Date(events[1].startMs).toISOString(), '2026-11-03T22:00:00.000Z');
});

test('stop closes the watcher and timer; very distant meetings do not overflow setTimeout', (t) => {
  const h = rig(t, { events: [event('Distant', 60 * 24 * 60)] }); h.reminders.start();
  assert.equal([...h.timers.values()][0].ms, 2147483647);
  h.reminders.stop(); assert.equal(h.timers.size, 0); assert.equal(h.closed, true);
  h.advance(90 * 86400000); assert.equal(h.delivered.length, 0);
});

test('read-only calendar is unchanged; journal write failure does not stop future meetings', (t) => {
  const failingIo = Object.create(fs);
  failingIo.writeFileSync = () => { throw new Error('read only journal'); };
  const h = rig(t, { events: [event('A', 10), event('B', 40)] }, { io: failingIo });
  const source = fs.readFileSync(h.file, 'utf8');
  h.reminders.start(); assert.equal(h.reminders.status(), 'persistence_error');
  h.reminders.refresh(); assert.equal(h.delivered.length, 1);
  h.advance(25 * MINUTE); assert.equal(h.delivered.length, 2);
  assert.equal(fs.readFileSync(h.file, 'utf8'), source);
});
