'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { pickAuto } = require('../src/ai/auto');

test('Auto keeps cheap work on A and sends live or computer work to B', () => {
  assert.deepEqual(pickAuto({ task: 'plan', user: '2+2' }), { role: 'A', mode: 'reply' });
  assert.deepEqual(pickAuto({ task: 'plan', user: 'open notepad' }), { role: 'A', mode: 'reply' });
  assert.deepEqual(pickAuto({ task: 'answer', user: 'Look up current news' }), { role: 'B', mode: 'reply' });
  assert.deepEqual(pickAuto({ task: 'answer', user: 'Look up current news', webAccess: false }), { role: 'A', mode: 'reply' });
  assert.deepEqual(pickAuto({ task: 'plan', goal: 'Check results in Chrome', user: 'Context and request' }), { role: 'B', mode: 'computer' });
  assert.deepEqual(pickAuto({ task: 'plan', user: 'compare flights in chrome and prove the cheapest fare' }), { role: 'C', mode: 'computer' });
  assert.deepEqual(pickAuto({ task: 'explain', user: 'what is this button' }), { role: 'A', mode: 'reply' });
  // NAVIGATE pattern: multi-step desktop navigation routes to computer B
  assert.deepEqual(pickAuto({ task: 'plan', user: 'open settings and show me where to change the wallpaper', goal: 'open settings and show me where to change the wallpaper' }), { role: 'B', mode: 'computer' });
  assert.deepEqual(pickAuto({ task: 'plan', user: 'show me where to turn off notifications', goal: 'show me where to turn off notifications' }), { role: 'B', mode: 'computer' });
  assert.deepEqual(pickAuto({ task: 'plan', user: 'go to the Privacy section in Settings', goal: 'go to the Privacy section in Settings' }), { role: 'B', mode: 'computer' });
  // Single-step 'open X' must NOT route to computer
  assert.deepEqual(pickAuto({ task: 'plan', user: 'open notepad' }), { role: 'A', mode: 'reply' });
  // Pointing / locating patterns: 'point to X', 'where is X' must route to computer B
  assert.deepEqual(pickAuto({ task: 'plan', user: 'point to the close button', goal: 'point to the close button' }), { role: 'B', mode: 'computer' });
  assert.deepEqual(pickAuto({ task: 'plan', user: 'where is the close button', goal: 'where is the close button' }), { role: 'B', mode: 'computer' });
});
