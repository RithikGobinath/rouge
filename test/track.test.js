'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { findTracked, nameScore } = require('../src/pointing/track');

const CARD = 'From 609 US dollars. 1 stop flight with Delta. Leaves San Francisco International Airport at 6:05 AM on Sunday, October 25.';
const card = { x: 2392, y: 1006, w: 260, h: 64 };

test('a blank or whitespace name never matches anything', () => {
  for (const name of ['', ' ', '   ', null, undefined]) assert.equal(nameScore(name, CARD), 0);
  assert.equal(nameScore(CARD, ' '), 0);
  assert.equal(nameScore(CARD, ''), 0);
});

test('the control is found again by its own name, not by a stray space or a short common word', () => {
  const elements = [
    { name: ' ', rect: { x: 1448, y: 864, w: 7, h: 29 } },
    { name: 'From', rect: { x: 2392, y: 1006, w: 40, h: 20 } },
    { name: 'US', rect: { x: 2000, y: 500, w: 30, h: 20 } },
    { name: CARD, rect: { x: 2392, y: 960, w: 260, h: 64 } },
  ];
  const found = findTracked(elements, { name: CARD }, card, card);
  assert.equal(found.name, CARD);
  assert.equal(found.rect.y, 960, 'followed the control as it scrolled');
});

test('nothing is returned when the window no longer shows the control', () => {
  const elements = [{ name: ' ', rect: { x: 1, y: 1, w: 7, h: 29 } }, { name: 'Search', rect: { x: 5, y: 5, w: 90, h: 30 } }];
  assert.equal(findTracked(elements, { name: CARD }, card, card), null);
  assert.equal(findTracked([], { name: CARD }, card, card), null);
});

test('a same-named element of a wildly different size is a different element', () => {
  const elements = [{ name: CARD, rect: { x: 100, y: 100, w: 3.5, h: 14.5 } }];
  assert.equal(findTracked(elements, { name: CARD }, card, card), null);
});

test('among identical names the one nearest to where the wand last pointed wins', () => {
  const elements = [{ name: 'Select', rect: { x: 100, y: 800, w: 120, h: 40 } }, { name: 'Select', rect: { x: 100, y: 330, w: 120, h: 40 } }, { name: 'Select', rect: { x: 100, y: 100, w: 120, h: 40 } }];
  const last = { x: 100, y: 320, w: 120, h: 40 };
  assert.equal(findTracked(elements, { name: 'Select' }, last, last).rect.y, 330);
});

test('a matching automation id breaks a tie between equal names', () => {
  const elements = [{ name: 'Select', automationId: 'other', rect: { x: 100, y: 330, w: 120, h: 40 } }, { name: 'Select', automationId: 'row-7', rect: { x: 100, y: 600, w: 120, h: 40 } }];
  const last = { x: 100, y: 320, w: 120, h: 40 };
  assert.equal(findTracked(elements, { name: 'Select', automationId: 'row-7' }, last, last).rect.y, 600);
});

test('a longer name containing a long enough wanted name still matches, a tiny fragment does not', () => {
  const rect = { x: 0, y: 0, w: 100, h: 20 };
  assert.equal(nameScore('Browse Photos from your computer', 'Browse Photos from your'), 1);
  assert.equal(nameScore('Browse Photos', 'Photos'), 0);
  assert.ok(findTracked([{ name: 'Save as new file', rect }], { name: 'save as new file' }, rect, rect));
});

test('elements without a usable rectangle are ignored', () => {
  const rect = { x: 0, y: 0, w: 100, h: 20 };
  const elements = [{ name: 'Save', rect: null }, { name: 'Save', rect: { x: NaN, y: 0, w: 5, h: 5 } }, { name: 'Save', rect: { x: 0, y: 0, w: 0, h: 9 } }, { name: 'Save', rect }];
  assert.equal(findTracked(elements, { name: 'Save' }, rect, rect).rect, rect);
});
