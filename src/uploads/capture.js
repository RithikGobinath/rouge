'use strict';
// Native picker evidence stays in the main process, never in prompts or settings.
const fs = require('fs');
const path = require('path');
const { createJsonlProcess } = require('../win/jsonl');

const TTL_MS = 120000;

function createUploadCapture({ log = () => {}, now = Date.now, stat = fs.promises.lstat,
  helper = createJsonlProcess({ name: 'upload-picker', command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, '../win/upload-picker.ps1')],
    pingTimeoutMs: 30000, restartOnTimeout: true,
    // Transport errors can contain native exception details; keep paths out of logs.
    log: () => log('upload capture: helper status changed'),
  }) } = {}) {
  let wanted = false;
  let generation = 0;
  let selected = null;

  const clear = () => { generation += 1; selected = null; };
  helper.on('availability', (available) => {
    clear();
    if (available && wanted) helper.request('watch.start').catch(() => { clear(); });
  });
  helper.on('upload.pending', clear);
  helper.on('upload.selected', async (event) => {
    clear();
    const version = generation;
    if (!wanted || !helper.available || !event || !/^[a-f0-9]{32}$/.test(event.selectionId || '')
      || !Number.isSafeInteger(event.hwnd) || event.hwnd <= 0 || typeof event.path !== 'string'
      || event.path.length > 260 || !/^[A-Za-z]:\\/.test(event.path)
      || /[\u0000-\u001f"<>|?*]/.test(event.path) || event.path.includes(':', 2)
      || /(?:^|\\)fakepath(?:\\|$)/i.test(event.path) || path.win32.extname(event.path).toLowerCase() !== '.pdf') return;
    try {
      const info = await stat(event.path);
      if (!info.isFile() || info.size <= 0 || !wanted || generation !== version) return;
      selected = { selectionId: event.selectionId, hwnd: event.hwnd, path: event.path,
        name: path.win32.basename(event.path), size: info.size, mtimeMs: info.mtimeMs, dev: info.dev, ino: info.ino, at: now() };
      log('upload capture: PDF selection confirmed');
    } catch (_) { /* Missing or inaccessible paths never become candidates. */ }
  });

  return {
    start() { if (wanted) return; wanted = true; clear(); helper.start(); },
    stop() { wanted = false; clear(); helper.stop(); },
    /** Internal only. Revalidate browser context and file identity before using a PDF. */
    async current({ hwnd, name } = {}) {
      const candidate = selected;
      if (!wanted || !helper.available || !candidate) return null;
      if (now() - candidate.at < 0 || now() - candidate.at >= TTL_MS) { clear(); return null; }
      if (hwnd !== undefined && candidate.hwnd !== hwnd || name !== undefined && candidate.name.toLowerCase() !== String(name).toLowerCase()) return null;
      const version = generation;
      try {
        const result = await helper.request('selection.current', { selectionId: candidate.selectionId }, 4000);
        const info = await stat(candidate.path);
        if (!wanted || version !== generation || result.ok !== true || !info.isFile()
          || info.size !== candidate.size || info.mtimeMs !== candidate.mtimeMs || info.dev !== candidate.dev || info.ino !== candidate.ino) {
          if (version === generation) clear();
          return null;
        }
        return { ...candidate };
      } catch (_) { if (version === generation) clear(); return null; }
    },
  };
}

module.exports = { createUploadCapture, TTL_MS };
