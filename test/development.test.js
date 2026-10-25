'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createExecutor } = require('../src/actions/executor');

test('development executor blocks direct and batched actions before touching dependencies', async () => {
  const reason = 'Computer controls are disabled during Mac development.';
  const deps = new Proxy({ disabledReason: reason }, {
    get(target, key) {
      if (key in target || key === 'sleep' || key === 'now') return target[key];
      throw new Error(`Unexpected dependency access: ${String(key)}`);
    },
  });
  const executor = createExecutor(deps);
  const open = { type: 'open_url', url: 'https://example.com' };
  assert.deepEqual(await executor.run(open), { ok: false, note: reason });
  const batch = await executor.runAll([open, { type: 'open_app', app: 'chrome' }]);
  assert.equal(batch.ok, false);
  assert.equal(batch.note, reason);
  assert.equal(batch.results.length, 1);
});
