'use strict';
// Creates the Rouge knot companion window — a transparent, always-on-top,
// frameless overlay that loads the handoff-spec frontend.
// The window sends/receives IPC with the main process via contextBridge.

const path = require('path');
const { BrowserWindow, ipcMain } = require('electron');

const PRELOAD = path.join(__dirname, '..', 'preload', 'knot.js');
const HTML    = path.join(__dirname, '..', '..', 'renderer', 'rouge-knot', 'index.html');

function createKnotWindow({ ui, voice, log = () => {} }) {
  const { screen: electronScreen } = require('electron');
  const primary = electronScreen.getPrimaryDisplay();
  const { width, height } = primary.workAreaSize;
  const win = new BrowserWindow({
    width, height,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: true,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Pass all events through by default; the page uses pointer-events:none on
  // the transparent parts and the renderer calls knotWindow.setHit(false) when
  // the pointer is not over any interactive element.
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(HTML).catch(e => log('knot-window load error: ' + e.message));

  // ---- Bridge: backend → renderer ----------------------------------------
  function send(channel, data) {
    if (!win.isDestroyed()) win.webContents.send(channel, data);
  }

  // Forward ui state changes to the knot renderer
  const uiStateMap = {
    idle:      'idle',
    thinking:  'thinking',
    listening: 'listening',
    acting:    'thinking',
    speaking:  'speaking',
    reading:   'reading',
    ready:     'ready',
  };

  // ---- Bridge: renderer → backend ----------------------------------------
  ipcMain.handle('knot:command', (_event, text) => {
    log('knot command: ' + text);
    if (voice && voice.runText) {
      voice.runText(String(text || '').trim()).catch(e => log('knot: ' + e.message));
    }
  });

  ipcMain.handle('knot:navigate', (_event, view) => {
    // The knot renderer handles its own view state — no-op in the backend
  });

  ipcMain.on('knot:statechange', (_event, state) => {
    log('knot statechange received');
  });

  // Forward ribbon ui events to the knot renderer
  function forwardState(appState) {
    // idle / thinking / listening / speaking / acting
    const knotState = uiStateMap[appState] || 'idle';
    send('ui:state', { state: knotState });
  }

  // Expose ui bridge for main.js to call
  return {
    win,
    send,
    forwardState,
    destroy() {
      if (!win.isDestroyed()) win.destroy();
    },
  };
}

module.exports = { createKnotWindow };
