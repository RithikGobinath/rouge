'use strict';
// Development only: `npm run smoke` boots the real app and checks it is whole;
// `npm run shots` drives every state of the overlay and the settings window
// and writes PNGs, so what is on screen can be looked at without a person.

const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms, what) {
  const t0 = Date.now();
  for (;;) {
    let v; try { v = await fn(); } catch (_) { v = false; }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

async function save(win, file, width) {
  let img = await win.webContents.capturePage();
  const s = img.getSize();
  if (width && s.width > width) img = img.resize({ width, quality: 'best' });
  fs.writeFileSync(file, img.toPNG());
  return file;
}

// ---------------------------------------------------------------------------------------
async function smoke(c) {
  const { services, log } = c;
  const { overlay, panel, store, sidecar, speech } = services;
  const problems = [];
  const consoleErrors = [];
  const watch = (name, wc) => wc.on('console-message', (e) => { if (e.level === 'error' || e.level === 3) consoleErrors.push(`${name}: ${e.message}`); });
  await waitFor(() => overlay.alive && !overlay.win.webContents.isLoading(), 15000, 'the overlay to load');
  watch('overlay', overlay.win.webContents);
  panel.open();
  await waitFor(() => panel.win && !panel.win.webContents.isLoading(), 15000, 'the settings window to load');
  watch('panel', panel.win.webContents);
  await sleep(600);

  await store.setKeys({ gemini: 'AIza-smoke-test-key-123456' });
  const state = await panel.win.webContents.executeJavaScript('window.panelApi.state()');
  if (!state || state.keys.gemini !== true) problems.push('the settings window does not see that a key is set');
  if (JSON.stringify(state).includes('smoke-test-key')) problems.push('a saved key leaked into the window state');
  const overlaySettings = await overlay.win.webContents.executeJavaScript('window.overlayApi.settingsGet()');
  if (!overlaySettings || overlaySettings.markCorner !== 'br') problems.push('the overlay did not get its settings');
  const sees = await overlay.win.webContents.executeJavaScript('typeof window.panelApi + "," + typeof window.require + "," + typeof window.process');
  if (sees !== 'undefined,undefined,undefined') problems.push(`the overlay can reach more than it should: ${sees}`);
  const markOk = await overlay.win.webContents.executeJavaScript('!!document.querySelector("#mark-canvas") && document.querySelector("#mark-canvas").width > 0');
  if (!markOk) problems.push('the ribbon canvas did not draw');
  await store.setKeys({ gemini: '' });

  const helpers = {};
  if (process.env.CLIPPY_SMOKE_HELPERS !== '0') {
    helpers.win = await waitFor(() => sidecar.available, 60000, 'the Windows helper').then(() => true).catch((e) => { problems.push(e.message); return false; });
    helpers.speech = await waitFor(() => speech.available, 60000, 'the speech recognizer').then(() => speech.recognizer).catch(() => { log('no speech recognizer in smoke'); return false; });
  }
  if (consoleErrors.length) problems.push(...consoleErrors.slice(0, 5));
  const out = { ok: problems.length === 0, problems, helpers, version: state && state.version };
  process.stdout.write(`SMOKE ${JSON.stringify(out)}\n`);
  return out.ok ? 0 : 1;
}

// ---------------------------------------------------------------------------------------
async function shots(c) {
  const { services, ROOT } = c;
  const { overlay, ui, panel, store, folders, routines, pointAsk } = services;
  const dir = process.env.CLIPPY_SHOTS_DIR || path.join(ROOT, 'shots');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const done = [];
  const take = async (win, name, width = 1500) => { await save(win, path.join(dir, `${name}.png`), width); done.push(name); };

  await waitFor(() => overlay.alive && !overlay.win.webContents.isLoading(), 15000, 'the overlay to load');
  await sleep(1200);
  const o = overlay.win;
  const exec = (js) => o.webContents.executeJavaScript(js);
  const errorRect = await exec('(() => { const r = document.querySelector("#fake-error").getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()');
  const reset = async () => { ui.closeAll(); pointAsk.close(); ui.state('idle'); ui.transcript(''); await exec('document.querySelectorAll("#bubble,#askfirst,#offer,#toast,#quick").forEach(e => e.classList.add("hidden"))'); await sleep(500); };

  // the ribbon at its corner
  await sleep(1500);
  await take(o, '01-corner-idle');
  ui.state('listening', { word: 'Listening', line: 'You:' }); ui.transcript('open notepad, new note, type hello'); ui.level(0.6);
  await sleep(900); await take(o, '02-corner-listening');
  ui.state('acting', { word: 'Doing it', line: 'Opening Notepad' });
  await sleep(700); await take(o, '03-corner-acting');
  ui.state('ready');
  ui.offerRoutine({ labels: ['Opening Notepad', 'Pressing Ctrl+N', 'Typing “hello”'] }).catch(() => {});
  await sleep(800); await take(o, '04-corner-offer');
  await reset();

  ui.state('acting', { word: 'Doing it', line: 'Ready to send' });
  ui.ask({ kicker: 'Check first', title: 'Click “Send”?', hint: 'This looks like it sends something.' }).catch(() => {});
  await sleep(800); await take(o, '05-corner-askfirst');
  await reset();

  ui.say('The lab report is due Friday at noon, on Canvas.', { sources: [{ folder: 'Class notes', file: 'week3/lab.md' }] });
  await sleep(700); await take(o, '06-corner-answer');
  await reset();

  ui.notice('Add a Gemini key (free) under Your keys and I can answer that.', { tone: 'info' });
  await sleep(600); await take(o, '07-corner-toast');
  await reset();

  // point and ask
  ui.state('reading', { word: 'Looking', line: 'At that spot' });
  o.webContents.send('point:target', { rect: errorRect, label: '' });
  await sleep(500); await take(o, '08-point-unwinding');
  ui.state('ready');
  o.webContents.send('point:bubble', { kicker: 'Explain', text: 'The link points to a file that moved. Relink it from Insert, then Link.', hint: '', actions: [{ id: 'more', label: 'Ask more' }, { id: 'close', label: 'Close' }], anchor: 'tip' });
  await sleep(2600); await take(o, '09-point-answer');
  o.webContents.send('point:clear', {});
  await sleep(1200); await reset();

  // each corner
  for (const corner of ['tl', 'bl']) { store.patch({ markCorner: corner }); await sleep(600); await take(o, `10-corner-${corner}`, 900); }
  store.patch({ markCorner: 'br' });

  // strip mode
  store.patch({ strip: true });
  await sleep(900); await take(o, '11-strip-idle');
  ui.state('listening', { word: 'Listening', line: 'You:' }); ui.transcript('email Sam the lab report');
  await sleep(700); await take(o, '12-strip-listening');
  ui.state('thinking', { word: 'Working it out' });
  await sleep(500); await take(o, '13-strip-thinking');
  ui.state('acting', { word: 'Doing it', line: 'Writing the email' });
  await sleep(500); await take(o, '14-strip-acting');
  ui.ask({ kicker: 'Check first', title: 'Click “Send”?', hint: 'This looks like it sends something.' }).catch(() => {});
  await sleep(700); await take(o, '15-strip-askfirst');
  ui.closeAll(); await sleep(300);
  ui.state('speaking', { word: 'Answering', line: 'Sent it to Sam.' });
  await sleep(600); await take(o, '16-strip-speaking');
  ui.state('idle');
  await sleep(400);
  // point and ask from the strip: the thread leaves the bar
  ui.state('reading', { word: 'Looking', line: 'At that spot' });
  o.webContents.send('point:target', { rect: errorRect, label: '' });
  await sleep(2600); await take(o, '17-strip-point');
  o.webContents.send('point:clear', {});
  await sleep(1300);
  ui.state('idle');
  await sleep(300);
  store.patch({ strip: false });
  await sleep(500);

  // the settings window, with something in it
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-shot-'));
  const classNotes = path.join(base, 'Class notes'); const resume = path.join(base, 'Resume and cover letters');
  fs.mkdirSync(classNotes); fs.mkdirSync(resume);
  fs.writeFileSync(path.join(classNotes, 'week3.md'), '# Week 3\nThe lab report is due Friday at noon.');
  fs.writeFileSync(path.join(classNotes, 'syllabus.txt'), 'Physics 101 syllabus');
  fs.writeFileSync(path.join(resume, 'cv.txt'), 'Curriculum vitae');
  const r1 = folders.add(classNotes); const r2 = folders.add(resume);
  if (r2.ok) folders.setEnabled(r2.folder.id, false);
  await sleep(800);
  routines.save({ name: 'Morning setup', actions: [{ type: 'open_app', app: 'notepad' }, { type: 'press_keys', keys: ['ctrl', 'n'] }, { type: 'type_text', text: 'hello' }] });
  routines.save({ name: 'Study time', actions: [{ type: 'open_url', url: 'https://www.youtube.com/results?search_query=lofi', label: 'youtube: lofi' }, { type: 'media', op: 'vol_down', times: 5 }] });
  await store.setKeys({ gemini: 'AIza-shot-key-123', anthropic: '' });
  store.patch({ onboarded: true });

  panel.open('saved'); await waitFor(() => panel.win && !panel.win.webContents.isLoading(), 10000, 'the panel'); await sleep(1200);
  panel.win.setSize(980, 760); await sleep(300);
  await take(panel.win, '20-panel-saved', 1100);
  panel.win.webContents.executeJavaScript('document.querySelector(\'[data-tab="folders"]\').click()'); await sleep(500);
  await take(panel.win, '21-panel-folders', 1100);
  panel.win.webContents.executeJavaScript('document.querySelector(\'[data-tab="settings"]\').click()'); await sleep(500);
  await take(panel.win, '22-panel-settings', 1100);
  panel.win.webContents.executeJavaScript('window.scrollTo(0, document.body.scrollHeight)'); await sleep(400);
  await take(panel.win, '23-panel-settings-more', 1100);

  await store.setKeys({ gemini: '' });
  void r1;
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(done, null, 2));
  process.stdout.write(`SHOTS ${JSON.stringify({ dir, count: done.length })}\n`);
  return 0;
}

async function run(c) {
  let code = 1;
  try { code = c.FLAGS.smoke ? await smoke(c) : await shots(c); } catch (e) { process.stdout.write(`HARNESS FAILED ${e.stack || e.message}\n`); }
  c.app.exit(code);
}

module.exports = { run };
