'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareCache, inspectProposal, wallToEpoch, DEFAULT_ZONE, guardEvidence, proposalIntent, readDateTime, conflictNotice } = require('../src/calendar/conflict');

const event = (extra = {}) => ({ title: 'Existing meeting', source: 'test', start: { dateTime: '2026-10-26T21:00:00', timeZone: 'UTC' }, end: { dateTime: '2026-10-26T22:00:00', timeZone: 'UTC' }, showAs: 'busy', response: 'accepted', ...extra });
const cache = (events = [event()]) => prepareCache({ coverageStart: '2026-10-23T07:00:00Z', coverageEnd: '2026-11-23T08:00:00Z', events });
const proposal = (extra = {}) => ({ intent: true, date: '2026-10-26', time: '14:00', timezone: DEFAULT_ZONE, duration_minutes: 30, ambiguity: null, ...extra });
const now = Date.parse('2026-10-24T18:00:00Z');

test('detects a real overlap in Pacific time', () => {
  const result = inspectProposal(proposal(), cache());
  assert.equal(result.kind, 'conflict');
  assert.equal(conflictNotice(result), 'This overlaps Existing meeting.');
});
test('an adjacent event does not overlap and stays quiet', () => {
  assert.equal(conflictNotice(inspectProposal(proposal({ time: '15:00' }), cache())), '');
});
test('free, cancelled and declined events do not block', () => {
  for (const extra of [{ showAs: 'free' }, { cancelled: true }, { response: 'declined' }]) assert.equal(inspectProposal(proposal(), cache([event(extra)])).kind, 'clear');
});
test('tentative appointments get a qualified warning', () => assert.equal(inspectProposal(proposal(), cache([event({ showAs: 'tentative' })])).kind, 'tentative'));
test('zero-duration deadlines do not occupy time', () => assert.equal(inspectProposal(proposal(), cache([event({ end: event().start })])).kind, 'clear'));
test('outside cache is unknown, never clear', () => assert.equal(inspectProposal(proposal({ date: '2027-01-01' }), cache()).kind, 'coverage'));
test('missing time stays ambiguous', () => assert.equal(inspectProposal(proposal({ time: null }), cache()).kind, 'clarify'));
test('an incomplete meeting draft does not show a notification', () => assert.equal(conflictNotice(inspectProposal(proposal({ time: null }), cache())), ''));
test('unknown duration is explicitly assumed', () => assert.match(inspectProposal(proposal({ duration_minutes: null }), cache()).assumption, /30-minute/));
test('DST changes the UTC offset correctly', () => {
  assert.equal(new Date(wallToEpoch('2026-10-26', '14:00', DEFAULT_ZONE)).toISOString(), '2026-10-26T21:00:00.000Z');
  assert.equal(new Date(wallToEpoch('2026-11-03', '14:00', DEFAULT_ZONE)).toISOString(), '2026-11-03T22:00:00.000Z');
});
test('guardEvidence blocks a bare hour without AM/PM', () => {
  assert.equal(guardEvidence('Can we meet Monday at 2?', proposal()).time, null);
  assert.equal(guardEvidence('Can we meet Monday at 2 PM?', proposal()).time, '14:00');
});

// proposalIntent: let the text decide, not a phrase list
test('explicit schedule request is a proposal', () => {
  assert.equal(proposalIntent('schedule a meeting on Oct 26 at 12:30pm'), true);
  assert.equal(proposalIntent('can we meet next monday at 12:30pm'), true);
  assert.equal(proposalIntent('do u wanna meet next monday at 12:30pm'), true);
  assert.equal(proposalIntent('wanna catch up on monday at 2pm?'), true);
  assert.equal(proposalIntent('are you free on monday at 2pm?'), true);
  assert.equal(proposalIntent('let\'s meet on tuesday at 3pm'), true);
});
test('informational message is not a proposal', () => {
  assert.equal(proposalIntent('I have a meeting on Oct 26 at 12:30pm'), false);
  assert.equal(proposalIntent('My meeting is on Monday at 2pm'), false);
  assert.equal(proposalIntent("I'm in a meeting on Monday"), false);
});
test('natural reply needs visible scheduling context', () => {
  assert.equal(proposalIntent('next Monday at 12:30 PM'), false);
  assert.equal(proposalIntent('next Monday at 12:30 PM', 'When can we meet?'), true);
  assert.equal(proposalIntent('next Monday at 12:30 PM', 'Are you free next week?'), true);
  assert.equal(proposalIntent('next Monday at 12:30 PM', 'I have a meeting'), false);
});

// readDateTime: deterministic extraction, no model
test('readDateTime extracts date and time from natural language', () => {
  assert.equal(readDateTime('schedule a meeting on 26th oct 12:30pm', now).date, '2026-10-26');
  assert.equal(readDateTime('do u wanna meet next monday at 12:30pm', now).date, '2026-10-26');
  assert.equal(readDateTime('can we meet next monday at 12:30 PM?', now).date, '2026-10-26');
  assert.equal(readDateTime('meeting on oct 26 at 2:00 pm', now).time, '14:00');
});
test('readDateTime returns null when clock is absent', () => {
  assert.equal(readDateTime('meeting on monday', now), null);
});
