'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('native PDF resolver rejects ambiguous paths without opening any UI', { skip: process.platform !== 'win32', timeout: 45000 }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rouge-picker-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'Résumé.pdf'), '%PDF-1.4\n');
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(__dirname, 'fixtures/upload-picker-paths.ps1'), '-Folder', dir], { encoding: 'utf8', windowsHide: true });
  assert.match(output, /PATH_CHECKS_OK/);
});
