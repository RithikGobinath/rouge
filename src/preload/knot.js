'use strict';
// Preload for the Rouge knot companion window.
// Bridges contextBridge so the renderer can communicate with the main process
// via window.rougeKnotBridge.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rougeKnotBridge', {
  // Renderer listens for backend messages
  on(channel, callback) {
    const allowed = new Set([
      'ui:state', 'ui:say', 'ui:notice', 'ui:transcript',
      'ui:ask', 'ui:ask:close', 'ui:offer', 'ui:offer:close',
      'ui:level', 'ui:stream',
    ]);
    if (!allowed.has(channel)) return;
    ipcRenderer.on(channel, (_event, data) => callback(data));
  },
  // Renderer sends messages to the backend
  send(channel, data) {
    const allowed = new Set(['knot:command', 'knot:navigate', 'knot:statechange']);
    if (!allowed.has(channel)) return;
    ipcRenderer.send(channel, data);
  },
  invoke(channel, data) {
    const allowed = new Set(['knot:command', 'knot:navigate']);
    if (!allowed.has(channel)) return Promise.reject(new Error('Not allowed'));
    return ipcRenderer.invoke(channel, data);
  },
});
