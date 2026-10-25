'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCalendarWatch } = require('../src/calendar/watch');
const { prepareCache } = require('../src/calendar/conflict');

const cache = prepareCache({
  coverageStart: '2026-10-23T07:00:00Z', coverageEnd: '2026-11-23T08:00:00Z',
  events: [{ title: 'Existing meeting', source: 'test', start: { dateTime: '2026-10-26T21:00:00', timeZone: 'UTC' }, end: { dateTime: '2026-10-26T22:00:00', timeZone: 'UTC' }, showAs: 'busy', response: 'accepted' }],
});

function harness(extra = {}) {
  const notices = []; const shots = [];
  let now = 0; let point = { x: 0, y: 0 }; let clicks = 0; let busy = false;
  const watch = createCalendarWatch({
    cache, poll: false, now: () => now, cursor: async () => point, clicks: () => clicks, busy: () => busy,
    capture: async () => { shots.push(now); return 'data:image/jpeg;base64,abc'; },
    notice: (text) => notices.push(text),
    askIntent: async (text) => /\b(?:meet|available|free|schedule)\b/i.test(text),
    // Vision fetch: model transcribes text only; code does the rest
    fetch: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
      observed_text: 'Can we meet on October 26 at 2:00 PM Pacific for 30 minutes?',
      previous_text: '',
    }) } }] }) }),
    ...extra,
  });
  return { watch, notices, shots, at(t) { now = t; }, move(x) { point = { x, y: 0 }; }, click() { clicks += 1; }, setBusy(v) { busy = v; } };
}

test('a still pointer takes no screenshot; movement triggers one per second', async () => {
  const h = harness();
  const base = Date.parse('2026-10-24T18:00:00Z');
  h.at(base);
  await h.watch.start();
  await h.watch.tick();
  await h.watch.tick();
  assert.equal(h.shots.length, 0);
  h.move(5);
  await h.watch.tick();
  h.move(9);
  h.at(base + 400);
  await h.watch.tick();
  assert.deepEqual(h.shots, [base]);
  h.at(base + 1000);
  h.move(12);
  await h.watch.tick();
  assert.deepEqual(h.shots, [base, base + 1000]);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.notices[0], 'This overlaps Existing meeting.');
  h.watch.stop();
});

test('typed meeting text is checked without a screenshot; conflict shows immediately', async () => {
  const h = harness();
  await h.watch.start();
  h.at(Date.parse('2026-10-24T18:00:00Z'));
  assert.equal(await h.watch.checkText('schedule a meeting on oct 26th at 2:00 pm'), true);
  assert.equal(h.shots.length, 0);
  assert.equal(h.notices[0], 'This overlaps Existing meeting.');
  h.watch.stop();
});

test('casual phrasings and typo-adjacent text fall through to askIntent', async () => {
  const intentCalls = [];
  const h = harness({ askIntent: async (t) => { intentCalls.push(t); return true; } });
  await h.watch.start();
  h.at(Date.parse('2026-10-24T18:00:00Z'));
  // "grab a coffee" won't match regex — falls through to askIntent
  assert.equal(await h.watch.checkText('wanna grab a coffee monday at 2pm?'), true);
  assert.equal(intentCalls.length, 1);
  assert.equal(h.notices[0], 'This overlaps Existing meeting.');
  h.watch.stop();
});

test('typing variations all detect the conflict', async () => {
  const h = harness();
  await h.watch.start();
  h.at(Date.parse('2026-10-24T18:00:00Z'));
  // Test cache event is Mon Oct 26 at 14:00 PDT (21:00 UTC)
  assert.equal(await h.watch.checkText('do u wanna meet next monday at 2pm'), true);
  assert.equal(await h.watch.checkText('can we meet next monday at 2pm'), true);
  assert.equal(await h.watch.checkText('are you free next monday at 2pm?'), true);
  h.watch.stop();
});

test('informational message does not trigger a warning', async () => {
  const h = harness();
  await h.watch.start();
  h.at(Date.parse('2026-10-24T18:00:00Z'));
  assert.equal(await h.watch.checkText('I have a meeting on oct 26 at 2pm'), false);
  assert.equal(h.notices.length, 0);
  h.watch.stop();
});

test('Rouge being busy suppresses background shots; look() still captures one', async () => {
  const h = harness();
  await h.watch.start();
  await h.watch.tick();
  h.setBusy(true);
  h.move(4);
  await h.watch.tick();
  assert.equal(h.shots.length, 0);
  await h.watch.look();
  assert.deepEqual(h.shots, [0]);
  h.watch.stop();
});
