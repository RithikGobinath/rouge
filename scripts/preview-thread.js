'use strict';
// Run with:  npx electron scripts/preview-thread.js
// Lets the ribbon thread out to a target and saves frames along the way.
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const root = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const times = (process.env.FRAMES || '150,400,700,1000,1600,3000').split(',').map(Number);

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1280, height: 720, useContentSize: true, backgroundColor: '#0a0d1b', webPreferences: { sandbox: true, contextIsolation: true, offscreen: true, backgroundThrottling: false } });
  win.webContents.setFrameRate(30);
  win.webContents.on('console-message', (e) => { if (e.level === 'error' || e.level === 3) console.log('console error:', e.message); });
  await win.loadFile(path.join(root, 'renderer/preview/thread.html'));
  await sleep(1200);
  fs.mkdirSync(path.join(root, 'shots'), { recursive: true });
  const zoom = process.env.ZOOM ? process.env.ZOOM.split(',').map(Number) : null;   // x,y,w,h,scale
  const shot = async (name) => {
    let img = await win.webContents.capturePage();
    if (zoom) { img = img.crop({ x: zoom[0], y: zoom[1], width: zoom[2], height: zoom[3] }).resize({ width: zoom[2] * zoom[4], height: zoom[3] * zoom[4], quality: 'best' }); }
    fs.writeFileSync(path.join(root, 'shots', `${name}.png`), img.toPNG());
  };
  await shot('thread-0-idle');
  const t0 = Date.now();
  await win.webContents.executeJavaScript('window.__go()');
  for (const t of times) { await sleep(Math.max(0, t - (Date.now() - t0))); await shot(`thread-${String(t).padStart(4, '0')}ms`); }
  if (process.env.REWIND) {
    await sleep(1200);
    const t1 = Date.now();
    await win.webContents.executeJavaScript('window.__back()');
    for (const t of [90, 220, 360, 520]) { await sleep(Math.max(0, t - (Date.now() - t1))); await shot(`rewind-${String(t).padStart(4, '0')}ms`); }
    await sleep(500); await shot('rewind-end');
  }
  console.log('saved', times.length + 1, 'frames; title:', win.webContents.getTitle());
  app.exit(0);
});
