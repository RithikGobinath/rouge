'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function buildMacClock(dir) {
  const source = path.join(__dirname, '..', 'src', 'mac', 'menu-clock.m');
  const binary = path.join(dir, 'bin', 'menu-clock');
  if (fs.existsSync(binary) && fs.statSync(binary).mtimeMs >= fs.statSync(source).mtimeMs) return binary;
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  const result = spawnSync('/usr/bin/xcrun', ['clang', '-fobjc-arc', '-O2', '-framework', 'AppKit', '-framework', 'CoreGraphics', source, '-o', binary + '.tmp'], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Could not build the menu clock reader. Install Apple Command Line Tools.');
  fs.renameSync(binary + '.tmp', binary);
  return binary;
}

module.exports = { buildMacClock };
