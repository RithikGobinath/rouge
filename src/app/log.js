'use strict';
// A small rolling log in the data folder: what the Windows helper, the speech
// engine and the hotkeys said, for when something does not work.

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 512 * 1024;

function createLog(dir) {
  const file = path.join(dir, 'logs', 'app.log');
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch (_) { /* logging is best effort */ }
  try { if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, `${file}.old`); } catch (_) { /* no log yet */ }
  const log = (msg) => {
    const line = `${new Date().toISOString()} ${String(msg).replace(/\s+/g, ' ').slice(0, 400)}\n`;
    if (process.env.CLIPPY_VERBOSE === '1') process.stdout.write(line);
    try { fs.appendFileSync(file, line); } catch (_) { /* disk full or locked: never take the app down */ }
  };
  log.file = file;
  return log;
}

module.exports = { createLog };
