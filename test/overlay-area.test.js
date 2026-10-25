'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

test('overlay reaches the system bars while companion coordinates stay in the usable area', () => {
  const screen = Object.assign(new EventEmitter(), { getPrimaryDisplay: () => ({
    bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 0, y: 24, width: 1440, height: 810 },
  }) });
  let options; let destroyed = false;
  class Window extends EventEmitter {
    constructor(opts) {
      super(); options = opts; this.bounds = opts;
      this.webContents = Object.assign(new EventEmitter(), { send() {}, isDestroyed: () => false, setWindowOpenHandler() {} });
    }
    setBounds(bounds) { this.bounds = bounds; }
    getBounds() { return this.bounds; }
    isDestroyed() { return destroyed; }
    destroy() { destroyed = true; }
    setAlwaysOnTop() {} setIgnoreMouseEvents() {} loadFile() {} showInactive() {}
  }
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/app/overlay.js'), 'utf8'), {
    module, require: (name) => name === 'electron' ? { BrowserWindow: Window, screen } : { name: 'Rouge' },
    setInterval: () => 1, clearInterval() {},
  });
  const overlay = module.exports.createOverlay({ preload: '/preload', html: '/overlay' });
  overlay.create(); overlay.win.webContents.emit('did-finish-load');
  assert.equal(options.enableLargerThanScreen, true);
  assert.equal(overlay.win.getBounds().y, 0);
  assert.equal(overlay.win.getBounds().height, 900);
  assert.equal(overlay.usableArea.y, 24);
  assert.equal(overlay.usableArea.bottom, 66);
  overlay.destroy();
  assert.equal(screen.listenerCount('display-metrics-changed'), 0);
});
