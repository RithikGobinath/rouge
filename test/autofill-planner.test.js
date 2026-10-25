'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { planFromProfile } = require('../src/autofill/planner');

const profile = { personal: { name: 'Ada Lovelace', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com', phone: '555-0100' } };
const field = (label) => ({ label, type: 'text', selector: `#${label}` });

test('a single "Name (First, Last)" box gets the full name', () => {
  const plan = planFromProfile([field('Name (First, Last)')], profile);
  assert.deepEqual(plan.map((p) => p.value), ['Ada Lovelace']);
});

test('separate first and last name boxes still get their own parts', () => {
  const plan = planFromProfile([field('First Name'), field('Last Name'), field('Email')], profile);
  assert.deepEqual(plan.map((p) => p.value), ['Ada', 'Lovelace', 'ada@example.com']);
});
