'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

assert.equal(process.platform, 'darwin', 'Use npm start on Windows.');
const root = path.join(__dirname, '..');
require('./build-mac-clock').buildMacClock(process.env.CLIPPY_USER_DATA || path.resolve(root, '..', 'rouge-user-data'));
const bundle = path.resolve(path.dirname(require('electron')), '..', '..');
const resources = path.join(bundle, 'Contents', 'Resources');
assert.ok(bundle.endsWith('.app') && fs.existsSync(resources), 'Install the macOS Electron runtime with npm ci first.');
const entry = path.join(resources, 'app');
fs.mkdirSync(entry, { recursive: true });
fs.writeFileSync(path.join(entry, 'package.json'), JSON.stringify({ name: 'rouge-development', version: '0.1.0', main: 'main.js' }));
fs.writeFileSync(path.join(entry, 'main.js'), [
  'process.argv.push("--mac-dev", "--panel");',
  `process.env.CLIPPY_USER_DATA ||= ${JSON.stringify(path.resolve(root, '..', 'rouge-user-data'))};`,
  `require(${JSON.stringify(path.join(root, 'src', 'main.js'))});`,
].join('\n'));
const launched = spawnSync('/usr/bin/open', ['-a', bundle], { stdio: 'inherit' });
if (launched.error) throw launched.error;
process.exitCode = launched.status === null ? 1 : launched.status;
