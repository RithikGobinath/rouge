'use strict';
// Read the existing calendar snapshot; only file changes and the next deadline wake us.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { prepareCache } = require('./conflict');

const LEAD_MS = 15 * 60 * 1000;
const MAX_DELAY = 2147483647;
const MAX_BYTES = 5 * 1024 * 1024;

function meetingEvents(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.events) || snapshot.events.length > 20000) throw new Error('invalid_calendar');
  const events = new Map();
  for (const event of snapshot.events) {
    if (!event || event.type === 'seriesMaster' || event.cancelled || event.isCancelled || event.isAllDay || event.allDay || event.response === 'declined' || event.responseStatus?.response === 'declined') continue;
    try {
      const normalized = prepareCache({ events: [event] }).events[0];
      if (!Number.isFinite(normalized.startMs) || !Number.isFinite(normalized.endMs) || normalized.endMs <= normalized.startMs) continue;
      const key = createHash('sha256').update(JSON.stringify([event.source || '', event.id || event.uid || event.title || event.subject || '', normalized.startMs])).digest('hex');
      events.set(key, { key, title: String(event.title || event.subject || 'Meeting').slice(0, 200), startMs: normalized.startMs });
    } catch (_) { /* One bad event must not suppress the valid meetings. */ }
  }
  return [...events.values()].sort((a, b) => a.startMs - b.startMs);
}

function createMeetingReminders({ file, stateFile, notify, onStatus = () => {}, now = Date.now,
  io = fs, watch = fs.watch, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let events = []; let seen = {}; let timer = null; let watcher = null; let stopped = true;
  const emitter = new EventEmitter();
  let watching = false; let persistenceError = false;
  let status = 'stopped';
  const report = (value) => { if (status === value) return; status = value; onStatus(value); emitter.emit('change'); };
  const cancelTimer = () => { if (timer !== null) clearTimer(timer); timer = null; };

  function saveSeen() {
    const cutoff = now() - 86400000;
    for (const [key, startMs] of Object.entries(seen)) if (!Number.isFinite(startMs) || startMs < cutoff) delete seen[key];
    io.mkdirSync(path.dirname(stateFile), { recursive: true });
    const temporary = `${stateFile}.tmp`;
    io.writeFileSync(temporary, JSON.stringify(seen));
    io.renameSync(temporary, stateFile);
  }

  function reconcile() {
    cancelTimer();
    if (stopped) return;
    const current = now();
    const pending = events.filter((event) => event.startMs > current && !Object.hasOwn(seen, event.key));
    const due = pending.filter((event) => event.startMs - LEAD_MS <= current);
    if (due.length) {
      try {
        // The callback hands the entire batch to the ready overlay before marking it delivered.
        notify(due);
        for (const event of due) seen[event.key] = event.startMs;
      } catch (_) { report('delivery_error'); return; }
      try { saveSeen(); persistenceError = false; } catch (_) { persistenceError = true; }
    }
    const next = pending.find((event) => !Object.hasOwn(seen, event.key));
    if (next) timer = setTimer(reconcile, Math.min(MAX_DELAY, Math.max(1, next.startMs - LEAD_MS - now())));
    report(persistenceError ? 'persistence_error' : watching ? 'ready' : 'watch_error');
  }

  function refresh() {
    cancelTimer();
    if (stopped) return;
    try {
      if (io.statSync(file).size > MAX_BYTES) throw new Error('calendar_too_large');
      const snapshot = JSON.parse(io.readFileSync(file, 'utf8'));
      events = meetingEvents(snapshot);
      const coverageEnd = snapshot.coverageEnd && Date.parse(snapshot.coverageEnd);
      if (Number.isFinite(coverageEnd) && coverageEnd <= now()) { events = []; report('stale'); return; }
      reconcile();
    } catch (error) {
      events = [];
      report(error.code === 'ENOENT' ? 'missing' : 'invalid');
    }
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    try {
      const saved = JSON.parse(io.readFileSync(stateFile, 'utf8'));
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) seen = saved;
    } catch (_) { seen = {}; }
    try {
      // Watch the directory because calendar exporters often replace the file atomically.
      watcher = watch(path.dirname(file), (_event, name) => {
        if (stopped || name && String(name) !== path.basename(file)) return;
        cancelTimer();
        timer = setTimer(refresh, 200);
      });
      watching = true;
      watcher.on('error', () => { watching = false; cancelTimer(); events = []; report('watch_error'); });
    } catch (_) { report('watch_error'); }
    refresh();
  }

  function stop() {
    stopped = true; cancelTimer();
    if (watcher) watcher.close();
    watcher = null; watching = false; events = []; report('stopped');
  }
  return { start, stop, refresh, status: () => status, file, on: (event, listener) => emitter.on(event, listener) };
}

module.exports = { createMeetingReminders, meetingEvents, LEAD_MS };
