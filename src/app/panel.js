'use strict';
// The settings window: Shortcuts, Library, Preferences. Closing it hides it; the app
// keeps running from the tray and the hotkeys keep working.

const { BrowserWindow } = require('electron');
const brand = require('../brand');

/** @param {{preload:string, html:string, icon?:any, log?:Function}} o */
function createPanel(o) {
  let win = null;
  let quitting = false;
  const alive = () => win && !win.isDestroyed();

  function create(tab) {
    win = new BrowserWindow({
      width: 940, height: 720, minWidth: 720, minHeight: 540,
      backgroundColor: '#fbf7ef', title: brand.name, show: false, autoHideMenuBar: true, icon: o.icon,
      titleBarStyle: 'hidden', titleBarOverlay: { color: '#fbf7ef', symbolColor: '#1f1a22', height: 44 },
      webPreferences: { preload: o.preload, contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
    });
    win.setMenuBarVisibility(false);
    win.loadFile(o.html, tab ? { query: { tab } } : undefined);
    win.once('ready-to-show', () => win.show());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.on('page-title-updated', (e) => e.preventDefault());                       // the title stays the product's name
    win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });
    return win;
  }

  return {
    open(tab) {
      if (!alive()) { create(tab); return; }
      if (tab) win.loadFile(o.html, { query: { tab } });
      if (win.isMinimized()) win.restore();
      win.show(); win.focus();
    },
    hide() { if (alive()) win.hide(); },
    get win() { return alive() ? win : null; },
    get visible() { return Boolean(alive() && win.isVisible()); },
    send(channel, data) { if (alive() && !win.webContents.isDestroyed()) win.webContents.send(channel, data); },
    quit() { quitting = true; if (alive()) win.destroy(); },
  };
}

module.exports = { createPanel };
