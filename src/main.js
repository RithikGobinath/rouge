'use strict';
// The composition root: builds the pieces, wires them, and owns the
// lifecycle. Nothing here knows how to do the real work.

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { app, shell, safeStorage, nativeImage, BrowserWindow, screen, powerMonitor } = require('electron');
const brand = require('./brand');

const ROOT = path.join(__dirname, '..');
const MAC_DEV = process.platform === 'darwin' && process.argv.includes('--mac-dev');
const FLAGS = { shots: process.argv.includes('--shots'), smoke: process.argv.includes('--smoke') };
const TEST = FLAGS.shots || FLAGS.smoke;
if (TEST || MAC_DEV) process.env.CLIPPY_NO_HOTKEYS = '1';
if (TEST && !process.env.CLIPPY_USER_DATA) process.env.CLIPPY_USER_DATA = require('fs').mkdtempSync(path.join(require('os').tmpdir(), 'clippy-test-'));

app.setName(brand.name);
app.setAppUserModelId(brand.appId);
app.setPath('userData', process.env.CLIPPY_USER_DATA || path.join(app.getPath('appData'), brand.dataDir));
if (!TEST && !app.requestSingleInstanceLock()) { app.quit(); }

const { createLog } = require('./app/log');
const { createStore } = require('./store');
const { createRoutines } = require('./routines');
const { createFolders } = require('./folders/manager');
const { createApps } = require('./actions/apps');
const { createExecutor } = require('./actions/executor');
const { createComputerController } = require('./computer/controller');
const { createWinSidecar } = require('./win/sidecar');
const { createSpeech } = require('./voice/speech');
const { createVoice } = require('./voice/session');
const { createJev } = require('./voice/jev');
const { createAI } = require('./ai');
const { createPointAsk } = require('./pointing/pointAsk');
const capture = require('./pointing/capture');
const { sensitiveTarget } = require('./pointing/sensitive');
const { prepareCache } = require('./calendar/conflict');
const { createCalendarWatch, startVisionModel } = require('./calendar/watch');
const { createMeetingReminders } = require('./calendar/reminders');
const { createTestCalendar } = require('./calendar/testCalendar');
const { createOverlay } = require('./app/overlay');
const { createOverlayUi } = require('./app/overlayUi');
const { createHotkeys, spoken } = require('./app/hotkeys');
const { createPanel } = require('./app/panel');
const { createTray } = require('./app/tray');
const { registerIpc } = require('./app/ipc');
const { createKnotWindow } = require('./app/knotWindow');

const log = createLog(app.getPath('userData'));
let services = null;
const VISION_PORT = 18770;

function calendarPaths() {
  const lab = process.env.CLIPPY_LAB_ROOT || 'C:\\Users\\rithi\\OneDrive\\Documents\\AutoAnatomy\\clippy-calendar-lab';
  return {
    cacheFile: process.env.CLIPPY_CALENDAR_FILE || (process.platform === 'win32'
      ? 'C:\\Users\\rithi\\.codex\\visualizations\\2026\\10\\19\\01a15501-b9fd-7720-9e84-9a7afef156cb\\clippy-calendar-lab-private\\calendar.json'
      : path.join(ROOT, 'calendar.json')),
    exe: path.join(lab, 'runtime', 'llama-cuda', 'llama-server.exe'),
    model: path.join(lab, 'models', 'Qwen3.5-2B-Q4_K_M.gguf'),
    mmproj: path.join(lab, 'models', 'mmproj-F16.gguf'),
  };
}

function portBusy(port) {
  return new Promise((resolve) => {
    const probe = net.connect({ host: '127.0.0.1', port });
    const done = (yes) => { probe.destroy(); resolve(yes); };
    probe.setTimeout(400);
    probe.once('connect', () => done(true));
    probe.once('error', () => done(false));
    probe.once('timeout', () => done(true));
  });
}

