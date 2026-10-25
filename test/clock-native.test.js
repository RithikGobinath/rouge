'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('production Windows clock selectors distinguish XAML classes and match only the current notification time', {
  skip: process.platform !== 'win32', timeout: 30000,
}, () => {
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(__dirname, 'fixtures/clock-matching.ps1')], { encoding: 'utf8', windowsHide: true, timeout: 25000 });
  assert.match(output, /Clock matching checks passed without desktop queries/);
});
