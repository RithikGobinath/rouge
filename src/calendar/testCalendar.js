'use strict';
// Temporary textbox-created events feed the real scheduler without editing the private snapshot.
const { randomUUID } = require('node:crypto');
const { wallToEpoch } = require('./conflict');
const { LEAD_MS } = require('./reminders');

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const COMMAND = /^add meeting to calendar at (\d{1,2})(?::(\d{2}))?\s*(am|pm) on (jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?) (\d{1,2})(?:,? (\d{4}))?[.!]?$/i;
const USAGE = 'Use: add meeting to calendar at 11:30 pm on oct 24. You can include a year. This only adds a temporary test meeting.';

function createTestCalendar({ now = Date.now, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone } = {}) {
  const events = new Map();
  const format = new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  function prune() { for (const [startMs] of events) if (startMs + 30 * 60000 <= now()) events.delete(startMs); }

  function command(input) {
    const text = String(input || '').trim().replace(/\s+/g, ' ');
    if (!/^add meeting to calendar\b/i.test(text)) return null;
    const match = COMMAND.exec(text);
    if (!match) return { ok: false, message: USAGE };
    const hour = Number(match[1]); const minute = Number(match[2] || 0);
    if (hour < 1 || hour > 12 || minute > 59) return { ok: false, message: 'Choose a time from 1:00 to 12:59 AM or PM.' };
    const year = match[6] || new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric' }).format(new Date(now()));
    const month = MONTHS.indexOf(match[4].slice(0, 3).toLowerCase()) + 1;
    const date = `${year}-${String(month).padStart(2, '0')}-${match[5].padStart(2, '0')}`;
    const clock = `${String(hour % 12 + (match[3].toLowerCase() === 'pm' ? 12 : 0)).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    let startMs;
    try { startMs = wallToEpoch(date, clock, timeZone); }
    catch (error) { return { ok: false, message: `That date/time is invalid: ${error.message}` }; }
    if (startMs <= now()) return { ok: false, message: 'That time has already passed. Choose a future time, or specify the year explicitly.' };
    prune();
    if (events.has(startMs)) return { ok: true, message: `A temporary test meeting is already scheduled for ${format.format(new Date(startMs))}.` };
    events.set(startMs, { id: randomUUID(), title: 'Test meeting', source: 'rouge-temporary-test',
      start: { dateTime: new Date(startMs).toISOString(), timeZone },
      end: { dateTime: new Date(startMs + 30 * 60000).toISOString(), timeZone } });
    const reminder = startMs - LEAD_MS;
    return { ok: true, message: `Temporary test meeting added for ${format.format(new Date(startMs))}. ${reminder <= now() ? 'The reminder is due now.' : `Reminder at ${format.format(new Date(reminder))}.`} It clears when Rouge quits.` };
  }
  return { command, events: () => { prune(); return [...events.values()].map((event) => structuredClone(event)); } };
}

module.exports = { createTestCalendar };
