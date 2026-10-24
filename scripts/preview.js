'use strict';
// Run with:  npx electron scripts/preview.js [page] [out.png] [width] [height] [query]
// Draws a page in a hidden window and saves what it looks like.
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const root = path.join(__dirname, '..');
const [page = 'renderer/preview/ribbon.html', out = 'shots/ribbon-preview.png', w = '1400', h = '1000', query = ''] = process.argv.slice(2).filter((a) => !a.startsWith('--'));

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: Number(w), height: Number(h), useContentSize: true, backgroundColor: '#0a0d1b', webPreferences: { sandbox: true, contextIsolation: true } });
  win.webContents.on('console-message', (e) => { if (e.level === 'error' || e.level === 3) console.log('console error:', e.message); });
  await win.loadFile(path.join(root, page), query ? { search: query } : undefined);
  await new Promise((r) => setTimeout(r, 900));
  let img = await win.webContents.capturePage();
  if (process.env.CROP) { const [x, y, cw, ch] = process.env.CROP.split(',').map(Number); const f = img.getSize().width / Number(w); img = img.crop({ x: Math.round(x * f), y: Math.round(y * f), width: Math.round(cw * f), height: Math.round(ch * f) }); }
  fs.mkdirSync(path.dirname(path.join(root, out)), { recursive: true });
  fs.writeFileSync(path.join(root, out), img.toPNG());
  console.log('saved', out, img.getSize().width + 'x' + img.getSize().height);
  app.exit(0);
});
