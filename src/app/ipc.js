'use strict';
// Every message a window can send, checked at the door: who sent it, what
// shape it has, how big it is. A window never gets a handle on anything; it
// asks, and the main process decides.

const { ipcMain, dialog, shell, Menu } = require('electron');
const brand = require('../brand');
const { publicWebUrl } = require('../ai/web');

const OPEN_OK = new Set(['https://typesafe.ai', 'https://aistudio.google.com/apikey', 'https://console.anthropic.com']);
const isId = (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 1e9;
const isName = (v) => typeof v === 'string' && v.length > 0 && v.length <= 80;
const isRid = (v) => typeof v === 'string' && /^[a-f0-9]{4,20}$/.test(v);

/**
 * @param {Object} c everything the windows may ask the app to do
 */
function registerIpc(c) {
  const fromOverlay = (e) => c.overlay.alive && e.sender === c.overlay.win.webContents;
  const fromPanel = (e) => Boolean(c.panel.win) && e.sender === c.panel.win.webContents;
  const bad = (what) => ({ ok: false, error: `That ${what} was not understood.` });

  // ---- shared ------------------------------------------------------------------
  ipcMain.handle('settings:get', (e) => (fromOverlay(e) || fromPanel(e) ? c.store.settings() : null));

  // ---- the overlay ---------------------------------------------------------------
  ipcMain.on('overlay:ready', (e) => { if (fromOverlay(e)) { c.overlay.send('settings', c.store.settings()); c.onOverlayReady && c.onOverlayReady(); } });
  ipcMain.on('overlay:ignore', (e, v) => { if (fromOverlay(e) && typeof v === 'boolean') c.overlay.setIgnore(v); });
  ipcMain.on('overlay:ask', (e, m) => { if (fromOverlay(e) && m && isId(m.id)) c.ui.answerAsk(m.id, m.yes === true); });
  ipcMain.on('overlay:offer', (e, m) => { if (fromOverlay(e) && m && isId(m.id)) c.ui.answerOffer(m.id, m.choice); });
  ipcMain.on('overlay:text', (e, text) => { if (fromOverlay(e) && typeof text === 'string' && text.trim()) c.onCommandText(text.trim().slice(0, 600)); });
  ipcMain.on('overlay:point:more', (e, text) => { if (fromOverlay(e) && typeof text === 'string' && text.trim()) c.pointAsk.followUp(text); });
  ipcMain.on('overlay:point:close', (e) => { if (fromOverlay(e)) c.pointAsk.close(); });
  ipcMain.on('overlay:reminder:dismiss', (e) => { if (fromOverlay(e) && c.onReminderDismiss) c.onReminderDismiss(); });
  ipcMain.handle('overlay:clock', (e) => fromOverlay(e) ? c.clockRect() : null);
  ipcMain.handle('overlay:source:open', async (e, value) => {
    if (!fromOverlay(e) || typeof value !== 'string' || value.length > 2048) return bad('source');
    const url = publicWebUrl(value);
    if (!url) return bad('source');
    try { await shell.openExternal(url); return { ok: true }; }
    catch (_) { return { ok: false, error: 'This source could not be opened.' }; }
  });
  ipcMain.handle('overlay:focus', async (e) => (fromOverlay(e) ? c.onFocusRequest() : false));
  ipcMain.on('overlay:blur', (e) => { if (fromOverlay(e)) c.onBlurRequest(); });
  ipcMain.on('overlay:menu', (e) => {
    if (!fromOverlay(e)) return;
    const s = c.store.settings();
    Menu.buildFromTemplate([
      { label: 'Type a command', click: () => c.overlay.send('quick:open', {}) },
      { label: `Open ${brand.name}`, click: () => c.panel.open() },
      { type: 'separator' },
      { label: 'Strip mode', type: 'checkbox', checked: s.strip, click: (i) => c.store.patch({ strip: i.checked }) },
      { label: 'Corner', submenu: [['tl', 'Top left'], ['tr', 'Top right'], ['bl', 'Bottom left'], ['br', 'Bottom right']].map(([id, label]) => ({ label, type: 'radio', checked: s.markCorner === id, click: () => c.store.patch({ markCorner: id }) })) },
      { label: 'Hide the ribbon', click: () => c.store.patch({ markHidden: true }) },
      { type: 'separator' },
      { label: 'Quit', click: () => c.quit() },
    ]).popup({ window: c.overlay.win });
  });

  // ---- the settings window --------------------------------------------------------
  ipcMain.handle('panel:state', async (e) => (fromPanel(e) ? c.buildState() : null));

  ipcMain.handle('panel:keys', async (e, keys) => {
    if (!fromPanel(e)) return bad('request');
    if (!keys || typeof keys !== 'object' || Array.isArray(keys)) return bad('key');
    return c.store.setKeys(keys);
  });

  ipcMain.handle('panel:settings', (e, patch) => {
    if (!fromPanel(e)) return bad('request');
    return c.store.patch(patch);
  });

  ipcMain.handle('panel:folder:add', async (e) => {
    if (!fromPanel(e)) return bad('request');
    const r = await dialog.showOpenDialog(c.panel.win, { title: 'Add a folder to the library: notes, documents or calendars', properties: ['openDirectory'], buttonLabel: 'Add folder' });
    if (r.canceled || !r.filePaths[0]) return { ok: true, canceled: true };
    return c.folders.add(r.filePaths[0]);
  });

  ipcMain.handle('panel:folder', async (e, m) => {
    if (!fromPanel(e) || !m || typeof m.id !== 'string' || m.id.length > 20) return bad('request');
    if (m.op === 'toggle') c.folders.setEnabled(m.id, m.arg === true);
    else if (m.op === 'remove') c.folders.remove(m.id);
    else if (m.op === 'refresh') c.folders.refresh(m.id);
    else return bad('request');
    return { ok: true };
  });

  ipcMain.handle('panel:routine', async (e, m) => {
    if (!fromPanel(e) || !m || !isRid(m.id)) return bad('request');
    const r = c.routines.get(m.id);
    if (!r) return { ok: false, error: 'That shortcut is gone.' };
    if (m.op === 'run') return c.runRoutine(r);
    if (m.op === 'rename') return isName(m.arg) ? c.routines.rename(m.id, m.arg) : bad('name');
    if (m.op === 'remove') { c.routines.remove(m.id); return { ok: true }; }
    return bad('request');
  });

  ipcMain.handle('panel:open', async (e, url) => {
    if (!fromPanel(e) || !OPEN_OK.has(url)) return { ok: false };
    await shell.openExternal(url);
    return { ok: true };
  });
}

module.exports = { registerIpc, OPEN_OK };
