'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { computerSystem } = require('../src/ai/prompts');

test('the computer agent is told to keep its final answer short and to say it only once', () => {
  const plan = computerSystem('plan', { timestamp: '2026-10-25T12:00:00Z' });
  assert.match(plan, /exactly one JSON object/);
  assert.match(plan, /about 50 words at most/);
  assert.match(plan, /never state the answer twice/);
  assert.match(plan, /nothing else: no prose before or after it/);
});

test('plain-text tasks still return only the answer', () => {
  assert.match(computerSystem('answer', { timestamp: '2026-10-25T12:00:00Z' }), /Return only the completed answer/);
});
