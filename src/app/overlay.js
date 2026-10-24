'use strict';
// The overlay: one transparent window, always on top, covering the work area of
// the main display. The ribbon, the thread, the strip bar and every bubble are
// drawn in it. It never moves (the ribbon picks a corner instead), and it lets
// the mouse through everywhere except over a piece of its own UI, so it never
// gets in the way of the app underneath.

const { BrowserWindow, screen } = require('electron');
const brand = require('../brand');

const POLL_MS = 40;            // how often the pointer is reported to the page
const RAISE_MS = 4000;         // how often the window is put back on top, in case something took the place

/**
 * @param {{preload:string, html:string, query?:object, sidecar?:any, log?:Function, onLoaded?:()=>void}} o
 */
function createOverlay(o) {
  const log = o.log || (() => {});
  let win = null;
  let passing = null;            // true: the mouse goes through the window; false: the window takes it
  let shown = true;
  let pollTimer = null; let raiseTimer = null;
  let lastSpot = '';
  let watchingDisplays = false;

  const area = () => screen.getPrimaryDisplay().workArea;
  const live = () => Boolean(win) && !win.isDestroyed();
  const handle = () => (live() ? win.getNativeWindowHandle().readUInt32LE(0) : 0);

  /** The mouse passes through the window (true) or stops at it (false). The page decides, per spot. */
  function letMousePass(yes) {
    if (!live() || yes === passing) return;
    passing = yes;
    win.setIgnoreMouseEvents(yes, { forward: true });
  }

  function fitToDisplay() {
    if (!live()) return;
    try { win.setBounds(area()); } catch (_) { /* a display went away while this was happening */ }
  }

  // Once Chromium has given a monitor-sized always-on-top window focus it drops it to the bottom of the stack and
  // will not raise it again by itself. The Windows helper can, from outside, without taking focus.
  function liftToTop() {
    if (!live() || !shown || !o.sidecar || !o.sidecar.available) return;
    o.sidecar.topmost(handle()).catch(() => {});
  }

  /** Tell the page where the pointer is, in the window's own pixels, whenever it has moved. */
  function reportPointer() {
    if (!live() || !shown) return;
    const at = screen.getCursorScreenPoint();
    const box = win.getBounds();
    const x = at.x - box.x; const y = at.y - box.y;
    if (x < 0 || y < 0 || x >= box.width || y >= box.height) {
      if (passing === false) letMousePass(true);          // the pointer left: nothing here may keep the mouse
      lastSpot = '';
      return;
    }
    const spot = `${x},${y}`;
    if (spot === lastSpot) return;
    lastSpot = spot;
    win.webContents.send('cursor:probe', { x, y });
  }

  function create() {
    const a = area();
    win = new BrowserWindow({
      title: `${brand.name} overlay`,
      x: a.x, y: a.y, width: a.width, height: a.height,
      show: false, frame: false, transparent: true, hasShadow: false,
      resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: true, alwaysOnTop: true, focusable: true,
      webPreferences: { preload: o.preload, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, spellcheck: false },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setIgnoreMouseEvents(true, { forward: true });
    passing = true;
    win.loadFile(o.html, o.query ? { query: o.query } : undefined);

    const page = win.webContents;
    page.setWindowOpenHandler(() => ({ action: 'deny' }));
    page.on('will-navigate', (e) => e.preventDefault());
    page.on('render-process-gone', (_e, why) => log(`overlay renderer gone: ${JSON.stringify(why)}`));
    page.on('did-finish-load', () => {
      if (shown) win.showInactive();
      fitToDisplay(); liftToTop();
      if (o.onLoaded) o.onLoaded();
    });
    win.on('focus', liftToTop);
    win.on('blur', liftToTop);

    if (!watchingDisplays) {
      watchingDisplays = true;
      for (const event of ['display-metrics-changed', 'display-added', 'display-removed']) screen.on(event, fitToDisplay);
    }
    pollTimer = setInterval(reportPointer, POLL_MS);
    raiseTimer = setInterval(liftToTop, RAISE_MS);
    return win;
  }

  return {
    create,
    get win() { return win; },
    get alive() { return live(); },
    get visible() { return shown; },
    send(channel, data) { if (live() && !win.webContents.isDestroyed()) win.webContents.send(channel, data); },
    setIgnore: letMousePass,
    show() { shown = true; if (live()) { win.showInactive(); liftToTop(); } },
    hide() { shown = false; if (live()) win.hide(); },
    toggle() { if (shown) this.hide(); else this.show(); return shown; },
    /** Give the overlay the keyboard (to type a command). False if it is hidden. */
    focus() { if (!live() || !shown) return false; win.focus(); return true; },
    blur() { if (live()) win.blur(); },
    rebound: fitToDisplay,
    /** A rectangle in screen pixels -> the same rectangle in the overlay's CSS pixels. */
    physToOverlay(r) {
      const from = screen.screenToDipPoint({ x: r.x, y: r.y });
      const to = screen.screenToDipPoint({ x: r.x + r.w, y: r.y + r.h });
      const origin = win.getBounds();
      return { x: from.x - origin.x, y: from.y - origin.y, w: Math.max(1, to.x - from.x), h: Math.max(1, to.y - from.y) };
    },
    destroy() {
      clearInterval(pollTimer); clearInterval(raiseTimer);
      if (live()) win.destroy();
      win = null;
    },
  };
}

module.exports = { createOverlay };
