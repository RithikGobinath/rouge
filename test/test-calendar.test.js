'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTestCalendar } = require('../src/calendar/testCalendar');
const { createMeetingReminders } = require('../src/calendar/reminders');
const { createVoice } = require('../src/voice/session');
const BASE = Date.parse('2026-10-25T04:00:00Z'); // Oct 24, 9 PM Pacific

test('the exact textbox command resolves PM and the date in local time', () => {
  const calendar = createTestCalendar({ now: () => BASE, timeZone: 'America/Los_Angeles' });
  assert.equal(calendar.command('what time is it?'), null);
  const result = calendar.command('add meeting to calendar at 11:30 pm on oct 24');
  assert.equal(result.ok, true);
  const events = calendar.events();
  assert.equal(events.length, 1);
  assert.equal(events[0].start.dateTime, '2026-10-25T06:30:00.000Z');
  assert.equal(events[0].end.dateTime, '2026-10-25T07:00:00.000Z');
  assert.equal(events[0].title, 'Test meeting');
  assert.match(result.message, /Reminder at/);
  assert.equal(calendar.command('ADD MEETING TO CALENDAR AT 11:30 PM ON OCTOBER 24').ok, true);
  assert.equal(calendar.events().length, 1, 'same-time commands do not duplicate an event');
  assert.equal(createTestCalendar({ now: () => BASE, timeZone: 'America/Los_Angeles' }).events().length, 0, 'new app session starts empty');
});

test('bad syntax, impossible dates, invalid clocks and past times stay local and are rejected', () => {
  const calendar = createTestCalendar({ now: () => BASE, timeZone: 'America/Los_Angeles' });
  for (const text of ['add meeting to calendar at 0 pm on oct 24', 'add meeting to calendar at 13 pm on oct 24',
    'add meeting to calendar at 11:60 pm on oct 24', 'add meeting to calendar at 11 pm on feb 30 2027',
    'add meeting to calendar at 8 pm on oct 24', 'add meeting to calendar at 9 pm on oct 24',
    'add meeting to calendar at 11:30 on oct 24', 'add meeting to calendar at 11 pm on oct 24 and email everyone']) {
    assert.equal(calendar.command(text).ok, false, text);
  }
  assert.equal(calendar.events().length, 0);
  assert.equal(calendar.command('add meeting to calendar at 12 am on oct 25 2026').ok, true);
  assert.equal(calendar.events()[0].start.dateTime, '2026-10-25T07:00:00.000Z');
});

test('DST ambiguity is refused; expired temporary meetings are pruned without a timer', () => {
  let clock = BASE;
  const calendar = createTestCalendar({ now: () => clock, timeZone: 'America/Los_Angeles' });
  assert.equal(calendar.command('add meeting to calendar at 1:30 am on nov 1 2026').ok, false);
  assert.equal(calendar.command('add meeting to calendar at 9:10 pm on oct 24').ok, true);
  clock += 41 * 60000;
  assert.equal(calendar.events().length, 0);
});

test('textbox-created meetings use the real scheduler with a missing source and no model call', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rouge-test-command-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = BASE; const delivered = []; const timers = new Map(); let id = 0;
  const calendar = createTestCalendar({ now: () => clock, timeZone: 'America/Los_Angeles' });
  const reminders = createMeetingReminders({ file: path.join(dir, 'calendar.json'), stateFile: path.join(dir, 'seen.json'),
    now: () => clock, extraEvents: () => calendar.events(), notify: (events) => delivered.push(events),
    watch: () => ({ on() {}, close() {} }), setTimer: (fn, delay) => { timers.set(++id, { fn, delay }); return id; }, clearTimer: (key) => timers.delete(key) });
  reminders.start(); t.after(() => reminders.stop());
  const replies = [];
  const voice = createVoice({ ui: { transcript() {}, say: (message) => replies.push(message) },
    ai: new Proxy({}, { get() { throw new Error('Must not use an AI model'); } }),
    addTestMeeting: (text) => { const result = calendar.command(text); if (result?.ok) reminders.refresh(); return result; } });
  return (async () => {
    assert.equal(await voice.runText('add meeting to calendar at 9:10 pm on oct 24'), true);
    assert.equal(delivered.length, 1, 'inside 15 minutes shows an immediate reminder');
    assert.equal(reminders.status(), 'test_only');
    assert.match(replies[0], /reminder is due now/);
    assert.equal(fs.existsSync(path.join(dir, 'calendar.json')), false, 'real calendar was not created or edited');
    assert.equal(await voice.runText('add meeting to calendar at 9:40 pm on oct 24'), true);
    assert.equal(timers.size, 1);
    const scheduled = [...timers.values()][0];
    assert.equal(scheduled.delay, 25 * 60000);
    clock += scheduled.delay; timers.clear(); scheduled.fn();
    assert.equal(delivered.length, 2);
    assert.equal(await voice.runText('add meeting to calendar at 1 pm on oct 24'), true);
    assert.equal(delivered.length, 2, 'bad dates do not fall through to AI or create an event');
  })();
});
