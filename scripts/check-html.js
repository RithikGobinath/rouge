'use strict';
// Opens ribbon.html in a hidden window and plays with it the way a person
// would, with real mouse events, then says what the ribbon did: out to the
// place to click, back in when that place is clicked, back in on its own when
// nobody follows it, back in when the ribbon is clicked.
//
//   npx electron scripts/check-html.js [file.html]        (shots are saved to shots/html-*.png)
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const root = path.join(__dirname, '..');
const file = path.resolve(process.argv[2] || path.join(root, 'ribbon.html'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1280, height: 720, useContentSize: true, backgroundColor: '#0a0d1b', webPreferences: { offscreen: true, backgroundThrottling: false } });
  win.webContents.setFrameRate(30);
  const errors = [];
  win.webContents.on('console-message', (e) => { if (e.level === 'error' || e.level === 3) errors.push(e.message); });
  await win.loadFile(file);
  await win.webContents.executeJavaScript('window.RougeWandArt.ready.then(() => true)');
  fs.mkdirSync(path.join(root, 'shots'), { recursive: true });

  const run = (js) => win.webContents.executeJavaScript(js);
  const click = async (x, y) => {
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
    await sleep(60);
  };
  const centre = (sel) => run(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const clickOn = async (sel) => { const p = await centre(sel); await click(p.x, p.y); };
  const tagText = () => run('(() => { const t = document.querySelector("#tag"); return t.classList.contains("hidden") ? "" : document.querySelector("#tag-text").textContent; })()');
  const toastText = () => run('(() => { const t = document.querySelector("#toast"); return t.classList.contains("hidden") ? "" : t.textContent; })()');
  /** How much red ribbon is on the page, away from the ribbon's own corner. */
  const ribbonPixels = async () => {
    const img = await win.webContents.capturePage();
    const { width, height } = img.getSize(); const px = img.toBitmap();
    let n = 0;
    for (let y = 0; y < height; y += 2) for (let x = 0; x < width; x += 2) {
      if (x > width - 280 && y > height - 280) continue;
      const i = (y * width + x) * 4; const b = px[i]; const g = px[i + 1]; const r = px[i + 2];
      if (r > 120 && g < 110 && r > 2.2 * g && r > 2.2 * b) n += 1;
    }
    return n;
  };
  const shot = async (name) => fs.writeFileSync(path.join(root, 'shots', `html-${name}.png`), (await win.webContents.capturePage()).toPNG());

  const results = [];
  const check = (what, ok, detail = '') => { results.push({ what, ok: Boolean(ok), detail }); };
  const isOut = async () => (await ribbonPixels()) > 150;
  const isIn = async () => (await ribbonPixels()) < 25;

  await sleep(500);
  check('nothing is out for the first moment', await isIn(), `${await ribbonPixels()} red px`);
  await sleep(2400);
  check('the ribbon is out to the first place to click, and says which', (await isOut()) && (await tagText()) === 'Export', `tag "${await tagText()}", ${await ribbonPixels()} px`);
  await shot('1-first-place');

  await clickOn('#b-export');
  check('clicking it is acknowledged', (await toastText()) === 'Exported.', await toastText());
  await sleep(1650);
  check('the ribbon has drawn back in', (await isIn()) && (await tagText()) === '', `${await ribbonPixels()} px, tag "${await tagText()}"`);
  await shot('2-drawn-back');
  await sleep(2000);
  check('then it goes out to the next place', (await isOut()) && (await tagText()) === 'Share', `tag "${await tagText()}"`);

  await clickOn('#b-share'); await sleep(3800);
  check('and the one after', (await isOut()) && (await tagText()) === 'Save', `tag "${await tagText()}"`);
  await clickOn('#b-save'); await sleep(1650);
  check('after the last one it draws back in and stays in', await isIn(), `${await ribbonPixels()} px`);
  await sleep(2500);
  check('and it is still in later', await isIn(), `${await ribbonPixels()} px`);

  await click(930, 330); await sleep(2200);
  check('clicking anywhere sends the ribbon there', (await isOut()) && (await tagText()) === 'here', `tag "${await tagText()}"`);
  await shot('3-a-spot');
  await sleep(3600);
  check('and it draws itself back in if nobody follows', await isIn(), `${await ribbonPixels()} px`);

  await click(930, 330); await sleep(2200);
  await click(930, 330); await sleep(1650);
  check('clicking the place it points at draws it back in', await isIn(), `${await ribbonPixels()} px`);

  await click(700, 520); await sleep(2200);
  await clickOn('#mark'); await sleep(1650);
  check('clicking the ribbon draws it back in', await isIn(), `${await ribbonPixels()} px`);
  await sleep(2200);
  check('and it stays in', await isIn(), `${await ribbonPixels()} px`);

  await clickOn('#mark'); await sleep(2800);
  check('clicking the ribbon when it is in starts the walk again', (await isOut()) && (await tagText()) === 'Export', `tag "${await tagText()}"`);

  const bad = results.filter((r) => !r.ok);
  for (const r of results) process.stdout.write(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.what}${r.ok ? '' : `   (${r.detail})`}\n`);
  if (errors.length) process.stdout.write(`console errors: ${errors.slice(0, 3).join(' | ')}\n`);
  process.stdout.write(`${results.length - bad.length}/${results.length} as expected\n`);
  app.exit(bad.length || errors.length ? 1 : 0);
});
