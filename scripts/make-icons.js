'use strict';
// Run with:  npx electron scripts/make-icons.js
// Draws the ribbon mark with the app's own renderer and saves the icons.
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const root = path.join(__dirname, '..');
const OUT = path.join(root, 'assets');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const JOBS = [
  // name, size, query
  ['clippy-512.png', 512, 'scale=0.34&simple=1'],
  ['icon.png', 256, 'bg=1&scale=0.31&simple=1'],
  ['tray-icon.png', 64, 'scale=0.36&simple=1'],
];

app.on('window-all-closed', () => { /* stay up between icons */ });
app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  for (const [name, size, query] of JOBS) {
    const win = new BrowserWindow({ show: false, width: size, height: size, useContentSize: true, transparent: true, frame: false, backgroundColor: '#00000000', webPreferences: { sandbox: true, contextIsolation: true, offscreen: true } });
    for (let attempt = 1; ; attempt += 1) {
      try { await win.loadFile(path.join(root, 'renderer/preview/logo.html'), { search: query }); break; } catch (e) { if (attempt >= 4) throw e; await sleep(400); }
    }
    await sleep(700);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, name), img.toPNG());
    console.log('saved', name, img.getSize().width + 'x' + img.getSize().height);
    win.destroy();
    await sleep(400);
  }
  app.exit(0);
});