async function grabCalendarFrame(sidecar, overlay) {
  const focus = await sidecar.focused().catch(() => null);
  if (sensitiveTarget(focus && focus.element)) return null;
  const shot = await capture.takeDisplay(screen.dipToScreenPoint(screen.getCursorScreenPoint()), { win: overlay.win });
  const size = shot.image.getSize();
  const height = Math.min(640, size.height);
  const width = Math.max(1, Math.round(size.width * height / size.height));
  return `data:image/jpeg;base64,${shot.image.resize({ width, height }).toJPEG(72).toString('base64')}`;
}

function build() {
  const dir = app.getPath('userData');
  const cipher = { available: () => safeStorage.isAsyncEncryptionAvailable(), encrypt: (s) => safeStorage.encryptStringAsync(s), decrypt: async (b) => (await safeStorage.decryptStringAsync(b)).result };
  const store = createStore({ dir, cipher });
  const routines = createRoutines({ file: path.join(dir, 'routines.json') });
  const folders = createFolders({ dir: path.join(dir, 'folders'), log });
  const apps = createApps({ log });
  const sidecar = createWinSidecar({ log, ignorePid: process.pid });
  const speech = createSpeech({ log });
  let computer = null;
  const ai = createAI({ store, folders, log, getComputer: () => computer });
  const overlay = createOverlay({ preload: path.join(ROOT, 'src', 'preload', 'overlay.js'), html: path.join(ROOT, 'renderer', 'overlay', 'overlay.html'), query: FLAGS.shots ? { test: '1' } : undefined, sidecar, log });
  const ui = createOverlayUi({ overlay });
  const panel = createPanel({ preload: path.join(ROOT, 'src', 'preload', 'panel.js'), html: path.join(ROOT, 'renderer', 'panel', 'panel.html'), icon: iconImage(), log });

  let voice = null;
  const paths = Object.fromEntries(['downloads', 'documents', 'desktop', 'pictures', 'music', 'videos'].map((n) => [n, app.getPath(n)]).concat([['home', app.getPath('home')]]));
  const executor = createExecutor({
    disabledReason: MAC_DEV ? 'Computer controls are disabled during Mac development.' : '',
    sidecar, apps, folders, routines, paths, ask: (card) => voice.ask(card), say: ({ text }) => ui.say(text),
    shell: { openExternal: (u) => shell.openExternal(u), openPath: (p) => shell.openPath(p) },
    spawnDetached: (file, args) => { const c = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true }); c.on('error', (e) => log(`spawn ${file}: ${e.message}`)); c.unref(); },
  });
  if (!MAC_DEV) computer = createComputerController({ sidecar, executor, ui: { ...ui, ask: (card) => voice.ask(card) }, log });

  let jev = null; let jevKey = '';
  const getJev = () => {
    const key = store.getKey('typesafe');
    if (!key) { jev = null; jevKey = ''; return null; }
    if (key !== jevKey) { jev = createJev({ apiKey: key }); jevKey = key; }
    return jev;
  };

  const testCalendar = createTestCalendar();
  const voiceDeps = { speech, ui, executor, routines, folders, ai, getJev, apps, sidecar, settings: () => store.settings(), log, calendar: null,
    addTestMeeting: (text) => { const result = testCalendar.command(text); if (result && result.ok) reminders.refresh(); return result; },
    // End-to-end tests only: hear a WAV instead of the microphone.
    listenFile: () => (process.env.CLIPPY_E2E === '1' ? process.env.CLIPPY_E2E_WAV : undefined) };
  voice = createVoice(voiceDeps);
  const pointAsk = createPointAsk({ sidecar, ai, overlay, ui, capture, log });
  voiceDeps.pointAsk = pointAsk;
  let calendarClicks = 0;
  const calendarDeps = {
    log, port: VISION_PORT, poll: !TEST, intervalMs: 1000, cache: null, busy: () => voice.active || voice.asking,
    cursor: async () => { const c = await sidecar.cursor(); return { x: c.x, y: c.y, input: c.input || 0 }; },
    clicks: () => calendarClicks,
    capture: () => grabCalendarFrame(sidecar, overlay),
    notice: (text, opts) => ui.notice(text, opts),
    askIntent: async (text) => {
      try {
        const r = await ai.answer(`Is this message proposing a new meeting to be scheduled? Reply only "yes" or "no".\nMessage: ${String(text).slice(0, 300)}`, { signal: AbortSignal.timeout(8000) });
        return /\byes\b/i.test(r.text.trim());
      } catch (_) { return false; }
    },
    prepare: async () => {
      const files = calendarPaths();
      if (![files.cacheFile, files.exe, files.model, files.mmproj].every((file) => fs.existsSync(file))) {
        log('calendar: local vision model or calendar snapshot is missing');
        return;
      }
      if (await portBusy(VISION_PORT)) { log('calendar: vision port is already in use'); ui.notice('The local vision model port is already in use, so calendar conflicts are paused.', { tone: 'info' }); return; }
      calendarDeps.cache = prepareCache(JSON.parse(fs.readFileSync(files.cacheFile, 'utf8')));
    },
    spawnModel: (token) => startVisionModel({ ...calendarPaths(), port: VISION_PORT, token }),
    health: async () => { try { return (await fetch(`http://127.0.0.1:${VISION_PORT}/health`, { signal: AbortSignal.timeout(1000) })).ok; } catch (_) { return false; } },
  };
  const calendar = createCalendarWatch(calendarDeps);
  voiceDeps.calendar = calendar;
  const reminders = createMeetingReminders({
    file: calendarPaths().cacheFile, stateFile: path.join(dir, 'meeting-reminders.json'),
    extraEvents: () => testCalendar.events(),
    notify: (events) => { overlay.show(); overlay.send('calendar:reminder', { events }); },
    onStatus: (status) => log(`meeting reminders: ${status}`),
  });
  return { store, routines, folders, apps, sidecar, speech, ai, overlay, ui, panel, executor, computer, voice, pointAsk, calendar, reminders, noteClick: () => { calendarClicks += 1; }, paths, getJev };
}

