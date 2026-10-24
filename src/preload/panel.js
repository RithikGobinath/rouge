'use strict';
// The settings window's only door to the app. Keys go out through saveKeys
// and never come back: state() says whether one is set, nothing more.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('panelApi', {
  state: () => ipcRenderer.invoke('panel:state'),
  saveKeys: (keys) => ipcRenderer.invoke('panel:keys', keys),
  setSettings: (patch) => ipcRenderer.invoke('panel:settings', patch),
  addFolder: () => ipcRenderer.invoke('panel:folder:add'),
  folder: (op, id, arg) => ipcRenderer.invoke('panel:folder', { op, id, arg }),
  routine: (op, id, arg) => ipcRenderer.invoke('panel:routine', { op, id, arg }),
  openExternal: (url) => ipcRenderer.invoke('panel:open', String(url || '')),
  on: (cb) => { if (typeof cb === 'function') ipcRenderer.on('panel:update', (_e, s) => cb(s)); },
});
