'use strict';
// The overlay's only door to the app. Everything it can ask for is listed
// here, each with a small bounded payload; it receives events, never handles.

const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = new Set([
  'settings', 'cursor:probe', 'quick:open',
  'ui:state', 'ui:transcript', 'ui:level', 'ui:say', 'ui:notice', 'ui:ask', 'ui:ask:close', 'ui:offer', 'ui:offer:close', 'ui:speak',
  'point:target', 'point:bubble', 'point:clear', 'test:backdrop',
  'calendar:reminder', 'overlay:area',
]);

contextBridge.exposeInMainWorld('overlayApi', {
  on: (channel, cb) => { if (EVENTS.has(channel) && typeof cb === 'function') ipcRenderer.on(channel, (_e, data) => cb(data)); },
  ready: () => ipcRenderer.send('overlay:ready'),
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  ignore: (v) => ipcRenderer.send('overlay:ignore', Boolean(v)),
  askAnswer: (id, yes) => ipcRenderer.send('overlay:ask', { id: Number(id) || 0, yes: Boolean(yes) }),
  offerAnswer: (id, choice) => ipcRenderer.send('overlay:offer', { id: Number(id) || 0, choice: choice === 'keep' ? 'keep' : 'skip' }),
  sendText: (text) => ipcRenderer.send('overlay:text', String(text || '').slice(0, 600)),
  pointFollowUp: (text) => ipcRenderer.send('overlay:point:more', String(text || '').slice(0, 1000)),
  pointClose: () => ipcRenderer.send('overlay:point:close'),
  dismissReminder: () => ipcRenderer.send('overlay:reminder:dismiss'),
  clockRect: () => ipcRenderer.invoke('overlay:clock'),
  openSource: (url) => ipcRenderer.invoke('overlay:source:open', typeof url === 'string' ? url.slice(0, 2048) : ''),
  menu: () => ipcRenderer.send('overlay:menu'),
  focusRequest: () => ipcRenderer.invoke('overlay:focus'),
  blurRequest: () => ipcRenderer.send('overlay:blur'),
});