function iconImage() {
  const img = nativeImage.createFromPath(path.join(ROOT, 'assets', 'icon.png'));
  return img.isEmpty() ? undefined : img;
}

async function boot() {
  services = build();
  await services.store.init();
  // End-to-end tests only: start with these keys set.
  if (process.env.CLIPPY_E2E === '1' && process.env.CLIPPY_E2E_KEYS) await services.store.setKeys(JSON.parse(process.env.CLIPPY_E2E_KEYS));
  const { store, routines, folders, apps, sidecar, speech, ai, overlay, ui, panel, voice, pointAsk } = services;
  let paused = false;
  let applyingFallback = false;
  let hotkeyStatus = { talk: false, point: false, hide: false, panic: false };
  let prevFg = null;
  // A notice sent before the overlay page has loaded would be lost, so early ones wait for it.
  let overlayReady = false;
  const early = [];
  const tell = (text, opts) => { if (overlayReady) ui.notice(text, opts); else early.push([text, opts]); };

  const buildState = async () => {
    const s = store.settings();
    return {
      name: brand.name, version: app.getVersion(), development: MAC_DEV, dataDir: app.getPath('userData'), settings: s, keys: store.keyStatus(), claudeCode: s.useClaudeCode ? await ai.claudeCode.available() : false,
      voice: { available: speech.available, recognizer: speech.recognizer, error: speech.error },
      helper: { win: sidecar.available },
      reminders: { status: services.reminders.status(), file: services.reminders.file },
      defaultHotkeys: store.defaults().hotkeys,
      hotkeys: Object.fromEntries(['talk', 'point', 'hide', 'panic'].map((k) => [k, { accel: s.hotkeys[k], ok: hotkeyStatus[k] || paused || process.env.CLIPPY_NO_HOTKEYS === '1' }])),
      folders: folders.list(), routines: routines.list(),
    };
  };
  let pushTimer = null;
  const push = () => { clearTimeout(pushTimer); pushTimer = setTimeout(async () => { if (panel.win) panel.send('panel:update', await buildState()); }, 80); };

  const runRoutine = (routine) => voice.runRoutine(routine);

  let hotkeys = null;

  hotkeys = createHotkeys({
    sidecar, log,
    handlers: {
      talkDown: async () => {
        if (!speech.available) { ui.notice('Windows speech recognition is not ready. Click the ribbon and type a command instead.', { tone: 'info' }); return; }
        const ok = await voice.begin('voice');
        if (!ok) log('voice.begin refused');
      },
      talkUp: async ({ tap }) => {
        if (tap) { voice.cancel(); ui.notice('Hold the keys while you talk.', { tone: 'info' }); return; }
        await voice.release();
      },
      point: () => { voice.cancel(); pointAsk.trigger(); },
      toggle: () => { store.patch({ markHidden: !store.settings().markHidden }); },
      panic: () => { voice.cancel(); pointAsk.close(); ui.closeAll(); ui.state('idle'); store.patch({ markHidden: true }); },
    },
  });
  const registerHotkeys = () => {
    if (paused || process.env.CLIPPY_NO_HOTKEYS === '1') { hotkeys.unregister(); hotkeyStatus = { talk: false, point: false, hide: false, panic: false }; return; }
    const wanted = store.settings().hotkeys;
    hotkeyStatus = hotkeys.register(wanted);
    log(`hotkeys: ${JSON.stringify(hotkeyStatus)} on ${JSON.stringify(hotkeys.used)}`);
    // A chord another app owns moves to its nearest free neighbour, and the new one is remembered and said out loud.
    const moved = Object.fromEntries(Object.entries(hotkeys.used).filter(([k, a]) => a !== wanted[k]));
    if (Object.keys(moved).length) {
      applyingFallback = true; store.patch({ hotkeys: moved }); applyingFallback = false;
      const said = Object.entries(moved).map(([k, a]) => `${spoken(wanted[k])} is taken by another app, so it is ${spoken(a)}`).join('; ');
      tell(`${said}. Change it any time in Settings, under Voice.`, { tone: 'info' });
    }
    if (!hotkeyStatus.talk) tell('Hold-to-talk has no free keys. Pick some in Settings, under Voice, or click the ribbon and type.', { tone: 'error' });
    push();
  };

  // ---- the windows and the tray ----------------------------------------------------
  const trayIcon = nativeImage.createFromPath(path.join(ROOT, 'assets', 'tray-icon.png')).resize({ width: 32, height: 32, quality: 'best' });
  const tray = createTray({
    icon: trayIcon, tooltip: () => MAC_DEV ? `${brand.name} · Mac development` : `${brand.name} · hold ${spoken(hotkeys.used.talk || store.settings().hotkeys.talk)} to talk`, settings: () => store.settings(), paused: () => paused,
    on: {
      open: () => panel.open(), quick: () => overlay.send('quick:open', {}), set: (patch) => store.patch(patch),
      pause: (p) => { paused = p; registerHotkeys(); if (p) { voice.cancel(); pointAsk.close(); overlay.hide(); } else if (!store.settings().markHidden) overlay.show(); tray.update(); },
      quit: () => app.quit(),
    },
  });

  registerIpc({
    store, overlay, ui, panel, pointAsk, folders, routines, buildState, runRoutine, quit: () => app.quit(),
    onCommandText: (text) => {
      voice.runText(text).then((ok) => {
        if (!ok) ui.notice('I am still answering your previous request.', { tone: 'info' });
      }).catch((e) => {
        log(`typed request failed: ${e.message}`);
        ui.notice('That request could not finish. Please try again.', { tone: 'error' });
      });
    },
    onFocusRequest: async () => { try { prevFg = await sidecar.fg(); } catch (_) { prevFg = null; } return overlay.focus(); },
    onBlurRequest: () => { overlay.blur(); if (prevFg && prevFg.title) sidecar.focusWindow(prevFg.title, '').catch(() => {}); prevFg = null; },
    onOverlayReady: () => {
      overlay.send('settings', store.settings());
      overlayReady = true;
      for (const [text, opts] of early.splice(0)) ui.notice(text, opts);
      if (!TEST) services.reminders.start();
    },
    onReminderDismiss: () => { if (paused || store.settings().markHidden) overlay.hide(); },
  });

  // ---- reacting to changes --------------------------------------------------------
  store.on('settings', (s, changed) => {
    overlay.send('settings', s);
    if (changed.includes('hotkeys') && !applyingFallback) registerHotkeys();
    if (changed.includes('startWithWindows')) app.setLoginItemSettings({ openAtLogin: Boolean(s.startWithWindows), args: ['--hidden'] });
    if (changed.includes('markHidden') && !paused) { if (s.markHidden) overlay.hide(); else overlay.show(); }
    tray.update(); push();
  });
  store.on('keys', () => { push(); });
  folders.on('change', push);
  routines.on('change', push);
  sidecar.on('availability', push);
  services.reminders.on('change', push);
  powerMonitor.on('resume', services.reminders.refresh);

  overlay.create();
  registerHotkeys();
  if (store.settings().markHidden) overlay.hide();

  // Knot companion window (built from ROUGE_BACKEND_HANDOFF.md spec) is available
  // but not shown alongside the ribbon by default. Re-enable when the UI design
  // is decided: remove the `false &&` to activate it.
  if (false && !TEST && !FLAGS.shots) {
    const knotWin = createKnotWindow({ ui, voice, log });
    services.store.on('settings', (s) => {
      if (s.markHidden) knotWin.win.hide(); else knotWin.win.show();
    });
    app.on('before-quit', () => knotWin.destroy());
  }

  // ---- the slow starts, in the background -------------------------------------------
  if (!FLAGS.shots && !MAC_DEV) {
    sidecar.start();
    if (!TEST) {
      sidecar.on('click', () => services.noteClick());
      sidecar.watch([], true, false, 'calendar').catch(() => {});
      services.calendar.start().catch((e) => log(`calendar: ${e.message}`));
    }
    speech.start();
    speech.init().then((r) => { log(`speech: ${r.ok ? r.recognizer : r.error}`); push(); });
    apps.load();
  }
  folders.load();
  folders.refreshAll();
  if (store.settings().useClaudeCode) ai.claudeCode.available().then(push);
  if (MAC_DEV) {
    log('Mac development mode: computer controls, voice, hotkeys and screen watching disabled');
    tell('Mac development mode: type to chat. Computer controls, voice and screen watching are disabled.', { tone: 'info' });
  }

  const first = !store.settings().onboarded && !FLAGS.shots;
  if (first || process.argv.includes('--panel')) { panel.open(); if (first) store.patch({ onboarded: true }); }

  if (TEST) require('./dev/harness').run({ FLAGS, services, ROOT, log, app, buildState, registerHotkeys });
}

app.on('second-instance', () => { if (services) services.panel.open(); });
app.on('window-all-closed', () => { /* the tray keeps the app running */ });
app.on('before-quit', () => {
  if (!services) return;
  services.voice.cancel();
  services.calendar.stop();
  services.reminders.stop();
  powerMonitor.removeListener('resume', services.reminders.refresh);
  services.panel.quit();
  services.sidecar.stop(); services.speech.stop();
  services.overlay.destroy();
});
app.on('will-quit', () => { const { globalShortcut } = require('electron'); globalShortcut.unregisterAll(); });

app.whenReady().then(boot).catch((e) => { log(`boot failed: ${e.stack || e.message}`); app.exit(1); });
void BrowserWindow;
